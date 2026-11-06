// book-check.mjs's stories of the lift (shared/review/lift.js, shell/ink/booklanding.js; Ink's folder), held like an iPad mini in landscape, on book-check's played store.
// A mark on HQ's page, saved from its post-it, lifts off as one layer at once and drifts into the book: open, onto the
// page shown, where its scrap shows once it's in the Notebook's newest page (turned to); folded, into the handle, which
// hears book:landed, and the scrap's id and page with it. Nothing of it stays over HQ (rule zero: ink.mjs).
// (Saved from the post-it since the pin flow)
import assert from 'node:assert/strict';
import { nothingDrawn } from './ink.mjs';
import { groupsOf } from './played.mjs';
import { savedScrap } from './scrap.mjs';
import { pressAlong } from './kit.mjs';
import { press } from './bar.mjs';
import { watchedPage } from './start.mjs';
import { LOOKS } from './arrival.mjs';
import { snipBox } from '../../../shared/review/snipbox.js';

const FLIGHT_MS = 6000; // (the lift's flight, on a loaded worker)
const RINGS = [
  { x: 250, y: 300, rx: 80, ry: 45 },
  { x: 250, y: 480, rx: 70, ry: 40 },
];

// c: book-check's { hqIn, base, MINI, settled, ring, inkAt, posts, hush, shot, noErrorsIn }
export function liftStories(c) {
  return {
    'a mark saved lifts off HQ into the open book, onto the newest page where its scrap shows, and leaves nothing behind':
      async browser => {
        for (const look of LOOKS(browser)) await openStory({ ...c, browser }, look);
      },
    "a mark saved lifts off HQ into the folded book's handle, which hears it land with its scrap": browser =>
      foldedStory({ ...c, browser }),
  };
}

// (look: HQ's look, arrival.mjs LOOKS.)
async function openStory(c, look) {
  const { page, errors, done } = await hqOpen(c, look);
  try {
    for (const [i, ring] of RINGS.entries()) {
      // (the second from New page's blank one: the book turns back to the newest page, where its scrap goes)
      if (i) await otherPage(page);
      const flight = await lifted(c, page, ring),
        what = `ring ${i + 1}${look}`;
      const desk = await page.locator('#book .bk-desk').boundingBox();
      assert.ok(inside(flight.land, desk), `${what}: it lands on the book's paper (${json(flight.land)})`);
      towards(flight, what);
      await shows(page, flight, what);
      await endsOnItsInk(page, flight, what);
      await clean(page, what);
    }
    await c.shot(`lift-open${look.replace('&renderer=', '-')}`, page);
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
    // (its scrap, once the Notebook has it (book:scrap), before or after the ink's own landing: WebKit's flight can end
    // after the save. The handle keeps the one with an id: bookhandle.js land.)
    const scrap = await page
      .waitForFunction(() => window.__flight.landed.find(l => l.id), null, { timeout: 5000 })
      .then(
        h => h.jsonValue(),
        () => null,
      );
    assert.deepEqual(scrap, { id: flight.id, page: flight.page, group: true }, '...and its scrap (book:scrap)');
    await clean(page, 'folded');
    await c.shot('lift-folded', page);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// A ring drawn with the pen and saved from its post-it: the lift's flight as the page saw it, { id, page, picture: its
// scrap's, from, land, path: the layer's box each frame, landed: every book:landed's { id, page, group } }, once its
// layer has gone and the scrap is in the store (ends: the rect it ends in)
async function lifted(c, page, ring) {
  await watchFlight(page);
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
// The page told to keep the lift's flight in window.__flight: where it's asked to land, each rect it's aimed at on the
// way, its layer's box each frame and where its flight ends (finish), when it's gone, and every book:landed.
async function watchFlight(page) {
  await watchAims(page);
  await watchLayer(page);
}
// (where it's asked to land, each rect it's aimed at on the way, its layer's box each frame, and every book:landed)
const watchAims = page =>
  page.evaluate(() => {
    const f = (window.__flight = { path: [], gone: false });
    document.addEventListener(
      'pencil:landing',
      e => {
        // (the book answers before this listener, added after it, hears the ask)
        // (up: its layer over HQ once lift.js has made it, though no frame may come before it's gone in headless
        // WebKit.)
        queueMicrotask(() =>
          Object.assign(f, { from: e.detail.from, land: e.detail.land, up: !!document.querySelector('review-lift') }),
        );
        // (each rect the book aims it at on the way, lift.js asking only while it flies: the last that moved it is
        // where it ends)
        const aim = e.detail.aim;
        f.ends = e.detail.land;
        if (aim)
          e.detail.aim = () => {
            const next = aim();
            if (next && ['x', 'y', 'w', 'h'].some(k => Math.abs(next[k] - f.ends[k]) >= 1)) f.ends = next;
            return next;
          };
        const sample = () => {
          const layer = document.querySelector('review-lift');
          if (!layer) return;
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
// (its layer's box where its flight ends, before lift.js takes it off: the frames seen on a loaded worker may stop short
// of it; and gone when it leaves the page: headless WebKit's frames come far apart, and the next may come long after
// it's gone.)
const watchLayer = page =>
  page.evaluate(() => {
    const f = window.__flight;
    document.addEventListener(
      'pencil:landing',
      () => {
        let ending = false;
        const left = new MutationObserver(() => {
          const layer = document.querySelector('review-lift');
          if (layer && !ending)
            ending = layer.getAnimations()[0]?.finished.then(() => {
              const b = layer.getBoundingClientRect();
              f.finish = { x: b.x, y: b.y, w: b.width, h: b.height };
            });
          if (layer) return;
          f.gone = true;
          left.disconnect();
        });
        left.observe(document.documentElement, { childList: true, subtree: true });
      },
      { once: true },
    );
  });
// The book open on the scrap's page, showing the scrap: its picture on the paper
async function shows(page, { id, page: on, picture }, what) {
  const seen = await page
    .waitForFunction(
      ([on, id, scrap]) => {
        const layer = document.querySelector(`#book .bk-world .bk-page:not([hidden]) > .bk-groups[data-page="${on}"]`);
        // (the store keeps the picture in its unit's own px: moved to where the masonry put the unit.)
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
// The flight ends on the very spot the page then draws its ink, within a px or two: its ink's box as it ends (the
// rect it lands in, the ink stretched to it each way: lift.js) against the ink's on the scrap's photo as the page draws it,
// the ink where review mode cut the snip round it (snipbox.js, as marks.js snipOf cuts it.)
async function endsOnItsInk(page, { from, land, ends, picture }, what) {
  const screen = await page.evaluate(() => [innerWidth, innerHeight]),
    snip = snipBox(from, ...screen),
    drawn = await page.evaluate(
      ([url, from, { x, y, w, h }]) => {
        const photo = [...document.querySelectorAll('#book .bk-world .bk-page:not([hidden]) .bk-photo')].find(
          p => p.dataset.url === url,
        );
        if (!photo) return null;
        const r = photo.getBoundingClientRect();
        return {
          x: r.left + ((from.x - x) / w) * r.width,
          y: r.top + ((from.y - y) / h) * r.height,
          w: (from.w / w) * r.width,
          h: (from.h / h) * r.height,
        };
      },
      [picture.url, from, snip],
    ),
    flown = { x: ends.x, y: ends.y, w: ends.w, h: ends.h };
  assert.ok(drawn, `${what}: the page draws its scrap's photo`);
  const off = Math.max(...['x', 'y', 'w', 'h'].map(n => Math.abs(flown[n] - drawn[n])));
  assert.ok(
    off <= 2,
    `${what}: it ends where the page draws its ink (${json(flown)}, drawn ${json(drawn)}; aimed first at ${json(land)})`,
  );
}
// The layer moved from the ink towards where it lands: halfway through its frames it's nearer there than it started,
// and its flight ends there. Where it lands is the rect the book aimed it at last (ends): its first aim is the page's next
// place, bent on the way to the scrap's photo once the page has it.
function towards({ from, ends, path, finish, up }, what) {
  assert.ok(path.length >= 1 || up, `${what}: a flight of its own`);
  const to = centre(ends),
    away = p => Math.hypot(centre(p).x - to.x, centre(p).y - to.y),
    start = Math.hypot(centre(from).x - to.x, centre(from).y - to.y);
  assert.ok(
    away(finish) < Math.max(24, start * 0.15),
    `${what}: it ends where it lands (${Math.round(away(finish))} px off)`,
  );
  // On a loaded worker Save's photo, cut as the ink flies, can hold every frame of the flight up: its way there is
  // judged where its frames are seen, and said when they aren't.
  if (path.length < 4)
    return console.log(`     ${what}: the flight's frames unseen (${path.length}), its path not judged`);
  const mid = away(path[Math.floor(path.length / 2)]);
  assert.ok(mid < start, `${what}: halfway it's nearer the book (${Math.round(mid)} px from ${Math.round(start)})`);
}
// Nothing of the lift left over HQ: its layer gone, and nothing drawn
async function clean(page, what) {
  assert.equal(await page.locator('review-lift').count(), 0, `${what}: no layer left over HQ`);
  await nothingDrawn(page, what, 0);
}
// The book on a page other than the newest: New page's blank one, turned to (it's stored once something's drawn on
// it, so the newest page is still the one before)
async function otherPage(page) {
  // (from More where the rail has folded it away.)
  await press(page, 'New page');
  await page.waitForFunction(
    () => document.querySelector('#book button[aria-label="The page before"]')?.disabled === false,
    null,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(1500);
}

// HQ on its played store, the book open beside it
// (each look on its own store, My journal with nothing on it, as the story's first: a store a run before has written on
// opens the book on its page as that run left it.)
async function hqOpen(c, look = '') {
  const now = new Date().toISOString(),
    journal = { notebooks: [{ id: 1, kind: 'mine', name: 'My journal', created: now, updated: now }], pages: [] },
    context = await c.hqIn(c.browser, c.MINI, look ? { notebooks: journal } : {});
  const { page, errors } = await watchedPage(context);
  await page.goto(`${c.base}/?intro=0${look}`);
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
