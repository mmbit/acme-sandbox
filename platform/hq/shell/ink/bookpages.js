// The pages inside the book: one page fills the book's paper, endless (its paper and dots drawn wherever it's panned or
// zoomed, bookview.js), its heading written at its top-left; a notebook's pages one after another in its order (My
// Notebook's when the book opens), changed from the pages control or the overview with a turn of the leaf
// (bookflip.js), never by panning past an edge; the pen writing, the page growing to hold what's on it, and the place
// it was left, per screen shape. A page's content is its groups (knowledge/notes/platform/notebook.md): what's drawn
// goes into them as it's saved (booksave.js), each shows its paperclip and its answers (bookgroups.js), and a page is
// sent whole (bookpagesend.js). Every screen showing a page reads it again when the store says it changed (book:notebook,
// events.js). (a notebook's pages, its groups)
//
// Moving about the page is bookpan.js; the overview bookzoom.js; the controls bookcontrols.js; one page's ink
// bookpage.js; writing bookwrite.js; the maths bookrow.js; saving booksave.js; the store's routes notebookdata.js; the
// mouse's tools booktools.js, asked in this order on a press on the paper: a pan (bookpan.js), then book.tools.press(e), then ink.
import { pen } from '/__review/ink.js';
import { store } from '../../util.js';
import { createPage, loadPages, loadShelf } from './notebookdata.js';
import { changed, readAgain, readPage, said, saveAll, shut } from './booksave.js';
import { pageView } from './bookpage.js';
import { panning } from './bookpan.js';
import { mountFar } from './bookpagesfar.js';
import { headOf } from './bookhead.js';
import { mountTape } from './booktape.js';
import { mountGroups } from './bookgroups.js';
import { mountDogEar } from './bookdogear.js';
import { sendShown, stamped } from './bookpagesend.js';
import { mountControls } from './bookcontrols.js';
import { turn } from './bookflip.js';
import { actualSize, at, away, draw, halt, setView, shown, slideTo, viewOf, zoomBy } from './bookview.js';
import { placeIn, scrapBoxOf, grownTo, showsBox } from './bookrow.js';
import { stepList, undo, redo } from './bookedit.js';
import { INK, drawable, dried, endLostLines } from './bookwrite.js';

const HTML = `<div class="bk-pages">
  <div class="bk-desk"><div class="bk-world"></div><canvas class="bk-wet"></canvas><p class="bk-lost" hidden></p></div>
</div>`;

// paper: the book's paper, empty. dev: on mock data. shape(): the screen's shape ('landscape' | 'portrait' | 'narrow'
// | 'wide'), for the place remembered. undo() takes back the book's last step; page() is the page shown (its summary).
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
    undo: () => stepped(book, undo),
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
  mountTape(book, paper, { lay, inView, current }); // (pictures taped in.)
  book.groups = mountGroups(book, groupHooks(book));
  mountDogEar(book); // (a page shared by its corner)
  book.zoom = mountFar(book, paper, { goTo, openNotebook }); // (the overview.)
  book.controls = mountControls(book, controlsOf(book));
  // (the mouse's tools, once they're there: booktools.js)
  import('./booktools.js').then(m => (book.tools = m.mountTools(book, paper, toolHooks(book))));
  // (the store changed a page: read again where it shows, the notebook's pages again when it's one not here)
  for (const type of ['book:notebook', 'book:changed'])
    document.addEventListener(type, e => storeChanged(book, e.detail?.page));
  new ResizeObserver(() => resized(book)).observe(book.desk);
  // (back in front, or a note written the old way here, which the store carries onto the current page: the pages again)
  document.addEventListener('visibilitychange', () => (document.hidden ? saveAll(book) : pagesAgain(book)));
  document.addEventListener('pencil:note', () => pagesAgain(book));
  const place = store.get(placeKey(book), null);
  openNotebook(book, place?.notebook, place);
  return {
    undo: book.undo,
    redo: () => stepped(book, redo),
    page: () => shownPage(book),
    show: id => show(book, id),
    find: at => find(book, at),
    made: id => made(book, id),
    away: on => away(book, on),
  };
}
// A page made outside the book (a call's, a scrap's on a fresh current page): the notebook's pages read again and that
// page turned to, once however many tell of it
function made(book, id) {
  if (id && book.making?.id === id) return book.making.read;
  const read = pagesAgain(book)
    .then(() => id && show(book, id))
    .finally(() => {
      if (book.making?.read === read) book.making = null;
    });
  book.making = { id, read };
  return read;
}
// A page the store changed (another screen drew on it, an answer clipped on, a send went): read again if it's here and
// read; the notebook's pages read again when it's one the book hasn't (a page made elsewhere), or none's named.
function storeChanged(book, id) {
  const v = id && book.views.find(x => x.page.id === id);
  if (v) return v.page.groups && readAgain(book, v.page);
  if (book.notebook) pagesAgain(book);
}

// The book's state as it opens on the paper
const bookOf = (paper, { dev, shape }) => ({
  dev,
  shape,
  paper,
  desk: paper.querySelector('.bk-desk'),
  world: paper.querySelector('.bk-world'),
  lost: paper.querySelector('.bk-lost'),
  notebook: null, // the notebook open (its id)
  views: [],
  cur: -1, // the page shown, of the notebook's
  pan: { x: 0, y: 0 },
  scale: 1,
  size: { w: 0, h: 0 },
  cams: new WeakMap(), // a page's view as it was left this visit: page → { pan, scale }
  // the book's steps this visit, the last last, for Undo: each { undo(), redo() } (a stroke, a group deleted, a send:
  // one that can't be made again has no redo), and those undone, for Redo (bookedit.js). (redo: job #19243)
  steps: null,
  undone: [],
  target: -1, // the page under the stroke being drawn
  inking: INK, // the stroke's ink, as it started
  waiting: undefined, // the place to open (goTo's) once the paper has a size
});

// ---- a notebook's pages

// A notebook's pages (My Notebook's when none's named, or the one named has gone), at a remembered place or its newest
// open page; one refused says why, a tap trying it again
async function openNotebook(book, id = null, place = null) {
  saveAll(book);
  let read;
  try {
    const asked = id ?? (await loadShelf(book.dev)).shelf[0]?.id;
    read = await loadPages(book.dev, asked).catch(e =>
      e.status === 404 && id ? loadShelf(book.dev).then(s => loadPages(book.dev, s.shelf[0].id)) : Promise.reject(e),
    );
    // (a notebook with no page open: its new one, the current page)
    if (!read.pages.length) {
      await createPage(book.dev, read.notebook.id);
      read = await loadPages(book.dev, read.notebook.id);
    }
  } catch (e) {
    book.lost.textContent = `${e.message} Tap to try again.`;
    book.lost.onclick = () => openNotebook(book, id, place);
    return void (book.lost.hidden = false);
  }
  book.lost.hidden = true;
  for (const v of book.views) drop(v);
  Object.assign(book, { notebook: read.notebook.id, name: read.notebook.name, steps: stepList(book) });
  Object.assign(book, { undone: [], cur: -1 });
  book.views = read.pages.map(p => viewFor(book, recordOf(p)));
  goTo(book, place);
  book.zoom.again();
}
// The notebook's pages read again, kept where they're the same pages (what's drawn on them, their reads), new ones
// added in their place and gone ones dropped; the page shown stays shown.
async function pagesAgain(book) {
  const id = book.notebook;
  if (!id) return;
  let read;
  try {
    read = await loadPages(book.dev, id);
  } catch (e) {
    return console.error('[hq] The notebook’s pages can’t be read:', e);
  }
  if (book.notebook !== id) return;
  const shownId = viewOf(book)?.page.id,
    old = new Map(book.views.map(v => [v.page.id, v]));
  book.views = read.pages.map(p => {
    const v = old.get(p.id);
    old.delete(p.id);
    if (!v) return viewFor(book, recordOf(p));
    // (a page changed on the store since it was read: read again)
    if (v.page.groups && p.updated !== v.page.updated) readAgain(book, v.page);
    Object.assign(v.page, summaryOf(p));
    stamped(book, v.page);
    return v;
  });
  for (const v of old.values()) drop(v);
  book.cur = Math.max(0, indexOf(book, shownId));
  book.views.forEach((v, k) => (v.el.hidden = k !== book.cur));
  book.controls?.update();
  book.zoom.again();
}
// The newest page neither sent nor archived: where new things land (the current page)
const newest = book =>
  book.views
    .map(v => v.page)
    .filter(p => !shut(p))
    .sort((a, b) => b.created.localeCompare(a.created))[0]?.id ?? book.views.at(-1)?.page.id;
// A page as the book keeps it while it shows: its summary, and its groups' ink, pictures and typed words once read
const recordOf = p => ({ ...summaryOf(p), ink: null, scraps: [], texts: [], groups: null, gone: new Map(), error: '' });
// (what the store says of a page: its day the one it was made on, its title its label; its groups' count left out, as
// a page read keeps its groups there)
const summaryOf = ({ groups: _count, ...p }) => ({ ...p, label: p.title ?? '', day: localDay(p.created) });
const localDay = at => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function viewFor(book, page) {
  const v = pageView(page, headOf(page, localDay(new Date())), book.away);
  v.el.hidden = true;
  book.world.append(v.el);
  v.place();
  book.groups.added(v);
  book.tools?.added?.(v);
  stamped(book, page, false, v.el);
  return v;
}
const drop = v => (v.drop(), v.el.remove());
const indexOf = (book, id) => book.views.findIndex(v => v.page.id === id);
// New page: a blank one at the notebook's end, the current page now, turned to
function newPage(book) {
  book.zoom.near();
  return turn(book.paper, {
    midway: async () => {
      try {
        const p = await createPage(book.dev, book.notebook);
        await pagesAgain(book);
        show1(book, indexOf(book, p.id));
      } catch (e) {
        said(book, viewOf(book).page, e.message);
      }
    },
  });
}
// The page new things land on (a picture taped in from outside): the current page, read
async function current(book) {
  const i = indexOf(book, newest(book));
  const v = book.views[i];
  if (v && !v.page.ink) await read(book, v);
  return { v, i };
}

// ---- the page shown

// Page i of the notebook shown, at a place on it ({ x, y, s }), or as it was left this visit, or at its top-left
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
// Turned to page i: a leaf turning forward or back (the page shown, at a place: slid there)
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
// A page's groups read, drawn and given to the tools
function read(book, v) {
  return (v.reading ??= readPage(book, v.page).then(
    () => {
      lay(book);
      v.redraw();
      book.groups.drawn(v.page);
      book.tools?.added?.(v);
    },
    e => {
      v.reading = null;
      said(book, v.page, e.message);
    },
  ));
}
// A remembered place ({ page: an id, x, y, s }) in the notebook, or its current page when that's gone. Found when the
// paper has a size, so a notebook that changed while it had none can't leave it pointing past its end.
function goTo(book, place) {
  if (!book.size.w) return (book.waiting = place);
  const ids = book.views.map(v => v.page.id),
    { i, at: on } =
      place && ids.includes(place.page) ? placeIn(ids, place) : { i: ids.indexOf(newest(book)), at: null };
  show1(book, i, on && { x: on.x ?? 0, y: on.y ?? 0, s: on.s ?? 1 });
}
// The paper's size taken, and a place waiting for it opened
function resized(book) {
  const size = { w: book.desk.clientWidth, h: book.desk.clientHeight };
  if (!size.w || !size.h) return;
  book.size = size;
  book.world.style.setProperty('--paper-w', `${Math.round(size.w)}px`); // (what a page's paper shows across at 100%)
  book.world.dispatchEvent(new Event('bk:paper')); // (a versions page lays its frames to it)
  if (book.waiting === undefined) return lay(book);
  const place = book.waiting;
  book.waiting = undefined;
  lay(book);
  goTo(book, place);
}
const placeKey = book => `book.place.${book.shape()}`;
function remember(book) {
  const v = viewOf(book);
  if (!v) return;
  const { pan, scale } = book;
  store.set(placeKey(book), {
    notebook: book.notebook,
    page: v.page.id,
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
  const { id, notebook, day, kind, label, w, h } = page;
  return { id, notebook, day, kind, label, w, h };
}
// Undo or Redo (bookedit.js): what's being typed kept and a selection let go first, so the step meets the page as it is
// (redo job #19243)
function stepped(book, act) {
  book.tools?.settle();
  return act(book);
}

// ---- what the other parts ask

// What the groups (bookgroups.js) ask of the book: the page laid again and drawn, the notebook's pages, one turned to
const groupHooks = book => ({
  ...toolHooks(book),
  pages: () => book.views.map(v => v.page),
  turnTo: page => show(book, page.id),
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
    book.groups.drawn(view.page);
  },
});
// What the controls (bookcontrols.js) do: zoom in or out (out of the page's whole width, or in from the overview, a
// step of the overview), 100%, the overview, a page of the notebook, New page, and Send
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
  send: () => sendShown(book, { pagesAgain: () => pagesAgain(book), show: id => show(book, id) }),
});
// A page of the notebook by its id (a second screen's turn, a send's fresh page), turned to at its top; y: that far
// down it, Search's find. (y: job #18532)
function show(book, id, y = 0) {
  const i = indexOf(book, id);
  if (i < 0) return;
  book.zoom.near();
  return turnTo(book, i, { x: 0, y: Math.max(0, y), s: book.scale });
}
// Search's find, or a card's Open in the book: its page, or its notebook at it
const find = (book, { page, notebook = null }) =>
  indexOf(book, page) >= 0 || notebook === null ? show(book, page) : openNotebook(book, notebook, { page });
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
