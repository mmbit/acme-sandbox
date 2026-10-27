// The book zoomed out past a page's whole width: the overview. First the day's pages side by side, with the days
// either side a step away; zoomed out again, the week as a contact sheet, a row a day, the latest first. A page
// clicked there opens it; zoomed in, it comes back to the page. Two fingers' pinch, a trackpad's pinch (a wheel with
// Ctrl), Safari's gesture events and the view's controls (bookcontrols.js) step it; each step turns a leaf of the book
// (bookflip.js), as a page change does.
//
// The pages are the store's (bookdata.js), their ink drawn with review mode's ink.js, as small as they show, each named
// as the book names it. Its head holds what's used from here: Search and the phone (bookui.js's overview island).
import { draw } from '/__review/ink.js';
import { drawScrap } from './sketchscraps.js';
import { picture, esc } from '../util.js';
import { loadDay, loadPage } from './bookdata.js';
import { dayName } from './bookhead.js';
import { island } from './bookui.js';
import { pageBox } from './bookrow.js';

// the views, nearest first: the page itself (bookpages.js), the day, the week
const LEVELS = ['page', 'day', 'week'];
// how far two fingers close (or open) before the overview steps out (or in): one step a pinch
const OUT = 0.78,
  IN = 1.28;
// a trackpad's pinch: this much wheel in one direction is a step, and a pause this long ends the pinch
const WHEEL_STEP = 50,
  WHEEL_REST_MS = 260;
// a page's frame shows at most this much of it, as tall as wide times this (a grown page shows its top)
const TALLEST = 1.5;
// the week's frames are this tall; bookdesk.css's .bk-far-row gap, its padding across (40 + 84) and down under its head
// (the nav, 28 + 28 and a frame's label)
const WEEK_PX = 128,
  GAP_PX = 18,
  PAD_X_PX = 124,
  PAD_Y_PX = 150;
// typed text on a page (booktools.js): its size and line, as the page sets it
const TEXT_PX = 18,
  TEXT_LINE = 1.45;
const font = () =>
  getComputedStyle(document.getElementById('book') ?? document.documentElement)
    .getPropertyValue('--bk-font')
    .trim() || 'system-ui, sans-serif';

// paper: the book's pages (bookpages.js's .bk-pages). book: the pages' state ({ dev, day, today, days, views, size }).
// title(page): its heading's words. open(day, id): that page shown. turn(dir, midway): a leaf turned over the paper,
// midway() swapping what's under it (bookflip.js). changed(level): the overview opened, stepped or closed.
export function mountZoom(paper, book, { title, open, turn, changed }) {
  const far = document.createElement('div');
  far.className = 'bk-far';
  far.hidden = true;
  far.setAttribute('role', 'list');
  far.setAttribute('aria-label', 'The overview');
  // (its head, kept while the views change under it)
  const head = document.createElement('div');
  head.className = 'bk-far-head';
  head.setAttribute('role', 'presentation');
  head.append(island('overview'));
  far.append(head);
  paper.append(far);
  const z = { far, head, book, title, open, turn, changed, level: 0, day: null, used: false, touches: new Map() };
  Object.assign(z, { wheel: 0, rest: 0, drawn: 0, went: '' });
  followSent(z);
  far.addEventListener('click', e => {
    const frame = e.target.closest('[data-page]'),
      day = e.target.closest('[data-day-go]');
    if (frame) back(z, { day: frame.dataset.day, id: Number(frame.dataset.page) });
    else if (day) go(z, 1, day.dataset.dayGo);
    else if (e.target.closest('[data-week]')) go(z, 2, z.day);
    else if (e.target.closest('.bk-far-lost')) show(z);
  });
  pinches(paper, z);
  // (showing the view resizes it too: only a room that changed since it was last drawn draws it again)
  new ResizeObserver(
    () => z.level && (far.clientWidth !== z.room?.w || far.clientHeight !== z.room?.h) && show(z),
  ).observe(far);
  return {
    // 'page', 'day' or 'week'
    level: () => LEVELS[z.level],
    // drawn again (the book's day changed)
    again: () => z.level && show(z),
    // back to the page at once, no leaf (a find, New page)
    near: () => z.level && close(z),
    // a step out (the controls and keys), or in (back to the page from the day).
    // (a pinch on the page never steps out)
    out: () => step(z, 1),
    in: () => step(z, -1),
    // the overview from the page, or back to it (the overview's button)
    toggle: () => (z.level ? back(z) : step(z, 1)),
  };
}

// The pages a sheet sent lately had notes on, ticked as soon as the rail reads them (book:sheets, bookrail.js), the
// store's word on older ones aside (a page's went).
function followSent(z) {
  document.addEventListener('book:sheets', e => {
    const went = [...new Set(e.detail.sent.flatMap(sheet => sheet.notes.map(n => n.page)))].sort().join(' ');
    if (went === z.went) return;
    z.went = went;
    if (z.level) show(z);
  });
}

// ---- the gestures

function pinches(paper, z) {
  fingers(paper, z);
  trackpads(paper, z);
}
// Two fingers on an iPad, as pointers. (split from pinches)
function fingers(paper, z) {
  const { touches } = z;
  // two fingers: how far apart they are now against when the second came down
  const spread = () => {
    const [a, b] = [...touches.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const on = (type, f) => paper.addEventListener(type, f, true);
  // (a first finger down: any other still held lifted unheard.)
  const forget = () => {
    touches.clear();
    z.from = 0;
    z.used = false;
  };
  on('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    if (e.isPrimary) forget();
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) z.from = spread();
  });
  on('pointermove', e => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2 && z.from > 0) pinched(z, spread() / z.from);
  });
  const lift = e => {
    touches.delete(e.pointerId);
    if (touches.size < 2) z.from = 0;
    if (!touches.size) z.used = false;
  };
  on('pointerup', lift);
  on('pointercancel', lift);
  addEventListener('blur', forget);
  document.addEventListener('visibilitychange', () => document.hidden && forget());
}
// Safari's own pinch (an iPad's fingers come as pointers too, so the first to see a pinch takes its step), and a
// trackpad's pinch, or Ctrl and a wheel. On the page these zoom it (bookpan.js); here they step the overview.
function trackpads(paper, z) {
  const { far, touches } = z;
  far.addEventListener('gesturestart', e => e.preventDefault());
  far.addEventListener('gesturechange', e => {
    e.preventDefault();
    pinched(z, e.scale);
  });
  far.addEventListener('gestureend', () => !touches.size && (z.used = false));
  paper.addEventListener(
    'wheel',
    e => {
      if (!e.ctrlKey && !e.metaKey) return;
      // (one step a pinch: it rests before the next)
      clearTimeout(z.rest);
      z.rest = setTimeout(() => ((z.wheel = 0), (z.used = false)), WHEEL_REST_MS);
      if (!z.level || !far.contains(e.target)) return;
      e.preventDefault();
      z.wheel += e.deltaY;
      if (Math.abs(z.wheel) >= WHEEL_STEP) pinched(z, z.wheel > 0 ? 0 : Infinity);
    },
    { passive: false },
  );
}
// A pinch's scale so far, over the overview: closed far enough, a step out; opened far enough, a step in. One step a
// pinch.
function pinched(z, scale) {
  if (!z.level || z.used || (scale > OUT && scale < IN)) return;
  z.used = true;
  step(z, scale <= OUT ? 1 : -1);
}
// One step out or in
function step(z, by) {
  const level = Math.max(0, Math.min(LEVELS.length - 1, z.level + by));
  if (level === z.level) return;
  if (!level) return back(z);
  go(z, level, z.day ?? z.book.day);
}

// ---- the views

// The overview at a level, for a day (the week: the seven days up to it), a leaf turning to it
function go(z, level, day) {
  const from = z.level;
  z.level = level;
  z.day = day;
  z.changed(LEVELS[level]);
  return z.turn(level > from || (level === from && day < z.book.day) ? -1 : 1, () => show(z));
}
// The overview drawn for its level
async function show(z) {
  const { far, book } = z,
    drawn = ++z.drawn,
    day = z.day ?? book.day;
  const days = LEVELS[z.level] === 'day' ? [day] : weekOf(day);
  // (a day that couldn't be read stops the view, said as the book says it, a tap reading it again)
  let read = [],
    lost = null;
  try {
    read = await Promise.all(days.map(d => pagesOf(book, d)));
  } catch (e) {
    lost = e;
  }
  if (drawn !== z.drawn || !z.level) return;
  const week = LEVELS[z.level] === 'week';
  far.dataset.level = LEVELS[z.level];
  far.hidden = false;
  far.replaceChildren(z.head);
  far.insertAdjacentHTML('beforeend', nav(z, day, week));
  const room = (z.room = { w: far.clientWidth, h: far.clientHeight }),
    under = room.h - z.head.offsetHeight; // (the height under its head)
  read.forEach((pages, i) => {
    if (!pages.length) return;
    const row = document.createElement('div');
    row.className = 'bk-far-day';
    row.setAttribute('role', 'listitem');
    row.innerHTML = `${
      week ? `<button class="bk-far-name" data-day-go="${days[i]}">${esc(dayName(days[i], book.today))}</button>` : ''
    }<div class="bk-far-row"></div>`;
    far.append(row);
    const strip = row.lastChild,
      tallest = Math.max(1, ...pages.map(shownHeight)),
      across = (room.w - PAD_X_PX - GAP_PX * (pages.length - 1)) / pages.reduce((w, p) => w + p.w, 0);
    // (the day: its pages side by side across the book, never smaller than a week's frame, nor taller than it)
    const s = week ? WEEK_PX / tallest : Math.min((under - PAD_Y_PX) / tallest, Math.max(across, WEEK_PX / tallest));
    for (const page of pages) strip.append(frameOf(z, page, days[i], s));
  });
  if (lost)
    far.insertAdjacentHTML(
      'beforeend',
      `<p class="bk-far-none bk-far-lost">${esc(lost.message)} Tap to try again.</p>`,
    );
  else if (far.childElementCount === 2)
    far.insertAdjacentHTML(
      'beforeend',
      `<p class="bk-far-none">Nothing written ${week ? 'in these seven days' : 'this day'} yet.</p>`,
    );
}
// The overview's head: the day with the days either side that have pages, and the week; the week's own name
function nav(z, day, week) {
  const { book } = z,
    all = [...new Set([...book.days, book.today])].sort(),
    before = all.filter(d => d < day).at(-1),
    after = all.find(d => d > day);
  const go = (d, words) =>
    d ? `<button class="bk-far-go" data-day-go="${d}">${words}</button>` : '<span class="bk-far-go"></span>';
  if (week)
    return `<nav class="bk-far-nav"><b>${day === book.today ? 'This week' : `The week to ${esc(dayName(day, book.today))}`}</b></nav>`;
  return `<nav class="bk-far-nav">${go(before, `‹ ${esc(dayName(before ?? '', book.today))}`)}<b>${esc(
    dayName(day, book.today),
  )}</b>${go(after, `${esc(dayName(after ?? '', book.today))} ›`)}<button class="bk-far-go" data-week>The week</button></nav>`;
}
// Back to the page, a leaf turning to it: a page's top (a frame clicked), or the page as it was
function back(z, to = null) {
  const day = z.day;
  return z.turn(1, () => {
    close(z);
    if (to) return z.open(to.day, to.id);
    if (day && day !== z.book.day) return z.open(day, null);
  });
}
function close(z) {
  z.level = 0;
  z.day = null;
  z.drawn++;
  z.far.hidden = true;
  z.far.replaceChildren(z.head);
  delete z.far.dataset.level;
  z.changed('page');
}

// A page's frame: its plain paper (a dot grid that small would only grey it), its ink, pictures and typed text drawn
// small, its name under it, and a green tick on a page that went (a page that couldn't be read: why, under it, as a refusal is said on a page)
function frameOf(z, page, day, s) {
  const frame = document.createElement('button'),
    w = Math.round(page.w * s),
    h = Math.round(shownHeight(page) * s);
  frame.className = 'bk-frame';
  frame.dataset.page = page.id;
  frame.dataset.day = day;
  frame.dataset.kind = page.kind;
  const words = z.title(page),
    went = page.went || z.went.split(' ').includes(String(page.id));
  frame.setAttribute('aria-label', `${words || 'A page'}${went ? ', sent' : ''}`);
  frame.innerHTML = `<canvas style="width:${w}px;height:${h}px"></canvas>${words ? `<span>${esc(words)}</span>` : ''}${
    went ? TICK : ''
  }`;
  frame.style.width = `${w}px`;
  const canvas = frame.firstChild;
  inked(z, page).then(
    full => paint(canvas, full, s),
    e => {
      frame.setAttribute('aria-label', `${words || 'A page'}: ${e.message}`);
      frame.insertAdjacentHTML('beforeend', `<em>${esc(e.message)}</em>`);
    },
  );
  return frame;
}
const TICK =
  '<svg class="bk-frame-went" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9"/><path d="M6 10.4l2.7 2.7L14.2 7.4"/></svg>';
function paint(canvas, page, s) {
  const k = devicePixelRatio || 1,
    w = parseFloat(canvas.style.width),
    h = parseFloat(canvas.style.height);
  Object.assign(canvas, { width: Math.round(w * k), height: Math.round(h * k) });
  const g = canvas.getContext('2d');
  // (from the page's own top-left, which may lie left of and above its heading)
  const { x0, y0 } = pageBox(page);
  g.setTransform(k * s, 0, 0, k * s, -x0 * k * s, -y0 * k * s);
  for (const sc of page.scraps) {
    // (a picture drawn again once it has loaded)
    sc.img ??= picture(sc.url);
    if (!sc.img.complete)
      sc.img.decode().then(
        () => paint(canvas, page, s),
        () => {},
      );
    drawScrap(g, sc);
  }
  // (a highlighter's strokes under the ink, as on the page)
  draw(g, [...page.ink.filter(st => st.alpha < 1), ...page.ink.filter(st => !(st.alpha < 1))]);
  for (const t of page.texts) typed(g, t);
}
// A text box typed on the page, set as the page sets it: wrapped at its width
function typed(g, { x, y, w, text, color }) {
  g.font = `${TEXT_PX}px ${font()}`;
  g.fillStyle = color || '#2a2352';
  g.textBaseline = 'top';
  const line = TEXT_PX * TEXT_LINE;
  let n = 0;
  for (const para of String(text).split('\n')) {
    let row = '';
    for (const word of para.split(' ')) {
      const next = row ? `${row} ${word}` : word;
      if (row && g.measureText(next).width > w) {
        g.fillText(row, x, y + n++ * line);
        row = word;
      } else row = next;
    }
    g.fillText(row, x, y + n++ * line);
  }
}

// ---- what they show

const shownHeight = page => Math.min(page.h, page.w * TALLEST);
// A day's pages with ids (the blank page waiting has none): the book's own for the day it shows, else the store's
async function pagesOf(book, day) {
  if (day === book.day) return book.views.map(v => v.page).filter(p => p.id);
  if (!book.days.includes(day)) return [];
  return (await loadDay(book.dev, day, book.who)).pages; // (an invited person's too)
}
// A page with its ink: as the book holds it, or read from the store
async function inked(z, page) {
  return page.ink ? page : loadPage(z.book.dev, page.id, z.book.who);
}
// The week up to a day: it and the six before it, the latest first
function weekOf(day) {
  const d = new Date(`${day}T12:00:00Z`);
  return Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - i)).toISOString().slice(0, 10),
  );
}
