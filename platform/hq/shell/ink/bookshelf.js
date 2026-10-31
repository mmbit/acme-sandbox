// The overview's two screens, drawn on the book's paper (bookzoom.js steps between them and the page): a notebook's
// pages as a grid, and the Shelf of every notebook with the Archive beside it.
// - The pages: each a small picture of the page in the notebook's order, its title under it and a stamp on one that
//   was sent; a tap opens it. New page at the end (in My journal). A page dragged to another place (held a moment
//   first with a finger, so a finger still scrolls) or moved with Alt and the arrows takes it; a page's small box
//   archives it, Undo a tap away, and the notebook's archived pages show behind "Archived".
// - My shelf: every notebook a big book with its cover standing on a shelf board, as many to a row as fit, My journal
//   first, the newest next (bookshelfbooks.js); a tap opens its pages. Its Archive: the archived notebooks, the same
//   way. A book's own menu changes its cover (bookshelfcover.js), archives it or brings it back (never My journal).
// Its head holds what's used from here: Search and the phone (bookui.js's overview island). What it reads and does is
// notebookdata.js's; the grid's numbers bookshelfgrid.js's. Drawn at once from what it read last, read again behind.
import { watchGuestBook } from './bookinvites.js';
import { esc } from '../../util.js';
import { island } from './bookui.js';
import { word } from './bookscope.js';
// (the Notebook's store)
import {
  archiveNotebook,
  archivePage,
  createPage,
  loadPages as loadNotebook,
  loadShelf,
  orderPages,
} from './notebookdata.js';
import { gridOf, moved, shelfOrder } from './bookshelfgrid.js';
import { ICONS, pageTile } from './bookshelftiles.js';
import { shelfRows } from './bookshelfbooks.js';
import { mountCover } from './bookshelfcover.js';
import { cancel, drags, flip } from './bookshelfdrag.js';
import { stamp } from './bookpaper.js';
import { mountOpen } from './bookshelfopen.js';
import { mountRounds } from './bookshelfround.js';
import { mountTold, told } from './bookshelftold.js';

// the grids' cells: at least this wide, this far apart, at most this many across (a page's picture this tall to its
// width: bookshelf.css's aspect-ratio); the Shelf's books the same, bookshelfbooks.css's --bk-book-gap apart (two to
// a row on an iPad mini upright, as the deck has them)
const PAGES = { least: 108, gap: 16, most: 8 },
  BOOKS = { least: 210, gap: 32, most: 6 };
// the first read of a screen: how long a turn waits for it before it turns onto the screen still filling in
const FIRST_MS = 200;
const HTML = `<div class="bk-far-head" role="presentation"><nav class="bk-far-nav"></nav></div>
  <div class="bk-far-body" role="presentation"></div>`;

// far: the overview's element, empty. dev: on mock data. current(): the notebook the book shows, a promise of its id
// (null: none on the Shelf, whose pages are then the Shelf); page(): the page it shows (its id); saved(): what's drawn
// saved in the store, before each read. open(page, id): a page of notebook id opened; shelf(): the Shelf;
// notebook(id): a notebook's pages.
// Returns { show(level, id), again(), hide() }: show draws 'pages' (notebook id's; null: current()'s) or 'shelf', at
// once from what it read before, and resolves once it's read (the first time only, FIRST_MS at most: a turn never
// waits on the store).
export function mountScreens(far, { dev, current, page, saved, open, shelf, notebook, scope = null }) {
  far.innerHTML = HTML;
  const s = {
    ...{ far, scope, dev, current, page, saved },
    hooks: { open, shelf, notebook },
    head: far.querySelector('.bk-far-nav'),
    body: far.querySelector('.bk-far-body'),
    undo: document.createElement('div'),
    level: null, // 'pages' or 'shelf' while it shows
    asked: null, // the notebook asked for (null: the one the book shows)
    here: undefined, // the notebook the book shows, as read last (its id; null: none on the Shelf)
    id: null, // the notebook whose pages show
    tab: 'shelf', // the Shelf or the Archive
    archived: false, // the notebook's archived pages shown
    read: { shelf: null, books: new Map() }, // what was read last: the Shelf, each notebook's pages
    lost: null, // a read that failed: why
    reading: 0,
    went: new Map(), // each notebook's pages seen sent: a page seen to go since is stamped
    press: null, // a page pressed, maybe picked up
    undoing: null,
    asking: null, // a round whose Close asks first, while asks are open: { id }
    menu: null, // the book whose own menu is open (its id, as its tile has it)
    cols: 1, // the Shelf's books to a row
    playing: null, // a round's envelope moving: { id, kind: 'wrap' or 'unwrap' }
  };
  far.querySelector('.bk-far-head').prepend(island('overview'));
  mountTold(s);
  if (!scope) mountOpen(far.querySelector('.bk-far-head'), { open }); // (the open forms and questions)
  far.addEventListener('click', e => clicked(s, e));
  far.addEventListener('keydown', e => keyed(s, e));
  // (a review round's Close and its envelope: bookshelfround.js; a book's cover: bookshelfcover.js)
  const ui = { draw: () => draw(s), refresh: () => refresh(s), told: words => told(s, words) };
  Object.assign(s, { rounded: mountRounds(s, ui), cover: mountCover(s, ui) });
  drags(s, (from, to) => reorder(s, from, to));
  // (the store's notebooks changed: read again while it shows)
  for (const name of ['book:changed', 'book:notebook']) document.addEventListener(name, () => s.level && refresh(s));
  // (a wider or narrower book: the grids' columns again)
  watchGrid(s);
  return {
    show: (level, id) => show(s, level, id),
    again: () => refresh(s),
    hide: () => {
      s.level = null;
      s.menu = null;
      cancel(s);
      told(s, null);
    },
  };
}

function watchGrid(s) {
  const far = s.far;
  let width = 0;
  new ResizeObserver(() => {
    if (!s.level || far.clientWidth === width) return;
    width = far.clientWidth;
    // (the Shelf's rows drawn again for a new count to a row)
    if (s.level === 'shelf' && shelfCols(s) !== s.cols) draw(s);
    else columns(s);
  }).observe(far);
}

// ---- reading and drawing

function show(s, level, asked) {
  const id = asked ?? s.here;
  if (s.level !== level || s.id !== id) s.far.scrollTop = 0;
  if (s.id !== id) s.archived = false;
  Object.assign(s, { level, asked, id, lost: null });
  const known = level === 'shelf' ? s.read.shelf : s.read.books.get(id);
  draw(s);
  const read = refresh(s);
  // (the first time, the leaf waits a moment for it, never longer)
  return known ? undefined : Promise.race([read, new Promise(res => setTimeout(res, FIRST_MS))]);
}
// What shows, read again from the store and drawn once it's in (never under a page being dragged)
async function refresh(s) {
  const n = ++s.reading,
    { level, asked } = s;
  try {
    await s.saved().catch(() => {});
    const here = await s.current(),
      id = asked ?? here;
    if (level === 'shelf' || id === null) s.read.shelf = await loadShelf(s.dev);
    else s.read.books.set(id, await loadNotebook(s.dev, id));
    if (n !== s.reading) return;
    Object.assign(s, { here, id, lost: null });
  } catch (e) {
    if (n !== s.reading) return;
    s.lost = e.message;
  }
  if (s.level && !s.press?.lifted && !s.playing) draw(s);
}
function draw(s) {
  const { far } = s;
  far.setAttribute('role', 'list');
  // (the Shelf or the Archive: its tabs say which)
  far.setAttribute('aria-label', word('The overview'));
  if (s.level === 'pages' && s.id !== null) drawPages(s);
  else drawShelf(s);
  if (s.lost)
    s.body.insertAdjacentHTML(
      'beforeend',
      `<p class="bk-far-none bk-far-lost">${esc(word('{error} Tap to try again.', { error: s.lost }))}</p>`,
    );
  columns(s);
}

// The notebook's pages: its head (back to the Shelf, its name, its archived pages), its grid, then New page
function drawPages(s) {
  const read = s.read.books.get(s.id),
    book =
      read?.notebook ?? [...(s.read.shelf?.shelf ?? []), ...(s.read.shelf?.archive ?? [])].find(n => n.id === s.id),
    archived = read?.archived ?? [];
  s.head.innerHTML = `${
    s.scope
      ? ''
      : `<button type="button" class="bk-far-go" data-go="shelf" aria-label="The Shelf: every notebook">${
          ICONS.shelf
        }<span>Shelf</span></button>`
  }<b class="bk-far-title">${esc(book?.name ?? '')}</b>${
    archived.length || s.archived
      ? `<button type="button" class="bk-far-go bk-far-toggle" data-archived aria-pressed="${s.archived}">${word('Archived')} <small>${archived.length}</small></button>`
      : ''
  }`;
  if (!read) return void (s.body.innerHTML = '');
  stamped(s, read);
  const here = s.id === s.here ? s.page() : null,
    adds = book?.kind === 'mine';
  s.body.innerHTML = `<div class="bk-grid" data-grid="pages" role="presentation">${read.pages
    .map((p, i) => pageTile(p, i, { here, drag: !s.scope, manage: !s.scope }))
    .join('')}${
    adds
      ? `<div class="bk-tile bk-tile-new" role="listitem"><button type="button" class="bk-tile-open" data-new aria-label="${word('New page')}"><span class="bk-tile-paper">${ICONS.add}</span><span class="bk-tile-name"><span>${word('New page')}</span></span></button></div>`
      : ''
  }</div>${!read.pages.length && !adds ? `<p class="bk-far-none">${word('No pages here yet.')}</p>` : ''}${
    s.archived && archived.length
      ? `<h3 class="bk-far-sub">${word('Archived')}</h3><div class="bk-grid" data-grid="pages" role="presentation">${archived
          .map((p, i) => pageTile(p, i, { here, archived: true }))
          .join('')}</div>`
      : ''
  }`;
}
// Once the page grid is drawn, a page seen to go since it was last drawn has its stamp pressed on (none the first time)
function stamped(s, read) {
  const sent = new Set(read.pages.filter(p => p.sent).map(p => String(p.id))),
    seen = s.went.get(s.id);
  s.went.set(s.id, sent);
  if (!seen) return;
  queueMicrotask(() => {
    for (const id of sent)
      if (!seen.has(id)) {
        const mark = s.body.querySelector(`.bk-tile[data-id="${CSS.escape(id)}"] .bk-stamp`);
        if (mark) stamp(mark);
      }
  });
}
// My shelf, or its Archive: its name in hand and its count, the way to the other; its books in rows, each on its shelf
// board. Guests are invited from the work, Share on it (desk.js): no Invite here
function drawShelf(s) {
  const read = s.read.shelf,
    archive = s.tab === 'archive',
    books = read ? shelfOrder(archive ? read.archive : read.shelf) : [],
    away = read?.archive.length;
  s.head.innerHTML = `<h2 class="bk-shelf-title">${archive ? 'Archive' : 'My shelf'}</h2>${
    read ? `<span class="bk-shelf-count">${books.length} ${books.length === 1 ? 'book' : 'books'}</span>` : ''
  }<button type="button" class="bk-far-go" data-tab="${archive ? 'shelf' : 'archive'}">${
    archive ? 'My shelf' : `Archive${away ? ` <small>${away}</small>` : ''}`
  }</button>`;
  if (!read) return void (s.body.innerHTML = '');
  s.cols = shelfCols(s);
  s.body.innerHTML = books.length
    ? `<div class="bk-shelf" role="presentation">${shelfRows(books, s.cols, n => ({
        here: n.id === s.here,
        menu: s.menu === String(n.id),
        asking: s.asking?.id === n.id ? n.round.asksOpen : null,
        playing: s.playing?.id === n.id ? s.playing.kind : null,
      }))}</div>`
    : `<p class="bk-far-none">${archive ? 'Nothing archived. A notebook archived from My shelf waits here.' : 'No notebooks yet.'}</p>`;
}
const shelfCols = s => gridOf(s.body.clientWidth, BOOKS).cols;
// The grids' columns for the paper's width now: as many as fit (bookshelfgrid.js)
function columns(s) {
  for (const grid of s.body.querySelectorAll('.bk-grid')) {
    const { cols, w } = gridOf(grid.clientWidth, PAGES);
    grid.style.setProperty('--cols', cols);
    grid.style.setProperty('--cell', `${Math.floor(w)}px`);
  }
}
// ---- what a tap does

function clicked(s, e) {
  const t = e.target;
  if (s.swallow) return;
  if (t.closest('[data-go=shelf]')) return s.hooks.shelf();
  const tab = t.closest('button[data-tab]');
  if (tab) return switchTab(s, tab.dataset.tab);
  if (t.closest('[data-archived]')) {
    s.archived = !s.archived;
    return draw(s);
  }
  if (t.closest('.bk-far-lost')) return refresh(s);
  if (t.closest('[data-new]')) return newPage(s);
  const act = t.closest('.bk-tile-act'),
    tile = t.closest('.bk-tile');
  if (s.level === 'shelf' && menued(s, t)) return;
  if (!tile) return;
  if (tile.dataset.book) {
    const n = [...s.read.shelf.shelf, ...s.read.shelf.archive].find(b => String(b.id) === tile.dataset.book),
      shelf = t.closest('[data-shelf]')?.dataset.shelf;
    if (shelf === 'cover') return s.cover(n);
    if (shelf) return putAway(s, n, shelf === 'archive');
    if (n.kind === 'round' && n.round) {
      const round = t.closest('[data-round]')?.dataset.round;
      if (round) return s.rounded(n, round);
      if (n.round.state === 'away') return told(s, `With ${n.round.with}'s team: it comes back here with the Advice.`);
    }
    if (n.kind === 'invited') return watchGuestBook(n.id);
    return s.hooks.notebook(n.id);
  }
  const read = s.read.books.get(s.id),
    p = [...read.pages, ...read.archived].find(x => String(x.id) === tile.dataset.id);
  if (act) return archive(s, p, act.dataset.act === 'archive');
  if (t.closest('.bk-tile-open')) s.hooks.open(p, s.id);
}

// A book's own menu: its button opens it (or shuts it again); a tap anywhere else shuts it, and does nothing more
// unless it's one of its items. Whether the tap's done with.
function menued(s, t) {
  const more = t.closest('.bk-book-more'),
    item = t.closest('.bk-book-menu [role=menuitem]');
  if (!more && s.menu == null) return false;
  const id = more?.closest('.bk-tile').dataset.book;
  s.menu = id && id !== s.menu ? id : null;
  draw(s);
  s.body.querySelector('.bk-book-menu [role=menuitem]')?.focus();
  return !item;
}

function switchTab(s, tab) {
  if (tab === s.tab) return;
  s.tab = tab;
  flip(s, () => draw(s));
}

// A page archived (or brought back): gone from the grid at once, Undo offered; the store's word read in once it's
// answered. A refusal puts it back, saying why.
async function archive(s, p, archived) {
  const id = s.id,
    read = s.read.books.get(id);
  flip(s, () => {
    read.pages = archived ? read.pages.filter(x => x !== p) : [...read.pages, { ...p, archived }];
    read.archived = archived ? [...read.archived, { ...p, archived }] : read.archived.filter(x => x !== p);
    if (!read.archived.length) s.archived = false;
    draw(s);
  });
  told(s, archived ? 'Page archived.' : 'Page back in the notebook.', () => archive(s, { ...p, archived }, !archived));
  try {
    await archivePage(s.dev, p.id, archived);
  } catch (e) {
    told(s, e.message);
  }
  if (s.id === id) refresh(s);
}
// A notebook archived or back on the Shelf, the same way
async function putAway(s, n, archived) {
  const read = s.read.shelf,
    moved_ = { ...n, archived };
  flip(s, () => {
    read.shelf = archived ? read.shelf.filter(x => x !== n) : [...read.shelf, moved_];
    read.archive = archived ? [...read.archive, moved_] : read.archive.filter(x => x !== n);
    draw(s);
  });
  told(s, archived ? `${n.name} archived.` : `${n.name} back on the Shelf.`, () => putAway(s, moved_, !archived));
  try {
    await archiveNotebook(s.dev, n.id, archived);
  } catch (e) {
    told(s, e.message);
  }
  if (s.level === 'shelf') refresh(s);
}
// New page: a blank one at the notebook's end, opened
async function newPage(s) {
  const id = s.id;
  try {
    const p = await createPage(s.dev, id);
    s.read.books.delete(id);
    s.hooks.open(p, id);
  } catch (e) {
    told(s, e.message);
  }
}
// A page moved from one place to another in the grid: the grid in its new order at once, the store's after
async function reorder(s, from, to) {
  const id = s.id,
    read = s.read.books.get(id);
  if (from === to || !read) return;
  flip(s, () => {
    read.pages = moved(read.pages, from, to);
    draw(s);
  });
  try {
    const answer = await orderPages(
      s.dev,
      id,
      [...read.pages, ...read.archived].map(p => p.id),
    );
    if (s.id === id && !s.press?.lifted) {
      s.read.books.set(id, answer);
      draw(s);
    }
  } catch (e) {
    told(s, e.message);
    refresh(s);
  }
}
// Alt with an arrow on a page's tile moves it a place back or on, the focus going with it
function keyed(s, e) {
  if (e.key === 'Escape' && s.menu != null) {
    s.menu = null;
    return draw(s);
  }
  const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key],
    tile = e.target.closest?.('.bk-tile[data-drag]');
  if (!e.altKey || !step || !tile) return;
  e.preventDefault();
  const tiles = [...tile.parentElement.querySelectorAll('.bk-tile[data-drag]')],
    from = tiles.indexOf(tile),
    to = Math.max(0, Math.min(tiles.length - 1, from + step));
  reorder(s, from, to);
  s.body.querySelector(`.bk-tile[data-id="${CSS.escape(tile.dataset.id)}"] .bk-tile-open`)?.focus();
}
