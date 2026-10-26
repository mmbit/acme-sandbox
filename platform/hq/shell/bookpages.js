// The pages inside the book: a row of pages a day on an endless table, the day's first free page waiting blank at the
// row's end, New page, the pen writing on them, a page that grows as it's written down, each saved as it's drawn on,
// and the place it was left, per screen shape.
//
// The Pencil and a mouse write on a page; a finger, a trackpad or a mouse on the bare table moves the table
// (bookpan.js). One page's paper and ink are bookpage.js; the table's numbers bookrow.js; saving booksave.js; the
// store's routes bookdata.js.
import { pen, INKS } from '/__review/ink.js';
import { store, DAYS, MONTHS, titleCase } from '../util.js';
import * as world from '../world/world.js';
import { loadDay, loadPage } from './bookdata.js';
import { changed, keepTears, said, saveAll } from './booksave.js';
import { pageView } from './bookpage.js';
import { panning } from './bookpan.js';
import { mountZoom } from './bookzoom.js';
import {
  boxOf,
  clampPan,
  grownHeight,
  newPageSize,
  pageAt,
  panTo,
  placeIn,
  rowOf,
  settleX,
  shownAt,
} from './bookrow.js';

// The book's one ink for now: Night, at review mode's pen size
const INK = { color: '#2a2352', size: INKS[0].size };
// how long the table takes to come to rest or to slide to a page
const SLIDE_MS = 220;

const PLUS =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 2.5h8l4 4v11H4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 8.5v6M7 11.5h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const HTML = `<div class="bk-pages">
  <header class="bk-head"><button class="bk-day" data-go="prev" hidden></button><b class="bk-when"></b>
    <button class="bk-day" data-go="next" hidden></button><button class="bk-new">${PLUS}<span>New page</span></button></header>
  <div class="bk-desk"><div class="bk-world"></div><canvas class="bk-wet"></canvas><p class="bk-lost" hidden></p></div>
</div>`;

// paper: the book's paper, empty. dev: on mock data. shape(): the screen's shape ('landscape' | 'portrait' | 'narrow'
// | 'wide'), for the place remembered. undo() takes back the last stroke drawn in the book; page() is the page that
// fills most of the paper (its summary), or null on the blank page or the bare table.
export function mountPages(paper, { dev, shape }) {
  paper.innerHTML = HTML;
  const desk = paper.querySelector('.bk-desk');
  const book = {
    dev,
    shape,
    desk,
    world: paper.querySelector('.bk-world'),
    head: paper.querySelector('.bk-head'),
    lost: paper.querySelector('.bk-lost'),
    day: null,
    today: null,
    days: [],
    views: [],
    row: [],
    pan: { x: 0, y: 0 },
    size: { w: 0, h: 0 },
    // the strokes drawn in the book this visit, the last last: { page, stroke, grewFrom (its height before, if it grew) }
    drawn: [],
    target: -1, // the page under the stroke being drawn
    slide: 0,
    waiting: undefined, // the place to open (goTo's) once the paper has a size
    spread: document.documentElement.dataset.book === 'spread', // the book open as two facing pages
  };
  book.setPan = p => setPan(book, p);
  book.settle = () => slideTo(book, { x: settleX(book.pan.x, book.row, book.size, book.spread), y: book.pan.y });
  book.halt = () => cancelAnimationFrame(book.slide);
  const table = panning(desk, book, { bare: e => pageUnder(book, e) < 0, drawing: () => book.ink.drawing });
  book.ink = pen(desk, paper.querySelector('.bk-wet'), {
    use: e => drawable(book, e, table),
    ink: () => INK,
    end: stroke => dried(book, stroke),
  });
  book.head.addEventListener('click', e => {
    const go = e.target.closest('[data-go]'),
      add = e.target.closest('.bk-new');
    if (go) openDay(book, go.dataset.day);
    if (add) newPage(book);
  });
  book.lost.onclick = () => openDay(book, book.day ?? undefined);
  book.zoom = zoomed(paper, book);
  new ResizeObserver(() => resized(book)).observe(desk);
  document.addEventListener('book:layout', e => arrange(book, e.detail.mode === 'spread'));
  document.addEventListener('visibilitychange', () => document.hidden && saveAll(book));
  const place = store.get(placeKey(book), null);
  openDay(book, place?.day, place);
  return { undo: () => undo(book), page: () => shownPage(book) };
}

// Pinched out: the day's pages, then the week's; a page tapped there opens at its top
function zoomed(paper, book) {
  const top = id => ({ page: id, x: 0, y: 0 });
  return mountZoom(paper.querySelector('.bk-pages'), book, {
    title: titleOf,
    open: (day, id) => (day === book.day ? goTo(book, top(id)) : openDay(book, day, top(id))),
  });
}

// ---- a day's row

// A day's pages on the table (today's without one), at the remembered place or its last page
async function openDay(book, day, place = null) {
  saveAll(book);
  let read;
  try {
    read = await loadDay(book.dev, day);
  } catch (e) {
    book.lost.textContent = `${e.message} Tap to try again.`;
    book.lost.hidden = false;
    return;
  }
  book.lost.hidden = true;
  // (a remembered day that has no pages any more: today instead)
  if (day && read.day !== read.today && !read.pages.length) return openDay(book);
  Object.assign(book, { day: read.day, today: read.today, days: read.days.map(d => d.day) });
  const pages = read.pages.map(recordOf);
  if (book.day === book.today && !pages.some(p => p.kind === 'free')) pages.push(blankPage(book));
  for (const v of book.views) {
    v.drop();
    v.el.remove();
  }
  book.views = [];
  book.drawn = [];
  pages.forEach(p => addView(book, p));
  heading(book);
  goTo(book, place);
}
// A page as the book keeps it while it shows: its summary, its ink once read, and its tear lines
const recordOf = s => ({
  ...s,
  ink: null,
  scraps: [],
  tears: store.get('book.tears', {})[s.id] ?? [],
  error: '',
});
const blankPage = book => ({
  id: null,
  blank: true,
  day: book.today,
  kind: 'free',
  owner: null,
  label: '',
  ...newPageSize(book.size, book.spread),
  ink: [],
  scraps: [],
  tears: [],
  error: '',
});
function addView(book, page) {
  const v = pageView(page, titleOf(page));
  book.views.push(v);
  book.world.append(v.el);
  lay(book);
}
// A page's head: whose sheet it is, a call's, or a free page's label
function titleOf(page) {
  const name = id => world.agents?.get(id)?.data.name ?? titleCase(id);
  if (page.kind === 'sheet') return `For ${name(page.owner)}`;
  if (page.kind === 'guest') return `A guest's notes for ${name(page.owner)}`;
  return page.kind === 'call' ? 'Call' : page.label;
}
// The head: the day before with pages, this day, the one after, and New page
function heading(book) {
  const before = book.days.find(d => d < book.day),
    after = [...book.days, book.today].filter(d => d > book.day).sort()[0];
  const [prev, next] = book.head.querySelectorAll('[data-go]');
  book.head.querySelector('.bk-when').textContent = book.day === book.today ? 'Today' : dayName(book.day);
  Object.assign(prev, { hidden: !before, textContent: before ? `‹ ${dayName(before)}` : '' });
  Object.assign(next, {
    hidden: !after,
    textContent: after ? `${after === book.today ? 'Today' : dayName(after)} ›` : '',
  });
  prev.dataset.day = before ?? '';
  next.dataset.day = after ?? '';
  book.zoom.again();
}
const dayName = day => {
  const d = new Date(`${day}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

// New page: a blank one at the end of today's row, and the table slides to it (the one waiting there already, if any)
async function newPage(book) {
  book.zoom.near();
  if (book.day !== book.today) await openDay(book);
  const last = book.views[book.views.length - 1];
  if (!last?.page.blank) addView(book, blankPage(book));
  const i = book.row.length - 1;
  slideTo(book, { x: panTo(book.row, i, book.size, book.spread, { right: true }), y: book.row[i].y });
}

// ---- the table

// Every page in its place on the table, and the paper drawn again where it is
function lay(book) {
  book.row = rowOf(
    book.views.map(v => v.page),
    book.spread,
  );
  book.views.forEach((v, i) => v.place(book.row[i].x, book.row[i].y));
  setPan(book, book.pan);
}
function setPan(book, pan) {
  book.pan = clampPan(pan, book.row, book.size);
  book.world.style.transform = `translate3d(${-book.pan.x}px, ${-book.pan.y}px, 0)`;
  paint(book);
}
// Each page near the paper shows the band of it there (its ink read first), the rest let go
function paint(book) {
  const { pan, size } = book;
  book.views.forEach((v, i) => {
    const r = book.row[i],
      near = r.x < pan.x + 2 * size.w && r.x + r.w > pan.x - size.w;
    if (!near) return v.show(null, null);
    if (!v.page.ink) return read(book, v);
    v.show(pan.y - r.y, pan.y - r.y + size.h);
  });
}
function read(book, v) {
  v.reading ??= loadPage(book.dev, v.page.id).then(
    full => {
      Object.assign(v.page, { ink: full.ink, scraps: full.scraps, h: Math.max(v.page.h, full.h) });
      lay(book);
    },
    e => said(book, v.page, e.message),
  );
}
// The table slides to a pan and comes to rest there, remembered
function slideTo(book, to) {
  book.halt();
  const from = { ...book.pan },
    start = performance.now();
  const step = now => {
    const t = Math.min(1, (now - start) / SLIDE_MS),
      ease = 1 - (1 - t) ** 3;
    setPan(book, { x: from.x + (to.x - from.x) * ease, y: from.y + (to.y - from.y) * ease });
    if (t < 1) book.slide = requestAnimationFrame(step);
    else remember(book);
  };
  book.slide = requestAnimationFrame(step);
}
// A remembered place ({ page, x, y }) on the day's row, or its last page when that's gone or there's none. Found in the
// row as it is when the paper has a size, so a row that changed while it had none can't leave it pointing past its end.
function goTo(book, place) {
  if (!book.size.w) return (book.waiting = place);
  const ids = book.views.map(v => v.page.id ?? 'new'),
    { i, at } = placeIn(ids, place),
    r = book.row[i];
  const x = at ? r.x + at.x : panTo(book.row, i, book.size, book.spread, { right: true });
  setPan(book, { x, y: r.y + (at?.y ?? 0) });
  remember(book);
}
// The paper's size taken, a blank page sized to it and the row laid again; a place waiting for it opened.
// Returns whether the waiting place was opened.
function measure(book) {
  const size = { w: book.desk.clientWidth, h: book.desk.clientHeight };
  if (size.w && size.h) book.size = size;
  for (const v of book.views) if (v.page.blank) Object.assign(v.page, newPageSize(book.size, book.spread));
  lay(book);
  if (book.waiting === undefined || !book.size.w) return false;
  const place = book.waiting;
  book.waiting = undefined;
  goTo(book, place);
  return true;
}
// The book became the spread, or back: the page on the paper's left half faces the next across the middle (the last
// page the one before), or fills the book again
function arrange(book, spread) {
  if (spread === book.spread) return;
  const half = { w: book.size.w / 2, h: book.size.h },
    i = shownAt(book.row, book.pan, half),
    dy = i < 0 ? 0 : book.pan.y - book.row[i].y;
  book.spread = spread;
  if (measure(book) || i < 0) return;
  // (the row's last page faces the one before it, so the spread never shows a page beside bare table)
  const right = i > 0 && i === book.row.length - 1;
  setPan(book, { x: panTo(book.row, i, book.size, spread, { right }), y: book.row[i].y + dy });
  remember(book);
}
// The paper changed size (the book opened, folded, spread or turned): the page shown stays where it was, and a blank
// page is as big as the paper again
function resized(book) {
  if (!book.desk.clientWidth || !book.desk.clientHeight) return;
  const i = shownAt(book.row, book.pan, book.size),
    r = book.row[i],
    offset = r && { x: book.pan.x - r.x, y: book.pan.y - r.y };
  if (!measure(book) && r) setPan(book, { x: book.row[i].x + offset.x, y: book.row[i].y + offset.y });
}
const placeKey = book => `book.place.${book.shape()}`;
function remember(book) {
  const i = shownAt(book.row, book.pan, book.size);
  if (i < 0) return;
  const r = book.row[i];
  store.set(placeKey(book), {
    day: book.day,
    page: book.views[i].page.id ?? 'new',
    x: Math.round(book.pan.x - r.x),
    y: Math.round(book.pan.y - r.y),
  });
}
function shownPage(book) {
  const page = book.views[shownAt(book.row, book.pan, book.size)]?.page;
  if (!page?.id) return null;
  const { id, day, kind, owner, url, call, label, w, h } = page;
  return { id, day, kind, owner, url, call, label, w, h };
}
// The page under a pointer, or -1 on the bare table
function pageUnder(book, e) {
  const r = book.desk.getBoundingClientRect();
  return pageAt(book.row, e.clientX - r.left + book.pan.x, e.clientY - r.top + book.pan.y);
}

// ---- writing

// The Pencil and a mouse write on a page whose ink is read; a finger never does (it moves the table)
function drawable(book, e, table) {
  const writes = e.pointerType === 'pen' || (e.pointerType === 'mouse' && e.button === 0);
  const i = writes ? pageUnder(book, e) : -1;
  if (i < 0 || !book.views[i].page.ink) return false;
  table.stop();
  book.target = i;
  return true;
}
// A stroke lifted: into its page's px, onto its ink, the page grown if it was written near its foot, and saved soon
function dried(book, stroke) {
  const v = book.views[book.target],
    r = book.row[book.target],
    page = v.page,
    dx = book.pan.x - r.x,
    dy = book.pan.y - r.y;
  const round = n => Math.round(n * 100) / 100;
  const line = { ...stroke, points: stroke.points.map(([x, y, p, t]) => [round(x + dx), round(y + dy), p, t]) };
  page.ink.push(line);
  v.addInk(line);
  book.ink.clear();
  // (a page written on keeps its size, whatever the paper does next)
  page.blank = false;
  const h = grownHeight(page.h, Math.max(...line.points.map(q => q[1])), book.size.h);
  book.drawn.push({ page, stroke: line, grewFrom: h > page.h ? page.h : null });
  if (h > page.h) {
    page.tears.push(page.h);
    page.h = h;
    keepTears(page);
    lay(book);
  }
  changed(book, page);
}
// Undo: the last stroke drawn in the book goes, and the growth it made; its page comes into view if it's out of it
function undo(book) {
  const last = book.drawn.pop();
  if (!last) return;
  const { page, stroke, grewFrom } = last;
  page.ink.splice(page.ink.lastIndexOf(stroke), 1);
  if (grewFrom !== null) {
    page.h = grewFrom;
    page.tears.pop();
    keepTears(page);
  }
  const i = book.views.findIndex(v => v.page === page);
  if (i >= 0) {
    book.views[i].redraw(boxOf(stroke));
    lay(book);
    inView(book, i, boxOf(stroke));
  }
  changed(book, page);
}
// The table slides to show a box on page i, unless the paper shows it already
function inView(book, i, box) {
  const r = book.row[i],
    { pan, size } = book;
  const shows =
    r.x + box.x1 > pan.x && r.x + box.x0 < pan.x + size.w && r.y + box.y1 > pan.y && r.y + box.y0 < pan.y + size.h;
  if (!shows) slideTo(book, { x: r.x, y: r.y + (box.y0 + box.y1) / 2 - size.h / 2 });
}
