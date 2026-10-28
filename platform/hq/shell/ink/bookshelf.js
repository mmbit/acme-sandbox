// The overview's two screens, drawn on the book's paper (bookzoom.js steps between them and the page): a notebook's
// pages as a grid, and the Shelf of every notebook with the Archive beside it.
// - The pages: each a small picture of the page in the notebook's order, its title under it and a stamp on one that
//   was sent; a tap opens it. New page at the end (in My Notebook). A page dragged to another place (held a moment
//   first with a finger, so a finger still scrolls) or moved with Alt and the arrows takes it; a page's small box
//   archives it, Undo a tap away, and the notebook's archived pages show behind "Archived".
// - The Shelf: every notebook as a small black hardcover with its name on a label, My Notebook first, the newest next;
//   a tap opens its pages. The Archive tab: the archived notebooks, the same grid. A notebook's small box archives it
//   or brings it back (never My Notebook).
// Its head holds what's used from here: Search and the phone (bookui.js's overview island). What it reads and does is
// notebookdata.js's; the grid's numbers bookshelfgrid.js's. Drawn at once from what it read last, read again behind.
import { showGuestNotebooks } from './bookinvites.js';
import { esc } from '../../util.js';
import { island } from './bookui.js';
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
import { ICONS, bookTile, pageTile } from './bookshelftiles.js';
import { cancel, drags, flip } from './bookshelfdrag.js';
import { stamp } from './bookpaper.js';

// the grids' cells: at least this wide, this far apart, at most this many across; a page's picture this tall to its
// width, a cover this tall to its width (bookshelf.css's aspect-ratio)
const PAGES = { least: 108, gap: 16, most: 8 },
  BOOKS = { least: 100, gap: 22, most: 6 };
// the first read of a screen: how long a turn waits for it before it turns onto the screen still filling in
const FIRST_MS = 200;
// how long Undo stays offered
const UNDO_MS = 6000;
const HTML = `<div class="bk-far-head" role="presentation"><nav class="bk-far-nav"></nav></div>
  <div class="bk-far-body" role="presentation"></div>`;

// far: the overview's element, empty. dev: on mock data. current(): the notebook the book shows, a promise of its id
// (null: none on the Shelf, whose pages are then the Shelf); page(): the page it shows (its id); saved(): what's drawn
// saved in the store, before each read. open(page, id): a page of notebook id opened; shelf(): the Shelf;
// notebook(id): a notebook's pages.
// Returns { show(level, id), again(), hide() }: show draws 'pages' (notebook id's; null: current()'s) or 'shelf', at
// once from what it read before, and resolves once it's read (the first time only, FIRST_MS at most: a turn never
// waits on the store).
export function mountScreens(far, { dev, current, page, saved, open, shelf, notebook }) {
  far.innerHTML = HTML;
  const s = {
    far,
    dev,
    current,
    page,
    saved,
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
  };
  far.querySelector('.bk-far-head').prepend(island('overview'));
  mountTold(s);
  far.addEventListener('click', e => clicked(s, e));
  far.addEventListener('keydown', e => keyed(s, e));
  drags(s, (from, to) => reorder(s, from, to));
  // (the store's notebooks changed: read again while it shows)
  for (const name of ['book:changed', 'book:notebook']) document.addEventListener(name, () => s.level && refresh(s));
  // (a wider or narrower book: the grids' columns again)
  let width = 0;
  new ResizeObserver(() => {
    if (!s.level || far.clientWidth === width) return;
    width = far.clientWidth;
    columns(s);
  }).observe(far);
  return {
    show: (level, id) => show(s, level, id),
    again: () => refresh(s),
    hide: () => {
      s.level = null;
      cancel(s);
      told(s, null);
    },
  };
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
  if (s.level && !s.press?.lifted) draw(s);
}
function draw(s) {
  const { far } = s;
  far.dataset.tab = s.tab;
  far.setAttribute('role', 'list');
  // (the Shelf or the Archive: its tabs say which)
  far.setAttribute('aria-label', 'The overview');
  if (s.level === 'pages' && s.id !== null) drawPages(s);
  else drawShelf(s);
  if (s.lost)
    s.body.insertAdjacentHTML('beforeend', `<p class="bk-far-none bk-far-lost">${esc(s.lost)} Tap to try again.</p>`);
  columns(s);
}

// The notebook's pages: its head (back to the Shelf, its name, its archived pages), its grid, then New page
function drawPages(s) {
  const read = s.read.books.get(s.id),
    book =
      read?.notebook ?? [...(s.read.shelf?.shelf ?? []), ...(s.read.shelf?.archive ?? [])].find(n => n.id === s.id),
    archived = read?.archived ?? [];
  s.head.innerHTML = `<button type="button" class="bk-far-go" data-go="shelf" aria-label="The Shelf: every notebook">${
    ICONS.shelf
  }<span>Shelf</span></button><b class="bk-far-title">${esc(book?.name ?? '')}</b>${
    archived.length || s.archived
      ? `<button type="button" class="bk-far-go bk-far-toggle" data-archived aria-pressed="${s.archived}">Archived <small>${archived.length}</small></button>`
      : ''
  }`;
  if (!read) return void (s.body.innerHTML = '');
  stamped(s, read);
  const here = s.id === s.here ? s.page() : null,
    adds = book?.kind === 'mine';
  s.body.innerHTML = `<div class="bk-grid" data-grid="pages" role="presentation">${read.pages
    .map((p, i) => pageTile(p, i, { here, drag: true }))
    .join('')}${
    adds
      ? `<div class="bk-tile bk-tile-new" role="listitem"><button type="button" class="bk-tile-open" data-new aria-label="New page"><span class="bk-tile-paper">${ICONS.add}</span><span class="bk-tile-name"><span>New page</span></span></button></div>`
      : ''
  }</div>${!read.pages.length && !adds ? '<p class="bk-far-none">No pages here yet.</p>' : ''}${
    s.archived && archived.length
      ? `<h3 class="bk-far-sub">Archived</h3><div class="bk-grid" data-grid="pages" role="presentation">${archived
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
// The Shelf, or the Archive: its tabs, and its notebooks as hardcovers
function drawShelf(s) {
  const read = s.read.shelf,
    archive = s.tab === 'archive',
    tab = (name, words, n = '') =>
      `<button type="button" role="tab" data-tab="${name}" aria-selected="${s.tab === name}">${words}${
        n === '' ? '' : ` <small>${n}</small>`
      }</button>`;
  s.head.innerHTML = `<div class="bk-tabs" role="tablist" aria-label="Notebooks">${tab('shelf', 'Shelf')}${tab(
    'archive',
    'Archive',
    read?.archive.length || '',
  )}</div><button type="button" class="bk-far-go" data-invite>Invite</button>`;
  if (!read) return void (s.body.innerHTML = '');
  const books = shelfOrder(archive ? read.archive : read.shelf),
    here = s.here;
  s.body.innerHTML = books.length
    ? `<div class="bk-grid" data-grid="books" role="presentation">${books.map(n => bookTile(n, n.id === here)).join('')}</div>`
    : `<p class="bk-far-none">${archive ? 'Nothing archived. A notebook archived from the Shelf waits here.' : 'No notebooks yet.'}</p>`;
}
// The grids' columns for the paper's width now: as many as fit (bookshelfgrid.js)
function columns(s) {
  for (const grid of s.body.querySelectorAll('.bk-grid')) {
    const { cols, w } = gridOf(grid.clientWidth, grid.dataset.grid === 'books' ? BOOKS : PAGES);
    grid.style.setProperty('--cols', cols);
    grid.style.setProperty('--cell', `${Math.floor(w)}px`);
  }
}
// ---- what a tap does

function clicked(s, e) {
  const t = e.target;
  if (s.swallow) return;
  if (t.closest('[data-invite]')) return showGuestNotebooks();
  if (t.closest('[data-go=shelf]')) return s.hooks.shelf();
  const tab = t.closest('[role=tab]');
  if (tab) return switchTab(s, tab.dataset.tab);
  if (t.closest('[data-archived]')) {
    s.archived = !s.archived;
    return draw(s);
  }
  if (t.closest('.bk-far-lost')) return refresh(s);
  if (t.closest('[data-new]')) return newPage(s);
  const act = t.closest('.bk-tile-act'),
    tile = t.closest('.bk-tile');
  if (!tile) return;
  if (tile.dataset.book) {
    const n = [...s.read.shelf.shelf, ...s.read.shelf.archive].find(b => String(b.id) === tile.dataset.book);
    if (act) return putAway(s, n, act.dataset.act === 'archive');
    if (n.kind === 'round' || n.kind === 'invited') return showGuestNotebooks(n.id);
    return s.hooks.notebook(n.id);
  }
  const read = s.read.books.get(s.id),
    p = [...read.pages, ...read.archived].find(x => String(x.id) === tile.dataset.id);
  if (act) return archive(s, p, act.dataset.act === 'archive');
  if (t.closest('.bk-tile-open')) s.hooks.open(p, s.id);
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
// Undo, and words, beside the overview on the paper, so it never scrolls away
function mountTold(s) {
  Object.assign(s.undo, {
    className: 'bk-told',
    hidden: true,
    innerHTML: '<span></span><button type="button">Undo</button>',
  });
  s.undo.setAttribute('role', 'status');
  s.far.after(s.undo);
  s.undo.querySelector('button').addEventListener('click', () => {
    const undo = s.undoing;
    told(s, null);
    undo?.();
  });
}
// Words at the overview's foot for a moment, with Undo when there's something to undo (null: put away)
function told(s, words, undo = null) {
  clearTimeout(s.undoTimer);
  s.undoing = undo;
  s.undo.hidden = !words;
  if (!words) return;
  s.undo.querySelector('span').textContent = words;
  s.undo.querySelector('button').hidden = !undo;
  s.undoTimer = setTimeout(() => told(s, null), UNDO_MS);
}
// Alt with an arrow on a page's tile moves it a place back or on, the focus going with it
function keyed(s, e) {
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
