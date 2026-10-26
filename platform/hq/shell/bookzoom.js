// The book seen from further off: pinched out, the day's pages side by side; pinched out again, the week as a contact
// sheet, a row a day, the latest first. Pinched in, or a page tapped, it comes back to the page. A trackpad's pinch (a wheel with Ctrl)
// and Safari's gesture events do the same.
//
// The pages are the store's (bookdata.js), their ink drawn with review mode's ink.js, as small as they show.
import { draw } from '/__review/ink.js';
import { drawScrap } from './sketchscraps.js';
import { picture, esc } from '../util.js';
import { loadDay, loadPage } from './bookdata.js';
import { dayName } from './bookhead.js';

// the views, nearest first: the page itself (bookpages.js), the day, the week
const LEVELS = ['page', 'day', 'week'];
// how far two fingers close (or open) before the view steps out (or in): one step a pinch
const OUT = 0.78,
  IN = 1.28;
// a trackpad's pinch: this much wheel in one direction is a step, and a pause this long ends the pinch
const WHEEL_STEP = 50,
  WHEEL_REST_MS = 260;
// a page's frame shows at most this much of it, as tall as wide times this (a grown page shows its top)
const TALLEST = 1.5;
// the week's frames are this tall; booklook.css's .bk-far-row gap, its padding across (40 + 24) and down (28 + 28) with
// a frame's label, and book.css's dot grid
const WEEK_PX = 128,
  GAP_PX = 18,
  PAD_X_PX = 64,
  PAD_Y_PX = 96,
  DOT_PX = 22;

// paper: the book's pages (bookpages.js's .bk-pages, over its desk). book: the pages' state ({ dev, day, today, days,
// views, size }). title(page): its head's words. open(day, id): the page shown again, at its top.
export function mountZoom(paper, book, { title, open }) {
  const far = document.createElement('div');
  far.className = 'bk-far';
  far.hidden = true;
  far.setAttribute('role', 'list');
  paper.append(far);
  const z = { far, book, title, open, level: 0, used: false, touches: new Map(), wheel: 0, rest: 0, drawn: 0 };
  far.addEventListener('click', e => {
    const frame = e.target.closest('[data-page]');
    if (frame) back(z, { day: frame.dataset.day, id: Number(frame.dataset.page) });
    else if (e.target.closest('.bk-far-lost')) show(z);
  });
  pinches(paper, z);
  // (showing the view resizes it too: only a room that changed since it was last drawn draws it again)
  new ResizeObserver(
    () => z.level && (far.clientWidth !== z.room?.w || far.clientHeight !== z.room?.h) && show(z),
  ).observe(far);
  // level(): 'page', 'day' or 'week'. again(): the far view drawn again (the book's day changed). near(): back to the page.
  return { level: () => LEVELS[z.level], again: () => z.level && show(z), near: () => z.level && back(z) };
}

// ---- the gestures

function pinches(paper, z) {
  const { touches } = z;
  // two fingers: how far apart they are now against when the second came down
  const spread = () => {
    const [a, b] = [...touches.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  paper.addEventListener(
    'pointerdown',
    e => {
      if (e.pointerType !== 'touch') return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) z.from = spread();
    },
    true,
  );
  paper.addEventListener(
    'pointermove',
    e => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2 && z.from > 0) pinched(z, spread() / z.from);
    },
    true,
  );
  const lift = e => {
    touches.delete(e.pointerId);
    if (touches.size < 2) z.from = 0;
    if (!touches.size) z.used = false;
  };
  paper.addEventListener('pointerup', lift, true);
  paper.addEventListener('pointercancel', lift, true);
  gestures(paper, z);
}
// Safari's own pinch (an iPad's fingers come as pointers too: the first to see the pinch takes its step), and a
// trackpad's pinch, or Ctrl and a wheel (the desk ignores it as a pan)
function gestures(paper, z) {
  paper.addEventListener('gesturestart', e => e.preventDefault());
  paper.addEventListener('gesturechange', e => {
    e.preventDefault();
    pinched(z, e.scale);
  });
  paper.addEventListener('gestureend', () => !z.touches.size && (z.used = false));
  paper.addEventListener(
    'wheel',
    e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      clearTimeout(z.rest);
      z.rest = setTimeout(() => ((z.wheel = 0), (z.used = false)), WHEEL_REST_MS);
      z.wheel += e.deltaY;
      if (Math.abs(z.wheel) >= WHEEL_STEP) pinched(z, z.wheel > 0 ? 0 : Infinity);
    },
    { passive: false },
  );
}
// A pinch's scale so far: closed far enough, a step out; opened far enough, a step in. One step a pinch.
function pinched(z, scale) {
  if (z.used || (scale > OUT && scale < IN)) return;
  z.used = true;
  step(z, scale <= OUT ? 1 : -1);
}
function step(z, by) {
  const level = Math.max(0, Math.min(LEVELS.length - 1, z.level + by));
  if (level === z.level) return;
  z.level = level;
  if (!level) return back(z);
  show(z, by);
}

// ---- the views

// The far view drawn for its level: the day's pages, or the week's days (by: the way it came, for its move)
async function show(z, by = 0) {
  const { far, book } = z,
    drawn = ++z.drawn;
  const days = LEVELS[z.level] === 'day' ? [book.day] : weekOf(book);
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
  far.innerHTML = '';
  const room = (z.room = { w: far.clientWidth, h: far.clientHeight });
  read.forEach((pages, i) => {
    if (!pages.length) return;
    const row = document.createElement('div');
    row.className = 'bk-far-day';
    row.setAttribute('role', 'listitem');
    row.innerHTML = `<b>${esc(dayName(days[i], book.today))}</b><div class="bk-far-row"></div>`;
    far.append(row);
    const strip = row.lastChild,
      tallest = Math.max(1, ...pages.map(shownHeight)),
      across = (room.w - PAD_X_PX - GAP_PX * (pages.length - 1)) / pages.reduce((w, p) => w + p.w, 0);
    // (the day: its pages side by side across the book, never smaller than a week's frame, nor taller than it)
    const s = week ? WEEK_PX / tallest : Math.min((room.h - PAD_Y_PX) / tallest, Math.max(across, WEEK_PX / tallest));
    for (const page of pages) strip.append(frameOf(z, page, days[i], s));
  });
  if (lost) far.innerHTML = `<p class="bk-far-none bk-far-lost">${esc(lost.message)} Tap to try again.</p>`;
  else if (!far.childElementCount)
    far.innerHTML = `<p class="bk-far-none">Nothing written ${week ? 'in these seven days' : 'this day'} yet.</p>`;
  if (by) {
    far.classList.remove('bk-far-out', 'bk-far-in');
    void far.offsetWidth;
    far.classList.add(by > 0 ? 'bk-far-out' : 'bk-far-in');
  }
}
// Back to the page: a page's top (a frame tapped), or the page as it was
function back(z, to = null) {
  z.level = 0;
  z.drawn++;
  z.far.hidden = true;
  z.far.innerHTML = '';
  delete z.far.dataset.level;
  if (to) z.open(to.day, to.id);
}

// A page's frame: its paper and dot grid at its scale, its ink and pictures drawn small, its head's words under it (a
// page that couldn't be read: why, under it, as a refusal is said on a page)
function frameOf(z, page, day, s) {
  const frame = document.createElement('button'),
    w = Math.round(page.w * s),
    h = Math.round(shownHeight(page) * s);
  frame.className = 'bk-frame';
  frame.dataset.page = page.id;
  frame.dataset.day = day;
  frame.dataset.kind = page.kind;
  const words = z.title(page);
  frame.setAttribute('aria-label', words || 'A page');
  frame.innerHTML = `<canvas style="width:${w}px;height:${h}px;background-size:${DOT_PX * s}px ${DOT_PX * s}px"></canvas>${
    words ? `<span>${esc(words)}</span>` : ''
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
function paint(canvas, page, s) {
  const k = devicePixelRatio || 1,
    w = parseFloat(canvas.style.width),
    h = parseFloat(canvas.style.height);
  Object.assign(canvas, { width: Math.round(w * k), height: Math.round(h * k) });
  const g = canvas.getContext('2d');
  g.setTransform(k * s, 0, 0, k * s, 0, 0);
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
  draw(g, page.ink);
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
// The week up to the book's day: it and the six before it, the latest first
function weekOf(book) {
  const d = new Date(`${book.day}T12:00:00Z`);
  return Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - i)).toISOString().slice(0, 10),
  );
}
