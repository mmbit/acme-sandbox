// book-check.mjs's stories of the lift (shared/review/lift.js, shell/ink/booklanding.js; Ink's folder), held like an iPad mini in landscape, on book-check's played store.
// A mark on HQ's page, once the pen has rested, lifts off as one layer and drifts into the book: open, onto its note's
// page (turned to first) where the note shows; folded, into the handle, which hears book:landed. Nothing of it stays
// over HQ (rule zero: bookink.mjs).
import assert from 'node:assert/strict';
import { nothingDrawn } from './bookink.mjs';

const SETTLE_MS = 1500; // (callnotes.js: the pen resting before a mark goes in)
const RINGS = [
  { x: 250, y: 300, rx: 80, ry: 45 },
  { x: 250, y: 480, rx: 70, ry: 40 },
];

// c: book-check's { hqIn, base, MINI, settled, penOn, ring, inkAt, shot, noErrorsIn }
export function liftStories(c) {
  return {
    "a mark lifts off HQ into the open book, onto its note's page turned to, and leaves nothing behind": browser =>
      openStory({ ...c, browser }),
    "a mark lifts off HQ into the folded book's handle, which hears it land": browser => foldedStory({ ...c, browser }),
  };
}

async function openStory(c) {
  const { page, errors, done } = await hqOpen(c);
  try {
    for (const [i, ring] of RINGS.entries()) {
      // (the second goes on the same sheet's page from another page: the book turns there first)
      if (i) await otherPage(page);
      const flight = await lifted(c, page, ring);
      const desk = await page.locator('#book .bk-desk').boundingBox();
      assert.ok(inside(flight.land, desk), `ring ${i + 1}: it lands on the book's paper (${json(flight.land)})`);
      towards(flight, `ring ${i + 1}`);
      await shows(page, flight, `ring ${i + 1}`);
      await clean(page, `ring ${i + 1}`);
    }
    await c.shot('lift-open', page);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

async function foldedStory(c) {
  const { page, errors, done } = await hqOpen(c);
  try {
    await page.evaluate(() => import('/shell/ink/book.js').then(m => m.foldBook()));
    await c.settled(page, 'folded');
    const ring = RINGS[0],
      flight = await lifted(c, page, ring),
      lip = await page.locator('#book .bk-lip').boundingBox(),
      end = centre(flight.land);
    assert.ok(
      Math.abs(end.x - lip.x) < 24 && end.y > lip.y && end.y < lip.y + lip.height,
      `it lands in the handle (${json(flight.land)}, the handle ${json(lip)})`,
    );
    towards(flight, 'into the handle');
    assert.equal(flight.landed?.id, flight.id, 'the handle heard it land (book:landed), with its note');
    assert.equal(flight.landed?.page, flight.page, '...and its page');
    await clean(page, 'folded');
    await c.shot('lift-folded', page);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// A ring drawn with the pen and left to settle: the lift's flight as the page saw it, { id, page, from, land,
// path: the layer's box each frame, landed: book:landed's detail }, once its layer has gone
async function lifted(c, page, ring) {
  await page.evaluate(() => {
    const f = (window.__flight = { path: [], gone: false });
    document.addEventListener(
      'pencil:landing',
      e => {
        // (the book answers before this listener, added after it, hears the ask)
        queueMicrotask(() =>
          Object.assign(f, { id: e.detail.id, page: e.detail.page, from: e.detail.from, land: e.detail.land }),
        );
        const sample = () => {
          const layer = document.querySelector('review-lift');
          if (!layer) return (f.gone = f.path.length > 0);
          const b = layer.getBoundingClientRect();
          f.path.push({ x: b.x, y: b.y, w: b.width, h: b.height });
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      },
      { once: true },
    );
    document.addEventListener('book:landed', e => (f.landed = e.detail), { once: true });
  });
  await c.penOn(page)(c.ring(ring.x, ring.y, ring.rx, ring.ry));
  await page.waitForFunction(() => window.__flight.gone, null, { timeout: SETTLE_MS + 6000 });
  return page.evaluate(() => window.__flight);
}
// The book open on the note's page, showing the note
async function shows(page, { id }, what) {
  const note = `#book .bk-world .bk-page:not([hidden]) .bs-note[data-id="${id}"]`;
  const seen = await page
    .waitForFunction(s => document.querySelector(s)?.getBoundingClientRect().width > 0, note, { timeout: 5000 })
    .then(
      () => null,
      () =>
        page.evaluate(id => {
          const el = document.querySelector(`#book .bs-note[data-id="${id}"]`),
            shown = document.querySelector('#book .bk-world .bk-page:not([hidden]) .bk-title')?.textContent;
          return `the book shows "${shown}"; the note ${el ? `on "${el.closest('.bk-page')?.querySelector('.bk-title')?.textContent}"` : 'nowhere'}`;
        }, id),
    );
  assert.equal(seen, null, `${what}: the book shows its note on its page`);
}
// The layer moved from the ink towards where it lands: halfway through its frames it's nearer there than it started
function towards({ from, land, path }, what) {
  assert.ok(path.length >= 4, `${what}: a flight of its own frames (${path.length})`);
  const to = centre(land),
    away = p => Math.hypot(centre(p).x - to.x, centre(p).y - to.y),
    start = Math.hypot(centre(from).x - to.x, centre(from).y - to.y),
    mid = away(path[Math.floor(path.length / 2)]),
    last = away(path.at(-1));
  assert.ok(mid < start, `${what}: halfway it's nearer the book (${Math.round(mid)} px from ${Math.round(start)})`);
  assert.ok(last < Math.max(24, start * 0.15), `${what}: it ends where it lands (${Math.round(last)} px off)`);
}
// Nothing of the lift left over HQ: its layer gone, and nothing drawn
async function clean(page, what) {
  assert.equal(await page.locator('review-lift').count(), 0, `${what}: no layer left over HQ`);
  await nothingDrawn(page, what, 0);
}
// The book turned to a page of the day other than the one shown: New page
async function otherPage(page) {
  const before = await shownTitle(page);
  await page.locator('#book button[aria-label="New page"]').first().click();
  await page.waitForFunction(was => {
    const title = document.querySelector('#book .bk-world .bk-page:not([hidden]) .bk-title')?.textContent;
    return title && title !== was;
  }, before);
  await page.waitForTimeout(600);
}
const shownTitle = page =>
  page.evaluate(() => document.querySelector('#book .bk-world .bk-page:not([hidden]) .bk-title')?.textContent ?? '');

// HQ on its played store, the book open beside it
async function hqOpen(c) {
  const context = await c.hqIn(c.browser, c.MINI),
    page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#loading.gone', { state: 'attached' });
  await page.waitForSelector('review-mode .fab', { state: 'attached' });
  await c.settled(page, 'open');
  return { page, errors, done: () => context.close() };
}

const centre = b => ({ x: b.x + (b.w ?? b.width) / 2, y: b.y + (b.h ?? b.height) / 2 });
const inside = (r, box) =>
  r &&
  r.x >= box.x - 1 &&
  r.y >= box.y - 1 &&
  r.x + r.w <= box.x + box.width + 1 &&
  r.y + r.h <= box.y + box.height + 1;
const json = r => JSON.stringify(r && Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v)])));
