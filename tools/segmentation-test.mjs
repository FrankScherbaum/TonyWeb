// Synthetic test for services/noteSegmentation.ts
// Usage: node tools/segmentation-test.mjs
import { build } from 'esbuild';
import { pathToFileURL } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seg-')), 'seg.mjs');
await build({ entryPoints: ['services/noteSegmentation.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'error' });
const { segmentNotesCore } = await import(pathToFileURL(out).href);

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

function synth({ seed, legato, vibrato, noise, glitches, nNotes = 30, hop = 512 / 44100 }) {
  const r = rng(seed);
  const notes = [];
  let t = 0.3, p = 60;
  for (let i = 0; i < nNotes; i++) {
    const leap = r() < 0.25 ? Math.round((r() - 0.5) * 14) : Math.round((r() - 0.5) * 4);
    p = Math.max(48, Math.min(76, p + (leap === 0 ? 2 : leap)));
    const dur = 0.25 + r() * 0.7;
    notes.push({ start: t, end: t + dur, midi: p });
    t += dur + (legato ? 0 : 0.04 + r() * 0.16);
  }
  const total = t + 0.3;
  const T = Math.floor(total / hop);
  const times = new Float64Array(T), freqs = new Float32Array(T), probs = new Float32Array(T);
  for (let k = 0; k < T; k++) {
    const tt = k * hop; times[k] = tt;
    let idx = notes.findIndex(n => tt >= n.start && tt < n.end);
    if (idx < 0) { freqs[k] = 0; probs[k] = 0.02; continue; }
    const n = notes[idx]; const into = tt - n.start;
    let m = n.midi;
    if (legato && idx > 0 && into < 0.06) { const prev = notes[idx - 1].midi; m = prev + (n.midi - prev) * (into / 0.06); }
    if (vibrato) m += 0.3 * Math.sin(2 * Math.PI * 5.5 * tt) * Math.min(1, Math.max(0, (into - 0.15) / 0.2));
    m += gauss(r) * noise;
    let f = 440 * Math.pow(2, (m - 69) / 12), pr = 0.85 + r() * 0.12;
    if (glitches) {
      const u = r();
      if (u < 0.012) f *= (r() < 0.5 ? 2 : 0.5);       // octave error
      else if (u < 0.022) { f = 0; pr = 0.05; }          // dropout
    }
    freqs[k] = f; probs[k] = pr;
  }
  return { notes, times, freqs, probs, hop };
}

function evaluate(ref, det) {
  const used = new Set(); let tp = 0, onsetErr = 0;
  for (const r of ref) {
    let bi = -1, bd = 1e9;
    det.forEach((d, i) => {
      if (used.has(i)) return;
      const pitchSt = Math.abs(12 * Math.log2(d.pitch / (440 * Math.pow(2, (r.midi - 69) / 12))));
      const od = Math.abs(d.start - r.start);
      if (od <= 0.08 && pitchSt <= 0.6 && od < bd) { bd = od; bi = i; }
    });
    if (bi >= 0) { used.add(bi); tp++; onsetErr += bd; }
  }
  return { ref: ref.length, det: det.length, tp, recall: tp / ref.length, precision: det.length ? tp / det.length : 0, onsetMs: tp ? 1000 * onsetErr / tp : 0 };
}

const cases = [
  { name: 'clean, gaps',                 legato: false, vibrato: false, noise: 0.03, glitches: false },
  { name: 'vibrato, gaps',               legato: false, vibrato: true,  noise: 0.08, glitches: false },
  { name: 'vibrato+glitches, gaps',      legato: false, vibrato: true,  noise: 0.08, glitches: true  },
  { name: 'legato glides',               legato: true,  vibrato: false, noise: 0.05, glitches: false },
  { name: 'legato+vibrato+glitches',     legato: true,  vibrato: true,  noise: 0.08, glitches: true  },
];
if (process.env.DEBUG_CASE) { const c = cases[parseInt(process.env.DEBUG_CASE)]; const sy = synth({ seed: 1, ...c }); const det = segmentNotesCore(sy.times, sy.freqs, sy.probs, process.argv[2] ? JSON.parse(process.argv[2]) : {}); const m = (hz) => (12*Math.log2(hz/440)+69).toFixed(1); console.log('REF:', sy.notes.slice(0,14).map(n=>`${n.start.toFixed(2)}-${n.end.toFixed(2)}@${n.midi}`).join('  ')); console.log('DET:', det.slice(0,14).map(n=>`${n.start.toFixed(2)}-${n.end.toFixed(2)}@${m(n.pitch)}`).join('  ')); process.exit(0); }
// optional argument: JSON with segmentation parameters, e.g. '{"observationTrust":0.6}'
const params = process.argv[2] ? JSON.parse(process.argv[2]) : {};
for (const c of cases) {
  let agg = { ref: 0, det: 0, tp: 0, onsetMs: 0 }, ms = 0;
  for (let seed = 1; seed <= 5; seed++) {
    const s = synth({ seed, ...c });
    const t0 = performance.now();
    const det = segmentNotesCore(s.times, s.freqs, s.probs, params);
    ms += performance.now() - t0;
    const e = evaluate(s.notes, det);
    agg.ref += e.ref; agg.det += e.det; agg.tp += e.tp; agg.onsetMs += e.onsetMs * e.tp;
  }
  console.log(`${c.name.padEnd(28)} recall ${(100 * agg.tp / agg.ref).toFixed(0).padStart(3)}%  precision ${(100 * agg.tp / agg.det).toFixed(0).padStart(3)}%  (${agg.tp}/${agg.ref} ref, ${agg.det} det)  onset err ${(agg.onsetMs / Math.max(1, agg.tp)).toFixed(0)} ms  ${(ms / 5).toFixed(0)} ms/run`);
}
