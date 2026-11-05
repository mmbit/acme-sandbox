// book-check.mjs's story of every page pinch-zooming, a page of scraps too (shell/ink/bookview.js zoomOf): a call's
// notes page, its scraps at the paper's left at their own size, as many columns as it holds (masonry.js MOST), two
// fingers pinch it in and pan it across, and there the Pencil's tap opens the scrap under it (the grid takes no ink:
// it's drawn on an opened scrap, canvas.mjs); put back, the grid is as it was left, a reload opens it so, and pinched
// out it's back at the paper's width with every card where it was; on an iPad mini and a phone, and on a desktop by a
// trackpad's pinch, the wheel and the mouse's click.
import assert from 'node:assert/strict';
import { DESKTOP, MINI, closeScrap, openScrap } from './kit.mjs';
import { mini } from './start.mjs';
import { hands } from './hands.mjs';
import { callSeed } from './notespage.mjs';
import { handsOn, pointOn, viewNow } from './canvas.mjs';
import { anotherColumn } from './unitsread.mjs';

const PHONE = { width: 390, height: 844 };
const CALL = 9101;
// the scraps' words, each its own note as a call's agent writes it
const NOTES = [
  'The shop sign: wood, hand-painted',
  'Which green for the door?',
  'Opening hours under the window',
  'A bench out front',
];

// c: book-check.mjs's { hqIn, base, shot, settled, noErrorsIn }
export const pinchStories = c => ({
  "every page pinch-zooms: a call's scraps use the width, and pinched in the Pencil's tap opens the scrap under it (iPad mini)":
    browser => byHand(browser, c, MINI, 'mini'),
  "every page pinch-zooms: a call's scraps use the width, and pinched in the Pencil's tap opens the scrap under it (phone)":
    browser => byHand(browser, c, PHONE, 'phone'),
  "every page pinch-zooms: a call's scraps zoom by a trackpad's pinch, pan by the wheel, the mouse's click opening one (desktop)":
    browser => byTrackpad(browser, c),
});

async function byHand(browser, c, viewport, device) {
  const s = await mini(browser, c, { viewport, notebooks: callSeed(new Date().toISOString()) });
  try {
    const fit = await notesOpen(s.page, c, device),
      cards = await cardsNow(s.page),
      hands = handsOn(s, await s.page.locator('#book .bk-desk').boundingBox()),
      { x, y, fingers, apart } = hands;
    await fingers(apart(40), apart(120));
    const zoomed = await viewNow(s.page);
    assert.ok(zoomed.s > 2.4 * fit.s, `pinched in: ${fit.s} to ${zoomed.s}`);
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
    await opensThere(s.page, c, `${device}-big`, s.pen, across);
    if (device === 'mini') await reopened(s.page, c, across);
    await fingers(apart(160), apart(20));
    await fingers(apart(160), apart(20));
    await backToFit(s.page, c, device, fit, cards);
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
      cards = await cardsNow(s.page),
      { zoomed, at, pinch } = await trackpadIn(s.page, fit);
    await s.page.mouse.move(...at);
    await s.page.mouse.wheel(200, 0);
    await s.page.waitForTimeout(800);
    const across = await viewNow(s.page);
    assert.ok(across.x > zoomed.x + 20 / zoomed.s, `the wheel takes it across: ${JSON.stringify({ zoomed, across })}`);
    await opensThere(s.page, c, 'desktop-big', { tap: ([x, y]) => s.page.mouse.click(x, y) }, across);
    await s.page.mouse.move(...at);
    for (let k = 0; k < 12; k++) await pinch(40);
    await s.page.waitForTimeout(800);
    await backToFit(s.page, c, 'desktop', fit, cards);
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
  const { trackpadPinch } = await hands(page),
    paper = await page.locator('#book .bk-desk').boundingBox(),
    at = [paper.x + paper.width / 2, paper.y + paper.height / 2],
    pinch = deltaY => trackpadPinch(at, deltaY),
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
  // (at their own size at the paper's left, the rest paper: no room right of them for another column at LEAST of its
  // size.)
  assert.ok(
    sides.left < 48 && sides.right < anotherColumn(sides.left),
    `the scraps at the paper's left, as many columns as it holds: ${JSON.stringify(sides)}`,
  );
  return viewNow(page);
}
// Zoomed in (view), a card tapped where it shows on the paper (pen.tap) opens that scrap, the one under the tap; put
// back, the grid is as it was left, at its zoom
async function opensThere(page, c, step, pen, view) {
  const card = await cardInSight(page);
  assert.ok(card, 'a card shows on the paper, zoomed in');
  const opened = await openScrap(page, pen, undefined, card.at);
  assert.equal(opened.gid, card.gid, 'the scrap tapped opened');
  await c.shot(`book-pinch-${step}`, page);
  await closeScrap(page, pen);
  const back = await viewNow(page);
  assert.ok(
    Math.abs(back.s - view.s) < 0.01 && Math.abs(back.x - view.x) <= 1 && Math.abs(back.y - view.y) <= 1,
    `put back, the grid as it was left: ${JSON.stringify({ view, back })}`,
  );
}
// A card on the page shown as far as it shows on the paper, clear of its edges, the tools at its right and the bar at
// its foot: its group and the middle of what of it shows there ({ gid, at }), or null
const cardInSight = page =>
  page.evaluate(() => {
    const desk = document.querySelector('#book .bk-desk').getBoundingClientRect(),
      area = {
        left: Math.max(0, desk.left) + 24,
        right: Math.min(innerWidth, desk.right) - 90,
        top: desk.top + 90,
        bottom: desk.bottom - 130,
      };
    for (const u of document.querySelectorAll('#book .bk-page:not([hidden]) .bk-unit')) {
      const r = u.getBoundingClientRect(),
        [x0, x1] = [Math.max(r.left, area.left), Math.min(r.right, area.right)],
        [y0, y1] = [Math.max(r.top, area.top), Math.min(r.bottom, area.bottom)],
        at = [(x0 + x1) / 2, (y0 + y1) / 2],
        hit = document.elementFromPoint(...at);
      if (x1 - x0 > 40 && y1 - y0 > 40 && hit?.closest('#book .bk-desk') && !hit.closest('button'))
        return { gid: Number(u.dataset.unit), at };
    }
    return null;
  });
// The cards on the page shown, where they are on the screen, by group
const cardsNow = page =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('#book .bk-page:not([hidden]) .bk-unit')].map(u => {
        const r = u.getBoundingClientRect();
        return [u.dataset.unit, [r.left, r.top, r.width, r.height].map(Math.round)];
      }),
    ),
  );
// Pinched out: back at its fit, the paper's width, and every card where it was there
async function backToFit(page, c, device, fit, cards) {
  const out = await viewNow(page);
  assert.ok(Math.abs(out.s - fit.s) < 0.01 && out.x === 0, `pinched out to the width: ${JSON.stringify({ fit, out })}`);
  await c.shot(`book-pinch-${device}-out`, page);
  const now = await cardsNow(page);
  for (const [g, r] of Object.entries(cards))
    assert.ok(
      now[g]?.every((v, i) => Math.abs(v - r[i]) <= 2),
      `card ${g} where it was at the fit: ${JSON.stringify({ was: r, now: now[g] })}`,
    );
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
