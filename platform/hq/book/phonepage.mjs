// book-check.mjs's stories of the Notebook's page with nothing to draw with on it (shell/ink/bookstrip.css,
// bookcontrols.js, bookrow.js unitsPans, bookwrite.js drawable, bookmarks.css, book.css), on the played Notebook
// seeded as dev mode's (mock/notebook.json), its last page holding a tall picture:
//   - a phone: one column of scraps in the middle, as far from either side; no tools, Undo or Redo on it; its bookmarks
//     big enough to see and hit and clear of the column; its pull tab flush with the screen's edge. A finger swiped
//     sideways moves none of it. A scrap opened by a finger's tap has its tools, Undo and Redo, which go with Done.
//   - a phone: a finger's second tap as a scrap flies up, and again as it flies back down, inks neither the scrap nor
//     the grid, on the screen or in the store.
//   - an iPad mini upright and a desktop: the page has no tools, Undo or Redo, its cards as big as on a desktop, laid
//     in the room the tools take; an opened scrap has them, and they go with Done.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { group, open } from './notebook.mjs';
import { hands, mouseOf } from './hands.mjs';
import { viewNow } from './canvas.mjs';
import { cardInSight } from './mouse.mjs';
import { DESKTOP, UPRIGHT, closeScrap, middleOf, openScrap, until } from './kit.mjs';

const PHONE = { width: 390, height: 844 };
// the seed's page the book opens at, and its scrap that's given a picture taller than any card holds
const TALL = { group: 12, h: 900 };
// a phone's one column stands as far from either side, to this many px
const CENTRED_PX = 6;
// a bookmark folded at a phone's edge, the least it shows: across (its icon whole beside the notch) and tall
const MARK = { w: 30, h: 44 };
// the least a card is wide on a phone and an iPad mini upright, laid in the room the tools take on an opened scrap too
// (320 px at the most)
const CARD_W = 300;

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn
export function phonePageStories(c) {
  return {
    'on a phone the page is one column in the middle with nothing to draw with on it, big bookmarks, the pull tab at the edge, never moved sideways':
      browser => onPhone(browser, c),
    "on a phone a finger's second tap as a scrap flies up or back down inks nothing": browser => flights(browser, c),
    'on an iPad mini upright the page has no tools or Undo, an opened scrap has them': browser =>
      onlyOpened(browser, c, 'mini-upright', UPRIGHT, { hasTouch: true, folded: true }),
    'on a desktop the page has no tools or Undo, an opened scrap has them': browser =>
      onlyOpened(browser, c, 'desktop', DESKTOP, {}),
  };
}

async function onPhone(browser, c) {
  const { page, errors, done } = await opened(browser, c, PHONE, { isMobile: true, hasTouch: true, folded: true });
  try {
    await c.shot('phone-page', page);
    await nothingToDrawWith(page, 'on the page');
    const units = await unitBoxes(page);
    const left = Math.min(...units.map(u => u.x)),
      right = PHONE.width - Math.max(...units.map(u => u.x + u.width));
    assert.equal(new Set(units.map(u => Math.round(u.x))).size, 1, 'one column');
    assert.ok(Math.abs(left - right) <= CENTRED_PX, `in the middle: ${left} px left of it, ${right} px right`);
    const lip = await page.locator('#book .bk-lip').boundingBox();
    assert.ok(Math.abs(lip.x) <= 1, `the pull tab flush with the screen's edge, not ${lip.x} px in`);
    for (const mark of await page.locator('#book .bk-marks button').all()) {
      const box = await mark.boundingBox(),
        shows = box.x + box.width - Math.max(0, box.x);
      assert.ok(shows >= MARK.w && box.height >= MARK.h, `a bookmark ${shows} × ${box.height} px, not smaller`);
      assert.ok(box.x + box.width <= left, 'the bookmarks clear of the column');
    }
    assert.ok(units[0].width >= CARD_W, `its cards ${units[0].width} px wide`);
    const { touch } = await hands(page),
      columns = async () => [...new Set((await unitBoxes(page)).map(u => u.x))];
    const at = await columns();
    for (const [from, to] of [
      [300, 60],
      [60, 330],
    ]) {
      await touch.stroke([[from, 420]], [[to, 410]]);
      await page.waitForTimeout(400);
      assert.deepEqual(await columns(), at, `a finger swiped from ${from} to ${to} moves nothing sideways`);
    }
    // (a finger's tap opens a scrap, the page still after the swipes: its tools, Undo and Redo with it, gone with Done)
    let was;
    await until(async () => {
      const now = JSON.stringify(await viewNow(page)),
        same = now === was;
      was = now;
      return same || (await page.waitForTimeout(150), false);
    }, 'the page still');
    const finger = { tap: async point => (await touch.down([point]), await touch.up()) };
    await openScrap(page, finger, undefined, await cardInSight(page));
    await c.shot('phone-page-scrap-open', page);
    await toolsShown(page);
    await closeScrap(page, finger);
    await nothingToDrawWith(page, 'after Done');
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// A finger tapped on a card, and at once a short finger line where the sheet comes; then Done, and at once a finger
// line on the grid coming back: no wet line laid for either, and the store's ink of every group as it was
async function flights(browser, c) {
  const { page, play, errors, done } = await opened(browser, c, PHONE, {
    isMobile: true,
    hasTouch: true,
    folded: true,
  });
  try {
    const ids = await page
        .locator('#book .bk-page:not([hidden]) .bk-unit[data-unit]')
        .evaluateAll(all => all.map(u => Number(u.dataset.unit))),
      inkOf = () => ids.map(id => group(play, id)?.ink.length ?? 0),
      had = inkOf();
    await page.evaluate(() => {
      window.__wet = 0;
      const watch = new MutationObserver(() => window.__wet++);
      for (const wet of document.querySelectorAll('#book .bk-wet')) watch.observe(wet, { attributes: true });
    });
    const { touch } = await hands(page),
      tap = async point => (await touch.down([point]), await touch.up()),
      line = () => touch.stroke([[200, 500]], [[260, 540]], 4);
    const card = await page.locator('#book .bk-page:not([hidden]) .bk-unit-paper').first().boundingBox();
    await tap(middleOf(card));
    await page.waitForTimeout(60);
    await line();
    await page.locator('#book .bk-sheet').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#book .bk-lift[data-flying]'));
    assert.equal(await page.evaluate(() => window.__wet), 0, 'no line laid as the scrap flew up');
    await tap(middleOf(await page.locator('#book .bk-sheet-keys .bk-sheet-done').boundingBox()));
    await page.waitForTimeout(60);
    await line();
    await page.waitForFunction(
      () => !document.querySelector('#book .bk-pages[data-open]') && !document.querySelector('#book .bk-lift'),
    );
    await page.waitForTimeout(600);
    await c.shot('phone-page-flights', page);
    assert.equal(await page.evaluate(() => window.__wet), 0, 'no line laid as it flew back down');
    assert.deepEqual(inkOf(), had, "no group's ink changed in the store");
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// size: the shots' name for the size
async function onlyOpened(browser, c, size, viewport, more) {
  const { page, errors, done } = await opened(browser, c, viewport, more);
  try {
    await c.shot(`${size}-page`, page);
    await nothingToDrawWith(page, 'on the page');
    const [card] = await unitBoxes(page);
    assert.ok(card.width >= CARD_W, `its cards ${card.width} px wide`);
    const mouse = mouseOf(page);
    await openScrap(page, mouse, await firstCard(page));
    await c.shot(`${size}-page-scrap-open`, page);
    await toolsShown(page);
    await closeScrap(page, mouse);
    await nothingToDrawWith(page, 'after Done');
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// The Notebook open on its page, its tall picture's scrap in it
async function opened(browser, c, viewport, more) {
  const notebooks = JSON.parse(await readFile(new URL('../mock/notebook.json', import.meta.url), 'utf8'));
  notebooks.groups.find(g => g.id === TALL.group).pictures[0].h = TALL.h;
  const book = await open(browser, c, viewport, { ...more, notebooks });
  await until(() => unitBoxes(book.page).then(u => u.length), 'the scraps laid');
  return book;
}
// The first scrap's card shown on the page: its group's id
const firstCard = page =>
  page.locator('#book .bk-page:not([hidden]) .bk-unit[data-unit]').first().getAttribute('data-unit').then(Number);
// The scraps' cards shown, each its box on the screen
const unitBoxes = page =>
  page
    .locator('#book .bk-page:not([hidden]) .bk-unit-paper')
    .evaluateAll(all =>
      all.map(el => el.getBoundingClientRect()).filter(r => r.width && r.bottom > 0 && r.top < innerHeight),
    );
// No tool, Undo or Redo showing
async function nothingToDrawWith(page, where) {
  const shown = await page.evaluate(() =>
    [...document.querySelectorAll('#book :is(.bk-strip, .bk-undo, .bk-redo)')]
      .filter(el => el.checkVisibility({ opacityProperty: true }))
      .map(el => el.getAttribute('aria-label') ?? el.className),
  );
  assert.deepEqual(shown, [], `nothing to draw with ${where}`);
}
// The tools, Undo and Redo showing on an opened scrap: the tools' box
async function toolsShown(page) {
  const strip = page.locator('#book .bk-strip');
  await strip.waitFor({ state: 'visible' });
  for (const key of ['.bk-scrap-history button:first-child', '.bk-scrap-history button:last-child'])
    assert.ok(await strip.locator(key).isVisible(), `${key} on the opened scrap's tools`);
  return strip.boundingBox();
}
