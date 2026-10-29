// node --test platform/hq/shell/ink/notebookshellwords.test.js   (the shared shell's own words in a guest's language: every
// word() the shell says, and every palette label it passes through word(), has its nl and de; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shell } from './notebookshellwords.js';

// (its own folder by path: HQ's load walk, extras.test.ts, reads a new URL beside it as a page it loads)
const dir = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(dir)
  .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
  .map(f => readFileSync(join(dir, f), 'utf8'));
// word('…') and word("…") with a fixed key, and either side of a word(a ? '…' : '…')
const said = sources.flatMap(s =>
  [...s.matchAll(/word\(\s*(?:[^'"`()]*\?\s*)?(['"])((?:(?!\1).)+)\1(?:\s*:\s*(['"])((?:(?!\3).)+)\3)?/g)].flatMap(m =>
    m[4] ? [m[2], m[4]] : [m[2]],
  ),
);
// the palette's labels, rows and inks, passed through word() by name (bookpalette.js row and the tools' island)
const palette = readFileSync(join(dir, 'bookpalette.js'), 'utf8');
const labels = [
  ...[...palette.matchAll(/(?:label|name): '([^']+)'/g)].map(m => m[1]),
  ...[...palette.matchAll(/row\(\s*'([^']+)'/g)].map(m => m[1]),
  ...[...palette.matchAll(/\[('[^']+'(?:, '[^']+')+)\]\[i\]/g)].flatMap(m => m[1].split(', ').map(x => x.slice(1, -1))),
  ...['ellipse', 'rectangle', 'line', 'arrow'].map(k => `Shapes: ${k}`),
];

test('every word the shell says has its Dutch and German', () => {
  assert.ok(said.length >= 30, `found ${said.length}`);
  for (const lang of ['nl', 'de']) for (const en of [...said, ...labels]) assert.ok(shell[lang][en], `${lang}: ${en}`);
});

test('Dutch and German hold the same words, with the same places to fill', () => {
  assert.deepEqual(Object.keys(shell.de).sort(), Object.keys(shell.nl).sort());
  const places = s => (s.match(/\{\w+\}/g) ?? []).sort();
  for (const [en, nl] of Object.entries(shell.nl)) {
    assert.deepEqual(places(nl), places(en), en);
    assert.deepEqual(places(shell.de[en]), places(en), en);
  }
});
