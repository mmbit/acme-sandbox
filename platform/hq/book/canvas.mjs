// book-check.mjs's story of an opened scrap as an endless canvas (bookscrapopen.js, bookview.js): on an iPad mini a
// new scrap opened by the Pencil's tap on a blank page, two fingers pinch it out to half and pan it on down and right
// past its first screen, the Pencil writes there and it's saved in that scrap where it was written, pinched in it writes
// big and sharp, and pinched out all of it shows; put back with Klaar, its card shows it, and opened again it has all
// of it where it was drawn. On a desktop, in a scrap opened by a click, a trackpad's pinch zooms about the pointer, the
// wheel pans it any way, up and left of where it opened too, and the mouse draws there.
// On an iPad mini upright, a scrap drawn on from corner to corner of its first screen pinches out far past it: all of it
// small in the middle of fresh paper, the Pencil writing beside it, two fingers panning, and pinched back in.
import assert from 'node:assert/strict';
import { DESKTOP, MINI, UPRIGHT, closeScrap, openScrap, until } from './kit.mjs';
import { mini } from './start.mjs';
import { hands } from './hands.mjs';
import { freePage, onDesk } from './mouse.mjs';

// c: book-check.mjs's { hqIn, base, notebook, pages, shot, settled, noErrorsIn }
export const canvasStories = c => ({
  'an opened scrap pinch-zooms and pans past its first screen, the Pencil writing there (iPad mini)': browser =>
    zoomedOnMini(browser, c),
  'an opened scrap zooms by a trackpad about the pointer and pans any way by the wheel, the mouse drawing there (desktop)':
    browser => zoomedOnDesktop(browser, c),
  'an opened scrap pinches out far past its first screen, all of it small in fresh paper, the Pencil writing beside it (iPad mini upright)':
    browser => farOutOnMini(browser, c),
});

async function zoomedOnMini(browser, c) {
  const sheet = freePage(c),
    s = await mini(browser, c, { viewport: MINI });
  try {
    const desk = await s.page.locator('#book .bk-desk').boundingBox(),
      { gid, sheet: box } = await openScrap(s.page, s.pen, undefined, [desk.x + 120, desk.y + 200]),
      hands = handsOn(s, box),
      far = await writtenFarOut(s, c, sheet, gid, hands);
    await writtenBig(s, c, sheet, gid, hands);
    // pinched out till everything drawn shows (its lines still a pixel wide or more, to be seen)
    let all = null;
    for (let k = 0; k < 6 && !(all?.seen && all.x1 >= far.x); k++) {
      await hands.fingers(hands.apart(200), hands.apart(120));
      all = await s.page.evaluate(inkBox);
    }
    assert.ok(all?.seen && all.x1 >= far.x, `pinched out, everything drawn shows: ${JSON.stringify({ all, far })}`);
    await c.shot('book-canvas-zoom-least', s.page);
    await closeScrap(s.page, s.pen);
    const card = s.page.locator(`#book .bk-unit[data-unit="${gid}"]`);
    await card.waitFor();
    await c.shot('book-canvas-zoom-card', s.page);
    await openScrap(s.page, s.pen, gid);
    const again = await s.page.evaluate(inkBox);
    // (all of it, where it was drawn, as near as its canvas's px pinched out show it: it opens at a zoom of 1 at least,
    // so a drawing this far out runs past the paper.)
    assert.ok(
      again && ['x0', 'y0', 'x1', 'y1'].every(k => Math.abs(again[k] - all[k]) <= 6),
      `opened again, what's on it shows where it was drawn: ${JSON.stringify({ all, again })}`,
    );
    c.noErrorsIn(s.errors);
  } catch (e) {
    await c.shot('book-canvas-zoom-mini-failed', s.page);
    throw e;
  } finally {
    await s.done();
  }
}
async function farOutOnMini(browser, c) {
  const sheet = freePage(c),
    s = await mini(browser, c, { viewport: UPRIGHT });
  try {
    const desk = await s.page.locator('#book .bk-desk').boundingBox(),
      { gid, sheet: box } = await openScrap(s.page, s.pen, undefined, [desk.x + 120, desk.y + 200]),
      hands = handsOn(s, box),
      first = await viewNow(s.page);
    await inCorners(s, c, sheet, gid, { box, desk, first });
    // pinched out again and again, as far as it goes
    for (let k = 0; k < 6; k++) await hands.fingers(hands.apart(220), hands.apart(30));
    const out = await viewNow(s.page);
    // (to an eighth at least)
    assert.ok(out.s <= 1 / 8 && first.s / out.s >= 8, `pinched out far: ${JSON.stringify({ first, out })}`);
    // all of it on the sheet, a small part of its width and height, fresh paper round it (where its strokes are: a
    // thin line this far out is fainter than inkBox reads)
    const on = onScreen(drawnBox(c, sheet, gid), out, desk);
    assert.ok(
      on.x0 > box.x && on.y0 > box.y && on.x1 < box.x + box.width && on.y1 < box.y + box.height,
      `pinched out, all of it on the sheet: ${JSON.stringify({ box, on })}`,
    );
    assert.ok(
      on.x1 - on.x0 < box.width / 4 && on.y1 - on.y0 < box.height / 4,
      `pinched out, all of it small: ${JSON.stringify({ box, on })}`,
    );
    await c.shot('book-canvas-far-out', s.page);
    await workedFarOut(s, c, sheet, gid, { box, out, hands });
    c.noErrorsIn(s.errors);
  } catch (e) {
    await c.shot('book-canvas-far-failed', s.page);
    throw e;
  } finally {
    await s.done();
  }
}
// A word in each corner of the sheet's first screen (box), clear of its keys and the tools, each saved where it was
// written: what's on it spans it
async function inCorners(s, c, sheet, gid, { box, desk, first }) {
  const corners = [
    [box.x + 40, box.y + 90],
    [box.x + box.width - 260, box.y + 90],
    [box.x + 40, box.y + box.height - 80],
    [box.x + box.width - 260, box.y + box.height - 80],
  ];
  for (const at of corners) {
    await zigzag(points => s.pen.stroke(points), at, 1);
    await savedNear(c, sheet, gid, pointOn(first, desk, at), `the word at ${at}`);
  }
  await c.shot('book-canvas-far-drawn', s.page);
}
// Pinched out (the view out): the Pencil writes in the fresh paper beside what's drawn, saved in the scrap where it was
// written, two fingers pan it, and a pinch brings it back in
async function workedFarOut(s, c, sheet, gid, { box, out, hands }) {
  const beside = [box.x + 60, box.y + box.height - 140],
    far = pointOn(out, await s.page.locator('#book .bk-desk').boundingBox(), beside);
  await zigzag(points => s.pen.stroke(points), beside, 1);
  await savedNear(c, sheet, gid, far, 'the word beside it, pinched out');
  await hands.fingers(
    [
      [hands.x - 40, hands.y],
      [hands.x + 40, hands.y],
    ],
    [
      [hands.x - 40, hands.y - 150],
      [hands.x + 40, hands.y - 150],
    ],
  );
  const panned = await viewNow(s.page);
  assert.ok(panned.y !== out.y && panned.s === out.s, `panned: ${JSON.stringify({ out, panned })}`);
  await hands.fingers(hands.apart(30), hands.apart(220));
  const back = await viewNow(s.page);
  assert.ok(back.s / out.s > 5, `pinched back in: ${JSON.stringify({ out, back })}`);
  await c.shot('book-canvas-far-back', s.page);
}
// Two fingers on the paper round its middle (x, y): fingers(from, to) held still before the lift (no glide), apart(d)
// one d above it and one below
export function handsOn(s, paper) {
  const [x, y] = [paper.x + paper.width / 2 - 60, paper.y + paper.height / 2];
  const fingers = async (from, to) => {
    await s.touch.down(from);
    await s.touch.move(to);
    await s.page.waitForTimeout(200);
    await s.touch.up();
    await s.page.waitForTimeout(800);
  };
  const apart = d => [
    [x, y - d],
    [x, y + d],
  ];
  return { paper, x, y, fingers, apart };
}
// Pinched out to half, then panned on down and right with two fingers as far as it goes (half a screen past what's on
// it: bookrow.js scrapPans) and the Pencil writing in the fresh paper there, again and again, each word taking the
// paper on further, till it's written a screen past where it opened: each saved in the scrap where it was written (its
// own px). Where the last was written.
async function writtenFarOut(s, c, sheet, gid, { paper, x, y, fingers, apart }) {
  const first = await viewNow(s.page);
  await fingers(apart(160), apart(80));
  const half = await viewNow(s.page);
  assert.ok(Math.abs(half.s / first.s - 0.5) < 0.05, `pinched out to half: ${JSON.stringify({ first, half })}`);
  const past = p => p && p.x > first.x + paper.width / first.s && p.y > first.y + paper.height / first.s,
    // (the word from the paper's middle, a quarter of it down: in the fresh paper past what's on it)
    at = [x + 60, y + paper.height / 4];
  let far = null,
    was = half;
  for (let round = 0; round < 5 && !past(far); round++) {
    for (let k = 0; k < 4; k++)
      await fingers(
        [
          [x - 40, y],
          [x + 40, y],
        ],
        [
          [x - 340, y - 250],
          [x - 260, y - 250],
        ],
      );
    const out = await viewNow(s.page);
    // (on down and right, as far as the last word took the paper: one way at least)
    assert.ok(
      out.x >= was.x && out.y >= was.y && (out.x > was.x || out.y > was.y),
      `panned on past what's on it: ${JSON.stringify({ was, out })}`,
    );
    was = out;
    far = pointOn(out, await s.page.locator('#book .bk-desk').boundingBox(), at);
    await zigzag(points => s.pen.stroke(points), at, 1);
    await savedNear(c, sheet, gid, far, `the word written in round ${round + 1}`);
  }
  assert.ok(past(far), `written past the first screen: ${JSON.stringify({ first, far })}`);
  await c.shot('book-canvas-zoom-out-written', s.page);
  return far;
}
// Pinched in to four times that, the Pencil writing big there, drawn sharp at that zoom
async function writtenBig(s, c, sheet, gid, { x, y, fingers, apart }) {
  const was = await viewNow(s.page);
  await fingers(apart(40), apart(160));
  const now = await viewNow(s.page);
  assert.ok(Math.abs(now.s / was.s - 4) < 0.3, `pinched in: ${JSON.stringify({ was, now })}`);
  const desk = await s.page.locator('#book .bk-desk').boundingBox(),
    at = [x - 100, y + 120];
  await zigzag(points => s.pen.stroke(points), at, 2);
  await savedNear(c, sheet, gid, pointOn(now, desk, at), 'the big word');
  await s.page.waitForTimeout(800);
  const sharp = await s.page.evaluate(sharpness);
  assert.ok(sharp >= 0.95, `the ink drawn for the zoom: ${sharp}`);
  await c.shot('book-canvas-zoom-in-written', s.page);
}
async function zoomedOnDesktop(browser, c) {
  const sheet = freePage(c),
    s = await onDesk(browser, c, { viewport: DESKTOP }),
    { trackpadPinch } = await hands(s.page),
    mouse = { tap: ([x, y]) => s.page.mouse.click(x, y) };
  try {
    const desk = await s.page.locator('#book .bk-desk').boundingBox(),
      { gid, sheet: box } = await openScrap(s.page, mouse, undefined, [desk.x + 120, desk.y + 200]),
      at = [box.x + box.width / 2, box.y + box.height / 2],
      pinch = deltaY => trackpadPinch(at, deltaY),
      from = await viewNow(s.page),
      under = pointOn(from, desk, at);
    for (let k = 0; k < 6; k++) await pinch(-20);
    await s.page.waitForTimeout(800);
    const zoomed = await viewNow(s.page);
    assert.ok(zoomed.s > from.s * 1.5, `a trackpad's pinch zooms in: ${JSON.stringify({ from, zoomed })}`);
    const still = pointOn(zoomed, desk, at);
    assert.ok(
      Math.abs(still.x - under.x) < 1 && Math.abs(still.y - under.y) < 1,
      `about the pointer: ${JSON.stringify({ under, still })}`,
    );
    // the wheel pans it any way: up and left of where it opened, then down and right, and the mouse draws there
    await s.page.mouse.move(...at);
    for (let k = 0; k < 4; k++) await s.page.mouse.wheel(-300, -300);
    await s.page.waitForTimeout(800);
    const up = await viewNow(s.page);
    assert.ok(up.x < zoomed.x - 100 && up.y < zoomed.y - 100, `panned up and left: ${JSON.stringify({ zoomed, up })}`);
    for (let k = 0; k < 8; k++) await s.page.mouse.wheel(300, 300);
    await s.page.waitForTimeout(800);
    const v = await viewNow(s.page);
    assert.ok(v.x > up.x + 100 && v.y > up.y + 100, `panned down and right: ${JSON.stringify({ up, v })}`);
    const word = [at[0] - 100, at[1]];
    await zigzag(points => mouseStroke(s.page, points), word, 2);
    await savedNear(c, sheet, gid, pointOn(v, desk, word), 'the word drawn down and right');
    await c.shot('book-canvas-zoom-desktop', s.page);
    c.noErrorsIn(s.errors);
  } catch (e) {
    await c.shot('book-canvas-zoom-desktop-failed', s.page);
    throw e;
  } finally {
    await s.done();
  }
}
// A zigzag word of four letters from a point on the screen, its letters k times the size
export async function zigzag(stroke, [x, y], k) {
  for (let l = 0; l < 4; l++)
    await stroke(Array.from({ length: 8 }, (_, i) => [x + k * (l * 30 + i * 3), y + k * (i % 2 ? 24 : 0)]));
}
// The box round the strokes saved in the opened scrap gid on the page sheet, in its px
function drawnBox(c, sheet, gid) {
  const points = c.notebook
    .route('/api/notebooks/pages/groups', { page: sheet.id })
    .groups.filter(g => g.id === gid)
    .flatMap(g => g.ink.flatMap(k => k.points));
  const xs = points.map(p => p[0]),
    ys = points.map(p => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
// A box in the page's px on the screen, the view v as it is, the paper at its box
const onScreen = (b, v, paper) => ({
  x0: paper.x + (b.x0 - v.x) * v.s,
  y0: paper.y + (b.y0 - v.y) * v.s,
  x1: paper.x + (b.x1 - v.x) * v.s,
  y1: paper.y + (b.y1 - v.y) * v.s,
});
// A word's first point (page px, at) saved in the opened scrap gid on the page sheet: a stroke starting within 6 px of it
async function savedNear(c, sheet, gid, at, what) {
  const starts = () =>
    c.notebook
      .route('/api/notebooks/pages/groups', { page: sheet.id })
      .groups.filter(g => g.id === gid)
      .flatMap(g => g.ink.map(k => k.points[0]));
  await until(
    () => starts().some(([x, y]) => Math.hypot(x - at.x, y - at.y) <= 6),
    () => `${what} saved in scrap ${gid} where it was written (${JSON.stringify(at)}: ${JSON.stringify(starts())})`,
  );
}
// A point on the screen as the page's px, the view as it is
export const pointOn = (v, paper, [x, y]) => ({ x: v.x + (x - paper.x) / v.s, y: v.y + (y - paper.y) / v.s });

export async function mouseStroke(page, points) {
  await page.mouse.move(...points[0]);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(...p);
  await page.mouse.up();
}

// (each function below runs in the page, so it names what it reads itself)
// The view: the page's point at the paper's top-left (x, y) and its zoom (s), as the paper draws it
export const viewNow = page =>
  page.evaluate(() => {
    const t = document.querySelector('#book .bk-world').style.transform,
      [, tx, ty] = t.match(/translate3d\((-?[\d.e-]+)px, (-?[\d.e-]+)px/),
      s = +t.match(/scale\(([\d.e-]+)\)/)[1];
    return { x: -tx / s, y: -ty / s, s };
  });
// How many canvas px the ink is drawn at a screen px (at 1x, 1 is sharp; drawn for no zoom, it'd be 1 / the zoom), at most
// of the page's canvases that show any
function sharpness() {
  let most = 0;
  const view =
    document.querySelector('#book .bk-page[data-focus]') ?? document.querySelector('#book .bk-page:not([hidden])');
  for (const cv of view.querySelectorAll('canvas.bk-ink')) {
    const r = cv.getBoundingClientRect();
    if (r.width > 4) most = Math.max(most, cv.width / r.width);
  }
  return most;
}
// The box round every inked pixel on the shown page's canvases, in the page's own px, and whether it's all on the
// book's paper in sight (seen). dark: the ink's dark pixels only, none of a scrap's paper or tape
export function inkBox(dark = false) {
  // (an opened scrap's page, the grid's parked under it)
  const view =
      document.querySelector('#book .bk-page[data-focus]') ?? document.querySelector('#book .bk-page:not([hidden])'),
    desk = document.querySelector('#book .bk-desk').getBoundingClientRect(),
    paper = {
      left: Math.max(0, desk.left),
      top: desk.top,
      right: Math.min(innerWidth, desk.right),
      bottom: desk.bottom,
    },
    o = view.getBoundingClientRect(),
    k = o.width / view.offsetWidth;
  let box = null;
  for (const cv of view.querySelectorAll('canvas.bk-ink')) {
    if (!cv.width || !cv.height) continue;
    const r = cv.getBoundingClientRect(),
      s = cv.width / r.width,
      { data } = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 128 || (dark && data[i - 3] + data[i - 2] + data[i - 1] > 300)) continue;
      const p = (i - 3) / 4,
        x = (r.left + (p % cv.width) / s - o.left) / k,
        y = (r.top + Math.floor(p / cv.width) / s - o.top) / k;
      box = box
        ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) }
        : { x0: x, y0: y, x1: x, y1: y };
    }
  }
  if (!box) return null;
  const on = { x0: o.left + box.x0 * k, y0: o.top + box.y0 * k, x1: o.left + box.x1 * k, y1: o.top + box.y1 * k },
    seen = on.x0 >= paper.left && on.x1 <= paper.right && on.y0 >= paper.top && on.y1 <= paper.bottom;
  return { ...Object.fromEntries(Object.entries(box).map(([key, v]) => [key, Math.round(v)])), seen };
}
