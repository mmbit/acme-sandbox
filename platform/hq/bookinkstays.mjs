// book-check.mjs's story of the board's ink staying where it drew it on a call's notes page (shell/ink/bookunits.js), by
// hand on its iPad at 1133 × 744 and 744 × 1133 with Chromium's own pen and touch: a circle drawn beside a scrap stays
// put as the scrap's room to write is dragged taller and as writing past its foot grows it; a scribble started over a
// scrap and across it lands on it, every scrap where it was; one finger, then two, scroll the page and nothing on it
// moves, the scribble drawn all the while.
import assert from 'node:assert/strict';
import { MINI, UPRIGHT, mini, strokes, unitOf, until } from './bookkit.mjs';
import { callSeed, fillCall } from './booknotespage.mjs';

// c: book-check.mjs's { hqIn, base, shot, settled, noErrorsIn }
export const inkStaysStories = c => ({
  "ink on a call's notes page stays where the board drew it, and the page holds still as it scrolls (landscape)":
    browser => stays(browser, c, MINI, 'landscape'),
  "ink on a call's notes page stays where the board drew it, and the page holds still as it scrolls (portrait)":
    browser => stays(browser, c, UPRIGHT, 'portrait'),
});

async function stays(browser, c, viewport, held) {
  const s = await mini(browser, c, { viewport, notebooks: callSeed(new Date().toISOString()) });
  try {
    await fillCall(s.page, s.page.context().notebook, viewport, { tall: true });
    await s.page.waitForFunction(() => document.querySelectorAll('[data-page="9101"] .bk-words').length === 13, null, {
      timeout: 30_000,
    });
    // (sideways, the Notebook beside HQ's page dragged wider by its edge with a finger, as the board did)
    if (held === 'landscape') await wider(s);
    await s.page.waitForTimeout(1500);
    await beside(s, c, held);
    const scribble = await across(s, c, held);
    await scrolled(s, c, held, scribble);
    c.noErrorsIn(s.errors);
  } catch (e) {
    await c.shot(`book-ink-stays-${held}-failed`, s.page);
    throw e;
  } finally {
    await s.done();
  }
}
async function wider({ page, touch }) {
  const edge = await page.locator('#book .bk-edge').boundingBox(),
    at = [edge.x + edge.width / 2, edge.y + edge.height / 2];
  await touch.down([at]);
  await touch.move([[at[0] - 320, at[1]]], 24);
  await touch.up();
}
// A circle drawn in the space beside a scrap, round its foot, started under it (the board's, call 174): it stays put as
// the room is dragged taller, and as the board writes past the room's foot
async function beside({ page, pen }, c, held) {
  const { card, room } = await page.evaluate(roomBeside);
  assert.ok(room, `a scrap with room beside it in sight: ${JSON.stringify(card)}`);
  const r = Math.min(room.w / 2 - 3, 24),
    [cx, cy] = [room.x + room.w / 2, card.y + card.h - r / 2],
    had = strokes(page);
  await pen.stroke(
    Array.from({ length: 25 }, (_, k) => [
      cx + r * Math.sin((k / 12) * Math.PI),
      cy + r * Math.cos((k / 12) * Math.PI),
    ]),
  );
  await until(() => strokes(page) > had, 'the circle saved');
  await page.waitForTimeout(800);
  const clip = await page.evaluate(onPage, { x: cx - r - 4, y: cy - r - 4, w: 2 * r + 8, h: 2 * r + 8 }),
    drawn = await page.evaluate(inkIn, clip),
    before = await page.evaluate(unitOf, card.g);
  assert.ok(drawn.n > 20, `the circle is drawn: ${JSON.stringify(drawn)}`);
  // (its room dragged taller by its handle)
  const handle = await page.locator(`#book .bk-room-handle[data-unit="${card.g}"]`).boundingBox(),
    grip = [handle.x + handle.width / 2, handle.y + handle.height / 2];
  await pen.down(grip);
  for (let k = 1; k <= 10; k++) await pen.move([grip[0], grip[1] + k * 12]);
  await pen.up([grip[0], grip[1] + 120]);
  await page.waitForTimeout(1500);
  const taller = await page.evaluate(unitOf, card.g),
    refused = await page.locator('#book .bk-page:not([hidden]) .bk-refusal').textContent();
  assert.ok(taller.h > before.h + 60, `the room dragged taller: ${JSON.stringify([before, taller, refused])}`);
  stillAt(await page.evaluate(inkIn, clip), drawn, 'as its room is dragged taller');
  await c.shot(`book-ink-stays-${held}-dragged`, page);
  // (written in, past its foot)
  const foot = taller.y + taller.h;
  await pen.stroke([
    [taller.x + 40, foot - 30],
    [taller.x + 120, foot + 20],
    [taller.x + 200, foot + 60],
  ]);
  await page.waitForTimeout(1500);
  const grown = await page.evaluate(unitOf, card.g);
  assert.ok(grown.h > taller.h + 40, `the room grew to hold the writing: ${JSON.stringify([taller, grown])}`);
  stillAt(await page.evaluate(inkIn, clip), drawn, 'as writing past its foot grows its room');
}
// A scribble started in the space over a scrap and drawn across it: it's the scrap's, and no scrap moves
async function across({ page, pen }, c, held) {
  const target = await page.evaluate(cardUnder);
  assert.ok(target, 'a scrap in sight with one over it');
  const before = await page.evaluate(cardsOnPage);
  await pen.stroke([
    [target.x + 40, target.y - 10],
    [target.x + 90, target.y + 30],
    [target.x + 140, target.y + 6],
    [target.x + 200, target.y + 40],
  ]);
  await page.waitForTimeout(2000);
  await c.shot(`book-ink-stays-${held}-across`, page);
  const after = await page.evaluate(cardsOnPage);
  for (const [g, was] of Object.entries(before))
    assert.deepEqual([after[g]?.x, after[g]?.y], [was.x, was.y], `scrap #${g} where it was`);
  const clip = await page.evaluate(onPage, { x: target.x + 36, y: target.y - 14, w: 168, h: 58 }),
    drawn = await page.evaluate(inkIn, clip);
  assert.ok(drawn.n > 20, `the scribble is drawn: ${JSON.stringify(drawn)}`);
  return { clip, drawn };
}
// One finger, then two, scroll the page down and back: nothing on it moves on the page, and the scribble shows at
// every step
async function scrolled({ page, touch }, c, held, scribble) {
  const cards = await page.evaluate(cardsOnPage),
    paper = await page.locator('#book .bk-desk').boundingBox(),
    [x, y] = [paper.x + paper.width / 2, paper.y + paper.height / 2],
    check = async when => {
      const now = await page.evaluate(cardsOnPage);
      for (const [g, was] of Object.entries(cards))
        assert.deepEqual([now[g]?.x, now[g]?.y], [was.x, was.y], `${when}: scrap #${g} where it was on the page`);
      stillAt(await page.evaluate(inkIn, scribble.clip), scribble.drawn, `${when}: the scribble`);
    };
  for (const [fingers, when] of [
    [[[x, y]], 'one finger'],
    [
      [
        [x - 40, y],
        [x + 40, y],
      ],
      'two fingers',
    ],
  ]) {
    await touch.down(fingers);
    for (const dy of [-60, -120, -180, -120, -60, 0]) {
      await touch.move(
        fingers.map(([fx, fy]) => [fx, fy + dy]),
        4,
      );
      await check(`${when} scrolling`);
    }
    await touch.up();
    await page.waitForTimeout(800);
    await check(`${when} scrolled`);
  }
  await c.shot(`book-ink-stays-${held}-scrolled`, page);
}

// The ink seen in a box of the page (its px, onPage) as now drawn on the page's canvases: how many pixels and where
// their middle is on the page
function stillAt(now, was, when) {
  assert.ok(now.n >= was.n * 0.9, `${when}: still drawn: ${JSON.stringify([was, now])}`);
  assert.ok(
    Math.abs(now.x - was.x) <= 1 && Math.abs(now.y - was.y) <= 1,
    `${when}: where it was drawn: ${JSON.stringify([was, now])}`,
  );
}

// (each function below runs in the page, so it names what it reads itself)
// A box on the screen in the call page's own px: from the page's corner, at its scale
function onPage(box) {
  const view = document.querySelector('#book .bk-groups[data-page="9101"]').parentElement,
    r = view.getBoundingClientRect(),
    s = r.width / view.offsetWidth || 1;
  return { x: (box.x - r.left) / s, y: (box.y - r.top) / s, w: box.w / s, h: box.h / s };
}
// How much ink the page's canvases show in a box of its px, and its middle there
function inkIn(box) {
  const view = document.querySelector('#book .bk-groups[data-page="9101"]').parentElement;
  let n = 0,
    sx = 0,
    sy = 0;
  for (const cv of view.querySelectorAll('canvas.bk-ink')) {
    const [left, top] = [parseFloat(cv.style.left), parseFloat(cv.style.top)],
      k = cv.width / parseFloat(cv.style.width),
      x0 = Math.max(box.x, left),
      y0 = Math.max(box.y, top),
      x1 = Math.min(box.x + box.w, left + parseFloat(cv.style.width)),
      y1 = Math.min(box.y + box.h, top + parseFloat(cv.style.height));
    if (x1 - x0 < 1 || y1 - y0 < 1) continue;
    const { data, width } = cv
      .getContext('2d')
      .getImageData(
        Math.floor((x0 - left) * k),
        Math.floor((y0 - top) * k),
        Math.ceil((x1 - x0) * k),
        Math.ceil((y1 - y0) * k),
      );
    for (let i = 3; i < data.length; i += 4)
      if (data[i] > 128) {
        const p = (i - 3) / 4;
        n++;
        sx += x0 + (p % width) / k;
        sy += y0 + Math.floor(p / width) / k;
      }
  }
  return { n, x: n && Math.round(sx / n), y: n && Math.round(sy / n) };
}
// The page's scraps (cards, not the board's drawings) in the page's px, by unit id
function cardsOnPage() {
  const view = document.querySelector('#book .bk-groups[data-page="9101"]').parentElement;
  return Object.fromEntries(
    [...view.querySelectorAll('.bk-unit:not([data-drawing])')].map(el => [
      el.dataset.unit,
      { x: el.offsetLeft, y: el.offsetTop, h: el.offsetHeight },
    ]),
  );
}
// A scrap whose room and handle are in sight, and the widest space beside its room clear of other scraps and of the
// paper's edges (screen px), at least 24 px wide
function roomBeside() {
  const view = document.querySelector('#book .bk-groups[data-page="9101"]').parentElement,
    paper = document.querySelector('#book .bk-desk').getBoundingClientRect(),
    cards = [...view.querySelectorAll('.bk-unit:not([data-drawing])')].map(el => {
      const r = el.getBoundingClientRect();
      return { g: el.dataset.unit, x: r.left, y: r.top, w: r.width, h: r.height, room: el.querySelector('.bk-room') };
    });
  let best = { card: null, room: null };
  for (const card of cards) {
    const handle = document.querySelector(`#book .bk-room-handle[data-unit="${card.g}"]`)?.getBoundingClientRect();
    if (!card.room || !handle || handle.top < paper.top + 40 || handle.bottom > paper.bottom - 160) continue;
    const room = card.room.getBoundingClientRect(),
      [y0, y1] = [Math.max(room.top, paper.top + 20), Math.min(room.bottom, paper.bottom - 20)];
    if (y1 - y0 < 40) continue;
    const others = cards.filter(o => o !== card && o.y < y1 && o.y + o.h > y0),
      left = Math.max(paper.left + 30, ...others.filter(o => o.x < card.x).map(o => o.x + o.w)),
      right = Math.min(paper.right - 30, ...others.filter(o => o.x > card.x).map(o => o.x)),
      sides = [
        { x: left + 2, w: card.x - left - 4 },
        { x: card.x + card.w + 2, w: right - card.x - card.w - 4 },
      ],
      side = sides[0].w >= sides[1].w ? sides[0] : sides[1];
    if (side.w >= 24 && side.w > (best.room?.w ?? 0)) best = { card, room: { ...side, y: y0, h: y1 - y0 } };
  }
  return best;
}
// A scrap in sight with another over it in its column, the space between them in sight
function cardUnder() {
  const paper = document.querySelector('#book .bk-desk').getBoundingClientRect(),
    view = document.querySelector('#book .bk-groups[data-page="9101"]').parentElement,
    cards = [...view.querySelectorAll('.bk-unit:not([data-drawing])')].map(el => el.getBoundingClientRect());
  const r = cards.find(
    c =>
      c.top > paper.top + 40 &&
      c.top + 60 < paper.bottom - 40 &&
      cards.some(o => o !== c && Math.abs(o.left - c.left) < 1 && o.top < c.top),
  );
  return r && { x: r.left, y: r.top, w: r.width, h: r.height };
}
