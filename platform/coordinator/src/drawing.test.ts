// node --test src/drawing.test.ts
// An agent's drawing with its words fitted to their shapes (drawing.ts, drawingfit.ts): a word wider than its box ends
// up inside it, a long sentence wraps beside a sketch, a drawing that fits is left as drawn, and words drawn over each
// other are named for the agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { playwright } from '../../../shared/browser/browser.mjs';
import type { Drawn } from './drawing.ts';

// (the platform's plain look, whichever company's look the repo has: a repo with no theme/hq.yaml)
const repo = mkdtempSync(join(tmpdir(), 'drawing-'));
process.env.REPO_DIR = repo;
process.env.DATA_DIR = `${repo}/.data`;
const { drawn } = await import('./drawing.ts');
test.after(() => rmSync(repo, { recursive: true, force: true }));

// (as pagecheck.test.ts: Playwright's Chromium, or the tests helper's headless shell)
process.env.CHROMIUM_PATH ??= process.env.BROWSER_HEADLESS_SHELL ?? playwright().chromium.executablePath();

const drawing = async (svg: string) => {
  const got = await drawn(svg);
  assert.ok(!Array.isArray(got), `drawn: ${JSON.stringify(got)}`);
  return got as Drawn;
};

// Whether any of a picture's pixels between two columns and two rows (fractions of its width and height) has ink
async function inked(png: Buffer, [left, right]: number[], [top, bottom]: number[]) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let y = Math.round(top * info.height); y < bottom * info.height; y++)
    for (let x = Math.round(left * info.width); x < right * info.width; x++)
      if (data[(y * info.width + x) * 4 + 3] > 40) return true;
  return false;
}

// The runs of inked columns across a picture's row (a fraction of its height) and a few px round it, [from, to] in px
async function inkRuns(png: Buffer, row: number) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = Math.round(row * info.height);
  const runs: [number, number][] = [];
  for (let x = 0; x < info.width; x++) {
    let ink = false;
    for (let y = at - 3; y <= at + 3 && !ink; y++) ink = data[(y * info.width + x) * 4 + 3] > 40;
    if (!ink) continue;
    if (runs.length && runs.at(-1)![1] === x - 1) runs.at(-1)![1] = x;
    else runs.push([x, x]);
  }
  return runs;
}

test('a word wider than its box is fitted inside it: across its middle the outermost ink is the box', async () => {
  const got = await drawing(
    '<svg viewBox="0 0 640 200"><rect x="260" y="60" width="120" height="60"/>' +
      '<text x="320" y="100" text-anchor="middle">Management</text></svg>',
  );
  assert.deepEqual(got.overlap, []);
  assert.equal(got.fitted.length, 1);
  assert.match(got.fitted[0], /^"Management" \(.+\)$/);
  // (the box's middle, 90 of the viewBox's 200 down past the frame's 16 px padding: a 3 px line, then room, the
  // word, room and the line again, however the box was fitted)
  const runs = await inkRuns(got.png, (16 + 90) / 232);
  const line = (3 * got.width) / 672 + 2;
  assert.ok(runs.length >= 3, JSON.stringify(runs));
  assert.ok(runs[0][1] - runs[0][0] <= line && runs.at(-1)![1] - runs.at(-1)![0] <= line, JSON.stringify(runs));
  assert.ok(runs[1][0] - runs[0][1] > 4 && runs.at(-1)![0] - runs.at(-2)![1] > 4, JSON.stringify(runs));
});

test('a sentence beside a sketch wraps before it reaches the sketch, inside the picture', async () => {
  const got = await drawing(
    '<svg viewBox="0 0 640 300"><rect x="400" y="30" width="200" height="140"/><circle cx="500" cy="100" r="30"/>' +
      '<text x="20" y="60">Sam wants the price seen first, so it moves up next to the photo, as big as the title.</text>' +
      '</svg>',
  );
  assert.deepEqual(got.overlap, []);
  assert.match(got.fitted[0], /^"Sam wants .+" \(on [3-9] lines\)$/);
  // (the box at 400-600 of 640 across: the words stay left of it)
  assert.equal(await inked(got.png, [(16 + 320) / 672, (16 + 397) / 672], [0, 1]), true, 'words up to the box');
  assert.equal(await inked(got.png, [(16 + 406) / 672, (16 + 594) / 672], [(16 + 36) / 332, (16 + 60) / 332]), false);
  assert.ok(Math.abs(got.width / got.height - 672 / 332) < 0.01, "the picture's size as drawn");
});

test('a drawing whose words fit is left as drawn, and words drawn over each other are named', async () => {
  const fits = await drawing(
    '<svg viewBox="0 0 640 200"><rect x="40" y="40" width="300" height="80"/>' +
      '<text x="190" y="90" text-anchor="middle">Fits</text><ellipse cx="500" cy="100" rx="120" ry="60"/>' +
      '<text x="500" y="110" text-anchor="middle">Poster</text></svg>',
  );
  assert.deepEqual([fits.fitted, fits.overlap], [[], []]);
  const over = await drawing(
    '<svg viewBox="0 0 640 200"><text x="40" y="100">Kaart</text><text x="60" y="110">Overlap</text></svg>',
  );
  assert.deepEqual(over.overlap, ['"Kaart" and "Overlap"']);
});
