import { PitchFrame } from '../types';

/**
 * "Snap to strongest spectral line": for every voiced frame, look at a
 * high-resolution spectrum around the frame and move the pitch to the
 * strongest spectral peak inside a search band above (and slightly below)
 * the currently detected frequency.
 *
 * Intended for ordinary-microphone recordings in which the tracker picks a
 * sub-harmonic (e.g. an octave too low) while the spectrogram shows a much
 * stronger line higher up.
 */
export interface SnapParams {
  /** Highest frequency considered, as a multiple of the detected pitch (2 = one octave, 3 = 3rd partial, ...) */
  maxRatio: number;
  /** Lowest frequency considered, as a multiple of the detected pitch */
  minRatio: number;
  /** Peaks within ~1 semitone of the previous frame's result get this magnitude bonus (stability) */
  continuityBonus: number;
  /** A peak must exceed the magnitude at the detected pitch by this factor to replace it */
  switchFactor: number;
}

export const DEFAULT_SNAP_PARAMS: SnapParams = {
  maxRatio: 3.2,
  minRatio: 0.93,
  continuityBonus: 1.5,
  switchFactor: 1.5,
};

const WIN = 4096;
const NFFT = 8192;

// --- minimal radix-2 FFT with cached tables ---
const rev = new Uint16Array(NFFT);
const cosT = new Float64Array(NFFT / 2);
const sinT = new Float64Array(NFFT / 2);
(() => {
  const bits = Math.log2(NFFT);
  for (let i = 0; i < NFFT; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  for (let i = 0; i < NFFT / 2; i++) {
    cosT[i] = Math.cos((2 * Math.PI * i) / NFFT);
    sinT[i] = -Math.sin((2 * Math.PI * i) / NFFT);
  }
})();

const fft = (re: Float64Array, im: Float64Array) => {
  for (let i = 0; i < NFFT; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1;
    const step = NFFT / size;
    for (let start = 0; start < NFFT; start += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const a = start + k, b = a + half;
        const xr = re[b] * cosT[t] - im[b] * sinT[t];
        const xi = re[b] * sinT[t] + im[b] * cosT[t];
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
};

const hann = new Float64Array(WIN);
for (let i = 0; i < WIN; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (WIN - 1)));

/**
 * Pure core (no DOM): returns new frequency for each frame (0 = unchanged / not processed).
 * `frameCenters` are the times (s) at which the analysis window is centred.
 */
export const snapFrequencies = async (
  data: Float32Array,
  sampleRate: number,
  freqs: number[],
  centers: number[],
  params: SnapParams = DEFAULT_SNAP_PARAMS,
  onProgress?: (p: number) => void
): Promise<number[]> => {
  const out = new Array<number>(freqs.length).fill(0);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const mag = new Float64Array(NFFT / 2);
  const binHz = sampleRate / NFFT;
  let prev = 0;

  for (let i = 0; i < freqs.length; i++) {
    if (i % 40 === 0) {
      onProgress?.(i / freqs.length);
      await new Promise(r => setTimeout(r, 0)); // keep UI responsive
    }
    const f0 = freqs[i];
    if (!(f0 > 0)) { prev = 0; continue; }

    const startSample = Math.round(centers[i] * sampleRate) - WIN / 2;
    for (let j = 0; j < NFFT; j++) { re[j] = 0; im[j] = 0; }
    for (let j = 0; j < WIN; j++) {
      const idx = startSample + j;
      re[j] = idx >= 0 && idx < data.length ? data[idx] * hann[j] : 0;
    }
    fft(re, im);

    const lo = Math.max(2, Math.floor((f0 * params.minRatio) / binHz));
    const hi = Math.min(NFFT / 2 - 2, Math.ceil((f0 * params.maxRatio) / binHz));
    for (let k = lo - 1; k <= hi + 1; k++) mag[k] = Math.hypot(re[k], im[k]);

    // magnitude at the currently detected pitch (best bin within +-1 semitone)
    let magAtF0 = 0;
    {
      const a = Math.max(2, Math.floor((f0 * 0.944) / binHz)), b = Math.min(NFFT / 2 - 2, Math.ceil((f0 * 1.059) / binHz));
      for (let k = a; k <= b; k++) {
        const m = Math.hypot(re[k], im[k]);
        if (m > magAtF0) magAtF0 = m;
      }
    }

    let bestScore = 0, bestK = -1, bestMag = 0;
    for (let k = lo; k <= hi; k++) {
      if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) {
        let score = mag[k];
        if (prev > 0 && Math.abs(Math.log2((k * binHz) / prev)) < 1 / 12) score *= params.continuityBonus;
        if (score > bestScore) { bestScore = score; bestK = k; bestMag = mag[k]; }
      }
    }

    let result = 0;
    if (bestK > 0 && bestMag > magAtF0 * params.switchFactor) {
      // parabolic interpolation on log magnitude
      const a = Math.log(mag[bestK - 1] + 1e-12), b = Math.log(mag[bestK] + 1e-12), c = Math.log(mag[bestK + 1] + 1e-12);
      const denom = a - 2 * b + c;
      const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
      result = (bestK + Math.max(-0.5, Math.min(0.5, delta))) * binHz;
    }
    out[i] = result;
    prev = result > 0 ? result : f0;
  }
  onProgress?.(1);
  return out;
};

/** Apply to the pitch frames whose timestamp lies in [start, end]. Returns the new frame list. */
export const snapPitchFrames = async (
  data: Float32Array,
  sampleRate: number,
  pitchData: PitchFrame[],
  start: number,
  end: number,
  params: SnapParams = DEFAULT_SNAP_PARAMS,
  onProgress?: (p: number) => void,
  /** offset between PitchFrame.timestamp (window start) and window centre, seconds */
  centerOffset = 1024 / sampleRate
): Promise<{ frames: PitchFrame[]; changed: number }> => {
  const idxs: number[] = [];
  pitchData.forEach((f, i) => { if (f.timestamp >= start && f.timestamp <= end && f.hasPitch && f.frequency > 0) idxs.push(i); });
  const newF = await snapFrequencies(
    data, sampleRate,
    idxs.map(i => pitchData[i].frequency),
    idxs.map(i => pitchData[i].timestamp + centerOffset),
    params, onProgress
  );
  const frames = pitchData.slice();
  let changed = 0;
  idxs.forEach((fi, k) => {
    const nf = newF[k];
    if (nf > 0 && Math.abs(nf - frames[fi].frequency) > 0.01) {
      const old = frames[fi];
      const cands = old.candidates ? old.candidates.slice() : [];
      if (!cands.some(c => Math.abs(c.frequency - nf) < 0.1)) cands.push({ frequency: nf, probability: old.probability });
      frames[fi] = { ...old, frequency: nf, hasPitch: true, candidates: cands };
      changed++;
    }
  });
  return { frames, changed };
};
