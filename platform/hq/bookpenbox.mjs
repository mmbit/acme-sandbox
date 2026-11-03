// node platform/hq/book-check.mjs --stories 'pen box' [--shots dir]   (desktop mouse and iPad mini Pencil)
// The pen's card offers the pen, the pencil, the brush and the marker, the pen's twelve colours and the marker's six
// (shell/ink/bookpalette.js): each nib and each of its colours picked from the card draws a line, saved as that ink
// (its colour, its width, the pencil's and the marker's see-through), drawn on the book's paper in its colour and in
// the agent's picture of the page (the coordinator's bookrender.ts) in the very same one. Each ink's card is shot with
// its colours and widths. Only the pen's own line is a gesture: the pencil's hatching stays ink. (the agent's picture
// and the cards' shots)
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { freePage, onDesk, paperBox, savedWhere } from './bookmouse.mjs';
import { DESKTOP, MINI, middleOf, mini, pressAlong } from './bookkit.mjs';
import { PENS } from '../../shared/review/ink.js';
import { MARKERS, MARKER_ALPHA, PENCIL_ALPHA, WIDTHS } from './shell/ink/bookinkmath.js';
import { render } from '../coordinator/src/ink/bookrender.ts';

const sharp = createRequire(new URL('../coordinator/', import.meta.url))('sharp');
// what each column draws with: its name on the card, its colours, its line's width (the middle one) and alpha
const INKS = [
  { name: 'Pen', colours: PENS, size: WIDTHS.pen[1] },
  { name: 'Pencil', colours: PENS, size: WIDTHS.pencil[1], alpha: PENCIL_ALPHA },
  { name: 'Brush', colours: PENS, size: WIDTHS.brush[1] },
  { name: 'Marker', colours: MARKERS, size: WIDTHS.highlighter[1], alpha: MARKER_ALPHA },
];
// the lines' grid on the paper (px from its left, under the words on the page): a row each ink, a column each colour,
// short lines
const LEFT = 40,
  ACROSS = 33,
  DOWN = 40,
  LONG = 14;

// What a story draws: [row, ink, its colours]. With a mouse every ink in every colour; on the iPad (a lighter run, for
// its memory) the pen's colours shared out among its nibs, every one drawn by one of them, and the marker in its six.
const NIB_COUNT = INKS.filter(ink => ink.colours === PENS).length,
  SHARE = Math.ceil(PENS.length / NIB_COUNT);
const plan = onIpad =>
  INKS.map((ink, row) => [
    row,
    ink,
    onIpad && ink.colours === PENS ? PENS.slice(row * SHARE, (row + 1) * SHARE) : ink.colours,
  ]);

export function penBoxStories(c) {
  return {
    "pen box: every nib and colour draws, saves and shows the same in the agent's picture, with a mouse": browser =>
      everyInk(browser, c, false),
    "pen box: every nib and colour draws, saves and shows the same in the agent's picture, with the Pencil on the iPad mini":
      browser => everyInk(browser, c, true),
    "pen box: the pencil's scribble stays ink, where the pen's scratches out": browser => scribbles(browser, c),
  };
}

async function everyInk(browser, c, onIpad) {
  const free = freePage(c),
    device = onIpad ? 'mini' : 'desktop';
  const opened = onIpad ? await mini(browser, c, { viewport: MINI }) : await onDesk(browser, c, { viewport: DESKTOP });
  const { page, errors, done } = opened;
  const tap = async locator => (onIpad ? opened.pen.tap(middleOf(await locator.boundingBox())) : locator.click());
  try {
    const paper = await paperBox(page),
      top = Math.max(await clearBelow(page), paper.y + 160) + DOWN,
      drawn = [];
    for (const [row, ink, colours] of plan(onIpad))
      for (const [col, colour] of colours.entries()) {
        await inkPicked(page, tap, ink, colour);
        const x = paper.x + LEFT + col * ACROSS,
          y = top + row * DOWN,
          points = [0, 0.5, 1].map(f => [x + f * LONG, y]);
        // (in one go in the page: on a loaded machine a mouse's moves come a second apart)
        await pressAlong(page, points, { type: onIpad ? 'pen' : 'mouse' });
        drawn.push({ ink, colour, at: [x + LONG / 2, y] });
        await savedWhere(c, free.id, p => p.ink.length === drawn.length);
      }
    await page.mouse.move(paper.x + 8, paper.y + 8);
    await page.waitForTimeout(c.settle);
    const saved = c.pages.find(p => p.id === free.id);
    assert.deepEqual(
      saved.ink.map(s => [s.color, s.size, s.alpha]),
      drawn.map(d => [d.colour.color, d.ink.size, d.ink.alpha]),
      'each line saved in its colour, width and alpha',
    );
    await c.shot(`book-penbox-${device}`, page);
    await sameInPicture(page, saved, drawn);
    // (each ink's card: the pen's twelve colours in two rows, each nib's and the marker's widths)
    for (const ink of INKS) {
      await card(page, tap);
      await pickInk(page, tap, ink.name);
      await card(page, tap);
      await c.shot(`book-penbox-${device}-card-${ink.name.toLowerCase()}`, page);
    }
    assert.deepEqual(errors, []);
  } finally {
    await done();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

// The book's paper and the agent's picture of the page: each line in the same colour on each
async function sameInPicture(page, saved, drawn) {
  const book = await pixels(await page.screenshot()),
    agent = await agentSees(saved);
  for (const [i, d] of drawn.entries()) {
    const mid = saved.ink[i].points[Math.floor(saved.ink[i].points.length / 2)],
      want = d.colour.color,
      onBook = deepest(book, d.at),
      onAgent = deepest(agent.img, [(mid[0] - agent.x) * agent.k, (mid[1] - agent.y) * agent.k]);
    const what = `${d.ink.name} in ${d.colour.name}`;
    same(onBook, blend(want, d.ink.alpha, onBook.paper), `${what} on the book's paper`);
    same(onAgent, blend(want, d.ink.alpha, onAgent.paper), `${what} in the agent's picture`);
  }
}

// A line with the pen, and the pencil scribbled back and forth over it, as a pen's scratch-out would be: both kept as
// ink (the pen's scratch-out deleting a line: booknotebook.mjs)
async function scribbles(browser, c) {
  const free = freePage(c);
  const { page, errors, done } = await onDesk(browser, c, { viewport: DESKTOP });
  const tap = locator => locator.click();
  try {
    const paper = await paperBox(page),
      x = paper.x + 40,
      y = paper.y + 640;
    await card(page, tap);
    await tap(item(page, 'Pen'));
    await page.keyboard.press('Escape');
    await pressAlong(
      page,
      [
        [x + 10, y + 12],
        [x + 110, y + 12],
      ],
      { type: 'mouse' },
    );
    await savedWhere(c, free.id, p => p.ink.length === 1);
    await card(page, tap);
    await tap(item(page, 'Pencil'));
    await page.keyboard.press('Escape');
    await pressAlong(
      page,
      Array.from({ length: 15 }, (_, i) => [x + (i % 2 ? 120 : 0), y + i * 2]),
      { type: 'mouse' },
    );
    const kept = await savedWhere(c, free.id, p => p.ink.length === 2);
    assert.deepEqual(
      kept.ink.map(s => s.alpha),
      [undefined, PENCIL_ALPHA],
      "the pen's line and the pencil's scribble over it both kept as ink",
    );
    assert.deepEqual(errors, []);
  } finally {
    await done();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

// The screen's y below the words typed on the page, clear for lines (below the page's head too: the caller)
const clearBelow = page =>
  page.evaluate(() =>
    Math.max(
      0,
      ...[...document.querySelectorAll('#book .bk-typed')]
        .map(el => el.getBoundingClientRect())
        .filter(r => r.width && r.top >= 0 && r.bottom <= innerHeight)
        .map(r => r.bottom),
    ),
  );

// The pen's card open (the pen's key on the tools, the pen's or the marker's: whichever is in hand), and it
const card = async (page, tap) => {
  const open = page.locator('#book .bk-palette');
  if (await open.isVisible()) return open;
  const ink = page.locator(
    "#book [data-island=tools] .bk-btn:is([data-mode='pen'], [data-mode='highlighter']):not([data-spare])",
  );
  await tap(ink);
  // (a tool not in hand picked by the first tap: the second opens its card)
  if (!(await open.isVisible())) await tap(ink);
  await open.waitFor();
  return open;
};
// An ink in a colour picked in the pen's card, the card put away after (it stays open for a width, and can hang over
// where the line goes, left of the tools)
async function inkPicked(page, tap, ink, colour) {
  await card(page, tap);
  await pickInk(page, tap, ink.name);
  // (the marker picked from the pen's card opens its own)
  if (!(await item(page, colour.name).isVisible())) await card(page, tap);
  await tap(item(page, colour.name));
  await page.keyboard.press('Escape');
  await page.locator('#book .bk-palette').waitFor({ state: 'detached' });
}
const item = (page, name) => page.locator('#book .bk-palette').getByRole('menuitemradio', { name, exact: true });
// An ink picked in the pen's card, its card open after (another tool's ink opens its own)
async function pickInk(page, tap, name) {
  if ((await item(page, name).getAttribute('aria-pressed')) !== 'true') await tap(item(page, name));
  assert.equal(await item(page, name).getAttribute('aria-pressed'), 'true', `${name}'s card open`);
}

// The agent's picture of the page: { img, x, y, k } (the page's top-left and the picture's px a page px)
async function agentSees(saved) {
  const x = saved.x ?? 0,
    y = saved.y ?? 0,
    drawn = { x, y, w: saved.w, h: saved.h, ink: saved.ink, scraps: [] };
  const png = await render(drawn, mkdtempSync(join(tmpdir(), 'penbox-'))),
    img = await pixels(png);
  return { img, x, y, k: img.info.width / saved.w };
}
const pixels = png => sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const rgb = ({ data, info }, x, y) => {
  const i = (Math.round(y) * info.width + Math.round(x)) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};
// The line's fullest colour across it at (x, y) (furthest from the paper), and the paper well above it: each the
// median of a short run along the line, so the paper's dots under a see-through ink never count
function deepest(img, [x, y]) {
  const run = dy => {
    const px = [-3, -2, -1, 0, 1, 2, 3].map(dx => rgb(img, x + dx, y + dy));
    return [0, 1, 2].map(i => px.map(p => p[i]).sort((a, b) => a - b)[3]);
  };
  const paper = run(-DOWN / 2);
  let ink = paper,
    far = -1;
  for (let dy = -5; dy <= 5; dy++) {
    const p = run(dy),
      d = Math.abs(p[0] - paper[0]) + Math.abs(p[1] - paper[1]) + Math.abs(p[2] - paper[2]);
    if (d > far) [ink, far] = [p, d];
  }
  return { ink, paper };
}
// a colour laid over the paper at its alpha
const blend = (hex, alpha = 1, paper) =>
  [1, 3, 5].map((at, i) => Math.round(parseInt(hex.slice(at, at + 2), 16) * alpha + paper[i] * (1 - alpha)));
// The line's colour is the one wanted: on the way from the paper to it, as far along in each channel (a thin line's
// fullest pixel is only partly covered), and most of the way there
function same({ ink, paper }, want, what) {
  const along = [0, 1, 2]
    .filter(i => Math.abs(want[i] - paper[i]) > 24)
    .map(i => (ink[i] - paper[i]) / (want[i] - paper[i]));
  const says = `${what}: rgb(${ink}) on rgb(${paper}) where rgb(${want}) was expected`;
  assert.ok(along.length && Math.min(...along) > 0.5 && Math.max(...along) < 1.15, says);
  assert.ok(Math.max(...along) - Math.min(...along) < 0.15, says);
}
