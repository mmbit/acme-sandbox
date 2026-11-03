// book-check.mjs's story of the Shelf in its own window (shell/ink/bookshelfwindow.js): HQ's Shelf key brings it over
// HQ, an open book shut first (its close played, then the Shelf), rising in; a notebook tapped there puts it away and
// opens in the book on its All pages; All pages' Shelf shuts the book again before it shows; a notebook's options'
// Archive this book (an open review round's too) moves it to the Archive's box, and there its options' Back on the
// Shelf brings it back; Esc puts it away and the book stays shut; a round back from Lyra, its string pulled, opens in
// the book on its Advice. On a desktop, a phone and an iPad mini with reduced motion (a fade, nothing rises or
// swings). A phone's open book is a spread over all of HQ: there HQ's key brings the Shelf with the book shut by its
// tab. And its little potted plant: standing on a board, the top one's or the last's, inside the window and clear of
// its controls and books, in Wire, Holo and Brownstone, on the iPad mini both ways and a desktop, with a shelf tall
// enough to scroll.
import assert from 'node:assert/strict';
import { errorsOf, until } from '../../../shared/browser/browser.mjs';
import { DESKTOP, LOADED_MS, MINI, UPRIGHT, shelfKey } from './kit.mjs';
import { namedNotebook } from './chrome.mjs';
import { shelfSeen, standing } from './myshelf.mjs';

const PHONE = { width: 390, height: 844 };
// a review round its guests still write in
const ROUND = {
  id: 3,
  kind: 'round',
  name: 'Ink vision: 30 Oct, 12:48',
  round: { state: 'open', guests: [], asksOpen: 0 },
};
// a round back from Lyra: its guest's page the newest, its Advice older
const BACK = {
    id: 4,
    kind: 'round',
    name: 'Shop round',
    round: { state: 'back', with: 'Lyra', guests: [], asksOpen: 0 },
  },
  ADVICE = 42;

// c: book-check.mjs's helpers: { base, hqIn(browser, viewport), settled(page, mode), shot, settle }
export function shelfWindowStories(c) {
  const story =
    "the Shelf in its own window: from HQ, after the book shuts; a notebook opens on its All pages; Archive from a book's options";
  return {
    [`${story} (desktop)`]: browser => shelfWindow(browser, c, DESKTOP),
    [`${story} (phone)`]: browser => shelfWindow(browser, c, PHONE),
    [`${story} (reduced motion)`]: browser => shelfWindow(browser, c, MINI, true),
    ...Object.fromEntries(
      Object.entries({ desktop: DESKTOP, 'iPad mini on its side': MINI, 'iPad mini upright': UPRIGHT }).map(
        ([size, viewport]) => [
          `the Shelf window's potted plant, in every look (${size})`,
          browser => shelfPlant(browser, c, viewport),
        ],
      ),
    ),
  };
}

// My journal, a call's notebook, an open round and one back from Lyra with its pages
function shelfSeed() {
  const seed = namedNotebook(),
    now = new Date().toISOString();
  seed.notebooks.push(
    { id: 2, kind: 'call', name: 'Call with Ansel', created: now, updated: now },
    { ...ROUND, created: now, updated: now },
    { ...BACK, round: { ...BACK.round }, created: now, updated: now }, // (the store unwraps it in place)
  );
  seed.pages.push(
    ...[
      { id: ADVICE, pos: 0, kind: 'advice', label: 'Advice', created: new Date(Date.now() - 60_000).toISOString() },
      { id: 41, pos: 0, label: 'Guest page', created: now },
    ].map(p => ({ notebook: BACK.id, updated: p.created, w: 1200, h: 1600, ...p })),
  );
  return seed;
}

async function shelfWindow(browser, c, viewport, reduced = false) {
  const phone = viewport.width < 500,
    label = reduced ? 'reduced' : phone ? 'phone' : 'desktop';
  const context = await c.hqIn(browser, viewport, {
    notebooks: shelfSeed(),
    deviceScaleFactor: 1,
    hasTouch: phone,
    isMobile: phone,
    reducedMotion: reduced ? 'reduce' : 'no-preference',
  });
  const page = await context.newPage(),
    errors = errorsOf(page);
  try {
    await page.goto(`${c.base}/?intro=0&renderer=wire`);
    await until(page, '#loading.gone');
    await c.settled(page, phone ? 'folded' : 'open');
    const shelf = page.getByRole('dialog', { name: 'The Shelf' }),
      pages = page.locator('#book .bk-pages > .bk-far');
    // HQ's Shelf key: the open book shuts, then the Shelf rises in over HQ
    shownAfterShut(await shelfShown(page, await shelfKey(page)), { reduced, open: !phone }, 'from HQ');
    await page.waitForTimeout(c.settle);
    assert.ok(await shelf.getByRole('button', { name: /^My journal,/ }).isVisible(), 'My journal on the Shelf');
    await c.shot(`shelf-window-${label}`, page);
    // a notebook tapped: the window away, the book open on its All pages
    await opened(page, c, shelf.getByRole('button', { name: /^Call with Ansel,/ }), phone);
    await onItsPages(page, 'Call with Ansel');
    // All pages' Shelf: the book shuts first, then the Shelf
    shownAfterShut(
      await shelfShown(page, pages.locator('.bk-far-up[data-go=shelf]')),
      { reduced },
      "from All pages' Shelf",
    );
    await page.waitForTimeout(c.settle);
    await shelfArchive(page, shelf, c, { label, phone });
    // My journal opens on its All pages too
    await opened(page, c, shelf.getByRole('button', { name: /^My journal,/ }), phone);
    await onItsPages(page, 'My journal');
    await escaped(page, c, shelf, { reduced, phone });
    await unwrapped(page, c, shelf, { phone, label });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

// HQ's key again (a phone's book shut by its tab first), then Esc puts the Shelf away; the book stays shut
async function escaped(page, c, shelf, { reduced, phone }) {
  if (phone) {
    await page.locator('#book .bk-lip').tap();
    await c.settled(page, 'folded');
  }
  shownAfterShut(await shelfShown(page, await shelfKey(page)), { reduced, open: !phone }, 'from HQ again');
  await page.waitForTimeout(c.settle);
  await page.keyboard.press('Escape');
  await shelf.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.book), 'folded', 'the book stays shut');
}

// The returned round's string pulled on the Shelf from HQ: the window away, the book open on its Advice page
async function unwrapped(page, c, shelf, { phone, label }) {
  await (await shelfKey(page)).click();
  await page.waitForTimeout(c.settle);
  await c.shot(`shelf-window-back-${label}`, page);
  await opened(page, c, shelf.getByRole('button', { name: /^Advice · Shop round\./ }), phone);
  const shown = await page.evaluate(() =>
    [...document.querySelectorAll('#book .bk-world .bk-groups[data-page]')]
      .filter(g => !g.closest('[hidden]'))
      .map(g => Number(g.dataset.page)),
  );
  assert.deepEqual(shown, [ADVICE], "the book open on the round's Advice");
}

// control pressed, the Shelf as the board sees it come: when the book was first seen shut and when the window opened
// (ms from the press), whether the book swung shut on the way, and the window's first frame's transform (none: a fade)
async function shelfShown(page, control) {
  await page.evaluate(() => {
    const seen = (window.__shelfShown = { folded: null, shown: null, swung: false, rise: null }),
      dialog = document.querySelector('#book .bk-shelf-window'),
      t0 = performance.now();
    const watch = () => {
      const now = performance.now() - t0;
      seen.swung ||= !!document.querySelector('#book.bk-swinging');
      if (seen.folded === null && document.documentElement.dataset.book === 'folded') seen.folded = now;
      if (!dialog.open) return void requestAnimationFrame(watch);
      seen.shown = now;
      seen.rise = dialog.getAnimations()[0]?.effect.getKeyframes()[0].transform ?? null;
    };
    watch();
  });
  await control.click();
  await page.waitForFunction(() => window.__shelfShown.shown !== null, null, { timeout: 30_000 });
  return page.evaluate(() => window.__shelfShown);
}
// (open: the book was open, so its close played first)
function shownAfterShut(seen, { reduced, open = true }, way) {
  assert.ok(seen.folded !== null && seen.folded <= seen.shown, `${way}: the book shut first ${JSON.stringify(seen)}`);
  if (reduced) return assert.ok(!seen.rise || seen.rise === 'none', `${way}: a fade only ${JSON.stringify(seen)}`);
  assert.equal(seen.swung, open, `${way}: the book's close played if it was open ${JSON.stringify(seen)}`);
  assert.match(seen.rise ?? '', /translate/, `${way}: the Shelf rises in ${JSON.stringify(seen)}`);
}

// A book on the Shelf tapped: the window put away and the book opened (the spread on a phone), its swing played
async function opened(page, c, book, phone) {
  await book.click();
  await page.locator('#book .bk-shelf-window').waitFor({ state: 'hidden' });
  await c.settled(page, phone ? 'spread' : 'open');
}
// The book open on a notebook's All pages, never on a page: name's
async function onItsPages(page, name) {
  // (and the leaf's turn over: it carries a copy of the page)
  await page.waitForFunction(
    () =>
      document.querySelector('#book')?.dataset.far === 'pages' &&
      !document.querySelector('#book :is(.bk-turn-leaf, .bk-turn-picture, .bk-fx-plane)'),
  );
  const title = page.locator('#book .bk-pages > .bk-far .bk-far-title');
  assert.equal(await title.textContent(), name, `All pages of ${name}`);
}

// A review round still open archived from its All pages' options: off My shelf and in the Archive's box, where its
// options bring it back. (shelf: the Shelf's window)
async function shelfArchive(page, shelf, c, { label, phone }) {
  const round = shelf.locator(`.bk-book[data-book="${ROUND.id}"]`),
    far = page.locator('#book .bk-pages > .bk-far'),
    picked = async (option, shot) => {
      await opened(page, c, round.locator('.bk-tile-open'), phone);
      await onItsPages(page, ROUND.name);
      await far.getByRole('button', { name: `Options: ${ROUND.name}`, exact: true }).click();
      if (shot) await c.shot(shot, page);
      await far.locator('.bk-far-menu').getByRole('menuitem', { name: option, exact: true }).click();
      await page
        .locator('#book .bk-told:not([hidden])')
        .getByRole('button', { name: 'Undo' })
        .waitFor({ timeout: LOADED_MS });
      // (back up to the Shelf)
      await far.locator('.bk-far-up[data-go=shelf]').click();
      await shelf.waitFor();
      await page.waitForTimeout(c.settle);
    };
  await picked('Archive this book', `shelf-window-options-${label}`);
  assert.equal(await round.count(), 0, 'the round off My shelf');
  await shelf.locator('.bk-shelf-box[data-tab=archive]').click();
  await page.waitForTimeout(c.settle);
  assert.equal(await shelf.locator('.bk-shelf-title').textContent(), 'Archive');
  assert.ok(await round.isVisible(), 'the round in the Archive');
  await picked('Back on the Shelf');
  // (the Shelf as it was left: the Archive, its way back to My shelf at its left)
  assert.equal(await shelf.locator('.bk-shelf-title').textContent(), 'Archive');
  assert.equal(await round.count(), 0, 'the round gone from the Archive');
  await shelf.getByRole('button', { name: 'Back to My shelf', exact: true }).click();
  await page.waitForTimeout(c.settle);
  assert.equal(await shelf.locator('.bk-shelf-title').textContent(), 'My shelf');
  assert.ok(await round.isVisible(), 'the round back on My shelf');
}

// The plant in each look: standing on a board, the top one's or the last's, inside the window and over none of its
// controls or books, and whole on the screen once scrolled to, with three books and with a dozen (the window as tall
// as the screen)
async function shelfPlant(browser, c, viewport) {
  for (const [books, looks] of [
    [3, ['wire', 'holo', 'brownstone']],
    [12, ['wire']],
  ]) {
    const seed = namedNotebook(),
      now = new Date().toISOString();
    for (let id = 2; id <= books; id++)
      seed.notebooks.push({ id, kind: 'call', name: `Call ${id}`, created: now, updated: now });
    const context = await c.hqIn(browser, viewport, { notebooks: seed, deviceScaleFactor: 1 });
    const page = await context.newPage(),
      errors = errorsOf(page);
    try {
      for (const look of looks) await plantIn(page, c, `${look}, ${books} books, ${viewport.width}x${viewport.height}`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
}
async function plantIn(page, c, at) {
  await page.goto(`${c.base}/?intro=0&renderer=${at.split(',')[0]}`);
  await until(page, '#loading.gone');
  await page.locator('#btn-shelf').click();
  const shelf = page.getByRole('dialog', { name: 'The Shelf' });
  await shelf.waitFor();
  await page.waitForTimeout(c.settle);
  await shelf.locator('.bk-shelf-plant').scrollIntoViewIfNeeded();
  const seen = await shelfSeen(page),
    plant = seen.things.find(t => t.what === 'the plant');
  standing(seen, at);
  assert.ok(
    [0, seen.rows - 1].includes(plant.row),
    `${at}: on the top board or the last (${plant.row} of ${seen.rows})`,
  );
  const controls = await shelf
    .locator('.bk-far-nav button')
    .evaluateAll(all => all.map(b => b.getBoundingClientRect().toJSON()));
  assert.ok(
    controls.every(
      b => b.right <= plant.left || plant.right <= b.left || b.bottom <= plant.top || plant.bottom <= b.top,
    ),
    `${at}: over none of its controls`,
  );
  assert.ok(plant.top >= 0 && plant.bottom <= page.viewportSize().height, `${at}: whole on screen`);
  await c.shot(`shelf-plant-${at.replace(/[, ]+/g, '-')}`, page);
  await page.keyboard.press('Escape');
  await shelf.waitFor({ state: 'hidden' });
}
