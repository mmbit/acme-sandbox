// book-check.mjs's story of the room below a page's last note (shell/ink/bookview.js): on a call's notes page full of
// scraps, at the board's iPad mini both ways and on a desktop, the page scrolled as far as it goes shows about a
// screen of empty page under the last note; its room is stretched far down into it and the board writes under it,
// and the page never scrolls by itself meanwhile
import assert from 'node:assert/strict';
import { DESKTOP, MINI, UPRIGHT, inkAt, penPans, strokes, unitOf, until } from './kit.mjs';
import { mini } from './start.mjs';
import { callSeed, fillCall } from './notespage.mjs';

// c: book-check.mjs's { hqIn, base, shot, settled, noErrorsIn }
export const roomBelowStories = c => ({
  'a page scrolls a screen past its last note, to stretch it and write under it (landscape)': browser =>
    roomBelow(browser, c, MINI, 'landscape'),
  'a page scrolls a screen past its last note, to stretch it and write under it (portrait)': browser =>
    roomBelow(browser, c, UPRIGHT, 'portrait'),
  'a page scrolls a screen past its last note, to stretch it and write under it (desktop)': browser =>
    roomBelow(browser, c, DESKTOP, 'desktop'),
});

async function roomBelow(browser, c, viewport, held) {
  const s = await mini(browser, c, { viewport, notebooks: callSeed(new Date().toISOString()) });
  try {
    await fillCall(s.page, s.page.context().notebook, viewport);
    await s.page.waitForFunction(() => document.querySelectorAll('[data-page="9101"] .bk-words').length === 12, null, {
      timeout: 30_000,
    });
    await s.page.waitForTimeout(1500);
    await toTheEnd(s, held);
    const paper = await s.page.locator('#book .bk-desk').boundingBox(),
      last = await s.page.evaluate(lastNote);
    // (most of a screen of empty page under it: all but the foot kept in sight at the top)
    assert.ok(
      paper.y + paper.height - (last.y + last.h) >= paper.height - 160,
      `a screen of page under the last note: ${JSON.stringify({ paper, last })}`,
    );
    assert.ok(last.y + last.h > paper.y, `the last note's foot still in sight: ${JSON.stringify({ paper, last })}`);
    await c.shot(`book-room-below-${held}-end`, s.page);
    await stretched(s, c, held, last, paper);
    await written(s, c, held, paper);
    c.noErrorsIn(s.errors);
  } catch (e) {
    await c.shot(`book-room-below-${held}-failed`, s.page);
    throw e;
  } finally {
    await s.done();
  }
}
// The page scrolled down as far as it goes: by a finger on the iPad, the wheel on a desktop, until it stops
async function toTheEnd({ page, touch }, held) {
  await penPans(page);
  const paper = await page.locator('#book .bk-desk').boundingBox();
  let was = null;
  for (let k = 0; k < 40; k++) {
    // (a finger on the paper itself, clear of the scraps and their words)
    const [x, y] = await page.evaluate(bare, paper);
    if (held === 'desktop') {
      await page.mouse.move(x, y);
      await page.mouse.wheel(0, 600);
    } else {
      await touch.down([[x, y]]);
      await touch.move([[x, y - paper.height * 0.4]], 8);
      await touch.up();
    }
    await page.waitForTimeout(1200);
    const now = await page.evaluate(pageTop);
    if (now === was) return;
    was = now;
  }
  assert.fail('the page stopped scrolling');
}
// The last note's room dragged far down by its handle into the page below it, the page held where it was
async function stretched({ page, pen }, c, held, last, paper) {
  assert.ok(last.handle, `the last note has a handle: ${JSON.stringify(last)}`);
  const top = await page.evaluate(pageTop),
    grip = [last.handle.x + last.handle.w / 2, last.handle.y + last.handle.h / 2],
    reach = Math.min(paper.y + paper.height - 120, grip[1] + 0.6 * paper.height) - grip[1];
  await pen.down(grip);
  for (let k = 1; k <= 20; k++) {
    await pen.move([grip[0], grip[1] + (k * reach) / 20]);
    assert.equal(await page.evaluate(pageTop), top, 'no scroll by itself while the note is stretched');
  }
  await pen.up([grip[0], grip[1] + reach]);
  await page.waitForTimeout(1500);
  const now = await page.evaluate(unitOf, last.g);
  assert.ok(now.h > last.h + reach - 60, `the note stretched as far: ${JSON.stringify({ last, now, reach })}`);
  assert.equal(await page.evaluate(pageTop), top, 'the page where it was once the note is stretched');
  await c.shot(`book-room-below-${held}-stretched`, page);
  // (and dragged back up, shorter than it was at first: the page still holds where it is, the handle let go too)
  const back = [grip[0], grip[1] + reach],
    to = Math.max(paper.y + 20, grip[1] - last.h / 2);
  await pen.down(back);
  for (let k = 1; k <= 20; k++) {
    await pen.move([back[0], back[1] + (k * (to - back[1])) / 20]);
    assert.equal(await page.evaluate(pageTop), top, 'no scroll by itself while the note is dragged back');
  }
  const short = await page.evaluate(unitOf, last.g);
  assert.ok(short.h < last.h, `dragged shorter than it was at first: ${JSON.stringify({ last, short })}`);
  await pen.up([back[0], to]);
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(pageTop), top, 'the page where it was once the shorter note is let go');
}
// A scribble under the stretched note, in the room still below it: drawn and kept, the page held where it was
async function written({ page, pen }, c, held, paper) {
  const top = await page.evaluate(pageTop),
    last = await page.evaluate(lastNote),
    y = (last.y + last.h + paper.y + paper.height) / 2,
    x = paper.x + paper.width / 2,
    had = strokes(page);
  assert.ok(paper.y + paper.height - (last.y + last.h) > 80, `page left under it: ${JSON.stringify({ paper, last })}`);
  await pen.stroke(Array.from({ length: 12 }, (_, k) => [x - 90 + k * 16, y + (k % 2 ? 18 : -18)]));
  await until(() => strokes(page) > had, 'the scribble saved');
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(pageTop), top, 'the page where it was as the board writes');
  const drawn = await page.evaluate(inkAt, { x: x - 100, y: y - 30, w: 200, h: 60 });
  assert.ok(drawn > 40, `the scribble drawn where it was written: ${drawn} px`);
  await c.shot(`book-room-below-${held}-written`, page);
}
// (each function below runs in the page, so it names what it reads itself)
// Where the call's page is on screen: its top, as the page scrolls
function pageTop() {
  return Math.round(
    document.querySelector('#book .bk-groups[data-page="9101"]').parentElement.getBoundingClientRect().top,
  );
}
// A point low on the paper (screen px) where nothing of the page's is but the paper
function bare(paper) {
  for (let y = paper.y + paper.height * 0.85; y > paper.y + paper.height * 0.5; y -= 20)
    for (let x = paper.x + 20; x < paper.x + paper.width - 20; x += 10) {
      const el = document.elementFromPoint(x, y);
      if (el?.matches('#book .bk-desk, #book .bk-page, #book .bk-world')) return [x, y];
    }
  throw new Error('no bare paper low on the screen');
}
// The page's note lowest down (screen px), and its room's handle
function lastNote() {
  const view = document.querySelector('#book .bk-groups[data-page="9101"]').parentElement,
    units = [...view.querySelectorAll('.bk-unit')],
    el = units.reduce((a, b) => (b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a)),
    r = el.getBoundingClientRect(),
    h = document.querySelector(`#book .bk-room-handle[data-unit="${el.dataset.unit}"]`)?.getBoundingClientRect();
  return {
    g: el.dataset.unit,
    x: r.left,
    y: r.top,
    w: r.width,
    h: r.height,
    handle: h && { x: h.left, y: h.top, w: h.width, h: h.height },
  };
}
