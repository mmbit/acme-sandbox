// book-check.mjs's stories of a book's bookmarks (shell/ink/bookmarks.js) on its chapters: a chapter with no pages yet,
// its tab marked empty, opens its own empty page, its name at its head, on a phone and a desktop; a round's book has
// Guests, Asks with its open count and Advice, and its Guests tab opens the list of its guests, how far each one's page
// is, a line tapped opening their page, on an iPad mini upright and sideways. (the empty tab and the chapter's pick:
import assert from 'node:assert/strict';
import { LOADED_MS, toChapter, until } from './kit.mjs';
import { SEED, SIZES, journal, onBook, page, shown, tabs } from './bookmarks.mjs';

// My journal with no call yet: Calls has no pages
const NO_CALLS = { ...SEED, notebooks: [journal({ asks: { open: 0, all: 0 } })], pages: SEED.pages.slice(0, 1) };
// A round's book: its three guests' pages, its Asks and, the round done, its Advice; and the board's own journal, which
// the book opens on
const ROUND = {
  ...SEED,
  notebooks: [
    journal({ id: 2 }),
    journal({
      kind: 'round',
      name: 'Shop page round',
      asks: { open: 0, all: 0 },
      round: {
        state: 'done',
        asksOpen: 2,
        guests: [
          { name: 'Anna', page: 11, notes: 2, done: false },
          { name: 'Bas', page: 12, notes: 0, done: false },
          { name: 'Cleo', page: 13, notes: 1, done: true },
        ],
      },
    }),
  ],
  pages: [
    page(11, 0, 'Anna', { guest: 'Anna' }),
    page(12, 1, 'Bas', { guest: 'Bas' }),
    page(13, 2, 'Cleo', { guest: 'Cleo' }),
    page(14, 3, 'Asks', { kind: 'asks' }),
    page(15, 4, 'Advice', { kind: 'advice' }),
    page(21, 0, 'Ideas', { notebook: 2 }),
  ],
  groups: [],
};

// c: book-check.mjs's hqIn, base, shot, noErrorsIn
export function bookmarkChaptersStories(c) {
  return {
    "the book's bookmarks: a chapter with no pages opens its own empty page, on a phone and a desktop":
      async browser => {
        for (const name of ['phone', 'desktop-wide'])
          await onBook(browser, c, name, SIZES[name], NO_CALLS, (p, press) => emptyChapter(p, c, name, press));
      },
    "the book's bookmarks: a round's Guests, Asks and Advice, the Guests tab opening its list of guests, on an iPad mini upright and sideways":
      async browser => {
        for (const name of ['ipad-mini-upright', 'ipad-mini-sideways'])
          await onBook(browser, c, name, SIZES[name], ROUND, (p, press) => guests(p, c, name, press));
      },
  };
}

// A chapter with no pages: its tab marked empty; picked, its own empty page, its name at its head, the tab the page's
// own; another tab picked lets the empty page go
async function emptyChapter(p, c, name, press) {
  const blank = p.locator('#book .bk-mk-blank');
  const empty = await p.evaluate(() =>
    [...document.querySelectorAll('#book .bk-marks .bk-mk-tab')].map(b => [
      b.dataset.chapter,
      b.hasAttribute('data-empty'),
    ]),
  );
  assert.deepEqual(
    empty,
    [
      ['sketch', false],
      ['asks', true],
      ['calls', true],
    ],
    `${name}: Asks and Calls with no pages yet`,
  );
  await toChapter(p, 'calls', press);
  await blank.waitFor({ timeout: LOADED_MS });
  assert.equal(await blank.locator('h2').textContent(), 'Calls', `${name}: Calls' empty page, its name at its head`);
  assert.equal((await shown(p)).here, 'calls', `${name}: Calls the page's own`);
  const covers = await p.evaluate(() => {
    const r = document.querySelector('#book .bk-mk-blank').getBoundingClientRect();
    return document
      .querySelector('#book .bk-mk-blank')
      .contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 3));
  });
  assert.ok(covers, `${name}: the empty page over the page shown`);
  await c.shot(`bookmarks-${name}-empty`, p);
  await toChapter(p, 'sketch', press);
  await blank.waitFor({ state: 'hidden', timeout: LOADED_MS });
  await until(async () => (await shown(p)).here === 'sketch', `${name}: back in Sketch`);
  assert.equal((await shown(p)).title, 'Ideas', `${name}: Sketch's page again`);
}

// A round's tabs: Guests, Asks with its open count, Advice; Guests picked lists its guests, how far each page is, and a
// guest's line opens their page and lets the list go
async function guests(p, c, name, press) {
  const list = p.locator('#book .bk-mk-guests'),
    // (the bookmarks show icons only: each read by its label)
    labels = async () => (await tabs(p)).map(t => t.label).join('; ');
  // (the round's book opened at Anna's page, as a card's Open in the book does)
  await p.evaluate(() => document.dispatchEvent(new CustomEvent('book:find', { detail: { notebook: 1, page: 11 } })));
  await until(async () => (await shown(p)).title === 'Anna', `${name}: the round's book open`, LOADED_MS);
  await until(
    async () => (await labels()) === 'Guests; Asks, 2 open; Advice',
    () => `${name}: a round's chapters`,
  );
  await toChapter(p, 'guests', press);
  await list.waitFor({ timeout: LOADED_MS });
  const lines = await list
    .locator('.bk-mk-guest')
    .evaluateAll(all =>
      all.map(b => [b.querySelector('.bk-mk-name').textContent, b.querySelector('.bk-mk-state').textContent.trim()]),
    );
  assert.deepEqual(
    lines,
    [
      ['Anna', '2 notes'],
      ['Bas', 'nothing yet'],
      ['Cleo', 'done'],
    ],
    `${name}: the round's guests, how far each page is`,
  );
  await c.shot(`bookmarks-${name}-guests`, p);
  await press(list.locator('.bk-mk-guest[data-name=Bas]'));
  await list.waitFor({ state: 'hidden', timeout: LOADED_MS });
  await until(async () => (await shown(p)).title === 'Bas', `${name}: Bas's page opened from the list`, LOADED_MS);
  assert.equal((await shown(p)).here, 'guests', `${name}: Guests the page's own`);
}
