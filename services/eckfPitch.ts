/**
 * Pitch tracking with the Extended Complex Kalman Filter (ECKF).
 *
 * Written from the equations and the parameter description in
 *   O. Das, J. O. Smith III, C. Chafe: "Improved Real-Time Monophonic Pitch Tracking with the
 *   Extended Complex Kalman Filter", J. Audio Eng. Soc. 68(1/2), 2020 (and the DAFx-2017 paper
 *   it builds on). The authors' MATLAB code was consulted for parameter values and details but
 *   no code was copied; this is an independent implementation (it is NOT a port) and differs
 *   from the original in places (marked "(own choice)").
 *
 * Outline
 *  1. The signal is cut into blocks (default 2048 samples) and every block is classified as
 *     silent (spectral flatness >= 0.45 of a Welch spectrum, or very low energy) or not.
 *  2. In every non-silent block the NP largest spectral peaks are found; the mode of the
 *     peak spacings is the f0 estimate. A harmonic (note) change is detected from the change
 *     of the peak spacings between consecutive blocks (>= nsemitones).
 *  3. At the start of a voiced stretch and at every note change the filter is reset: the
 *     state (frequency, amplitude, phase of the fundamental) is initialised from the block
 *     `waitBlocks` blocks later (to skip the unstable attack) and propagated backwards to the
 *     start of the block ("backtracking"), the error covariance is set to zero.
 *  4. A sample-by-sample complex EKF follows frequency, amplitude and phase. The process
 *     noise is adaptive: log10(Q) = -c + |innovation| (c = 7 ... 11, larger = smoother).
 *  5. The per-sample f0 is reduced to frames of `hopSize` samples (own choice: median over the
 *     frame; a frame is voiced if at least half of its samples are).
 *
 * Self-contained (no imports) so that it can be serialised with toString() into a Web Worker.
 */
import { PitchFrame } from '../types';

export interface EckfParams {
  /** Block size in samples for silence / note-change detection (default 2048) */
  blockSize?: number;
  /** Process-noise constant c (default 6; larger = smoother track) */
  c?: number;
  /** Blocks to skip after an onset before the filter is initialised (default 2) */
  waitBlocks?: number;
  /** Number of spectral peaks used for f0 estimation / change detection (default 4) */
  npeaks?: number;
  /** Pitch change (semitones) from which a new note is assumed (default 2) */
  nsemitones?: number;
  /** Output frame step in samples (default 256) */
  hopSize?: number;
  /** Scale the signal to a peak of 0.9 before filtering (default true; the process-noise rule depends on the signal level) */
  normalize?: boolean;
}

export const DEFAULT_ECKF_PARAMS: Required<EckfParams> = {
  blockSize: 2048,
  c: 6,
  waitBlocks: 2,
  npeaks: 4,
  nsemitones: 2,
  hopSize: 256,
  normalize: true,
};

export function eckfPitchCore(
  dataIn: Float32Array,
  sampleRate: number,
  paramsIn: any,
  onProgress: (p: number) => void
): { timestamp: number; frequency: number; probability: number; hasPitch: boolean; candidates?: { frequency: number; probability: number }[] }[] {
  const prm = {
    blockSize: 2048, c: 6, waitBlocks: 2, npeaks: 4, nsemitones: 2, hopSize: 256, normalize: true,
  } as any;
  for (const k in paramsIn || {}) if (paramsIn[k] !== undefined) prm[k] = paramsIn[k];
  const B = Math.max(256, Math.round(prm.blockSize));
  const NP = Math.max(2, Math.round(prm.npeaks));
  const WAIT = Math.max(0, Math.round(prm.waitBlocks));
  const hop = Math.max(16, Math.round(prm.hopSize));
  const sr = sampleRate;
  const Ts = 1 / sr;
  const N = dataIn.length;

  // ---------------------------------------------------------------- helpers
  const nextPow2 = (n: number) => { let p = 1; while (p < n) p <<= 1; return p; };

  // in-place radix-2 complex FFT
  const fft = (re: Float64Array, im: Float64Array) => {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        const half = len >> 1;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const xr = re[b] * cr - im[b] * ci;
          const xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  };

  // normalisation
  let data = dataIn;
  if (prm.normalize) {
    let mx = 0;
    for (let i = 0; i < N; i++) { const a = Math.abs(dataIn[i]); if (a > mx) mx = a; }
    if (mx > 0) { data = new Float32Array(N); const g = 0.9 / mx; for (let i = 0; i < N; i++) data[i] = dataIn[i] * g; }
  }

  const nb = Math.floor(N / B);
  if (nb < 2) return [];

  // ------------------------------------------------ silence (Welch spectral flatness)
  const segL = Math.floor(B / 4.5);
  const segOverlap = Math.floor(segL / 2);
  const segStep = segL - segOverlap;
  const nSeg = Math.floor((B - segOverlap) / segStep);
  const wnfft = Math.max(256, nextPow2(segL));
  const hamming = new Float64Array(segL);
  for (let i = 0; i < segL; i++) hamming[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (segL - 1));
  const wre = new Float64Array(wnfft), wim = new Float64Array(wnfft);
  const psd = new Float64Array(wnfft / 2 + 1);

  const isSilent = (start: number): boolean => {
    let energy = 0;
    for (let i = 0; i < B; i++) { const v = data[start + i]; energy += v * v; }
    if (energy <= 0 || 20 * Math.log10(energy) < -50) return true;
    psd.fill(0);
    for (let s = 0; s < nSeg; s++) {
      const o = start + s * segStep;
      wre.fill(0); wim.fill(0);
      for (let i = 0; i < segL; i++) wre[i] = data[o + i] * hamming[i];
      fft(wre, wim);
      for (let k = 0; k <= wnfft / 2; k++) psd[k] += wre[k] * wre[k] + wim[k] * wim[k];
    }
    let sumLog = 0, sum = 0;
    const m = psd.length;
    for (let k = 0; k < m; k++) { const v = psd[k] / nSeg + 1e-30; sumLog += Math.log(v); sum += v; }
    const flatness = Math.exp(sumLog / m) / (sum / m);
    return flatness >= 0.45;
  };

  // ------------------------------------------------ spectral peaks / f0 estimate
  const nfft = nextPow2(4 * (B + 1));
  const binHz = sr / nfft;
  const blackman = new Float64Array(B);
  let winSum = 0;
  for (let i = 0; i < B; i++) {
    blackman[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (B - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (B - 1));
    winSum += blackman[i];
  }
  const kMin = Math.max(2, Math.ceil(50 / binHz)); // ignore everything below 50 Hz
  const kMax = Math.floor(nfft / 2) - 1;
  const poisson = (k: number) => Math.exp(-0.5 * 5 * (k - kMin) / (kMax - kMin));
  const sre = new Float64Array(nfft), sim = new Float64Array(nfft);
  const mag = new Float64Array(nfft / 2);

  // returns spectrum magnitude in `mag` (of the Blackman-windowed, mean-removed block)
  const spectrum = (start: number) => {
    let mean = 0;
    for (let i = 0; i < B; i++) mean += data[start + i];
    mean /= B;
    sre.fill(0); sim.fill(0);
    for (let i = 0; i < B; i++) sre[i] = (data[start + i] - mean) * blackman[i];
    fft(sre, sim);
    for (let k = 0; k < nfft / 2; k++) mag[k] = Math.sqrt(sre[k] * sre[k] + sim[k] * sim[k]);
  };

  // parabolic interpolation of a peak at bin k -> fractional bin position
  const interpPos = (k: number) => {
    const a = mag[k - 1], b = mag[k], c = mag[k + 1];
    const den = a - 2 * b + c;
    return den === 0 ? 0 : 0.5 * (a - c) / den;
  };

  // frequencies (Hz) of the NP largest (Poisson-weighted) peaks, sorted by frequency;
  // expects `mag` to hold the spectrum of the block
  const findPeakFreqs = (): number[] => {
    const cand: { k: number; w: number }[] = [];
    for (let k = kMin; k <= kMax; k++) {
      if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) cand.push({ k, w: mag[k] * poisson(k) });
    }
    cand.sort((x, y) => y.w - x.w);
    const top = cand.slice(0, NP).map(p => (p.k + interpPos(p.k)) * binHz);
    top.sort((x, y) => x - y);
    return top;
  };

  const modeOfRounded = (vals: number[]): number => {
    const counts = new Map<number, number>();
    let best = 0, bestCount = 0;
    for (const v of vals) {
      const r = Math.round(v);
      const c = (counts.get(r) || 0) + 1;
      counts.set(r, c);
    }
    counts.forEach((c, r) => { if (c > bestCount || (c === bestCount && r < best)) { best = r; bestCount = c; } });
    return best;
  };

  const diffsOf = (f: number[]) => { const d: number[] = []; for (let i = 1; i < f.length; i++) d.push(f[i] - f[i - 1]); return d; };

  // note change between two blocks from the change of the peak spacings
  const harmonicChange = (prevPeaks: number[], curPeaks: number[]): boolean => {
    if (prevPeaks.length < 3 || curPeaks.length < 3 || prevPeaks.length !== curPeaks.length) return false;
    const dc = diffsOf(curPeaks), dp = diffsOf(prevPeaks);
    const dd = dc.map((v, i) => Math.abs(v - dp[i]));
    const mn = Math.min(...dd), mx = Math.max(...dd);
    let centre: number;
    if (mx - mn < 1e-9) centre = mn;
    else {
      const counts = new Array(100).fill(0);
      const w = (mx - mn) / 100;
      for (const v of dd) counts[Math.min(99, Math.floor((v - mn) / w))]++;
      let ix = 0;
      for (let i = 1; i < 100; i++) if (counts[i] > counts[ix]) ix = i;
      centre = mn + (ix + 0.5) * w;
    }
    const f0 = modeOfRounded(dc);
    if (f0 <= 0) return false;
    const centsDev = 1200 * Math.log2(f0 / (f0 + centre));
    return Math.abs(centsDev) >= prm.nsemitones * 100;
  };

  // initial state from the block starting at `start`: {f, a, phi} (phi = phase at block start)
  const initialEstimate = (start: number): { f: number; a: number; phi: number } | null => {
    spectrum(start);
    const peaks = findPeakFreqs();
    if (peaks.length === 0) return null;
    let f0: number;
    if (peaks.length >= 2) f0 = modeOfRounded(diffsOf(peaks));
    else f0 = peaks[0];
    if (!(f0 > 40)) f0 = peaks[0];
    // refine: local maximum of the spectrum near f0
    let k0 = Math.round(f0 / binHz);
    let bestK = Math.max(kMin, Math.min(kMax, k0));
    const span = Math.max(2, Math.round(f0 * 0.03 / binHz));
    for (let k = Math.max(kMin, k0 - span); k <= Math.min(kMax, k0 + span); k++) if (mag[k] > mag[bestK]) bestK = k;
    const f = (bestK + interpPos(bestK)) * binHz;
    // amplitude and phase from the windowed DTFT at f (phase relative to the block start)
    let mean = 0;
    for (let i = 0; i < B; i++) mean += data[start + i];
    mean /= B;
    let xr = 0, xi = 0;
    const w = 2 * Math.PI * f * Ts;
    for (let i = 0; i < B; i++) {
      const v = (data[start + i] - mean) * blackman[i];
      xr += v * Math.cos(w * i);
      xi -= v * Math.sin(w * i);
    }
    const a = 2 * Math.sqrt(xr * xr + xi * xi) / winSum;
    const phi = Math.atan2(xi, xr);
    return { f, a, phi };
  };

  // ------------------------------------------------ pass 1: silence flags
  const silent = new Uint8Array(nb);
  for (let b = 0; b < nb; b++) {
    silent[b] = isSilent(b * B) ? 1 : 0;
    if (b % 50 === 0) onProgress(0.05 * b / nb);
  }

  // ------------------------------------------------ pass 2: filter
  const f0s = new Float32Array(nb * B); // per-sample f0, 0 = unvoiced
  const cSmooth = prm.c;

  // state: x (3 complex), P (3x3 complex)
  const xr = new Float64Array(3), xi = new Float64Array(3);
  const Pr = new Float64Array(9), Pi = new Float64Array(9);
  const vr = new Float64Array(3), vi = new Float64Array(3);
  const Kr = new Float64Array(3), Ki = new Float64Array(3);
  const hpr = new Float64Array(3), hpi = new Float64Array(3);
  const Ar = new Float64Array(9), Ai = new Float64Array(9);
  let tr = 0, ti = 0;
  const cmul = (ar: number, ai: number, br: number, bi: number) => { tr = ar * br - ai * bi; ti = ar * bi + ai * br; };
  const twoPiTs = 2 * Math.PI * Ts;

  let active = false;
  let harmPrev = false;
  let prevPeaks: number[] = [];
  let peaksCur: number[] = [];
  let havePrevPeaks = false;
  let lastFreq = 0;

  const resetFilter = (f: number, a: number, theta0: number) => {
    // x = [alpha, u, u*], alpha = exp(j 2 pi f Ts), u = a exp(j theta0)
    xr[0] = Math.cos(twoPiTs * f); xi[0] = Math.sin(twoPiTs * f);
    xr[1] = a * Math.cos(theta0); xi[1] = a * Math.sin(theta0);
    xr[2] = a * Math.cos(theta0); xi[2] = -a * Math.sin(theta0);
    Pr.fill(0); Pi.fill(0);
  };

  for (let b = 0; b < nb; b++) {
    if (b % 20 === 0) onProgress(0.05 + 0.9 * b / nb);
    const start = b * B;

    if (silent[b]) { active = false; harmPrev = false; havePrevPeaks = false; continue; }

    // peaks of this block (needed for note-change detection)
    spectrum(start);
    peaksCur = findPeakFreqs();
    let harmCur = false;
    if (havePrevPeaks && active) harmCur = harmonicChange(prevPeaks, peaksCur);
    const onset = !active || (!harmPrev && harmCur);
    prevPeaks = peaksCur;
    havePrevPeaks = true;

    if (onset) {
      // last block of this voiced stretch (limits the waiting time)
      let last = b;
      while (last + 1 < nb && !silent[last + 1] && last - b < WAIT) last++;
      const initBlock = last;
      const est = initialEstimate(initBlock * B);
      if (!est || !(est.f > 40) || !(est.a > 1e-6)) { active = false; harmPrev = harmCur; continue; }
      // propagate the phase back to the start of block b
      const theta0 = est.phi - twoPiTs * est.f * ((initBlock - b) * B);
      resetFilter(est.f, est.a, theta0);
      active = true;
    }
    harmPrev = harmCur;

    // sample-by-sample complex EKF over the block
    for (let n = 0; n < B; n++) {
      const y = data[start + n];

      // K = P H^H / (H P H^H + 1),  H = [0, 0.5, 0.5]
      for (let i = 0; i < 3; i++) {
        vr[i] = 0.5 * (Pr[i * 3 + 1] + Pr[i * 3 + 2]);
        vi[i] = 0.5 * (Pi[i * 3 + 1] + Pi[i * 3 + 2]);
      }
      const dr = 0.5 * (vr[1] + vr[2]) + 1;
      const di = 0.5 * (vi[1] + vi[2]);
      const den = dr * dr + di * di;
      for (let i = 0; i < 3; i++) {
        Kr[i] = (vr[i] * dr + vi[i] * di) / den;
        Ki[i] = (vi[i] * dr - vr[i] * di) / den;
      }
      // H P (row)
      for (let j = 0; j < 3; j++) {
        hpr[j] = 0.5 * (Pr[3 + j] + Pr[6 + j]);
        hpi[j] = 0.5 * (Pi[3 + j] + Pi[6 + j]);
      }
      // innovation and state update
      const er = y - 0.5 * (xr[1] + xr[2]);
      const ei = -0.5 * (xi[1] + xi[2]);
      for (let i = 0; i < 3; i++) {
        xr[i] += Kr[i] * er - Ki[i] * ei;
        xi[i] += Kr[i] * ei + Ki[i] * er;
      }
      // covariance update P = P - K (H P)
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          Pr[i * 3 + j] -= Kr[i] * hpr[j] - Ki[i] * hpi[j];
          Pi[i * 3 + j] -= Kr[i] * hpi[j] + Ki[i] * hpr[j];
        }
      }
      // outputs
      const x0r = xr[0], x0i = xi[0];
      const m0 = Math.sqrt(x0r * x0r + x0i * x0i);
      if (!(m0 > 1e-9) || !isFinite(m0)) { active = false; break; }
      const lnm = Math.log(m0), arg = Math.atan2(x0i, x0r);
      const f = Math.sqrt(lnm * lnm + arg * arg) / twoPiTs;
      f0s[start + n] = f;
      lastFreq = f;

      // adaptive process noise from the innovation after the update
      const e2r = y - 0.5 * (xr[1] + xr[2]);
      const e2i = -0.5 * (xi[1] + xi[2]);
      const Q = Math.pow(10, -(cSmooth - Math.sqrt(e2r * e2r + e2i * e2i)));

      // F (Jacobian) at the updated state and prediction
      // F = [[1,0,0],[x1, x0, 0],[-x2/x0^2, 0, 1/x0]]
      const inv0r = x0r / (m0 * m0), inv0i = -x0i / (m0 * m0);           // 1/x0
      cmul(inv0r, inv0i, inv0r, inv0i); const inv2r = tr, inv2i = ti;     // 1/x0^2
      cmul(xr[2], xi[2], inv2r, inv2i); const f20r = -tr, f20i = -ti;     // -x2/x0^2
      cmul(xr[2], xi[2], inv0r, inv0i); const nx2r = tr, nx2i = ti;       // x2/x0
      cmul(x0r, x0i, xr[1], xi[1]); const nx1r = tr, nx1i = ti;           // x0*x1
      const f10r = xr[1], f10i = xi[1], f11r = x0r, f11i = x0i;
      const f22r = inv0r, f22i = inv0i;

      // A = F P
      for (let j = 0; j < 3; j++) {
        Ar[j] = Pr[j]; Ai[j] = Pi[j];
        cmul(f10r, f10i, Pr[j], Pi[j]); let ar = tr, ai = ti;
        cmul(f11r, f11i, Pr[3 + j], Pi[3 + j]); Ar[3 + j] = ar + tr; Ai[3 + j] = ai + ti;
        cmul(f20r, f20i, Pr[j], Pi[j]); ar = tr; ai = ti;
        cmul(f22r, f22i, Pr[6 + j], Pi[6 + j]); Ar[6 + j] = ar + tr; Ai[6 + j] = ai + ti;
      }
      // P = A F^H + Q I   ((A F^H)[i][j] = sum_k A[i][k] conj(F[j][k]))
      for (let i = 0; i < 3; i++) {
        const a0r = Ar[i * 3], a0i = Ai[i * 3];
        const a1r = Ar[i * 3 + 1], a1i = Ai[i * 3 + 1];
        const a2r = Ar[i * 3 + 2], a2i = Ai[i * 3 + 2];
        Pr[i * 3] = a0r; Pi[i * 3] = a0i;                                       // j = 0
        cmul(a0r, a0i, f10r, -f10i); let pr = tr, pi = ti;                       // j = 1
        cmul(a1r, a1i, f11r, -f11i); Pr[i * 3 + 1] = pr + tr; Pi[i * 3 + 1] = pi + ti;
        cmul(a0r, a0i, f20r, -f20i); pr = tr; pi = ti;                           // j = 2
        cmul(a2r, a2i, f22r, -f22i); Pr[i * 3 + 2] = pr + tr; Pi[i * 3 + 2] = pi + ti;
      }
      Pr[0] += Q; Pr[4] += Q; Pr[8] += Q;

      xr[0] = x0r; xi[0] = x0i; // alpha unchanged
      xr[1] = nx1r; xi[1] = nx1i;
      xr[2] = nx2r; xi[2] = nx2i;
    }
    if (!active) { for (let n = 0; n < B; n++) if (f0s[start + n] > 0 && !isFinite(f0s[start + n])) f0s[start + n] = 0; }
    if (!isFinite(xr[0]) || !isFinite(xr[1]) || !isFinite(xr[2])) active = false;
  }
  void lastFreq;

  // ------------------------------------------------ frames
  const total = nb * B;
  const frames: any[] = [];
  const nFrames = Math.floor(total / hop);
  const buf: number[] = [];
  for (let i = 0; i < nFrames; i++) {
    const t0 = i * hop;
    // window of `hop` samples centred on the time stamp
    const a = Math.max(0, t0 - (hop >> 1)), bnd = Math.min(total, t0 + (hop >> 1));
    buf.length = 0;
    for (let s = a; s < bnd; s++) if (f0s[s] > 0) buf.push(f0s[s]);
    const timestamp = t0 / sr;
    if (buf.length * 2 >= (bnd - a) && buf.length > 0) {
      buf.sort((x, y) => x - y);
      const f = buf[buf.length >> 1];
      frames.push({
        timestamp, frequency: f, probability: 0.9, hasPitch: true,
        // octave alternatives so that a wrong octave can be corrected with the up/down keys
        candidates: [
          { frequency: f / 2, probability: 0.2 },
          { frequency: f, probability: 0.9 },
          { frequency: f * 2, probability: 0.2 },
        ],
      });
    } else {
      frames.push({ timestamp, frequency: 0, probability: 0.99, hasPitch: false, candidates: [] });
    }
  }
  onProgress(1);
  return frames;
}

/**
 * Runs the ECKF pitch tracker in a Web Worker.
 */
export const extractPitchEckf = (
  audioData: Float32Array,
  sampleRate: number,
  onProgress: (p: number) => void,
  params: EckfParams = {}
): Promise<PitchFrame[]> => {
  const workerCode = `
    const eckfPitchCore = ${eckfPitchCore.toString()};
    self.onmessage = function(e) {
      try {
        const d = e.data;
        const result = eckfPitchCore(d.data, d.sampleRate, d.params,
          function(p) { self.postMessage({ type: 'progress', payload: p }); });
        self.postMessage({ type: 'result', payload: result });
      } catch (err) {
        self.postMessage({ type: 'error', payload: String(err) });
      }
    };
  `;
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  const workerUrl = URL.createObjectURL(blob);
  const worker = new Worker(workerUrl);
  return new Promise<PitchFrame[]>((resolve, reject) => {
    const cleanup = () => { worker.terminate(); URL.revokeObjectURL(workerUrl); };
    worker.onmessage = (e) => {
      const { type, payload } = e.data;
      if (type === 'progress') onProgress(payload);
      else if (type === 'result') { cleanup(); resolve(payload as PitchFrame[]); }
      else if (type === 'error') { cleanup(); reject(new Error(payload)); }
    };
    worker.onerror = (e) => { cleanup(); reject(new Error(e.message)); };
    worker.postMessage({ data: audioData, sampleRate, params });
  });
};
