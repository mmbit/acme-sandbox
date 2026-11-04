// book-check.mjs's story of the page to every edge (the Ink README, "The book's frame"; shell/ink/bookdesk.css,
// bookview.js, bookrow.js), at realbook.mjs's sizes with their blur: an iPhone upright and an iPad on its side. On a
// sketch page:
//   - every point of the paper is the page's but where a control is, so a pen's line starts and is drawn in the blur's
//     strip at the top, beside the tools' island up to the screen's right edge, and under the bar;
//   - the page is one surface: zoomed out, the strip under the blur is the page whose dots zoom with it;
//   - the page's corner is its top-left: on a fresh page, panned as far up and left as it goes, at any zoom, the
//     page's corner stays at the paper's left, set down just below the blur, where the view's title lies;
//   - what's drawn above the corner stays in reach: panned up, the line drawn in the blur's strip comes below the
//     blur, the page's corner lower.
// Recorded with --shots.
import assert from 'node:assert/strict';
import { inkAt, middleOf, pressAlong, toChapter, until } from './kit.mjs';
import { SIZES, opened } from './realbook.mjs';
import { islandsSeen } from './islands.mjs';

// how near (screen px) a place counts as there
const NEAR = 1.5;

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn
export function edgeStories(c) {
  return {
    'the page to every edge on an iPhone: drawn on under the blur, beside the tools and under the bar, one zooming surface, its corner the top-left':
      browser => edges(browser, c, 'iphone'),
    'the page to every edge on an iPad on its side: drawn on under the blur, beside the tools and under the bar, one zooming surface, its corner the top-left':
      browser => edges(browser, c, 'ipad'),
  };
}

async function edges(browser, c, name) {
  const size = SIZES[name],
    { context, p, errors } = await opened(browser, c, name, size);
  try {
    await toChapter(p, 'sketch');
    await until(() => p.evaluate(cornerShown), `${name}: the sketch page`);
    await p.waitForFunction(() => !document.querySelector('#book .bk-turn-picture, #book .bk-turn-leaf'));
    const missed = await p.evaluate(notPage);
    assert.deepEqual(missed, [], `${name}: every point of the paper is the page's or a control's`);
    await corner(p, name, size);
    await drawnToEdges(p, name, size);
    await c.shot(`edges-${name}-drawn`, p);
    await oneSurface(p, name, size);
    await c.shot(`edges-${name}-zoomed`, p);
    await aboveInReach(p, name, size);
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot(`edges-${name}-failed`, p);
    throw e;
  } finally {
    await context.close();
  }
}

// A pen's lines started in the blur's strip, beside the tools (where the page used to end) and over to the screen's
// right edge, and under the bar: each is ink on the page where it was drawn
async function drawnToEdges(p, name, { width, height, sat = 0 }) {
  const { tools, bar, desk } = await islandsSeen(p),
    lines = {
      "the blur's strip": [
        [desk.left + 40, sat / 2],
        [desk.left + 200, sat / 2],
      ],
      'beside the tools': [
        [tools.left - 5, tools.top + 10],
        [tools.left - 5, tools.bottom - 10],
      ],
      "over the tools to the screen's edge": [
        [tools.left - 5, tools.top - 24],
        [width - 2, tools.top - 24],
      ],
      'under the bar': [
        [bar.left + 30, (bar.bottom + height) / 2],
        [bar.left + 160, (bar.bottom + height) / 2],
      ],
    };
  for (const [where, points] of Object.entries(lines)) {
    const [[x0, y0], [x1, y1]] = points,
      box = { x: Math.min(x0, x1) - 3, y: Math.min(y0, y1) - 3, w: Math.abs(x1 - x0) + 6, h: Math.abs(y1 - y0) + 6 };
    await pressAlong(p, points);
    await until(async () => (await p.evaluate(inkAt, box)) > 0, `${name}: a line drawn ${where}`, 10_000);
  }
}

// Zoomed out about the page's middle (a trackpad's pinch), the strip under the blur is the page, its dots drawn to the zoom
async function oneSurface(p, name, { sat = 0 }) {
  await wheel(p, await middleOfPage(p), { deltaY: 240, ctrlKey: true });
  const seen = await p.evaluate(surfaceAt, Math.max(1, sat / 2));
  assert.ok(seen.page, `${name}: the strip under the blur is the page (${seen.under})`);
  assert.ok(seen.scale < 0.95, `${name}: the page zoomed out (${seen.scale})`);
  assert.ok(Math.abs(seen.dots - 22 * seen.scale) < 0.01, `${name}: the dots there zoom with it (${seen.dots} px)`);
}

// Panned as far up and left as it goes, zoomed out, then in: the page's corner at the paper's left, set down just below
// the blur, every time
async function corner(p, name, { sat = 0 }) {
  const middle = await middleOfPage(p);
  for (const [zoom, deltaY] of [
    ['as it is', 0],
    ['zoomed out', 400],
    ['zoomed in', -900],
  ]) {
    if (deltaY) await wheel(p, middle, { deltaY, ctrlKey: true });
    await wheel(p, middle, { deltaX: -3000, deltaY: -3000 });
    const { left, top, paper } = await p.evaluate(cornerShown);
    assert.ok(Math.abs(left - paper) <= NEAR, `${name}, ${zoom}: the corner at the paper's left (${left}, ${paper})`);
    assert.ok(Math.abs(top - sat) <= NEAR, `${name}, ${zoom}: the corner set down below the blur (${top}, ${sat})`);
  }
}

// Drawn on above the page's corner (the blur's strip), panned as far up as it goes: the corner lies lower than a fresh
// page's, the line above it in sight below the blur
async function aboveInReach(p, name, { sat = 0 }) {
  await wheel(p, await middleOfPage(p), { deltaX: -3000, deltaY: -3000 });
  const { top } = await p.evaluate(cornerShown);
  assert.ok(
    top > sat + NEAR,
    `${name}: what's drawn above the corner in reach (the corner at ${top}, a fresh page's ${sat})`,
  );
}

// The middle of the page drawn on (beside HQ's page on an iPad on its side)
const middleOfPage = async p => middleOf(await p.locator('#book .bk-desk').boundingBox());
// A wheel at a point on the screen (with ctrlKey: a trackpad's pinch), as the browser sends it to what's there
const wheel = (p, [x, y], more) =>
  p.evaluate(
    ({ x, y, more }) =>
      document
        .elementFromPoint(x, y)
        .dispatchEvent(new WheelEvent('wheel', { clientX: x, clientY: y, bubbles: true, cancelable: true, ...more })),
    { x, y, more },
  );

// (each function below runs in the page, with page.evaluate, so it names what it reads itself.)
// The shown page's corner, its 0,0: where it is on the screen, and the paper's left; null before it shows
function cornerShown() {
  const shown = document.querySelector('#book .bk-page:not([hidden])'),
    desk = document.querySelector('#book .bk-desk');
  if (!shown?.getBoundingClientRect().width) return null;
  const r = shown.getBoundingClientRect();
  return { left: r.left, top: r.top, paper: desk.getBoundingClientRect().left };
}
// Every 8 px of the book's paper that isn't the page or a control: an island, a bookmark, the pull tab, the cover's
// edge, the open asks' counter (a few, for the message)
function notPage() {
  const paper = document.querySelector('#book .bk-paper').getBoundingClientRect(),
    missed = [];
  for (let y = 0; y < paper.bottom && missed.length < 6; y += 8)
    for (let x = Math.max(0, paper.left); x < Math.min(innerWidth, paper.right) && missed.length < 6; x += 8) {
      const el = document.elementFromPoint(x, y);
      if (!el?.closest('#book :is(.bk-desk, .bk-strip, .bk-bar, .bk-marks, .bk-lip, .bk-edge, .bk-for-you-count)'))
        missed.push(`${x},${y}: ${el?.className || el?.tagName}`);
    }
  return missed;
}
// What's a third of the way across the book's paper, y px down: whether it's the page, what it is, the page's zoom,
// and how far apart its dots are there
function surfaceAt(y) {
  const paper = document.querySelector('#book .bk-paper').getBoundingClientRect(),
    el = document.elementFromPoint(paper.left + paper.width / 3, y),
    desk = el?.closest('#book .bk-desk');
  return {
    page: !!desk,
    under: el?.className || el?.tagName,
    scale: parseFloat(desk?.style.getPropertyValue('--bk-scale')) || 1,
    dots: desk && parseFloat(getComputedStyle(desk).backgroundSize),
  };
}
