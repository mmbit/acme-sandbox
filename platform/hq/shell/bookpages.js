// The pages inside the book: one page fills the book's paper, endless (its paper and dots drawn wherever it's panned or
// zoomed, bookview.js), its heading written at its top-left; a day's pages one after another, changed from the pages
// control or the overview with a turn of the leaf (bookflip.js), never by panning past an edge; a blank page only on a
// day with none yet, or New page's; the pen writing, the page growing to hold
// what's on it, each page saved as it's drawn on; and the place it was left, per screen shape. (one endless page; was a row of pages on a table)
//
// Moving about the page is bookpan.js; the overview bookzoom.js; the controls bookcontrols.js; one page's ink
// bookpage.js; writing bookwrite.js; the maths bookrow.js; saving booksave.js; the store's routes bookdata.js; the
// mouse's tools booktools.js, asked in this order on a press on the paper: a pan (bookpan.js), then book.tools.press(e), then ink.
import { pen } from '/__review/ink.js';
import { store } from '../util.js';
import { loadDay, loadPage } from './bookdata.js';
import { changed, readAgain, readAt, said, saveAll } from './booksave.js';
import { pageView } from './bookpage.js';
import { panning } from './bookpan.js';
import { mountZoom } from './bookzoom.js';
import { headOf, nameOf } from './bookhead.js';
import { mountTape } from './booktape.js';
import { mountSheets } from './booksheet.js';
import { mountControls } from './bookcontrols.js';
import { turn } from './bookflip.js';
import { actualSize, at, draw, halt, setView, shown, slideTo, viewOf, zoomBy } from './bookview.js';
import { grownTo, newPageSize, placeIn, scrapBoxOf, showsBox, spanOf } from './bookrow.js';
import { stepList, undo, redo } from './bookedit.js';
import { INK, drawable, dried, endLostLines } from './bookwrite.js';

const HTML = `<div class="bk-pages">
  <div class="bk-desk"><div class="bk-world"></div><canvas class="bk-wet"></canvas><p class="bk-lost" hidden></p></div>
</div>`;

// paper: the book's paper, empty. dev: on mock data. shape(): the screen's shape ('landscape' | 'portrait' | 'narrow'
// | 'wide'), for the place remembered. undo() takes back the book's last step; page() is the page shown (its summary),
// or null on the blank page.
export function mountPages(paper, { dev, shape }) {
  paper.innerHTML = HTML;
  const book = bookOf(paper, { dev, shape });
  book.steps = stepList(book);
  // (what the mouse's tools and the pages' parts ask of the page: booktools.js, booktape.js)
  Object.assign(book, {
    at: (x, y) => at(book, x, y),
    shown: () => shown(book),
    view: () => viewOf(book),
    remember: () => remember(book),
    far: () => book.zoom.level() !== 'page',
    zoomed: () => book.controls?.update(),
  });
  const table = (book.table = panning(book.desk, book, { drawing: () => book.ink.drawing }));
  book.ink = pen(book.desk, paper.querySelector('.bk-wet'), {
    use: e => drawable(book, e, table),
    // (the wet line as thick on screen as it dries at this zoom)
    ink: () => ({ ...book.inking, size: book.inking.size * book.scale }),
    end: stroke => dried(book, stroke, { lay: () => lay(book), inView: (i, box) => inView(book, i, box) }),
    // (its dry ink is the page's canvases, which a call's watch-along records)
    pictured: true,
  });
  endLostLines(book);
  mountTape(book, paper, { openDay, lay, inView, blank }); // (pictures taped in.)
  book.sheets = mountSheets(book, sheetHooks(book, table));
  book.lost.onclick = () => openDay(book, book.day ?? undefined);
  book.zoom = mountZoom(paper.querySelector('.bk-pages'), book, {
    title: nameOf,
    open: (day, id) => (day === book.day ? goTo(book, id && { page: id }) : openDay(book, day, id && { page: id })),
    turn: (dir, midway) => turn(paper, { dir, midway }),
    changed: () => book.controls?.update(),
  });
  book.controls = mountControls(book, controlsOf(book));
  // (the mouse's tools, once they're there: booktools.js)
  import('./booktools.js').then(m => (book.tools = m.mountTools(book, paper, toolHooks(book))));
  // (an invited person's book from the rail)
  document.addEventListener('book:person', e => openBookOf(book, e.detail));
  document.addEventListener('book:changed', e => wroteTo(book, e.detail?.page));
  new ResizeObserver(() => resized(book)).observe(book.desk);
  document.addEventListener('visibilitychange', () => document.hidden && saveAll(book));
  const place = store.get(placeKey(book), null);
  openDay(book, place?.day, place);
  const api = {
    undo: () => stepped(book, undo),
    redo: () => stepped(book, redo),
    page: () => shownPage(book),
    show: id => show(book, id),
  };
  return { ...api, find: at => find(book, at), made: id => made(book, id) }; // (find; made: book.js)
}
// A page made outside the book (a call's, a note's first on an agent's work): today read again at it, once however
// many tell of it (the page's maker and the note on it).
function made(book, id) {
  if (id && book.making?.id === id) return book.making.read;
  const read = openDay(own(book), undefined, id && { page: id }).finally(() => {
    if (book.making?.read === read) book.making = null;
  });
  book.making = { id, read };
  return read;
}
// A page the store wrote to (id: an answer typed under the board's question), read again if it's here and read: one not
// read yet reads whole when shown, and one being typed in merges it at its save.
function wroteTo(book, id) {
  const v = id && book.views.find(x => x.page.id === id);
  if (v?.page.base && !book.tools?.editing()) readAgain(book, v.page).then(() => lay(book));
}

// The book's state as it opens on the paper
function bookOf(paper, { dev, shape }) {
  return {
    dev,
    shape,
    paper,
    desk: paper.querySelector('.bk-desk'),
    world: paper.querySelector('.bk-world'),
    lost: paper.querySelector('.bk-lost'),
    day: null,
    today: null,
    days: [],
    views: [],
    cur: -1, // the page shown, of the day's
    pan: { x: 0, y: 0 },
    scale: 1,
    size: { w: 0, h: 0 },
    cams: new WeakMap(), // a page's view as it was left this visit: page → { pan, scale }
    // the book's steps this visit, the last last, for Undo: each { undo(), redo() } (a stroke, a note moved, a send: one
    // that can't be made again has no redo), and those undone, for Redo (bookedit.js). (redo: job #19243)
    steps: null,
    undone: [],
    target: -1, // the page under the stroke being drawn
    inking: INK, // the stroke's ink, as it started
    waiting: undefined, // the place to open (goTo's) once the paper has a size
    who: null, // the book open: the board's own (null), or an invited person's ({ who, name, colour }: whose)
    whose: null,
  };
}

// ---- a day's pages

// A day's pages (today's a blank one when it has none: never one the board didn't ask for beside its pages), at the
// remembered place or its last page
async function openDay(book, day, place = null) {
  saveAll(book);
  const who = book.who;
  let read;
  try {
    read = await loadDay(book.dev, day, who);
  } catch (e) {
    if (book.who !== who) return;
    book.lost.textContent = `${e.message} Tap to try again.`;
    book.lost.hidden = false;
    return;
  }
  if (book.who !== who) return; // (another book was opened while this one was read)
  book.lost.hidden = true;
  // (a remembered day that has no pages any more: today instead)
  if (day && read.day !== read.today && !read.pages.length) return openDay(book);
  Object.assign(book, { day: read.day, today: read.today, days: read.days.map(d => d.day) });
  const pages = read.pages.map(s => recordOf(s, who));
  if (book.day === book.today && !pages.length) pages.push(blankPage(book));
  for (const v of book.views) {
    v.drop();
    v.el.remove();
  }
  Object.assign(book, { views: [], steps: stepList(book), undone: [], cur: -1 });
  pages.forEach(p => addView(book, p));
  goTo(book, place);
  if (!book.who) book.sheets?.drawAll();
  book.zoom.again();
  document.dispatchEvent(new CustomEvent('book:whose', { detail: { who: book.who } })); // (the rail's: job #19223)
}
// Another's book open in this one, an invited person's from the rail ({ who, name, colour }), or the board's own again
// (null): its days, the pen writing in the board's ink on their pages. No sheets there, nor a place remembered.
function openBookOf(book, person) {
  if ((person?.who ?? null) === book.who) return;
  saveAll(book);
  book.zoom.near();
  Object.assign(book, { who: person?.who ?? null, whose: person, days: [] });
  return openDay(book, undefined, person ? null : store.get(placeKey(book), null));
}
// The board's own book, back from another's at once (a face's sheet, Search's find, a page made outside the book)
const own = book => (book.who && Object.assign(book, { who: null, whose: null }), book);
// A page as the book keeps it while it shows: its summary, and its ink, pictures and typed text once read (who: the
// book it's in, an invited person's or null for the board's own, as it was when read.)
// (x and y, the page's top-left)
const recordOf = (s, who = null) => ({ x: 0, y: 0, ...s, who, ink: null, scraps: [], texts: [], error: '' });
const blankPage = book => ({
  id: null,
  who: book.who,
  blank: true,
  day: book.today,
  kind: 'free',
  owner: null,
  label: '',
  x: 0,
  y: 0,
  ...newPageSize(book.size),
  ink: [],
  scraps: [],
  texts: [],
  error: '',
});
function addView(book, page) {
  const v = pageView(page, headOf(page, book.today, book.whose));
  v.el.hidden = true;
  book.views.push(v);
  book.world.append(v.el);
  v.place();
  if (!book.who) book.sheets?.added(v);
  book.tools?.added?.(v);
}
// New page: a blank one after the last of today's, turned to (the one waiting there already, if any)
function newPage(book) {
  book.zoom.near();
  return turn(book.paper, {
    midway: async () => {
      if (book.day !== book.today) await openDay(book);
      show1(book, book.views.indexOf(blank(book)));
    },
  });
}
// Today's blank page at the end of its pages, added when none waits there (New page, a picture carried in with no free
// page today: booktape.js.)
function blank(book) {
  if (!book.views.at(-1)?.page.blank) addView(book, blankPage(book));
  return book.views.at(-1);
}

// ---- the page shown

// Page i of the day shown, at a place on it ({ x, y, s }), or as it was left this visit, or at its top-left
function show1(book, i, place = null) {
  const old = viewOf(book);
  if (old) book.cams.set(old.page, { pan: { ...book.pan }, scale: book.scale });
  halt(book);
  // (a finger's pan or pinch on the page before ends with it.)
  book.table.letGo();
  book.cur = i;
  book.views.forEach((v, k) => (v.el.hidden = k !== i));
  const v = viewOf(book);
  if (!v) return;
  const cam = place
    ? { pan: { x: place.x ?? 0, y: place.y ?? 0 }, scale: place.s ?? 1 }
    : (book.cams.get(v.page) ?? { pan: { x: 0, y: 0 }, scale: 1 });
  setView(book, cam);
  if (!v.page.ink) read(book, v);
  remember(book);
  book.controls?.update();
}
// Turned to page i of the day: a leaf turning forward or back (the page shown, at a place: slid there)
async function turnTo(book, i, place = null) {
  if (i < 0 || i >= book.views.length) return;
  if (i === book.cur) return place && slideTo(book, { pan: place }, () => remember(book));
  await turn(book.paper, { dir: i > book.cur ? 1 : -1, midway: () => show1(book, i, place) });
}
// The page laid again (its size, as it has grown) and drawn where it is
function lay(book) {
  for (const v of book.views) {
    // (a picture taped past what the page held: the page grows to hold it)
    for (const s of v.page.scraps) Object.assign(v.page, grownTo(v.page, scrapBoxOf(s)));
    v.place();
  }
  setView(book);
}
function read(book, v) {
  v.reading ??= loadPage(book.dev, v.page.id, book.who).then(
    full => {
      Object.assign(readAt(v.page, full), {
        ink: full.ink,
        scraps: full.scraps,
        texts: full.texts,
        ...spanOf(v.page, full),
      });
      book.sheets.inked(v); // (laid out, a sheet's notes clear of its ink too.)
      book.tools?.added?.(v);
    },
    e => said(book, v.page, e.message),
  );
}
// A remembered place ({ page: an id or 'new', x, y, s }) in the day, or its last page when that's gone or there's none.
// Found when the paper has a size, so a day that changed while it had none can't leave it pointing past its end.
function goTo(book, place) {
  if (!book.size.w) return (book.waiting = place);
  const { i, at: on } = placeIn(
    book.views.map(v => v.page.id ?? 'new'),
    place,
  );
  show1(book, i, on && { x: on.x ?? 0, y: on.y ?? 0, s: on.s ?? 1 });
}
// The paper's size taken, a blank page sized to it, and a place waiting for it opened
function resized(book) {
  const size = { w: book.desk.clientWidth, h: book.desk.clientHeight };
  if (!size.w || !size.h) return;
  book.size = size;
  // (what a page's paper shows across at 100%, for a sheet's notes on a page wider than the book.)
  book.world.style.setProperty('--paper-w', `${Math.round(size.w)}px`);
  for (const v of book.views) if (v.page.blank) Object.assign(v.page, newPageSize(size));
  if (book.waiting === undefined) return lay(book);
  const place = book.waiting;
  book.waiting = undefined;
  lay(book);
  goTo(book, place);
}
const placeKey = book => `book.place.${book.shape()}`;
function remember(book) {
  const v = viewOf(book);
  if (!v || book.who) return;
  const { pan, scale } = book;
  store.set(placeKey(book), {
    day: book.day,
    page: v.page.id ?? 'new',
    x: Math.round(pan.x),
    y: Math.round(pan.y),
    s: Math.round(scale * 1000) / 1000,
  });
  // (the page shown: book:turn on the document, for a second screen to follow.)
  document.dispatchEvent(new CustomEvent('book:turn', { detail: { page: v.page.id } }));
}
function shownPage(book) {
  const page = viewOf(book)?.page;
  if (!page?.id) return null;
  const { id, day, kind, owner, url, call, label, w, h } = page;
  return { id, day, kind, owner, url, call, label, w, h };
}

// Undo or Redo (bookedit.js): what's being typed kept and a selection let go first, so the step meets the page as it is
// (redo job #19243)
function stepped(book, act) {
  book.tools?.settle();
  return act(book);
}

// ---- what the other parts ask

// What the sheets on the pages (booksheet.js) ask of the book: the page laid again, a page saved, a page shown, a day
// opened, a page made outside it read in, and a finger's pan let go.
const sheetHooks = (book, table) => ({
  lay: () => lay(book),
  changed: page => changed(book, page),
  show: id => show(book, id),
  // (a day, today's by default, at a page: a face's sheet under a turning leaf.)
  open: (day, id) => openDay(own(book), day, id ? { page: id } : null),
  made: id => made(book, id),
  release: table.release,
});
// What the mouse's tools (booktools.js) ask of the book: the page laid again, a page saved, a box on a page drawn
// again (all of it: null), a box on page i shown, and a page's ink, pictures and words all drawn again (bookedit.js)
const toolHooks = book => ({
  lay: () => lay(book),
  changed: page => changed(book, page),
  redraw: (view, box) => view.redraw(box),
  inView: (i, box) => inView(book, i, box),
  refresh: view => {
    lay(book);
    view.redraw();
    book.tools?.added(view);
  },
});
// What the controls (bookcontrols.js) do: zoom in or out (out of the page's whole width, or in from the overview, a
// step of the overview), 100%, the overview, a page of the day, New page, another day, the board's own book again
const controlsOf = book => ({
  zoom: k => {
    if (book.far()) return k > 1 ? book.zoom.in() : book.zoom.out();
    if (!zoomBy(book, k)) book.zoom.out();
  },
  actual: () => (book.far() ? book.zoom.toggle() : actualSize(book)),
  overview: () => book.zoom.toggle(),
  level: () => book.zoom.level(),
  turnTo: i => turnTo(book, i),
  newPage: () => newPage(book),
  openDay: day => turn(book.paper, { dir: day < book.day ? -1 : 1, midway: () => openDay(book, day) }),
  mine: () => openBookOf(book, null),
});
// A page of the day by its id (a face's sheet, a second screen's turn), turned to at its top; y: that far down it,
// Search's find. (y: job #18532)
function show(book, id, y = 0) {
  const i = book.views.findIndex(v => v.page.id === id);
  if (i < 0) return;
  book.zoom.near();
  return turnTo(book, i, { x: 0, y: Math.max(0, y), s: book.scale });
}
// A find of Search's: its day opened, its page turned to, and the view slid to its note there, the number lit, a
// third down the paper (its page's top when no page of the day shows the note).
async function find(book, { day, page, note }) {
  book.zoom.near();
  if (day !== book.day || book.who) await openDay(own(book), day, { page, x: 0, y: 0 });
  const el = book.sheets?.light(note),
    i = el ? book.views.findIndex(v => v.el.contains(el)) : -1;
  if (i < 0) return show(book, page);
  if (i !== book.cur) await turnTo(book, i);
  const v = book.views[i],
    y = (el.getBoundingClientRect().top - v.el.getBoundingClientRect().top) / book.scale;
  slideTo(book, { pan: { x: book.pan.x, y: y - book.size.h / book.scale / 3 } }, () => remember(book));
}
// The view slides to show a box on page i, unless the paper shows it already (turning to that page first), anywhere
// on the page.
async function inView(book, i, box) {
  const centre = {
    x: (box.x0 + box.x1) / 2 - book.size.w / book.scale / 2,
    y: (box.y0 + box.y1) / 2 - book.size.h / book.scale / 2,
  };
  if (i !== book.cur) return turnTo(book, i, { ...centre, s: book.scale });
  if (!showsBox(box, book.pan, book.scale, book.size)) slideTo(book, { pan: centre }, () => remember(book));
  else draw(book);
}
