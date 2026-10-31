// book-check.mjs's story of the board's own drawing on a notebook page (shell/ink/bookunits.js): on My journal's blank
// page, the word WHY written with the pen and three rectangles pulled out, at a phone and an iPad mini both ways and a
// desktop. Each stays whole, as ink where it was drawn: no stroke cut off at a scrap's edge, none moved into another
// column, no paper scrap under any of it, and no arrows for stepping through scraps. Then the Asks tab, its chapter
// empty, opening its own empty page. Recorded with --shots.
import assert from 'node:assert/strict';
import { freePage } from './bookmouse.mjs';

// c: book-check.mjs's hqIn, base, pages, notebook, shot, noErrorsIn
export function drawnPageStories(c) {
  return {
    "the board's own drawing on a blank page: WHY and three rectangles whole, as ink where drawn, at five sizes":
      async browser => {
        const failed = [];
        for (const [name, size] of Object.entries(DRAWN_SIZES))
          await drawnAt(browser, c, name, size).catch(e => failed.push(e.message));
        assert.deepEqual(failed, [], failed.join('\n'));
      },
  };
}

// The five sizes the board's drawing is checked at: a phone and an iPad mini both ways, and a desktop beside HQ
const DRAWN_SIZES = {
  'phone-upright': { width: 390, height: 844 },
  'phone-sideways': { width: 844, height: 390 },
  'ipad-mini-upright': { width: 744, height: 1133 },
  'ipad-mini-sideways': { width: 1133, height: 744 },
  desktop: { width: 1920, height: 1080, book: 900 },
};
// On My journal's blank page, the word WHY written with the pen and three rectangles pulled out (one from its foot's
// right corner up): every corner of each rectangle and every end of the letters inked where it was drawn (nothing cut
// off, nothing moved), no paper scrap under any of it, and no arrows for stepping through scraps. Shot as drawn. Then
// the Asks tab, its chapter empty: its own empty page.
async function drawnAt(browser, c, name, size) {
  // (a blank page of its own at each size, not the one the size before drew on)
  freePage(c);
  const { context, page, errors } = await blankBook(browser, c, size);
  try {
    const { letters, rects } = await written(page);
    await page.waitForTimeout(900);
    await c.shot(`drawn-${name}`, page);
    const ends = [
      ...letters.flatMap(l => [l[0], l.at(-1)]),
      ...rects.flatMap(([[x0, y0], [x1, y1]]) => [
        [x0, y0],
        [x1, y0],
        [x0, y1],
        [x1, y1],
      ]),
    ];
    assert.deepEqual(await bareOf(page, ends), [], `${name}: every corner and letter's end inked where it was drawn`);
    const shown = await page.evaluate(() => ({
      scraps: document.querySelectorAll('#book .bk-page:not([hidden]) .bk-unit:not([data-drawing])').length,
      arrows: [...document.querySelectorAll('#book .bk-for-you-count')].some(e => e.checkVisibility()),
    }));
    assert.deepEqual(shown, { scraps: 0, arrows: false }, `${name}: no paper scrap under the drawing, no arrows`);
    // (Asks, a chapter with no pages yet: its own empty page, its tab lit)
    await page.locator('#book .bk-marks [data-chapter="asks"]').click();
    await page.waitForTimeout(500);
    await c.shot(`drawn-${name}-asks`, page);
    await page.locator('#book .bk-mk-blank').waitFor({ timeout: 3000 });
    assert.equal(await page.locator('#book .bk-marks [aria-current="page"]').getAttribute('data-chapter'), 'asks');
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot(`drawn-${name}-failed`, page);
    e.message = `${name}: ${e.message} (page errors: ${errors.join(' | ') || 'none'})`;
    throw e;
  } finally {
    await context.close();
  }
}
// HQ at a size with the book open on My journal's newest page, blank (a desktop's as wide as size.book)
async function blankBook(browser, c, size) {
  const { book, ...viewport } = size,
    context = await c.hqIn(browser, viewport, { hasTouch: false, isMobile: false });
  // (no microphone: on a loaded machine a stroke's first move can come after the hold, and the press held still is then
  // a voice note, as bookunitspage.mjs's)
  await context.addInitScript(() => (navigator.mediaDevices.enumerateDevices = async () => []));
  if (book)
    await context.addInitScript(
      w => localStorage.setItem('hq.book.wide', JSON.stringify({ mode: 'open', book: w })),
      book,
    );
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#book .bk-desk', { state: 'attached', timeout: 30_000 });
  await page.waitForFunction(
    () => document.documentElement.dataset.book && !document.querySelector('#book.bk-swinging'),
  );
  if ((await page.evaluate(() => document.documentElement.dataset.book)) === 'folded') {
    await page.locator('#book .bk-lip').click();
    // (and at rest: a stroke while it swings open is drawn on a page still moving in)
    await page.waitForFunction(
      () =>
        !['folded', 'shut'].includes(document.documentElement.dataset.book) &&
        !document.querySelector('#book.bk-swinging'),
    );
  }
  await page.waitForTimeout(600);
  return { context, page, errors };
}
// WHY in strokes as a hand writes it (W in one, H in three, Y in two), 40 px tall
const WHY = [
  [
    [0, 0],
    [10, 40],
    [20, 12],
    [30, 40],
    [40, 0],
  ],
  [
    [55, 0],
    [55, 40],
  ],
  [
    [85, 0],
    [85, 40],
  ],
  [
    [55, 20],
    [85, 20],
  ],
  [
    [100, 0],
    [115, 20],
    [130, 0],
  ],
  [
    [115, 20],
    [115, 40],
  ],
];
// WHY written with the pen and three rectangles pulled
// out under it, the second from its foot's right corner up: their points on screen
async function written(page) {
  const d = await page.locator('#book .bk-desk').boundingBox(),
    // (the room left of whatever controls stand at the paper's right)
    w = Math.min(d.width, 560) - 80,
    at = (fx, fy) => [d.x + 40 + fx * w, d.y + fy * d.height],
    k = Math.min(44, d.height * 0.1) / 40,
    [wx, wy] = at(0, 0.16);
  const letters = WHY.map(l => l.map(([x, y]) => [wx + x * k * 1.4, wy + y * k]));
  await page.keyboard.press('p');
  for (const l of letters) await stroke(page, l);
  await page.keyboard.press('s');
  await page.keyboard.press('r');
  const box = (fy, fw, back) => {
    const [x0, y0] = at(0, fy),
      x1 = x0 + w * fw,
      y1 = y0 + Math.min(80, d.height * 0.13);
    return back
      ? [
          [x1, y1],
          [x0, y0],
        ]
      : [
          [x0, y0],
          [x1, y1],
        ];
  };
  const rects = [box(0.34, 0.7), box(0.54, 0.9, true), box(0.74, 0.5)];
  for (const r of rects) await stroke(page, r);
  return { letters, rects };
}
// The points (CSS px) with no ink of the page's within 3 px of them
const bareOf = (page, points) =>
  page.evaluate(points => {
    const inked = ([x, y]) =>
      [...document.querySelectorAll('#book .bk-page:not([hidden]) canvas.bk-ink')].some(cv => {
        const r = cv.getBoundingClientRect();
        if (x < r.left - 3 || x > r.right + 3 || y < r.top - 3 || y > r.bottom + 3) return false;
        const sx = cv.width / r.width,
          [px, py, n] = [(x - r.left - 3) * sx, (y - r.top - 3) * sx, 6 * sx].map(Math.round);
        return cv
          .getContext('2d')
          .getImageData(px, py, n, n)
          .data.some((v, i) => i % 4 === 3 && v > 128);
      });
    return points.filter(p => !inked(p)).map(p => p.map(Math.round));
  }, points);
// A stroke with the mouse through points (CSS px), in small steps
async function stroke(page, points) {
  await page.mouse.move(...points[0]);
  await page.mouse.down();
  for (let k = 1; k < points.length; k++) {
    const [[x0, y0], [x1, y1]] = [points[k - 1], points[k]];
    for (let t = 1; t <= 6; t++) await page.mouse.move(x0 + ((x1 - x0) * t) / 6, y0 + ((y1 - y0) * t) / 6);
  }
  await page.mouse.up();
  await page.waitForTimeout(200);
}
