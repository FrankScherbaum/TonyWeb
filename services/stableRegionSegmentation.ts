/**
 * Note segmentation by morphological filtering of the pitch track ("stable regions").
 *
 * Implemented from
 *  - the Mathematica notebook "PitchtrackSegmentation.nb" (getNoteDataFromPitchtrackLong[]):
 *    morphological filter -> join -> split -> trim, with the notebook's default parameters, and
 *  - Rosenzweig, Scherbaum, Müller: "Detecting Stable Regions in Frequency Trajectories for
 *    Tonal Analysis of Traditional Georgian Vocal Music", ISMIR 2019 (idea of the
 *    dilation/erosion filter on a cent scale).
 *
 * Steps (all pitch values in cents relative to 55 Hz):
 *  1. Only voiced frames are used. Sliding maximum (dilation) and minimum (erosion) with radius
 *     dRange / eRange (in frames at the reference hop of 11.61 ms; rescaled to the real hop).
 *  2. penalty = MeanFilter(dilation - erosion, radius meanRange). A frame is "stable" if its
 *     penalty is below the `pitchThreshold` quantile (default 0.7) of all penalties.
 *  3. Runs of stable frames become preliminary notes (mean pitch).
 *  4. Join: neighbouring notes with gap <= joinGapSec and pitch difference <= joinCents are
 *     grouped; a group is cut where a note deviates by more than joinSpreadCents from the
 *     duration-weighted cumulative mean of the group.
 *  5. Split: inside every joined note the frames are scanned; a new note starts where a frame
 *     deviates from the cumulative mean by more than splitMinCents AND more than splitFactor
 *     times the cumulative standard deviation.
 *  6. Trim: only frames within +-trimCents of the note's mean are kept (start/end of the
 *     note = first/last such frame).
 *  7. (own addition) Notes shorter than minDur are dropped, then gaps up to closeGapSec between
 *     neighbouring notes are closed.
 *
 * NOT a line-by-line port. Deviations (own choice): the notebook's quirks are not reproduced
 * (first note dropped, run onset one frame early, deviating note attached to the *previous*
 * part when joining/splitting - here the cut is made *before* it); runs are also cut where the
 * voiced frames are more than joinGapSec apart; the notebook's slope term (weight 0 by default)
 * is omitted.
 *
 * Self-contained (no imports) so that it could also be serialised into a Web Worker; it is fast
 * enough to run on the main thread.
 */

export interface StableRegionParams {
  /** Dilation radius in frames at the reference hop (default 10) */
  dRange?: number;
  /** Erosion radius in frames at the reference hop (default 10) */
  eRange?: number;
  /** Radius of the mean filter applied to the penalty (frames, default 2) */
  meanRange?: number;
  /** Quantile of the penalty values below which frames count as stable (default 0.7) */
  pitchThreshold?: number;
  /** Notes shorter than this (s) are dropped (default 0) */
  minDur?: number;
  /** Join: maximum gap between notes (s, default 0.3) */
  joinGapSec?: number;
  /** Join: maximum pitch difference between neighbouring notes (cents, default 60) */
  joinCents?: number;
  /** Join: maximum deviation from the cumulative mean within a group (cents, default 50) */
  joinSpreadCents?: number;
  /** Split: minimum deviation from cumulative mean (cents, default 30) */
  splitMinCents?: number;
  /** Split: deviation must exceed this many standard deviations (default 2) */
  splitFactor?: number;
  /** Trim: maximum deviation of kept frames from the note mean (cents, default 30) */
  trimCents?: number;
  /**
   * Gaps between consecutive notes up to this length (s) are closed by moving both note
   * boundaries to the middle of the gap. 0 = off. (own choice, not in the notebook)
   */
  closeGapSec?: number;
}

export const DEFAULT_STABLE_REGION_PARAMS: Required<StableRegionParams> = {
  dRange: 10,
  eRange: 10,
  meanRange: 2,
  pitchThreshold: 0.7,
  minDur: 0,
  joinGapSec: 0.3,
  joinCents: 60,
  joinSpreadCents: 50,
  splitMinCents: 30,
  splitFactor: 2,
  trimCents: 30,
  closeGapSec: 0,
};

export interface StableRawNote {
  start: number;
  end: number;
  pitch: number; // Hz
}

/**
 * @param times  frame timestamps (s), ascending
 * @param freqs  f0 in Hz per frame, 0 = unvoiced
 */
export function segmentStableRegions(
  times: ArrayLike<number>,
  freqs: ArrayLike<number>,
  paramsIn: StableRegionParams = {}
): StableRawNote[] {
  const P = Object.assign({}, DEFAULT_STABLE_REGION_PARAMS, paramsIn) as Required<StableRegionParams>;
  const REF_HOP = 0.01161; // hop of the pitch files the defaults were designed for
  const REF_HZ = 55;
  const N = times.length;
  if (N < 3) return [];

  // typical hop (median of time differences)
  const diffs: number[] = [];
  for (let i = 1; i < N; i++) { const d = times[i] - times[i - 1]; if (d > 0) diffs.push(d); }
  if (diffs.length === 0) return [];
  diffs.sort((a, b) => a - b);
  const hop = diffs[Math.floor(diffs.length / 2)];
  const scale = REF_HOP / hop; // frames per reference frame
  const rad = (r: number) => Math.max(0, Math.round(r * scale));

  // --- voiced frames only, in cents
  const t: number[] = [];
  const c: number[] = [];
  for (let i = 0; i < N; i++) {
    if (freqs[i] > 0) { t.push(times[i]); c.push(1200 * Math.log2(freqs[i] / REF_HZ)); }
  }
  const M = t.length;
  if (M < 3) return [];
  const hzOf = (cents: number) => REF_HZ * Math.pow(2, cents / 1200);

  // --- 1. dilation / erosion (window clipped at the borders = -inf / +inf padding)
  const dR = rad(P.dRange), eR = rad(P.eRange), mR = rad(P.meanRange);
  const slidingExtreme = (r: number, isMax: boolean): number[] => {
    // monotonic deque, window [i-r, i+r]
    const out = new Array<number>(M);
    const dq: number[] = [];
    let next = 0;
    for (let i = 0; i < M; i++) {
      const hi = Math.min(M - 1, i + r);
      while (next <= hi) {
        while (dq.length && (isMax ? c[dq[dq.length - 1]] <= c[next] : c[dq[dq.length - 1]] >= c[next])) dq.pop();
        dq.push(next++);
      }
      while (dq[0] < i - r) dq.shift();
      out[i] = c[dq[0]];
    }
    return out;
  };
  const dil = slidingExtreme(dR, true);
  const ero = slidingExtreme(eR, false);

  // --- 2. penalty and threshold
  const diff = new Array<number>(M);
  for (let i = 0; i < M; i++) diff[i] = dil[i] - ero[i];
  const pen = new Array<number>(M);
  {
    const cs = new Array<number>(M + 1); cs[0] = 0;
    for (let i = 0; i < M; i++) cs[i + 1] = cs[i] + diff[i];
    for (let i = 0; i < M; i++) {
      const a = Math.max(0, i - mR), b = Math.min(M - 1, i + mR);
      pen[i] = (cs[b + 1] - cs[a]) / (b - a + 1);
    }
  }
  const sorted = pen.slice().sort((a, b) => a - b);
  // Mathematica Quantile[list, q] (default parameters {{0,0},{1,0}}): sorted[ceil(q n)]
  const qi = Math.min(M - 1, Math.max(0, Math.ceil(P.pitchThreshold * M) - 1));
  const thresh = sorted[qi];

  // --- 3. runs of stable frames -> preliminary notes {start, end, cents (mean)}
  interface PNote { start: number; end: number; cents: number; }
  const pre: PNote[] = [];
  {
    let i = 0;
    while (i < M) {
      if (!(pen[i] < thresh)) { i++; continue; }
      let j = i;
      while (j + 1 < M && pen[j + 1] < thresh && t[j + 1] - t[j] <= P.joinGapSec) j++;
      let s = 0;
      for (let k = i; k <= j; k++) s += c[k];
      pre.push({ start: t[i], end: t[j] + hop, cents: s / (j - i + 1) });
      i = j + 1;
    }
  }
  if (pre.length === 0) return [];

  // --- 4. join
  const joined: PNote[] = [];
  {
    // group by gap and pitch difference between neighbours
    const groups: PNote[][] = [];
    let cur: PNote[] = [pre[0]];
    for (let i = 1; i < pre.length; i++) {
      const prev = pre[i - 1], n = pre[i];
      if (n.start - prev.end <= P.joinGapSec && Math.abs(n.cents - prev.cents) <= P.joinCents) cur.push(n);
      else { groups.push(cur); cur = [n]; }
    }
    groups.push(cur);
    // cut groups where a note deviates from the cumulative (duration-weighted) mean
    for (const g of groups) {
      let part: PNote[] = [];
      let sumW = 0, sumWC = 0;
      for (const n of g) {
        const w = n.end - n.start;
        if (part.length > 0 && Math.abs(n.cents - sumWC / sumW) > P.joinSpreadCents) {
          joined.push(mergeNotes(part));
          part = []; sumW = 0; sumWC = 0;
        }
        part.push(n); sumW += w; sumWC += w * n.cents;
      }
      if (part.length) joined.push(mergeNotes(part));
    }
  }
  function mergeNotes(part: PNote[]): PNote {
    if (part.length === 1) return part[0];
    let w = 0, wc = 0;
    for (const n of part) { const d = n.end - n.start; w += d; wc += d * n.cents; }
    return { start: part[0].start, end: part[part.length - 1].end, cents: wc / w };
  }

  // --- 5. split by deviation from cumulative mean, 6. trim
  const out: StableRawNote[] = [];
  // index range of voiced frames inside [start, end)
  let lo = 0;
  for (const jn of joined) {
    while (lo < M && t[lo] < jn.start - 1e-9) lo++;
    let hi = lo;
    while (hi < M && t[hi] < jn.end - 1e-9) hi++;
    // frames lo..hi-1
    let a = lo;
    while (a < hi) {
      let n = 0, sum = 0, sumSq = 0;
      let cut = hi;
      for (let k = a; k < hi; k++) {
        n++; sum += c[k]; sumSq += c[k] * c[k];
        if (n < 2) continue;
        const mean = sum / n;
        const variance = Math.max(0, (sumSq - n * mean * mean) / (n - 1));
        const sd = Math.sqrt(variance);
        const dev = Math.abs(c[k] - mean);
        if (dev > P.splitMinCents && dev > P.splitFactor * sd) { cut = k; break; }
      }
      if (cut <= a) cut = a + 1; // safety
      emitTrimmed(a, cut);
      a = cut;
    }
  }
  function emitTrimmed(a: number, b: number) {
    // frames a..b-1
    if (b - a < 2) return;
    let s = 0;
    for (let k = a; k < b; k++) s += c[k];
    const mean = s / (b - a);
    let first = -1, last = -1, cnt = 0, s2 = 0;
    for (let k = a; k < b; k++) {
      if (Math.abs(c[k] - mean) <= P.trimCents) { if (first < 0) first = k; last = k; cnt++; s2 += c[k]; }
    }
    if (cnt < 2) return;
    const start = t[first], end = t[last] + hop;
    if (end - start < P.minDur) return;
    out.push({ start, end, pitch: hzOf(s2 / cnt) });
  }

  // make sure notes do not overlap (trim can leave neighbours touching)
  out.sort((x, y) => x.start - y.start);
  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].end) out[i - 1].end = out[i].start;
  }
  const res = out.filter(n => n.end - n.start > 0);
  if (P.closeGapSec > 0) {
    for (let i = 1; i < res.length; i++) {
      const gap = res[i].start - res[i - 1].end;
      if (gap > 1e-9 && gap <= P.closeGapSec) {
        const mid = (res[i - 1].end + res[i].start) / 2;
        res[i - 1].end = mid;
        res[i].start = mid;
      }
    }
  }
  return res;
}
