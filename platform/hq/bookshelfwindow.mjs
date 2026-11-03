// book-check.mjs's story of the Shelf in its own window (shell/ink/bookshelfwindow.js): HQ's Shelf key brings it over HQ, an open book shut first (its close played, then the Shelf), rising
// in; a notebook tapped there puts it away and opens in the book, on its page; the overview's Shelf shuts the book
// again before it shows; Archive moves a notebook (an open review round's too) to the Archive and Back on the Shelf
// brings it back; Esc puts it away and the book stays shut; a round back from Lyra, its string pulled, opens in the
// book on its Advice. On a desktop, a phone and an iPad mini with reduced motion (a fade, nothing rises or swings).
// A phone's open book is a spread over all of HQ: there HQ's key brings the Shelf with the book shut by its tab.
// And its little potted plant: on its top edge at the right, on screen, clear
// of its controls and books, in Wire, Holo and Brownstone, on the iPad mini both ways and a desktop, with a shelf tall
// enough to scroll.
import assert from 'node:assert/strict';
import { errorsOf, until } from '../../shared/browser/browser.mjs';
import { DESKTOP, MINI, OVERVIEW, UPRIGHT, shelfKey } from './bookkit.mjs';
import { namedNotebook } from './bookchrome.mjs';

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
  const story = 'the Shelf in its own window: from HQ, after the book shuts; a notebook opens in the book; Archive';
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
      far = shelf.getByRole('list', { name: 'The overview' });
    // HQ's Shelf key: the open book shuts, then the Shelf rises in over HQ
    shownAfterShut(await shelfShown(page, await shelfKey(page)), { reduced, open: !phone }, 'from HQ');
    await page.waitForTimeout(c.settle);
    assert.ok(await far.getByRole('button', { name: /^My journal,/ }).isVisible(), 'My journal on the Shelf');
    await c.shot(`shelf-window-${label}`, page);
    // a notebook tapped: the window away, the book open on it
    await opened(page, c, far.getByRole('button', { name: /^Call with Ansel,/ }), phone);
    await page.locator('#book').getByRole('button', { name: OVERVIEW, exact: true }).click();
    await page.waitForTimeout(c.settle);
    const pages = page.locator('#book .bk-pages > .bk-far');
    assert.equal(await pages.locator('.bk-far-title').textContent(), 'Call with Ansel', 'the notebook tapped');
    // the overview's Shelf: the book shuts first, then the Shelf
    shownAfterShut(await shelfShown(page, pages.locator('[data-go=shelf]')), { reduced }, "from the overview's Shelf");
    await page.waitForTimeout(c.settle);
    await shelfArchive(page, far, c, label, viewport);
    // My journal opens on its page, not the overview it was left on
    await opened(page, c, far.getByRole('button', { name: /^My journal,/ }), phone);
    assert.ok(await pages.isHidden(), 'the book opens on its page');
    await escaped(page, c, shelf, { reduced, phone });
    await unwrapped(page, c, far, { phone, label });
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
async function unwrapped(page, c, far, { phone, label }) {
  await (await shelfKey(page)).click();
  await page.waitForTimeout(c.settle);
  await c.shot(`shelf-window-back-${label}`, page);
  await opened(page, c, far.getByRole('button', { name: /^Advice · Shop round\./ }), phone);
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

// A review round still open archived from its book's own menu: off My shelf and in the
// Archive, where its menu brings it back
async function shelfArchive(page, far, c, label, viewport) {
  const round = far.locator(`.bk-book[data-book="${ROUND.id}"]`),
    menu = async () => {
      if (viewport.width >= 500) await round.hover();
      await far.getByRole('button', { name: `More: ${ROUND.name}`, exact: true }).click();
    };
  await menu();
  await c.shot(`shelf-window-menu-${label}`, page);
  await far.getByRole('menuitem', { name: 'Archive', exact: true }).click();
  await page.waitForTimeout(c.settle);
  assert.equal(await round.count(), 0, 'the round off My shelf');
  await far.getByRole('button', { name: /^Archive/ }).click();
  await page.waitForTimeout(c.settle);
  assert.equal(await far.locator('.bk-shelf-title').textContent(), 'Archive');
  assert.ok(await round.isVisible(), 'the round in the Archive');
  await menu();
  await far.getByRole('menuitem', { name: 'Back on the Shelf', exact: true }).click();
  await page.waitForTimeout(c.settle);
  assert.equal(await round.count(), 0, 'the round gone from the Archive');
  await far.getByRole('button', { name: 'My shelf', exact: true }).click();
  await page.waitForTimeout(c.settle);
  assert.ok(await round.isVisible(), 'the round back on My shelf');
}

// The plant in each look: standing on the window's top edge at its right, whole on screen, over none of its controls
// or books, with three books and with a dozen (the window as tall as the screen)
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
  const seen = await page.evaluate(() => {
    const box = el => el.getBoundingClientRect().toJSON(),
      dialog = document.querySelector('#book .bk-shelf-window');
    return {
      plant: box(dialog.querySelector('.bk-shelf-plant')),
      window: box(dialog),
      others: [...dialog.querySelectorAll('button, .bk-book')].map(box).filter(b => b.width && b.height),
    };
  });
  const { plant, window: w } = seen;
  assert.ok(Math.abs(plant.bottom - w.top) <= 2, `${at}: the plant stands on the top edge ${JSON.stringify(seen)}`);
  assert.ok(plant.left > w.left + w.width * 0.8 && plant.right < w.right, `${at}: at its right`);
  assert.ok(plant.top >= 0 && plant.height > 40, `${at}: whole on screen`);
  const over = seen.others.filter(
    b => b.left < plant.right && b.right > plant.left && b.top < plant.bottom && b.bottom > plant.top,
  );
  assert.deepEqual(over, [], `${at}: over none of its controls or books`);
  await c.shot(`shelf-plant-${at.replace(/[, ]+/g, '-')}`, page);
  await page.keyboard.press('Escape');
  await shelf.waitFor({ state: 'hidden' });
}
