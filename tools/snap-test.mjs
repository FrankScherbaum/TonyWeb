// node tools/snap-test.mjs  – tests services/spectralSnap.ts on synthetic signals
import { build } from 'esbuild';
import { pathToFileURL } from 'url';
import path from 'path'; import os from 'os'; import fs from 'fs';
import assert from 'node:assert/strict';
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snap-')), 's.mjs');
await build({ entryPoints: ['services/spectralSnap.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'error' });
const { snapFrequencies, DEFAULT_SNAP_PARAMS } = await import(pathToFileURL(out).href);

const sr = 44100, dur = 2;
const mk = (f0, amps) => { const d = new Float32Array(sr * dur); for (let i = 0; i < d.length; i++) { let v = 0; amps.forEach((a, h) => v += a * Math.sin(2 * Math.PI * f0 * (h + 1) * i / sr)); d[i] = v; } return d; };
const centers = [0.5, 0.7, 0.9, 1.1], cents = (a, b) => 1200 * Math.log2(a / b);

// A: weak fundamental (tracker said 200 Hz), strong 2nd partial (400 Hz) -> snap to 400
let r = await snapFrequencies(mk(200, [0.1, 1, 0.3]), sr, [200, 200, 200, 200], centers);
r.forEach(x => assert.ok(Math.abs(cents(x, 400)) < 5, `A got ${x}`));
// B: strong fundamental -> unchanged (0)
r = await snapFrequencies(mk(200, [1, 0.4, 0.2]), sr, [200, 200, 200, 200], centers);
r.forEach(x => assert.equal(x, 0));
// C: tracker was an octave too low (100) of a 200 Hz tone
r = await snapFrequencies(mk(200, [1, 0.5]), sr, [100, 100, 100, 100], centers);
r.forEach(x => assert.ok(Math.abs(cents(x, 200)) < 5, `C got ${x}`));
// D: unvoiced (0) stays 0, ratio limit 1.5 forbids reaching 400
r = await snapFrequencies(mk(200, [0.1, 1]), sr, [0, 200], [0.5, 0.7], { ...DEFAULT_SNAP_PARAMS, maxRatio: 1.5 });
assert.equal(r[0], 0); assert.equal(r[1], 0);
console.log('snap tests passed');
