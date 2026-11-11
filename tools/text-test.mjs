// Tests for note-text helpers: node tools/text-test.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = mkdtempSync(path.join(tmpdir(), 'tw-'));
const entry = path.join(dir, 'entry.ts');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
writeFileSync(entry, `
export { parseCSV, generateNotesCSV, generateNotesTSV, generateSVL } from '${root}/services/exportService';
export { inheritNoteTexts, splitNote } from '${root}/utils/noteUtils';
export { suggestNoteTexts } from '${root}/utils/textSuggest';
`);
const out = path.join(dir, 'out.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, platform: 'node', logLevel: 'error' });
const m = await import(out);

const N = (start, end, pitch, text) => ({ id: crypto.randomUUID(), start, end, pitch, text });

// 1. Tony Notes.txt (tab, no header, onset Hz duration text)
const tony = "0.5\t220.5\t0.25\tდა\n1.0\t230\t0.5\tა\n2.0\t240\t0.3\t\n";
let notes = m.parseCSV(tony, 'note');
assert.equal(notes.length, 3);
assert.equal(notes[0].text, 'და'); assert.equal(notes[0].pitch, 220.5);
assert.ok(Math.abs(notes[0].end - 0.75) < 1e-9);
assert.equal(notes[2].text, undefined);

// 2. TSV round trip
const back = m.parseCSV(m.generateNotesTSV(notes), 'note');
assert.deepEqual(back.map(n => [n.start, n.end, n.text]), notes.map(n => [n.start, n.end, n.text]));

// 3. CSV with text and quoting
const csv = m.generateNotesCSV([N(0, 1, 200, 'a,"b"'), N(1, 2, 210, 'ბა')]);
const c2 = m.parseCSV(csv, 'note');
assert.equal(c2[0].text, 'a,"b"'); assert.equal(c2[1].text, 'ბა'); assert.equal(c2[1].pitch, 210);
// old CSV without text still works
const c3 = m.parseCSV("Onset(s),Duration(s),Pitch(Hz)\n0.1,0.2,300\n", 'note');
assert.equal(c3[0].pitch, 300); assert.equal(c3[0].text, undefined);

// 4. SVL label escape
assert.ok(m.generateSVL([], [N(0, 1, 100, 'a&b')], 44100, 'x').includes('label="a&amp;b"'));

// 5. split keeps text left only
const sp = m.splitNote(N(0, 1, 100, 'და'), 0.5, []);
assert.equal(sp[0].text, 'და'); assert.equal(sp[1].text, undefined);

// 6. inherit by overlap
const old = [N(0, 1, 100, 'ა'), N(1, 2, 100, 'ბე')];
const nn = m.inheritNoteTexts(old, [N(0.05, 0.95, 100), N(1.1, 1.9, 100), N(2.5, 3, 100)]);
assert.deepEqual(nn.map(n => n.text), ['ა', 'ბე', undefined]);

// 7. suggestions
const seq = ['და', 'ა', 'და', 'ა', 'და', 'ბე', 'და', undefined].map((t, i) => N(i, i + 0.9, 100, t));
const sg = m.suggestNoteTexts(seq, 7, 4);
assert.equal(sg[0], 'ა');                 // vowel continuation of "და"
assert.ok(sg.includes('ბე'));
assert.equal(new Set(sg).size, sg.length);
console.log('all text tests passed');
