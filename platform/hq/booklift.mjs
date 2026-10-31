// book-check.mjs's stories of the lift (shared/review/lift.js, shell/ink/booklanding.js; Ink's folder), held like an iPad mini in landscape, on book-check's played store.
// A mark on HQ's page, saved from its post-it, lifts off as one layer at once and drifts into the book: open, onto the
// page shown, where its scrap shows once it's in the Notebook's newest page (turned to); folded, into the handle, which
// hears book:landed, then the scrap's id and page with it. Nothing of it stays over HQ (rule zero: bookink.mjs).
// (Saved from the post-it since the pin flow)
import assert from 'node:assert/strict';
import { nothingDrawn } from './bookink.mjs';
import { groupsOf } from './bookplayed.mjs';
import { savedScrap } from './bookscrap.mjs';
import { pressAlong } from './bookkit.mjs';

const FLIGHT_MS = 6000; // (the lift's flight, on a loaded worker)
const RINGS = [
  { x: 250, y: 300, rx: 80, ry: 45 },
  { x: 250, y: 480, rx: 70, ry: 40 },
];

// c: book-check's { hqIn, base, MINI, settled, ring, inkAt, posts, hush, shot, noErrorsIn }
export function liftStories(c) {
  return {
    'a mark saved lifts off HQ into the open book, onto the newest page where its scrap shows, and leaves nothing behind':
      browser => openStory({ ...c, browser }),
    "a mark saved lifts off HQ into the folded book's handle, which hears it land with its scrap": browser =>
      foldedStory({ ...c, browser }),
  };
}

async function openStory(c) {
  const { page, errors, done } = await hqOpen(c);
  try {
    for (const [i, ring] of RINGS.entries()) {
      // (the second from New page's blank one: the book turns back to the newest page, where its scrap goes)
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
    assert.ok(flight.landed.length >= 1, 'the handle heard it land (book:landed)');
    assert.deepEqual(
      flight.landed.at(-1),
      { id: flight.id, page: flight.page, group: true },
      '...then its scrap, once the Notebook has it (book:scrap)',
    );
    await clean(page, 'folded');
    await c.shot('lift-folded', page);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// A ring drawn with the pen and saved from its post-it: the lift's flight as the page saw it, { id, page, picture: its
// scrap's, from, land, path: the layer's box each frame, landed: every book:landed's { id, page, group } }, once its
// layer has gone and the scrap is in the store
async function lifted(c, page, ring) {
  await page.evaluate(() => {
    const f = (window.__flight = { path: [], gone: false });
    document.addEventListener(
      'pencil:landing',
      e => {
        // (the book answers before this listener, added after it, hears the ask)
        queueMicrotask(() => Object.assign(f, { from: e.detail.from, land: e.detail.land }));
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
    f.landed = [];
    document.addEventListener('book:landed', e =>
      f.landed.push({ id: e.detail.id, page: e.detail.page, group: e.detail.group }),
    );
  });
  const from = c.posts.length;
  c.hush(true);
  await pressAlong(page, c.ring(ring.x, ring.y, ring.rx, ring.ry));
  await savedScrap({ page, posts: c.posts }, from, 'the lift');
  await page.waitForFunction(() => window.__flight.gone, null, { timeout: FLIGHT_MS });
  const scrap = groupsOf(page.context().notebook).at(-1);
  await page.waitForTimeout(300); // (book:scrap, after the post)
  return {
    ...(await page.evaluate(() => window.__flight)),
    id: scrap.id,
    page: scrap.page,
    picture: scrap.pictures[0],
  };
}
// The book open on the scrap's page, showing the scrap: its picture on the paper
async function shows(page, { id, page: on, picture }, what) {
  const seen = await page
    .waitForFunction(
      ([on, id, scrap]) => {
        const layer = document.querySelector(`#book .bk-world .bk-page:not([hidden]) > .bk-groups[data-page="${on}"]`);
        // (the store keeps the picture in its unit's own px: moved to where the masonry put the unit. job #15978)
        const card = layer?.parentElement.querySelector(`.bk-unit[data-unit="${id}"]`);
        if (!card) return false;
        const el = layer.parentElement,
          o = el.getBoundingClientRect(),
          k = o.width / el.offsetWidth,
          paper = document.querySelector('#book .bk-desk').getBoundingClientRect(),
          x = o.left + (parseFloat(card.style.left) + scrap.x + scrap.w / 2) * k,
          y = o.top + (parseFloat(card.style.top) + scrap.y + scrap.h / 2) * k;
        return x > paper.left && x < paper.right && y > paper.top && y < paper.bottom;
      },
      [on, id, picture],
      { timeout: 5000 },
    )
    .then(
      () => null,
      () =>
        page.evaluate(id => {
          const el = document.querySelector(`#book .bk-unit[data-unit="${id}"]`),
            shown = document.querySelector('#book .bk-world .bk-page:not([hidden])')?.ariaLabel;
          return `the book shows "${shown}"; the scrap ${el ? `on "${el.closest('.bk-page')?.ariaLabel}"` : 'nowhere'}`;
        }, id),
    );
  assert.equal(seen, null, `${what}: the book shows its scrap on its page`);
}
// The layer moved from the ink towards where it lands: halfway through its frames it's nearer there than it started
function towards({ from, land, path }, what) {
  assert.ok(path.length >= 1, `${what}: a flight of its own`);
  // (on a loaded worker Save's photo, cut as the ink flies, can hold every frame of the flight up: its path is judged
  // where its frames are seen, and said when they aren't. job #12594)
  if (path.length < 4)
    return console.log(`     ${what}: the flight's frames unseen (${path.length}), its path not judged`);
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
// The book on a page other than the newest: New page's blank one, turned to (it's stored once something's drawn on
// it, so the newest page is still the one before)
async function otherPage(page) {
  await page.locator('#book button[aria-label="New page"]').first().click();
  await page.waitForFunction(
    () => document.querySelector('#book button[aria-label="The page before"]')?.disabled === false,
    null,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(1500);
}

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
