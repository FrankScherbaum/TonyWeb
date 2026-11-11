import { Note, PitchFrame } from '../types';

/**
 * AUTOMATIC NOTE SEGMENTATION
 *
 * Re-implementation of the idea behind the "MonoNote" note-tracking stage of the
 * pYIN Vamp plugin (used by Tony): a Hidden Markov Model with three states per
 * pitch bin (attack, stable, silent), decoded with the Viterbi algorithm.
 *
 *   - pitch bins: 3 per semitone, MIDI 35 ... 104  (207 bins, 621 states)
 *   - note changes always pass through a silent state (silent -> attack of any
 *     pitch within a limited interval), so notes are separated by >= 1 frame
 *   - observations: the (corrected) f0 of each frame, with a "pitched" probability
 *
 * NOTE: This is NOT a line-by-line port of the original C++ code. Parameter
 * values follow the original where known; deviations are marked "(own choice)".
 *
 * The core function below is deliberately self-contained (no imports, no
 * outer-scope references) because it is serialised with toString() and run
 * inside a Web Worker, exactly like the pYIN code in yin.ts.
 */

export interface SegmentationParams {
  /** Notes shorter than this (seconds) are discarded. Original default: 0.1 */
  pruneSec?: number;
  /**
   * Weight of the f0 evidence (exponent applied to the observation likelihood; the
   * original "yinTrust" is 0.1 but is used with a differently normalised likelihood).
   * Defined for the original frame rate (256 samples @ 44.1 kHz) and rescaled
   * internally for other frame rates. Tuned on a Tony reference (see tools/).
   * Lower = smoother (ignores vibrato/jitter, may miss quick notes),
   * higher = follows the pitch curve more closely (may split on vibrato/glides).
   */
  observationTrust?: number;
  /** Gaps between consecutive notes up to this length (s) are closed. (own choice) */
  closeGapSec?: number;
  /** Std. dev. (semitones) of the interval distribution between consecutive notes. (own choice) */
  leapSigma?: number;
  /**
   * Per-frame probability (at the original frame rate) of changing directly from one
   * note to another WITHOUT a silent frame in between (legato / melisma). 0 = off.
   * The original model has no such transition. (own choice)
   */
  legatoProb?: number;
}

export const DEFAULT_SEGMENTATION_PARAMS: Required<SegmentationParams> = {
  pruneSec: 0.1,
  observationTrust: 0.85,
  closeGapSec: 0.04,
  leapSigma: 5.0,
  legatoProb: 0.004,
};

export interface RawNote {
  start: number;
  end: number;
  pitch: number; // Hz
}

/**
 * @param times  frame timestamps (s), ascending, evenly spaced
 * @param freqs  f0 in Hz per frame, 0 = unvoiced
 * @param probs  voicing/pitch confidence per frame (0..1)
 */
export function segmentNotesCore(
  times: ArrayLike<number>,
  freqs: ArrayLike<number>,
  probs: ArrayLike<number>,
  options: SegmentationParams,
  onProgress?: (p: number) => void
): RawNote[] {
  const T = times.length;
  if (T < 2) return [];

  const pruneSec = options.pruneSec !== undefined ? options.pruneSec : 0.1;
  const trust = options.observationTrust !== undefined ? options.observationTrust : 0.85;
  const closeGapSec = options.closeGapSec !== undefined ? options.closeGapSec : 0.04;
  const leapSigma = options.leapSigma !== undefined ? options.leapSigma : 5.0;
  const legatoProb = options.legatoProb !== undefined ? options.legatoProb : 0.004;

  // ---- Model constants (MonoNoteParameters of the original) ----
  const MIN_PITCH = 35;        // lowest MIDI pitch
  const NPPS = 3;              // pitch bins per semitone
  const NS = 69;               // number of semitones
  const NSPP = 3;              // states per pitch: 0 attack, 1 stable, 2 silent
  const NP = NS * NPPS;        // pitch bins
  const N = NP * NSPP;         // states
  const P_ATTACK_SELF = 0.9;
  const P_STABLE_SELF = 0.99;
  const P_SILENT_SELF = 0.9999;
  const MAX_JUMP = 13;         // semitones
  const MIN_SEMITONE_DISTANCE = 0.5;
  const SIGMA_ATTACK = 5;      // semitones, observation spread in attack state
  const SIGMA_STABLE = 0.8;    // semitones, observation spread in stable state

  // The original probabilities refer to its frame rate (step 256 @ 44.1 kHz).
  // Rescale per-frame probabilities to our frame rate.
  const hopSec = (times[T - 1] - times[0]) / (T - 1);
  const scale = Math.max(0.25, hopSec / (256 / 44100));
  const pAttackSelf = Math.pow(P_ATTACK_SELF, scale);
  const pStableSelf = Math.pow(P_STABLE_SELF, scale);
  const pSilentSelf = Math.pow(P_SILENT_SELF, scale);
  // evidence per frame grows with the time a frame represents
  const trustEff = trust * scale;
  const pLegato = legatoProb > 0 ? 1 - Math.pow(1 - legatoProb, scale) : 0;

  // ---- Sparse transition model ----
  const fromArr: number[] = [];
  const toArr: number[] = [];
  const lpArr: number[] = [];
  const add = (f: number, t: number, p: number) => {
    if (p > 0) { fromArr.push(f); toArr.push(t); lpArr.push(Math.log(p)); }
  };
  for (let i = 0; i < NP; i++) {
    const a = i * NSPP, s = a + 1, q = a + 2;
    add(a, a, pAttackSelf);
    add(a, s, 1 - pAttackSelf);
    add(s, s, pStableSelf - pLegato);
    add(s, q, 1 - pStableSelf);
    add(q, q, pSilentSelf);

    if (pLegato > 0) {
      // direct note-to-note change without a silent frame (own addition)
      const lt: number[] = [];
      const lw: number[] = [];
      let lsum = 0;
      for (let j = 0; j < NP; j++) {
        const d = Math.abs(i - j) / NPPS;
        if (d > MIN_SEMITONE_DISTANCE && d < MAX_JUMP) {
          const w = Math.exp(-0.5 * (d / leapSigma) * (d / leapSigma));
          lt.push(j); lw.push(w); lsum += w;
        }
      }
      for (let k = 0; k < lt.length; k++) add(s, lt[k] * NSPP, pLegato * lw[k] / lsum);
    }

    const targets: number[] = [];
    const weights: number[] = [];
    let sum = 0;
    for (let j = 0; j < NP; j++) {
      const d = Math.abs(i - j) / NPPS;
      if (d === 0 || (d > MIN_SEMITONE_DISTANCE && d < MAX_JUMP)) {
        const w = Math.exp(-0.5 * (d / leapSigma) * (d / leapSigma));
        targets.push(j); weights.push(w); sum += w;
      }
    }
    for (let k = 0; k < targets.length; k++) {
      add(q, targets[k] * NSPP, (1 - pSilentSelf) * weights[k] / sum);
    }
  }
  const nTrans = fromArr.length;
  const from = Int32Array.from(fromArr);
  const to = Int32Array.from(toArr);
  const lp = Float64Array.from(lpArr);

  // ---- Observation model ----
  const logObs = new Float64Array(N);
  const logSA = Math.log(SIGMA_ATTACK);
  const logSS = Math.log(SIGMA_STABLE);
  const tmpA = new Float64Array(NP);
  const tmpS = new Float64Array(NP);

  const computeObs = (f: number, prob: number) => {
    if (f > 0) {
      const m = 69 + 12 * Math.log2(f / 440);
      let pIsPitched = 0.5 + 0.5 * Math.max(0, Math.min(1, prob));
      if (pIsPitched > 0.98) pIsPitched = 0.98;
      let maxV = -Infinity;
      for (let i = 0; i < NP; i++) {
        const mean = MIN_PITCH + i / NPPS;
        const da = (m - mean) / SIGMA_ATTACK;
        const ds = (m - mean) / SIGMA_STABLE;
        const va = trustEff * (-0.5 * da * da - logSA);
        const vs = trustEff * (-0.5 * ds * ds - logSS);
        tmpA[i] = va; tmpS[i] = vs;
        if (va > maxV) maxV = va;
        if (vs > maxV) maxV = vs;
      }
      let acc = 0;
      for (let i = 0; i < NP; i++) acc += Math.exp(tmpA[i] - maxV) + Math.exp(tmpS[i] - maxV);
      const lse = maxV + Math.log(acc);
      const lPitched = Math.log(pIsPitched);
      const lSilent = Math.log((1 - pIsPitched) / NP);
      for (let i = 0; i < NP; i++) {
        logObs[i * NSPP] = lPitched + tmpA[i] - lse;
        logObs[i * NSPP + 1] = lPitched + tmpS[i] - lse;
        logObs[i * NSPP + 2] = lSilent;
      }
    } else {
      // unvoiced frame: almost surely silent
      const pIsPitched = 0.02;
      const lPitched = Math.log(pIsPitched / (2 * NP));
      const lSilent = Math.log((1 - pIsPitched) / NP);
      for (let i = 0; i < NP; i++) {
        logObs[i * NSPP] = lPitched;
        logObs[i * NSPP + 1] = lPitched;
        logObs[i * NSPP + 2] = lSilent;
      }
    }
  };

  // ---- Viterbi ----
  let delta = new Float64Array(N);
  let next = new Float64Array(N);
  const bp = new Int16Array(T * N);

  computeObs(freqs[0], probs[0]);
  delta.fill(-Infinity);
  for (let i = 0; i < NP; i++) {
    delta[i * NSPP + 2] = Math.log(1 / NP) + logObs[i * NSPP + 2];
  }

  for (let t = 1; t < T; t++) {
    if (onProgress && t % 500 === 0) onProgress(t / T);
    computeObs(freqs[t], probs[t]);
    next.fill(-Infinity);
    const base = t * N;
    for (let k = 0; k < nTrans; k++) {
      const v = delta[from[k]] + lp[k];
      const tk = to[k];
      if (v > next[tk]) { next[tk] = v; bp[base + tk] = from[k]; }
    }
    for (let s = 0; s < N; s++) next[s] += logObs[s];
    const swap = delta; delta = next; next = swap;
  }

  let best = 0;
  let bestV = -Infinity;
  for (let s = 0; s < N; s++) if (delta[s] > bestV) { bestV = delta[s]; best = s; }
  const path = new Int16Array(T);
  path[T - 1] = best;
  for (let t = T - 1; t > 0; t--) path[t - 1] = bp[t * N + path[t]];

  // ---- Path -> notes ----
  interface Seg { i0: number; i1: number; fallback: number }
  const found: Seg[] = [];
  let startIdx = -1;
  for (let t = 0; t < T; t++) {
    // a note ends at a silent frame or at a direct (legato) change of pitch bin
    const state = path[t];
    const silent = state % NSPP === 2;
    const changed = startIdx >= 0 && !silent && t > 0 && state % NSPP === 0 &&
      Math.floor(state / NSPP) !== Math.floor(path[t - 1] / NSPP) && path[t - 1] % NSPP !== 2;
    if (startIdx >= 0 && (silent || changed)) {
      const midi = MIN_PITCH + Math.floor(path[startIdx] / NSPP) / NPPS;
      found.push({ i0: startIdx, i1: t, fallback: 440 * Math.pow(2, (midi - 69) / 12) });
      startIdx = -1;
    }
    if (!silent && startIdx < 0) startIdx = t;
  }
  if (startIdx >= 0) {
    const midi = MIN_PITCH + Math.floor(path[startIdx] / NSPP) / NPPS;
    found.push({ i0: startIdx, i1: T, fallback: 440 * Math.pow(2, (midi - 69) / 12) });
  }

  const timeAt = (i: number) => (i < T ? times[i] : times[T - 1] + hopSec);
  const medianPitch = (sg: Seg) => {
    const fs: number[] = [];
    for (let i = sg.i0; i < sg.i1; i++) if (freqs[i] > 0) fs.push(freqs[i]);
    if (fs.length === 0) return sg.fallback;
    fs.sort((x, y) => x - y);
    const mid = Math.floor(fs.length / 2);
    return fs.length % 2 === 0 ? (fs[mid - 1] + fs[mid]) / 2 : fs[mid];
  };

  // Prune short notes and merge fragments of one note (own additions):
  //  - a pruned glitch note between two notes of the same pitch is bridged
  //  - neighbours of the same pitch with a tiny gap (vibrato / dropout splits) are merged
  const kept: Seg[] = [];
  let prunedBetween = false;
  for (const sg of found) {
    if (timeAt(sg.i1) - timeAt(sg.i0) < pruneSec) { prunedBetween = true; continue; }
    const last = kept.length > 0 ? kept[kept.length - 1] : null;
    if (last) {
      const gap = timeAt(sg.i0) - timeAt(last.i1);
      const semis = Math.abs(12 * Math.log2(medianPitch(sg) / medianPitch(last)));
      if (semis < 0.6 && (gap <= closeGapSec || (prunedBetween && gap <= pruneSec + 2 * hopSec))) {
        last.i1 = sg.i1;
        prunedBetween = false;
        continue;
      }
    }
    kept.push({ i0: sg.i0, i1: sg.i1, fallback: sg.fallback });
    prunedBetween = false;
  }

  const raw: RawNote[] = kept.map(sg => ({ start: timeAt(sg.i0), end: timeAt(sg.i1), pitch: medianPitch(sg) }))
    .filter(n => n.pitch > 0);

  // Close tiny gaps between neighbouring notes so they touch
  for (let i = 0; i + 1 < raw.length; i++) {
    const gap = raw[i + 1].start - raw[i].end;
    if (gap > 0 && gap <= closeGapSec) raw[i].end = raw[i + 1].start;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Main-thread wrapper: runs the core in a Web Worker
// ---------------------------------------------------------------------------

export const segmentNotes = (
  pitchData: PitchFrame[],
  params: SegmentationParams = {},
  onProgress: (p: number) => void = () => {}
): Promise<Note[]> => {
  if (pitchData.length < 2) return Promise.resolve([]);

  const times = new Float64Array(pitchData.length);
  const freqs = new Float32Array(pitchData.length);
  const probs = new Float32Array(pitchData.length);
  for (let i = 0; i < pitchData.length; i++) {
    const f = pitchData[i];
    times[i] = f.timestamp;
    freqs[i] = f.hasPitch && f.frequency > 0 ? f.frequency : 0;
    probs[i] = f.probability;
  }

  const workerCode = `
    const segmentNotesCore = ${segmentNotesCore.toString()};
    self.onmessage = function(e) {
      try {
        const d = e.data;
        const result = segmentNotesCore(d.times, d.freqs, d.probs, d.params,
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

  return new Promise<Note[]>((resolve, reject) => {
    const cleanup = () => { worker.terminate(); URL.revokeObjectURL(workerUrl); };
    worker.onmessage = (e) => {
      const { type, payload } = e.data;
      if (type === 'progress') {
        onProgress(payload);
      } else if (type === 'result') {
        cleanup();
        resolve((payload as RawNote[]).map(n => ({
          id: crypto.randomUUID(),
          start: n.start,
          end: n.end,
          pitch: n.pitch,
          state: 'default' as const,
        })));
      } else if (type === 'error') {
        cleanup();
        reject(new Error(payload));
      }
    };
    worker.onerror = (e) => { cleanup(); reject(new Error(e.message)); };
    worker.postMessage({ times, freqs, probs, params });
  });
};
