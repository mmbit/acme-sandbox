// book-check.mjs's story of every page pinch-zooming, a page of scraps too (shell/ink/bookview.js zoomOf; call 176:
// "my handwriting is a lot better if I can write big"): a call's notes page, its scraps across the paper's width, two
// fingers pinch it in, the Pencil writes big there and its ink lands where it was written, two fingers pan it across,
// a reload opens it as it was left, and pinched out it's back at the paper's width with the words where they were
// written; on an iPad mini and a phone, and on a desktop by a trackpad's pinch, the wheel and the mouse.
import assert from 'node:assert/strict';
import { DESKTOP, MINI, mini, until } from './bookkit.mjs';
import { callSeed } from './booknotespage.mjs';
import { handsOn, inkBox, mouseStroke, pointOn, viewNow, zigzag } from './bookcanvas.mjs';

const PHONE = { width: 390, height: 844 };
const CALL = 9101;
// the scraps' words, each its own note as a call's agent writes it
const NOTES = [
  'The shop sign: wood, hand-painted',
  'Which green for the door?',
  'Opening hours under the window',
  'A bench out front',
];
// how far the Pencil's ink may lie from where it was written (page px): its line's half, and a pixel's rounding
const NEAR = 6;

// c: book-check.mjs's { hqIn, base, shot, settled, noErrorsIn }
export const pinchStories = c => ({
  "every page pinch-zooms: a call's scraps use the width, and pinched in the Pencil writes big where it lands (iPad mini)":
    browser => byHand(browser, c, MINI, 'mini'),
  "every page pinch-zooms: a call's scraps use the width, and pinched in the Pencil writes big where it lands (phone)":
    browser => byHand(browser, c, PHONE, 'phone'),
  "every page pinch-zooms: a call's scraps zoom by a trackpad's pinch, pan by the wheel, the mouse drawing (desktop)":
    browser => byTrackpad(browser, c),
});

async function byHand(browser, c, viewport, device) {
  const s = await mini(browser, c, { viewport, notebooks: callSeed(new Date().toISOString()) });
  try {
    const fit = await notesOpen(s.page, c, device),
      hands = handsOn(s, await s.page.locator('#book .bk-desk').boundingBox()),
      { x, y, fingers, apart } = hands;
    await fingers(apart(40), apart(120));
    const zoomed = await viewNow(s.page);
    assert.ok(zoomed.s > 2.4 * fit.s, `pinched in: ${fit.s} to ${zoomed.s}`);
    const word = await writtenAt(s.page, c, `${device}-big`, zoomed, points => s.pen.stroke(points), [x - 30, y]);
    // two fingers take it across, to the scraps' right
    await fingers(
      [
        [x - 40, y],
        [x + 40, y],
      ],
      [
        [x - 140, y],
        [x - 60, y],
      ],
    );
    const across = await viewNow(s.page);
    assert.ok(across.x > zoomed.x + 20 / zoomed.s, `panned across: ${JSON.stringify({ zoomed, across })}`);
    if (device === 'mini') await reopened(s.page, c, across);
    await fingers(apart(160), apart(20));
    await fingers(apart(160), apart(20));
    const out = await viewNow(s.page);
    assert.ok(
      Math.abs(out.s - fit.s) < 0.01 && out.x === 0,
      `pinched out to the width: ${JSON.stringify({ fit, out })}`,
    );
    await stillWritten(s.page, c, word, `${device}-out`);
    c.noErrorsIn(s.errors);
  } catch (e) {
    await c.shot(`book-pinch-${device}-failed`, s.page);
    throw e;
  } finally {
    await s.done();
  }
}
async function byTrackpad(browser, c) {
  const s = await mini(browser, c, {
    viewport: DESKTOP,
    hasTouch: false,
    notebooks: callSeed(new Date().toISOString()),
  });
  try {
    const fit = await notesOpen(s.page, c, 'desktop'),
      { zoomed, at, pinch } = await trackpadIn(s.page, fit),
      word = await writtenAt(s.page, c, 'desktop-big', zoomed, points => mouseStroke(s.page, points), [
        at[0] - 100,
        at[1],
      ]);
    await s.page.mouse.move(...at);
    await s.page.mouse.wheel(200, 0);
    await s.page.waitForTimeout(800);
    const across = await viewNow(s.page);
    assert.ok(across.x > zoomed.x + 20 / zoomed.s, `the wheel takes it across: ${JSON.stringify({ zoomed, across })}`);
    for (let k = 0; k < 12; k++) await pinch(40);
    await s.page.waitForTimeout(800);
    const out = await viewNow(s.page);
    assert.ok(
      Math.abs(out.s - fit.s) < 0.01 && out.x === 0,
      `pinched out to the width: ${JSON.stringify({ fit, out })}`,
    );
    await stillWritten(s.page, c, word, 'desktop-out');
    c.noErrorsIn(s.errors);
  } catch (e) {
    await c.shot('book-pinch-desktop-failed', s.page);
    throw e;
  } finally {
    await s.done();
  }
}
// A trackpad's pinch in at the paper's middle (a wheel with Ctrl, no Ctrl key down), about the pointer. → the view,
// the pointer, and the pinch (pinch(deltaY))
async function trackpadIn(page, fit) {
  const cdp = await page.context().newCDPSession(page),
    paper = await page.locator('#book .bk-desk').boundingBox(),
    at = [paper.x + paper.width / 2, paper.y + paper.height / 2],
    pinch = deltaY =>
      cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at[0], y: at[1], deltaX: 0, deltaY, modifiers: 2 }),
    under = pointOn(fit, paper, at);
  for (let k = 0; k < 6; k++) await pinch(-20);
  await page.waitForTimeout(800);
  const zoomed = await viewNow(page),
    still = pointOn(zoomed, paper, at);
  assert.ok(zoomed.s > 2 * fit.s, `a trackpad's pinch zooms in: ${fit.s} to ${zoomed.s}`);
  assert.ok(
    Math.abs(still.x - under.x) < 1 && Math.abs(still.y - under.y) < 1,
    `about the pointer: ${JSON.stringify({ under, still })}`,
  );
  return { zoomed, at, pinch };
}

// The call's notes put on its page as its agent does, the page laid: its scraps reach across the paper, side to side
// as the masonry's margins leave it (never a narrow column in the middle of wide paper), at its fit. → the view
async function notesOpen(page, c, device) {
  const play = page.context().notebook;
  for (const text of NOTES) play.note(CALL, 'lyra', { texts: [{ x: 12, y: 12, w: 296, color: '#1d1a2f', text }] });
  await page.waitForFunction(
    n => document.querySelectorAll('#book .bk-page:not([hidden]) .bk-unit').length === n,
    NOTES.length,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(1500);
  await c.shot(`book-pinch-${device}-fit`, page);
  const sides = await page.evaluate(() => {
    const desk = document.querySelector('#book .bk-desk').getBoundingClientRect(),
      units = [...document.querySelectorAll('#book .bk-page:not([hidden]) .bk-unit')].map(u =>
        u.getBoundingClientRect(),
      );
    return {
      left: Math.min(...units.map(r => r.left)) - Math.max(0, desk.left),
      right: Math.min(innerWidth, desk.right) - Math.max(...units.map(r => r.right)),
    };
  });
  assert.ok(sides.left < 48 && sides.right < 48, `the scraps across the paper's width: ${JSON.stringify(sides)}`);
  return viewNow(page);
}
// A zigzag word twice the size written from a point on the screen, the view as it is: where its ink is on the page
// (inkBox), where it was written
async function writtenAt(page, c, step, view, stroke, from) {
  const paper = await page.locator('#book .bk-desk').boundingBox(),
    before = await page.evaluate(inkBox, true),
    drawn = [];
  await zigzag(points => (drawn.push(...points), stroke(points)), from, 2);
  await until(() => strokesOn(page) >= 4, `the word's four strokes saved (${strokesOn(page)})`);
  await page.waitForTimeout(1500);
  const word = await page.evaluate(inkBox, true),
    at = drawn.map(p => pointOn(view, paper, p)),
    wrote = {
      x0: Math.min(...at.map(p => p.x)),
      y0: Math.min(...at.map(p => p.y)),
      x1: Math.max(...at.map(p => p.x)),
      y1: Math.max(...at.map(p => p.y)),
    };
  await c.shot(`book-pinch-${step}`, page);
  assert.equal(before, null, 'no ink on the page before the word');
  for (const k of ['x0', 'y0', 'x1', 'y1'])
    assert.ok(Math.abs(word[k] - wrote[k]) <= NEAR, `the ink where it was written: ${JSON.stringify({ wrote, word })}`);
  return word;
}
// Read again: the page where it was left, at its zoom
async function reopened(page, c, was) {
  await page.reload();
  await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
  await c.settled(page, 'open');
  await page.waitForTimeout(1500);
  const again = await viewNow(page);
  assert.ok(
    Math.abs(again.s - was.s) < 0.01 && Math.abs(again.x - was.x) <= 2 && Math.abs(again.y - was.y) <= 2,
    `opened where it was left: ${JSON.stringify({ was, again })}`,
  );
}
// The word where it was on the page, and on the paper
async function stillWritten(page, c, word, step) {
  const now = await page.evaluate(inkBox, true);
  await c.shot(`book-pinch-${step}`, page);
  assert.ok(now?.seen, `the word shows on the paper (${step}): ${JSON.stringify(now)}`);
  for (const k of ['x0', 'y0', 'x1', 'y1'])
    assert.ok(
      Math.abs(now[k] - word[k]) <= 2,
      `the word where it was written (${step}): ${JSON.stringify({ word, now })}`,
    );
}
// How many strokes the call's page has in the store
const strokesOn = page =>
  page
    .context()
    .notebook.route('/api/notebooks/pages/groups', { page: CALL })
    .groups.reduce((n, g) => n + g.ink.length, 0);
