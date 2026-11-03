// Two screens on the book's paper: a notebook's pages as a grid (the book's overview, bookzoom.js), and the Shelf of
// every notebook with the Archive on it (in its own window over HQ, bookshelfwindow.js). One title line heads each.
// - The pages: "‹ Shelf", the notebook's name and its options (bookshelfoptions.js), then Search (bookzoom.js); its
//   pages split as the book is, under its chapters' plain heads (bookshelftiles.js), each a small picture of the page
//   in the notebook's order, its title and day under it and a stamp on one that was sent; a tap opens it. New page at
//   Sketch's end (in My journal). A page dragged to another place (held a moment first with a finger, so a finger still
//   scrolls) or moved with Alt and the arrows takes it. A page archived (from its own dots menu: archivePage) is
//   crumpled away as a deleted thing is, Undo a tap away; the archived pages show behind the options' Archived pages.
//   A bookmark tapped while it shows scrolls to its chapter.
// - My shelf: a bookcase, every notebook standing covers out on its boards, as many to a board as fit, My journal
//   first, the newest next, the Archive's box after them and the plant (bookshelfbooks.js); a book tapped opens on its
//   pages. The Archive: the archived notebooks in the same bookcase.
// What it reads and does is notebookdata.js's; the grid's numbers bookshelfgrid.js's. Drawn at once from what it read
// last, read again behind.
import { watchGuestBook } from './bookinvites.js';
import { esc } from '../../util.js';
import { scope, word } from './bookscope.js';
// (the Notebook's store)
import { archivePage, createPage, loadPages as loadNotebook, loadShelf, orderPages } from './notebookdata.js';
import { gridOf, moved, shelfFit, shelfOrder } from './bookshelfgrid.js';
import { ICONS, chapterGrids, pageTile } from './bookshelftiles.js';
import { shelfRows } from './bookshelfbooks.js';
import { optionTapped, optionsMenu } from './bookshelfoptions.js';
import { mountCover } from './bookshelfcover.js';
import { cancel, drags, flip } from './bookshelfdrag.js';
import { crumple, stamp } from './bookpaper.js';
import { mountRounds } from './bookshelfround.js';
import { mountTold, told } from './bookshelftold.js';

// the grid's cells: at least this wide, this far apart, at most this many across (a page's picture this tall to its
// width: bookshelf.css's aspect-ratio)
const PAGES = { least: 96, gap: 16, most: 8 };
// the first read of a screen: how long a turn waits for it before it turns onto the screen still filling in
const FIRST_MS = 200;
const HTML = `<div class="bk-far-head" role="presentation"><nav class="bk-far-nav"></nav></div>
  <div class="bk-far-body" role="presentation"></div>`;
// a chapter scrolled to sits this far below the overview's top
const TOP_GAP = 12;

// far: the overview's element, empty. dev: on mock data. current(): the notebook the book shows now, its id (null: none
// on the Shelf, whose pages are then the Shelf); page(): the page it shows (its id); saved(): what's drawn
// saved in the store, before each read. open(page, id): a page of notebook id opened; shelf(): the Shelf (the pages'
// way back to it); notebook(id): a notebook tapped on the Shelf; archived(): a page archived or brought back.
// Returns { show(level), again(), hide(), archive(id) }: show draws 'pages' (current()'s) or 'shelf', at once from what
// it read before of them, and resolves once it's read (the first time only, FIRST_MS at most: a turn never waits on the
// store); archive(id) archives a page of the notebook shown, as it shows.
export function mountScreens(far, { dev, current, page, saved, open, shelf, notebook, archived }) {
  far.innerHTML = HTML;
  const s = {
    ...{ far, dev, current, page, saved },
    hooks: { open, shelf, notebook, archived },
    head: far.querySelector('.bk-far-nav'),
    body: far.querySelector('.bk-far-body'),
    undo: document.createElement('div'),
    level: null, // 'pages' or 'shelf' while it shows
    id: undefined, // the notebook the book shows, as last asked (null: none, on the Shelf; undefined: not asked yet)
    tab: 'shelf', // the Shelf or the Archive
    archived: false, // the notebook's archived pages shown
    read: { shelf: null, books: new Map() }, // what was read last: the Shelf, each notebook's pages
    lost: null, // a read that failed: why
    reading: 0,
    went: new Map(), // each notebook's pages seen sent: a page seen to go since is stamped
    press: null, // a page pressed, maybe picked up
    undoing: null,
    asking: null, // a round whose Close asks first, while asks are open: { id }
    menu: false, // the notebook's options open
    cols: 1, // the Shelf's books to a board
    playing: null, // a round's envelope moving: { id, kind: 'wrap' or 'unwrap' }
  };
  mountTold(s);
  far.addEventListener('click', e => clicked(s, e));
  far.addEventListener('keydown', e => keyed(s, e));
  // (a review round's Close and its envelope: bookshelfround.js; a book's cover: bookshelfcover.js)
  const ui = { draw: () => draw(s), refresh: () => refresh(s), told: words => told(s, words) };
  Object.assign(s, { ui, rounded: mountRounds(s, ui), cover: mountCover(s, ui) });
  drags(s, (from, to, chapter) => reorder(s, from, to, chapter));
  // (the store's notebooks changed: read again while it shows)
  for (const name of ['book:changed', 'book:notebook']) document.addEventListener(name, () => s.level && refresh(s));
  // (a wider or narrower book: the grids' columns again)
  watchGrid(s);
  // (a bookmark tapped over the pages: its chapter scrolled to, bookmarks.js)
  document.addEventListener('book:chapter', e => s.level === 'pages' && toChapter(s, e.detail.chapter));
  return {
    show: level => show(s, level),
    again: () => refresh(s),
    hide: () => {
      s.level = null;
      s.menu = false;
      s.asking = null;
      cancel(s);
      told(s, null);
    },
    archive: id => archiveShown(s, id),
  };
}

function watchGrid(s) {
  const far = s.far;
  let width = 0;
  new ResizeObserver(() => {
    if (!s.level || far.clientWidth === width) return;
    width = far.clientWidth;
    // (the Shelf's boards drawn again for their new width)
    if (s.level === 'shelf') draw(s);
    else columns(s);
  }).observe(far);
}

// ---- reading and drawing

function show(s, level) {
  if (s.level !== level) s.far.scrollTop = 0;
  Object.assign(s, { level, lost: null });
  at(s, s.current());
  const known = level === 'shelf' || s.id === null ? s.read.shelf : s.read.books.get(s.id);
  draw(s);
  const read = refresh(s);
  // (the first time, the leaf waits a moment for it, never longer)
  return known ? undefined : Promise.race([read, new Promise(res => setTimeout(res, FIRST_MS))]);
}
// What shows, read again from the store and drawn once it's in (never under a page being dragged)
async function refresh(s) {
  const n = ++s.reading,
    { level } = s;
  try {
    await s.saved().catch(() => {});
    const id = s.current();
    if (level === 'shelf' || id === null) s.read.shelf = await loadShelf(s.dev);
    else s.read.books.set(id, await loadNotebook(s.dev, id));
    if (n !== s.reading) return;
    at(s, id);
    s.lost = null;
  } catch (e) {
    if (n !== s.reading) return;
    s.lost = e.message;
  }
  if (s.level && !s.press?.lifted && !s.playing) draw(s);
}
// The book's notebook now the one whose pages show: another since, its pages from their top, archived ones put away
function at(s, id) {
  if (s.level === 'pages' && s.id !== undefined && s.id !== id) {
    s.archived = false;
    s.far.scrollTop = 0;
  }
  s.id = id;
}
function draw(s) {
  const { far } = s;
  far.setAttribute('role', 'list');
  // (the Shelf or the Archive: its tabs say which)
  far.setAttribute('aria-label', word('overview'));
  if (s.level === 'pages' && s.id !== null) drawPages(s);
  else drawShelf(s);
  if (s.lost)
    s.body.insertAdjacentHTML(
      'beforeend',
      `<p class="bk-far-none bk-far-lost">${esc(word('tapToRetry', { error: s.lost }))}</p>`,
    );
  columns(s);
}

// The notebook's pages: its title line (back to the Shelf, its name, its options), its chapters' grids (New page at
// Sketch's end), then its archived pages
function drawPages(s) {
  const read = s.read.books.get(s.id),
    book =
      read?.notebook ?? [...(s.read.shelf?.shelf ?? []), ...(s.read.shelf?.archive ?? [])].find(n => n.id === s.id),
    archived = read?.archived ?? [];
  s.head.innerHTML = `${
    scope
      ? '<span></span>'
      : `<button type="button" class="bk-far-up" data-go="shelf" aria-label="The Shelf: every notebook">${ICONS.up}<span>Shelf</span></button>`
  }<h2 class="bk-far-title">${esc(book?.name ?? '')}</h2>${
    scope || !book
      ? '<span></span>'
      : `<button type="button" class="bk-far-more" aria-haspopup="menu" aria-expanded="${s.menu}" aria-label="${esc(
          `Options: ${book.name}`,
        )}">${ICONS.more}</button>${optionsMenu(s, book, archived.length)}`
  }`;
  if (!read) return void (s.body.innerHTML = '');
  stamped(s, read);
  const here = s.page();
  s.body.innerHTML = `${chapterGrids(read.notebook ?? book, read.pages, {
    here,
    drag: !scope,
    adds: book?.kind === 'mine',
  })}${
    s.archived
      ? `<h3 class="bk-far-sub">${esc(word('archivedPages'))}</h3>${
          archived.length
            ? `<div class="bk-grid" data-grid="pages" role="presentation">${archived
                .map(p => pageTile(p, { here, archived: true }))
                .join('')}</div>`
            : `<p class="bk-far-none bk-far-empty">${esc(word('noPages'))}</p>`
        }`
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
// My shelf, or its Archive: one title line (the way back from the Archive, its name, the window's Close after it:
// bookshelfwindow.js), then the bookcase. Guests are invited from the work, Share on it (desk.js): no Invite here
function drawShelf(s) {
  const read = s.read.shelf,
    archive = s.tab === 'archive',
    books = read ? shelfOrder(archive ? read.archive : read.shelf) : [];
  s.head.innerHTML = `${
    archive
      ? `<button type="button" class="bk-far-up" data-tab="shelf" aria-label="Back to My shelf">${ICONS.up}<span>My shelf</span></button>`
      : '<span></span>'
  }<h2 class="bk-shelf-title">${archive ? 'Archive' : 'My shelf'}</h2>`;
  if (!read) return void (s.body.innerHTML = '');
  const fit = shelfFit(s.body.clientWidth);
  s.cols = fit.cols;
  s.body.innerHTML = `<div class="bk-shelf" role="presentation" style="--bk-book-w:${fit.book}px;--bk-row-in:${fit.inset}px">${shelfRows(
    books,
    { cols: s.cols, box: archive ? null : read.archive.length, plant: fit.plant },
    n => ({ playing: s.playing?.id === n.id ? s.playing.kind : null }),
  )}</div>${
    archive && !books.length
      ? '<p class="bk-far-none">Nothing archived. A notebook archived from its options waits here.</p>'
      : ''
  }`;
}
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
  if (s.level === 'pages' && optionTapped(s, t, shownBook(s))) return;
  if (t.closest('[data-go=shelf]')) return s.hooks.shelf();
  const tab = t.closest('button[data-tab]');
  if (tab) return switchTab(s, tab.dataset.tab);
  if (t.closest('.bk-far-lost')) return refresh(s);
  if (t.closest('[data-new]')) return newPage(s);
  const act = t.closest('.bk-tile-act'),
    tile = t.closest('.bk-tile');
  if (!tile) return;
  if (tile.dataset.book) {
    const n = [...s.read.shelf.shelf, ...s.read.shelf.archive].find(b => String(b.id) === tile.dataset.book);
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
  if (act) return archive(s, p, false);
  if (t.closest('.bk-tile-open')) s.hooks.open(p, s.id);
}
// The notebook whose pages show, as last read
const shownBook = s =>
  s.read.books.get(s.id)?.notebook ??
  [...(s.read.shelf?.shelf ?? []), ...(s.read.shelf?.archive ?? [])].find(n => n.id === s.id);

function switchTab(s, tab) {
  if (tab === s.tab) return;
  s.tab = tab;
  flip(s, () => draw(s));
}
// A chapter's head scrolled to the overview's top
function toChapter(s, chapter) {
  const head = s.body.querySelector(`.bk-far-chapter[data-chapter="${CSS.escape(chapter)}"]`);
  if (!head) return;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  s.far.scrollTo({ top: head.offsetTop - TOP_GAP, behavior: still ? 'auto' : 'smooth' });
}
// A page of the notebook shown archived from its own dots menu: once its grid shows, as a tap on its tile would
async function archiveShown(s, id) {
  if (!s.read.books.has(s.id)) await refresh(s);
  const p = s.read.books.get(s.id)?.pages.find(x => String(x.id) === String(id));
  if (p) return archive(s, p, true);
}

// A page archived (or brought back): gone from the grid at once, an archived one's picture crumpled away over it, Undo
// offered; the store's word read in once it's answered. A refusal puts it back, saying why.
async function archive(s, p, archived) {
  const id = s.id,
    read = s.read.books.get(id);
  if (archived) crumpled(s, p);
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
  s.hooks.archived();
  if (s.id === id) refresh(s);
}
// A page's tile's picture as it goes, crumpled up and thrown away (bookpaper.js, as a deleted thing, heard as
// it goes; nothing waits on it)
function crumpled(s, p) {
  const paper = s.body.querySelector(`.bk-tile[data-id="${CSS.escape(String(p.id))}"] .bk-tile-paper`);
  if (!paper) return;
  crumple(paper.getBoundingClientRect(), paper.cloneNode(true));
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
// A page moved from one place to another in its chapter's grid: the grid in its new order at once, the store's after
async function reorder(s, from, to, chapter) {
  const id = s.id,
    read = s.read.books.get(id);
  if (from === to || !read) return;
  flip(s, () => {
    const order = moved(
      read.pages.filter(p => p.chapter === chapter),
      from,
      to,
    );
    read.pages = read.pages.map(p => (p.chapter === chapter ? order.shift() : p));
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
  if (e.key === 'Escape' && s.menu) {
    s.menu = false;
    s.asking = null;
    draw(s);
    return s.head.querySelector('.bk-far-more')?.focus();
  }
  const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key],
    tile = e.target.closest?.('.bk-tile[data-drag]');
  if (!e.altKey || !step || !tile) return;
  e.preventDefault();
  const tiles = [...tile.parentElement.querySelectorAll('.bk-tile[data-drag]')],
    from = tiles.indexOf(tile),
    to = Math.max(0, Math.min(tiles.length - 1, from + step));
  reorder(s, from, to, tile.parentElement.dataset.chapter);
  s.body.querySelector(`.bk-tile[data-id="${CSS.escape(tile.dataset.id)}"] .bk-tile-open`)?.focus();
}
