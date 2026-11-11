// Test for services/stableRegionSegmentation.ts
// Usage: node tools/stable-test.mjs "<pitch.csv>"   (CSV: Time(s),Frequency(Hz),Probability; 0 = unvoiced)
import { build } from 'esbuild';
import { pathToFileURL } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-')), 'sr.mjs');
await build({ entryPoints: ['services/stableRegionSegmentation.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'error' });
const { segmentStableRegions } = await import(pathToFileURL(out).href);

const file = process.argv[2];
if (!file) { console.error('usage: node tools/stable-test.mjs pitch.csv'); process.exit(1); }
const rows = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map(l => l.split(',').map(Number));
const t = rows.map(r => r[0]), f = rows.map(r => r[1]);
const notes = segmentStableRegions(t, f);
const d = notes.map(n => n.end - n.start).sort((a, b) => a - b);
console.log(`notes: ${notes.length}, median duration ${d[d.length >> 1].toFixed(3)} s, max ${d.at(-1).toFixed(2)} s`);
let bad = 0;
for (let i = 0; i < notes.length; i++) {
  const n = notes[i];
  if (!(n.end > n.start) || !(n.pitch > 0) || (i && n.start < notes[i - 1].end - 1e-9)) bad++;
}
console.log(bad ? `FAIL: ${bad} invalid/overlapping notes` : 'OK: notes are valid and non-overlapping');
process.exit(bad ? 1 : 0);
