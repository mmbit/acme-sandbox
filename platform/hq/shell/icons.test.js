// node --test platform/hq/shell/icons.test.js   (every look style's icon style has a folder, and every folder is complete)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconStyle } from './icons.js';

const HQ = join(dirname(fileURLToPath(import.meta.url)), '..');
// a style's folder: the platform's, and the company's own drawings beside them (theme/hq/icons/<style>/, served first)
const FOLDERS = [join(HQ, 'icons'), join(HQ, '../../theme/hq/icons')];
// the icon styles the looks wear: a look's style is pixel, line or any (its scene.js `style`)
const styles = [...new Set(['pixel', 'line', 'any'].map(iconStyle))];
const filesIn = style =>
  FOLDERS.map(f => join(f, style))
    .filter(existsSync)
    .flatMap(dir =>
      readdirSync(dir)
        .filter(f => f.endsWith('.svg'))
        .map(f => join(dir, f)),
    );
const nameOf = file => file.split('/').pop().slice(0, -4);
const namesIn = style => [...new Set(filesIn(style).map(nameOf))];
const every = [...new Set(styles.flatMap(namesIn))].sort();

test('every icon style a look wears has a folder', () => {
  assert.deepEqual(
    styles.filter(s => !existsSync(join(FOLDERS[0], s))),
    [],
    'a style without its folder',
  );
});

test('every style draws every icon', () => {
  for (const style of styles) {
    const own = new Set(namesIn(style));
    assert.deepEqual(
      every.filter(n => !own.has(n)),
      [],
      `icons/${style}/ lacks these (another style draws them)`,
    );
  }
});

test('every drawing is an SVG with a viewBox, inked in the text colour', () => {
  for (const style of styles) {
    for (const file of filesIn(style)) {
      const svg = readFileSync(file, 'utf8');
      assert.match(svg, /^<svg [^>]*viewBox="[\d. ]+"/, file);
      assert.doesNotMatch(svg, /<script|black|#000/i, `${file}: fixed ink or a script`);
    }
  }
});
