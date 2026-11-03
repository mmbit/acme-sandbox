// book-check.mjs's story of a sketch page as a canvas (shell/ink/sketchcanvas.js): a word written on the right of a
// sketch page stays where it was written as the notebook is made wider, narrower and turned, on an iPad mini with the
// Pencil and a finger on the book's edge, on a desktop with the mouse, and on a phone turned on its side. Narrower than
// the word reaches, the page pans sideways to it.
// And it zooms and pans as a near-endless canvas (bookview.js): on an iPad mini two fingers pinch it out and pan it past
// the first screen, the Pencil writes there, pinched in it writes big and sharp, a reload opens it where it was left and
// pinched out all of it shows; on a desktop a trackpad's pinch zooms about the pointer and the wheel takes it up and left
// of its origin, where the mouse draws.
import assert from 'node:assert/strict';
import { DESKTOP, MINI, UPRIGHT, until } from './kit.mjs';
import { mini } from './start.mjs';
import { freePage, onDesk } from './mouse.mjs';

const PHONE = { width: 390, height: 844 },
  PHONE_SIDEWAYS = { width: 844, height: 390 };

// c: book-check.mjs's { hqIn, base, notebook, pages, shot, settled, noErrorsIn }
export const canvasStories = c => ({
  'a sketch stays where it was drawn as the notebook is resized (iPad mini)': browser => onMini(browser, c),
  'a sketch stays where it was drawn as the notebook is resized (desktop)': browser => onDesktop(browser, c),
  'a sketch stays where it was drawn as the notebook is resized (phone)': browser => onPhone(browser, c),
  'a sketch page pinch-zooms and pans past its first screen, the Pencil writing there (iPad mini)': browser =>
    zoomedOnMini(browser, c),
  'a sketch page zooms by a trackpad and pans up and left of its origin, the mouse drawing there (desktop)': browser =>
    zoomedOnDesktop(browser, c),
});

async function zoomedOnMini(browser, c) {
  const sheet = freePage(c),
    s = await mini(browser, c, { viewport: MINI });
  try {
    const hands = handsOn(s, await s.page.locator('#book .bk-desk').boundingBox()),
      far = await writtenFarOut(s, c, sheet, hands);
    const big = await writtenBig(s, c, sheet, hands);
    await reopened(s, c, big);
    // pinched out as far as it goes: the first screen and both words show
    await hands.fingers(hands.apart(200), hands.apart(20));
    await hands.fingers(hands.apart(200), hands.apart(20));
    const all = await s.page.evaluate(inkBox);
    assert.ok(all?.seen && all.x1 >= far.x, `pinched out, everything drawn shows: ${JSON.stringify(all)}`);
    await c.shot('book-canvas-zoom-least', s.page);
    c.noErrorsIn(s.errors);
  } catch (e) {
    await c.shot('book-canvas-zoom-mini-failed', s.page);
    throw e;
  } finally {
    await s.done();
  }
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
// Pinched out to half, panned on right and down as far as two fingers take it, and the Pencil writing there: its
// unit's place, past the first screen
async function writtenFarOut(s, c, sheet, { paper, x, y, fingers, apart }) {
  await fingers(apart(160), apart(80));
  assert.ok(Math.abs((await viewNow(s.page)).s - 0.5) < 0.03, `pinched out to half: ${(await viewNow(s.page)).s}`);
  for (let k = 0; k < 2; k++)
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
  assert.ok(
    out.x + paper.width / out.s > 2 * paper.width && out.y + paper.height / out.s > 2 * paper.height,
    `panned on: the paper shows a screen past the first: ${JSON.stringify(out)}`,
  );
  await zigzag(points => s.pen.stroke(points), [x + 80, y], 1);
  const far = await savedUnit(c, sheet, 1);
  assert.ok(far.x > paper.width, `saved past the first screen: ${JSON.stringify(far)}`);
  await c.shot('book-canvas-zoom-out-written', s.page);
  return far;
}
// Pinched in to twice its size, the Pencil writing big there, drawn sharp at that zoom: the view and what's drawn
// (inkBox)
async function writtenBig(s, c, sheet, { x, y, fingers, apart }) {
  await fingers(apart(40), apart(160));
  assert.ok(Math.abs((await viewNow(s.page)).s - 2) < 0.1, `pinched in: ${(await viewNow(s.page)).s}`);
  await zigzag(points => s.pen.stroke(points), [x - 100, y + 120], 2);
  await savedUnit(c, sheet, 2);
  await s.page.waitForTimeout(800);
  const sharp = await s.page.evaluate(sharpness);
  assert.ok(sharp >= 0.95, `the ink drawn for the zoom: ${sharp}`);
  await c.shot('book-canvas-zoom-in-written', s.page);
  return { view: await viewNow(s.page), ink: await s.page.evaluate(inkBox) };
}
// Read again: the page where it was left, at its zoom, what's drawn near the paper's view where it was (zoomed in, a
// canvas holds a little past what shows)
async function reopened(s, c, before) {
  await s.page.reload();
  await s.page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
  await c.settled(s.page, 'open');
  await s.page.waitForTimeout(1500);
  const again = await viewNow(s.page),
    was = before.view;
  assert.ok(
    Math.abs(again.s - was.s) < 0.01 && Math.abs(again.x - was.x) <= 2 && Math.abs(again.y - was.y) <= 2,
    `opened where it was left: ${JSON.stringify({ was, again })}`,
  );
  const now = await s.page.evaluate(inkBox);
  await c.shot('book-canvas-mini-zoom-reloaded', s.page);
  for (const k of ['x0', 'y0', 'x1', 'y1'])
    assert.ok(
      Math.abs(now[k] - before.ink[k]) <= 2,
      `the words where they were written: ${JSON.stringify({ before, now })}`,
    );
}
async function zoomedOnDesktop(browser, c) {
  const sheet = freePage(c),
    s = await onDesk(browser, c, { viewport: DESKTOP }),
    cdp = await s.page.context().newCDPSession(s.page);
  try {
    const paper = await s.page.locator('#book .bk-desk').boundingBox(),
      at = [paper.x + paper.width / 2, paper.y + paper.height / 2],
      // (a trackpad's pinch: a wheel with Ctrl, no Ctrl key down)
      pinch = deltaY =>
        cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: at[0],
          y: at[1],
          deltaX: 0,
          deltaY,
          modifiers: 2,
        }),
      from = await viewNow(s.page),
      under = pointOn(from, paper, at);
    for (let k = 0; k < 6; k++) await pinch(-20);
    await s.page.waitForTimeout(800);
    const zoomed = await viewNow(s.page);
    assert.ok(zoomed.s > 1.5, `a trackpad's pinch zooms in: ${zoomed.s}`);
    const still = pointOn(zoomed, paper, at);
    assert.ok(
      Math.abs(still.x - under.x) < 1 && Math.abs(still.y - under.y) < 1,
      `about the pointer: ${JSON.stringify({ under, still })}`,
    );
    // the wheel takes it up and left of the page's origin, and the mouse draws there
    await s.page.mouse.move(...at);
    for (let k = 0; k < 4; k++) await s.page.mouse.wheel(-300, -300);
    await s.page.waitForTimeout(800);
    const v = await viewNow(s.page);
    assert.ok(v.x < -100 && v.y < -100, `panned up and left of the origin: ${JSON.stringify(v)}`);
    await zigzag(points => mouseStroke(s.page, points), [at[0] - 100, at[1]], 2);
    const unit = await savedUnit(c, sheet, 1);
    assert.ok(unit.x < 0 && unit.y < 0, `saved up and left of the origin, where it was drawn: ${JSON.stringify(unit)}`);
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
// The newest of a page's units once it has n with ink, as the store keeps it: its place, page px (x, y)
async function savedUnit(c, sheet, n) {
  const groups = () =>
    c.notebook.route('/api/notebooks/pages/groups', { page: sheet.id }).groups.filter(g => g.ink.length && g.place);
  await until(() => groups().length >= n, `${n} units saved`);
  return groups().sort((a, b) => b.id - a.id)[0].place;
}
// A point on the screen as the page's px, the view as it is
export const pointOn = (v, paper, [x, y]) => ({ x: v.x + (x - paper.x) / v.s, y: v.y + (y - paper.y) / v.s });

async function onMini(browser, c) {
  const sheet = freePage(c),
    s = await mini(browser, c, { viewport: MINI });
  try {
    const word = await written(s.page, c, sheet, 'mini', points => s.pen.stroke(points));
    await edgeBy(s.page, -300, s.touch);
    await stillAt(s.page, c, word, 'mini-wider');
    // (near as narrow as the book goes: the word past the paper's right side, the page panned to it with a finger)
    await edgeBy(s.page, 440, s.touch);
    await panTo(s.page, word, async (from, to) => s.touch.stroke([from], [to]));
    await stillAt(s.page, c, word, 'mini-narrowest');
    await s.page.setViewportSize(UPRIGHT);
    await c.settled(s.page, 'folded');
    await s.page.evaluate(() => document.querySelector('#book .bk-lip').click());
    await c.settled(s.page, 'spread');
    await stillAt(s.page, c, word, 'mini-upright');
    c.noErrorsIn(s.errors);
  } catch (e) {
    await c.shot('book-canvas-mini-failed', s.page);
    throw e;
  } finally {
    await s.done();
  }
}
async function onDesktop(browser, c) {
  const sheet = freePage(c),
    s = await onDesk(browser, c, { viewport: DESKTOP });
  try {
    const word = await written(s.page, c, sheet, 'desktop', points => mouseStroke(s.page, points));
    await edgeBy(s.page, -400);
    await stillAt(s.page, c, word, 'desktop-wider');
    await edgeBy(s.page, 800);
    await panTo(s.page, word, async (from, to) => {
      await s.page.mouse.move(...from);
      await s.page.mouse.wheel(from[0] - to[0], 0);
    });
    await stillAt(s.page, c, word, 'desktop-narrowest');
    c.noErrorsIn(s.errors);
  } catch (e) {
    await c.shot('book-canvas-desktop-failed', s.page);
    throw e;
  } finally {
    await s.done();
  }
}
async function onPhone(browser, c) {
  const sheet = freePage(c),
    s = await mini(browser, c, { viewport: PHONE });
  try {
    const word = await written(s.page, c, sheet, 'phone', points => s.pen.stroke(points));
    await s.page.setViewportSize(PHONE_SIDEWAYS);
    await s.page.waitForTimeout(1500);
    await stillAt(s.page, c, word, 'phone-sideways');
    await s.page.setViewportSize(PHONE);
    await s.page.waitForTimeout(1500);
    await stillAt(s.page, c, word, 'phone-upright');
    c.noErrorsIn(s.errors);
  } catch (e) {
    await c.shot('book-canvas-phone-failed', s.page);
    throw e;
  } finally {
    await s.done();
  }
}

// A word written on the right of the paper, clear of the rail, and saved: where its ink is on the page (its px)
async function written(page, c, sheet, device, stroke) {
  const paper = await page.locator('#book .bk-desk').boundingBox(),
    x = paper.x + paper.width - 200,
    y = paper.y + 220;
  // (four zigzag letters, each its own stroke, as a word is written)
  for (let k = 0; k < 4; k++)
    await stroke(Array.from({ length: 8 }, (_, i) => [x + k * 30 + i * 3, y + (i % 2 ? 24 : 0)]));
  await until(() => inkSaved(c, sheet) >= 4, 'the word saved');
  await page.waitForTimeout(1500);
  const word = await page.evaluate(inkBox);
  assert.ok(word && word.x1 - word.x0 > 80, `the word is drawn: ${JSON.stringify(word)}`);
  await c.shot(`book-canvas-${device}-written`, page);
  return word;
}
const inkSaved = (c, sheet) =>
  c.notebook.route('/api/notebooks/pages/groups', { page: sheet.id }).groups.reduce((n, g) => n + g.ink.length, 0);
// The word where it was on the page, within a pixel's rounding, after the notebook changed its size
async function stillAt(page, c, word, step) {
  await page.waitForTimeout(800);
  const now = await page.evaluate(inkBox);
  await c.shot(`book-canvas-${step}`, page);
  assert.ok(now?.seen, `the word shows on the paper (${step}): ${JSON.stringify(now)}`);
  for (const k of ['x0', 'y0', 'x1', 'y1'])
    // (in the page's own px, wherever the page is panned)
    assert.ok(
      Math.abs(now[k] - word[k]) <= 2,
      `the word where it was written (${step}): ${JSON.stringify({ word, now })}`,
    );
}
// The book's edge dragged by dx (+ narrower), a finger's or the mouse's
async function edgeBy(page, dx, touch) {
  // (above its pull tab, which sits at its middle and opens and closes the book)
  const edge = await page.locator('#book .bk-edge').boundingBox(),
    at = [edge.x + edge.width / 2, edge.y + edge.height * 0.25],
    to = [at[0] + dx, at[1]];
  if (touch) await touch.stroke([at], [to]);
  else {
    await page.mouse.move(...at);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(at[0] + (i * dx) / 20, at[1]);
    await page.mouse.up();
  }
  await page.waitForTimeout(1500);
}
// The page panned sideways (by pan(from, to): a finger's drag or the wheel) until the word is on the paper
async function panTo(page, word, pan) {
  const paper = await page.locator('#book .bk-desk').boundingBox(),
    shown = await page.evaluate(pageLeft),
    past = shown + word.x1 + 40 - (paper.x + paper.width - 90);
  if (past <= 0) return;
  const from = [paper.x + paper.width / 2, paper.y + paper.height - 120];
  await pan(from, [from[0] - past, from[1]]);
  await page.waitForTimeout(1200);
  assert.ok((await page.evaluate(pageLeft)) < shown - past / 2, 'the page panned sideways to the word');
}
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
  for (const cv of document.querySelectorAll('#book .bk-page:not([hidden]) canvas.bk-ink')) {
    const r = cv.getBoundingClientRect();
    if (r.width > 4) most = Math.max(most, cv.width / r.width);
  }
  return most;
}
// Where the shown page's left edge is on the screen
function pageLeft() {
  return document.querySelector('#book .bk-page:not([hidden])').getBoundingClientRect().left;
}
// The box round every inked pixel on the shown page's canvases, in the page's own px, and whether it's all on the
// book's paper in sight (seen). dark: the ink's dark pixels only, none of a scrap's paper or tape
export function inkBox(dark = false) {
  const view = document.querySelector('#book .bk-page:not([hidden])'),
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
