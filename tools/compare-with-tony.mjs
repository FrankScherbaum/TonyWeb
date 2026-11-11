// Compare TonyWeb's automatic segmentation with notes exported from original Tony.
// Usage: node tools/compare-with-tony.mjs <tony_pitchtrack.txt> <tony_notes.txt> [paramsJSON]
//   pitchtrack: "time<TAB>Hz" per frame (0 = unvoiced), notes: "onset<TAB>Hz<TAB>duration[<TAB>text]"
import { build } from 'esbuild';
import { pathToFileURL } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';

const [ptFile, ntFile, paramJson] = process.argv.slice(2);
if (!ptFile || !ntFile) { console.error('usage: node tools/compare-with-tony.mjs <pitchtrack.txt> <notes.txt> [paramsJSON]'); process.exit(1); }
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seg-')), 'seg.mjs');
await build({ entryPoints: ['services/noteSegmentation.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'error' });
const { segmentNotesCore } = await import(pathToFileURL(out).href);

const rows = fs.readFileSync(ptFile, 'utf8').split('\n').filter(Boolean).map(l => l.split('\t'));
const times = Float64Array.from(rows, r => +r[0]), freqs = Float32Array.from(rows, r => +r[1]);
const probs = Float32Array.from(freqs, f => f > 0 ? 0.9 : 0.02);
const ref = fs.readFileSync(ntFile, 'utf8').split('\n').filter(Boolean).map(l => { const p = l.split('\t'); return { start: +p[0], hz: +p[1], end: +p[0] + +p[2] }; });
const det = segmentNotesCore(times, freqs, probs, paramJson ? JSON.parse(paramJson) : {});

const st = (a, b) => Math.abs(12 * Math.log2(a / b));
for (const [tol, ptol] of [[0.05, 0.6], [0.08, 0.6], [0.12, 0.6]]) {
  const used = new Set(); let tp = 0, on = 0;
  for (const r of ref) {
    let bi = -1, bd = 1e9;
    det.forEach((d, i) => { if (used.has(i)) return; const od = Math.abs(d.start - r.start); if (od <= tol && st(d.pitch, r.hz) <= ptol && od < bd) { bd = od; bi = i; } });
    if (bi >= 0) { used.add(bi); tp++; on += bd; }
  }
  const R = tp / ref.length, P = tp / det.length;
  console.log(`onset ±${(tol * 1000).toFixed(0)} ms, pitch ±${ptol} st: recall ${(100 * R).toFixed(1)}%  precision ${(100 * P).toFixed(1)}%  F1 ${(100 * 2 * R * P / (R + P)).toFixed(1)}%  mean onset error ${(1000 * on / Math.max(tp, 1)).toFixed(0)} ms   (${tp} of ${ref.length} Tony notes, ${det.length} detected)`);
}
