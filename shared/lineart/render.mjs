// The examples as SVG files, each in every palette: examples/<name>-<palette>.svg.
//   node shared/lineart/render.mjs
import { writeFileSync } from 'node:fs';
import { drawing, PALETTES } from './lineart.js';
import { EXAMPLES } from './examples/examples.js';

const folder = new URL('./examples/', import.meta.url);
for (const [name, { build, W, H, title }] of Object.entries(EXAMPLES))
  for (const palette of Object.keys(PALETTES)) {
    writeFileSync(new URL(`${name}-${palette}.svg`, folder), drawing(build, palette, { W, H, title }));
    console.log(`examples/${name}-${palette}.svg`);
  }
