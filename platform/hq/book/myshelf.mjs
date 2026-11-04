// book-check.mjs's story of My shelf (shell/ink/bookshelf.js, bookshelfbooks.js, bookshelfcover.js): a bookcase, its
// books standing covers out on its boards, drawn like the notebook itself. The board gives My journal a cover from
// its pages' options (a picture picked on the device); a project's book wears its project's cover, another a drawn one;
// each says its one line under its name and counts its waiting asks on its corner; a round back from Lyra stands there
// in its envelope, beside the Archive's box and the plant. In the Shelf's own window from HQ's Shelf key
// (bookshelfwindow.js), at a phone, an iPad mini upright and sideways, and a desktop: every book, the box and the plant
// inside the window and standing on a board, clear of each other, names and lines unclipped, two to a board on the
// phone and three on the iPad on its side; a book tapped opens on its All pages.
import assert from 'node:assert/strict';
import { errorsOf } from '../../../shared/browser/browser.mjs';
import { DESKTOP, MINI, UPRIGHT, openShelf, until } from './kit.mjs';

const PHONE = { width: 390, height: 844 };
const DAY = 86_400_000,
  at = ms => new Date(ms).toISOString();
// books to a board where the screen says so
const COLS = { phone: 2, 'mini-sideways': 3 };
// how far a thing's foot stands from its board's top edge (straight on: on it), and how far off that a foot may be (px:
// bookshelfbooks.css)
const FOOT_PX = 0,
  FOOT_SLACK_PX = 3;

// c: book-check.mjs's helpers: { base, hqIn(browser, viewport), settled(page, mode), shot, settle }
export function myShelfStories(c) {
  return {
    "My shelf: a bookcase, My journal's cover given from its pages' options, project books with covers, a round's envelope, the Archive's box and the plant on its boards at a phone, an iPad mini both ways and a desktop, nothing overlapping; a book tapped opens on All pages":
      browser => shelves(browser, c),
  };
}

async function shelves(browser, c) {
  const picture = await lighthouse(browser);
  for (const [label, viewport] of [
    ['mini-upright', UPRIGHT],
    ['phone', PHONE],
    ['mini-sideways', MINI],
    ['desktop', DESKTOP],
  ])
    await shelfAt(browser, c, { label, viewport, picture, upload: label === 'mini-upright' });
}

async function shelfAt(browser, c, { label, viewport, picture, upload }) {
  const seed = shelfSeed(upload ? null : `data:image/png;base64,${picture.toString('base64')}`);
  const touch = viewport.width < 800;
  const context = await c.hqIn(browser, viewport, { notebooks: seed, hasTouch: touch, isMobile: touch });
  const page = await context.newPage(),
    errors = errorsOf(page);
  try {
    const shelf = await openShelf(page, c);
    if (upload) await giveCover(page, shelf, c, label, picture);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#book .bk-shelf-window img.bk-cover-art')].every(
        i => i.complete && i.naturalWidth,
      ),
    );
    shelfChecked(await shelfSeen(page), label);
    await c.shot(`myshelf-${label}`, page);
    await opensOnPages(page, shelf, 'Rocketlings', label);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

// A book tapped on the Shelf: the window away, the book open on that notebook's All pages, never on a page
async function opensOnPages(page, shelf, name, label) {
  await shelf.getByRole('button', { name: new RegExp(`^${name},`) }).click();
  await shelf.waitFor({ state: 'hidden' });
  // (and the leaf's turn over: it carries a copy of the page)
  await page.waitForFunction(
    () =>
      document.querySelector('#book')?.dataset.far === 'pages' &&
      !document.querySelector('#book :is(.bk-turn-leaf, .bk-turn-picture, .bk-fx-plane)'),
  );
  const title = page.locator('#book .bk-pages > .bk-far .bk-far-title');
  assert.equal(await title.textContent(), name, `${label}: All pages of ${name}`);
}

// My journal opened from the Shelf, its options' Change cover pressed and the picture picked: kept as a JPEG, and on
// its front once back on the Shelf
async function giveCover(page, shelf, c, label, picture) {
  await opensOnPages(page, shelf, 'My journal', label);
  const far = page.locator('#book .bk-pages > .bk-far');
  await far.getByRole('button', { name: 'Options: My journal', exact: true }).click();
  await c.shot(`myshelf-options-${label}`, page);
  const chooser = page.waitForEvent('filechooser');
  await far.getByRole('menuitem', { name: 'Change cover' }).click();
  await (await chooser).setFiles({ name: 'lighthouse.png', mimeType: 'image/png', buffer: picture });
  await until(
    () => /^data:image\/jpeg;base64,/.test(page.context().notebook.route('/api/notebooks').shelf[0].cover ?? ''),
    `${label}: the cover kept as a JPEG`,
  );
  await far.locator('.bk-far-up[data-go=shelf]').click();
  await shelf.waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#book .bk-shelf-window .bk-book[data-book="1"] img.bk-cover-art')].some(
      i => i.complete && i.naturalWidth,
    ),
  );
}

// Each book's name, line, count and cover as the deck has them; every book, the box and the plant inside the window,
// standing on its board and clear of the others; the books to a board the screen holds
function shelfChecked(seen, label) {
  const books = seen.things.filter(t => t.book);
  assert.deepEqual(
    books.map(b => [b.title, b.line]),
    [
      ['My journal', '1 new answer'],
      ['Rocketlings', '2 asks wait'],
      ['Carrel', 'all read'],
      ['Recurring', 'quiet this week'],
      [null, null],
    ],
    `${label}: each book's name and line`,
  );
  assert.deepEqual(
    books.slice(0, 4).map(b => b.asks),
    ['', '2', '', ''],
    `${label}: asks counted only where they wait`,
  );
  assert.deepEqual(
    books.slice(0, 4).map(b => b.picture),
    [true, true, true, false],
    `${label}: covers`,
  );
  assert.deepEqual(
    seen.things.filter(t => !t.book).map(t => t.what),
    ["the Archive's box", 'the plant'],
    `${label}: the box and the plant on the Shelf`,
  );
  assert.ok(!books.some(b => b.clipped), `${label}: every book's name and line whole`);
  standing(seen, label);
  if (COLS[label]) assert.equal(seen.across, COLS[label], `${label}: ${COLS[label]} books to a board`);
  console.log(`  ${label}: books ${seen.width} px, ${seen.across} to a board`);
}

// Every book, the Archive's box and the plant (seen: shelfSeen's) inside the window, standing on its board and clear
// of the others (at: where, for the messages)
export function standing(seen, at) {
  const name = t => t.title ?? t.what;
  for (const t of seen.things) {
    const where = JSON.stringify({ thing: t, window: seen.window });
    assert.ok(
      t.left >= seen.window.left && t.right <= seen.window.right,
      `${at}: ${name(t)} inside the window ${where}`,
    );
    assert.ok(t.board !== null, `${at}: ${name(t)} on a board`);
    assert.ok(
      Math.abs(t.bottom - (t.board + FOOT_PX)) <= FOOT_SLACK_PX,
      `${at}: ${name(t)} stands on its board (its foot at ${t.bottom}, the board's top at ${t.board})`,
    );
  }
  for (const [i, a] of seen.things.entries())
    for (const b of seen.things.slice(i + 1))
      assert.ok(
        a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
        `${at}: ${name(a)} and ${name(b)} apart`,
      );
}

// What the Shelf shows: the window's sides, and each book's (the Archive's box's, the plant's) box, the top of the
// board it stands on (its row's ::after) and which row that is of how many, and a book's name, line, asks and picture
export const shelfSeen = page =>
  page.evaluate(() => {
    const dialog = document.querySelector('#book .bk-shelf-window'),
      w = dialog.getBoundingClientRect();
    const rows = [...dialog.querySelectorAll('.bk-shelf-row')];
    const boardOf = el => {
      const row = el.closest('.bk-shelf-row');
      if (!row) return null;
      const board = getComputedStyle(row, '::after'),
        r = row.getBoundingClientRect();
      if (board.content === 'none') return null;
      return Math.round(r.bottom - row.clientTop - parseFloat(board.bottom) - parseFloat(board.height));
    };
    const thing = (el, more) => {
      const b = el.getBoundingClientRect();
      return {
        left: Math.round(b.left),
        right: Math.round(b.right),
        top: Math.round(b.top),
        bottom: Math.round(b.bottom),
        board: boardOf(el),
        row: rows.indexOf(el.closest('.bk-shelf-row')),
        ...more,
      };
    };
    const books = [...dialog.querySelectorAll('.bk-book')].map(el => {
      const title = el.querySelector('.bk-cover-title'),
        line = el.querySelector('.bk-cover-line');
      return thing(el, {
        book: true,
        what: `book ${el.dataset.book}`,
        title: title?.textContent ?? null,
        line: line?.textContent ?? null,
        asks: el.querySelector('.bk-asks')?.textContent ?? '',
        picture: !!el.querySelector('img.bk-cover-art'),
        clipped: [title, line].some(t => t && t.scrollWidth > t.clientWidth + 1),
      });
    });
    const others = [
      ...[...dialog.querySelectorAll('.bk-shelf-box')].map(el => thing(el, { what: "the Archive's box" })),
      ...[...dialog.querySelectorAll('.bk-shelf-plant')].map(el => thing(el, { what: 'the plant' })),
    ];
    return {
      window: { left: Math.round(w.left), right: Math.round(w.right) },
      rows: rows.length,
      things: [...books, ...others],
      width: Math.round(dialog.querySelector('.bk-book .bk-cover').getBoundingClientRect().width),
      across: Number(dialog.querySelector('.bk-shelf-row').dataset.cols),
    };
  });

// The Shelf as the deck draws it: My journal (its cover given here, or already), Rocketlings and Carrel with their
// projects' covers, Recurring quiet, and the shop round back from Lyra
function shelfSeed(cover) {
  const now = Date.now(),
    book = (id, kind, name, more) => ({ id, kind, name, created: at(now - 30 * DAY), updated: at(now - DAY), ...more });
  return {
    notebooks: [
      book(1, 'mine', 'My journal', { news: 1, updated: at(now), ...(cover && { cover }) }),
      book(2, 'project', 'Rocketlings', {
        updated: at(now - 3600_000),
        cover: 'covers/rocketlings.png',
        asks: { open: 2, all: 3 },
      }),
      book(3, 'project', 'Carrel', { cover: 'covers/carrel.png', asks: { open: 0, all: 14 } }),
      book(4, 'project', 'Recurring', { updated: at(now - 10 * DAY) }),
      book(5, 'round', 'shop round', {
        updated: at(now - 12 * DAY),
        round: { state: 'back', with: 'Lyra', guests: [], asksOpen: 0, closed: at(now - 3 * DAY), back: at(now - DAY) },
      }),
    ],
    pages: [{ id: 1, notebook: 1, pos: 0, created: at(now - DAY), updated: at(now - DAY), w: 1200, h: 1600 }],
  };
}

// The board's own picture for My journal: a lighthouse drawn in the line style, as a phone's photo would come (PNG)
async function lighthouse(browser) {
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
  try {
    await page.setContent(`<body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 200 200">
<rect width="200" height="200" fill="#dfe9ee"/><circle cx="150" cy="44" r="16" fill="#f4d36b"/>
<g fill="none" stroke="#1d1b17" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
<path d="M84 160 L91 72 L109 72 L116 160 Z" fill="#fbf8f2"/><path d="M86 136h28M88 108h24" />
<rect x="90" y="52" width="20" height="20" rx="2" fill="#fbf8f2"/><path d="M86 52 L100 38 L114 52 Z" fill="#c2402e"/>
<path d="M88 58 L50 46 M88 66 L50 78 M112 58 L150 46 M112 66 L150 78" stroke-dasharray="5 6"/>
<path d="M10 164 q 14 -10 28 0 t 28 0 t 28 0 t 28 0 t 28 0 t 28 0 t 28 0" />
<path d="M24 180 q 14 -10 28 0 t 28 0 t 28 0 t 28 0 t 28 0 t 28 0" /></g></svg></body>`);
    return await page.screenshot({ type: 'png' });
  } finally {
    await page.close();
  }
}
