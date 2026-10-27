// Giving through a face: what goes (a sheet's notes at the tap of the small plane by its face, or a page carried by its
// corner: bookdogear.js) folds into a paper plane that flies into the face it goes to, with a soft paper whoosh, then
// ten seconds to undo, a ring running out round the small plane by that face (bookrail.js), and what went to whom said
// for a moment on the page (bookwent.js). Undo, or a tap on the ringed plane, takes it back. (through the faces; was a plane in the page's
// head)
import { noise, ready } from './audio.js';
import { faceBox, faceButton } from './bookrail.js';
import { SEND_MS, sendSheet, undoSend } from './booksheetdata.js';
import { whose } from './booksheetplace.js';
import { keep } from './bookedit.js';
import { went } from './bookwent.js';

export const PLANE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 11.2 21 3.5l-4.6 17-5.1-5.6-3.1 3.6.4-5.3z" fill="#fff" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8.6 13.2 21 3.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';

// When each send made here goes, in this browser's clock (sheet id → ms), as the store answered the tap
export const deadlines = new Map();
// When a send goes, in this browser's clock: as the store answered the tap here, else its send_at (within the seconds)
export function sendAt(sheet) {
  const now = Date.now();
  return deadlines.get(sheet.id) ?? Math.min(now + SEND_MS, Math.max(now, sheet.send_at ?? now));
}

// A sheet handed over from its page (v): its notes there fold into the plane and fly into the face, the board's writing
// beside its notes going with them
export function handOver(sh, v, sheet) {
  const notes = [...v.el.querySelectorAll(`.bs-group[data-sheet="${sheet.id}"] .bs-note[data-open]`)];
  const layer = notes.length ? layerOf(notes, sh.book.paper) : null;
  for (const g of v.el.querySelectorAll(`.bs-group[data-sheet="${sheet.id}"]`)) g.dataset.going = '';
  return give(sh, v, whose(sheet, sh.ceo()), layer, sheet, () => sendSheet(sh.dev, sheet.id, spotsOf(sh, sheet)));
}

// Something given to an agent (to): the layer (what goes, on the screen, or null) folds into the plane and flies into
// their face while the store takes it (send(): the sheet in its seconds), then the ring at the face and Undo.
// what: the sheet sent (its notes said) or, a page sent on its own, { page: true }.
export async function give(sh, v, to, layer, what, send) {
  whoosh();
  const [flown, sent] = await Promise.allSettled([layer ? fly(layer, faceBox(to)) : null, send()]);
  if (flown.status === 'fulfilled') caught(to);
  went(v, what, sh.name(to));
  if (sent.status === 'rejected') {
    for (const g of v.el.querySelectorAll('[data-going]')) delete g.dataset.going;
    sh.tell(v.page, sent.reason);
  } else {
    const s = sent.value;
    deadlines.set(s.id, Date.now() + SEND_MS);
    sh.book.steps.push({ sheet: s.id, undo: () => undoNow(sh, v, s) });
  }
  await sh.refresh();
}
// Where each note lies on the pages showing the sheet's notes that go, any sheet's, in each page's px (the page's box
// on screen is its w at any zoom): the store sends the writing nearest each of the sheet's with it, and leaves the
// writing nearest another sheet's note on the page (bookwriting.ts).
export function spotsOf(sh, sheet) {
  return sh.book.views.flatMap(v => {
    const going = `.bs-note[data-open][data-sheet="${Number(sheet.id)}"]`;
    if (v.page.kind !== 'sheet' || !v.page.id || !v.el.querySelector(going)) return [];
    const at = v.el.getBoundingClientRect(),
      k = v.page.w / at.width;
    return [...v.el.querySelectorAll('.bs-note')].map(el => {
      const r = el.getBoundingClientRect();
      return {
        note: Number(el.dataset.id),
        page: v.page.id,
        x: (r.left - at.left) * k,
        y: (r.top - at.top) * k,
        w: r.width * k,
        h: r.height * k,
      };
    });
  });
}
export async function undoNow(sh, v, sheet) {
  if (!sheet) return;
  keep(sh.book.steps, step => step.sheet !== sheet.id);
  deadlines.delete(sheet.id);
  try {
    await undoSend(sh.dev, sheet.id);
  } catch (e) {
    sh.tell(v?.page, e);
  }
  sh.refresh();
}
// A send in its seconds: the sheets read again as they end (the store sends it then), and again a little later if the
// two clocks disagree
export function awaitSend(sh, sheet) {
  sh.waits ??= new Map();
  if (sh.waits.has(sheet.id)) return;
  const tries = (sh.tries ??= new Map()),
    n = tries.get(sheet.id) ?? 0;
  if (n > 8) return;
  tries.set(sheet.id, n + 1);
  const wait = Math.max(0, sendAt(sheet) - Date.now()) + 300 + n * 700;
  sh.waits.set(
    sheet.id,
    setTimeout(() => {
      sh.waits.delete(sheet.id);
      sh.refresh();
    }, wait),
  );
}

// ---- the fold and the flight

// The notes on the screen as one sheet of paper, lifted off the page where they lie (copies: the notes themselves stay)
function layerOf(notes, paper) {
  const shown = paper.getBoundingClientRect(),
    boxes = notes.map(n => n.getBoundingClientRect());
  const left = Math.max(shown.left, Math.min(...boxes.map(b => b.left)) - 10),
    top = Math.max(shown.top, Math.min(...boxes.map(b => b.top)) - 10),
    right = Math.min(shown.right, Math.max(...boxes.map(b => b.right)) + 10),
    bottom = Math.min(shown.bottom, Math.max(...boxes.map(b => b.bottom)) + 10);
  const layer = foldLayer({ left, top, width: Math.max(40, right - left), height: Math.max(40, bottom - top) });
  notes.forEach((n, i) => {
    const copy = n.cloneNode(true);
    Object.assign(copy.style, {
      position: 'absolute',
      margin: '0',
      left: `${boxes[i].left - left}px`,
      top: `${boxes[i].top - top}px`,
      width: `${boxes[i].width}px`,
    });
    layer.querySelector('.bs-fold-on').append(copy);
  });
  return layer;
}
// A loose sheet over the book at a box on the screen: its paper, what's on it (.bs-fold-on), and the creases a plane
// folds along, unseen till it folds. Exported: a page carried by its corner is one (bookdogear.js).
export function foldLayer({ left, top, width, height }) {
  const layer = document.createElement('div');
  layer.className = 'bs-fold';
  layer.setAttribute('aria-hidden', 'true');
  Object.assign(layer.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  layer.innerHTML = `<div class="bs-fold-sheet"><div class="bs-fold-on"></div><svg class="bs-fold-creases"
    viewBox="0 0 100 100" preserveAspectRatio="none"><path d="M50 0V100M50 0L4 92M50 0L96 92"/></svg></div>`;
  document.getElementById('book').append(layer);
  return layer;
}

// The paper plane it folds into, seen from above, nose up (a box 100 across): its wings, the near one in the light,
// and the keel under them
const DART_SVG = `<svg viewBox="-4 -4 108 112" aria-hidden="true"><path d="M50 0 43 76 50 104 57 76z" fill="#e2d4b4"
  stroke="#2a2352" stroke-width="3.2" stroke-linejoin="round"/><path d="M50 0 0 92 43 76z" fill="#efe3c8" stroke="#2a2352"
  stroke-width="3.2" stroke-linejoin="round"/><path d="M50 0 100 92 57 76z" fill="#fffaf0" stroke="#2a2352"
  stroke-width="3.2" stroke-linejoin="round"/></svg>`;
// how long the fold and the flight take, and the plane's size (px across)
const FOLD_MS = 950,
  DART_PX = 56;

// The layer folds into a plane where it is: the sheet squares up and folds to a dart, which turns its nose to the face
// (to: its box, or null: up off the paper) and flies there in an arc, shrinking into it. Resolves as it lands.
export async function fly(layer, to) {
  const from = layer.getBoundingClientRect();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    await layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' }).finished;
    return layer.remove();
  }
  const way = course(from, to),
    plane = dartAt(layer, way);
  await Promise.all([fold(layer, from, way).finished, flight(plane, way).finished]).catch(() => {});
  layer.remove();
  plane.remove();
}
// The way from the sheet's centre to the face: the step (dx, dy), the heading the nose turns to (the shorter way
// round), the arc's height, the sheet's scale as a dart, and where the dart starts (cx, cy)
function course(from, to) {
  const cx = from.left + from.width / 2,
    cy = from.top + from.height / 2,
    dx = (to ? to.left + to.width / 2 : cx + 80) - cx,
    dy = (to ? to.top + to.height / 2 : from.top - 200) - cy,
    heading = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  return {
    ...{ cx, cy, dx, dy },
    turn: ((((heading + 180) % 360) + 360) % 360) - 180,
    lift: Math.min(90, 30 + Math.hypot(dx, dy) * 0.2),
    k: Math.min(1, DART_PX / Math.min(from.width, from.height)),
  };
}
const at = (x, y, r, s) => `translate(${x}px, ${y}px) rotate(${r}deg) scale(${s})`,
  RUN = { duration: FOLD_MS, easing: 'linear', fill: 'forwards' },
  EASE = 'cubic-bezier(.45,.05,.4,1)';
// The sheet squaring up and folding to a dart, what's on it fading as the creases show; gone as the dart takes over.
// Returns the layer's own animation.
function fold(layer, from, { turn, k }) {
  const { sheet, square, dart, box } = outlines(from.width, from.height);
  Object.assign(layer.querySelector('.bs-fold-creases').style, box);
  layer.firstChild.animate(
    [
      { offset: 0, clipPath: sheet, easing: EASE },
      { offset: 0.22, clipPath: square, easing: EASE },
      { offset: 0.46, clipPath: dart },
      { offset: 1, clipPath: dart },
    ],
    RUN,
  );
  layer
    .querySelector('.bs-fold-on')
    .animate([{ opacity: 1 }, { opacity: 1, offset: 0.24 }, { opacity: 0.15, offset: 0.44 }, { opacity: 0.15 }], RUN);
  layer
    .querySelector('.bs-fold-creases')
    .animate([{ opacity: 0 }, { opacity: 0, offset: 0.26 }, { opacity: 1, offset: 0.44 }, { opacity: 1 }], RUN);
  return layer.animate(
    [
      { offset: 0, transform: at(0, 0, 0, 1), easing: EASE },
      { offset: 0.22, transform: at(0, -6, -4, Math.max(k, 0.5)), easing: EASE },
      { offset: 0.48, transform: at(0, -10, turn, k), opacity: 1 },
      { offset: 0.52, transform: at(0, -10, turn, k), opacity: 0 },
      { offset: 1, transform: at(0, -10, turn, k), opacity: 0 },
    ],
    RUN,
  );
}
// The dart, crisp at its own size, over where the sheet folds
function dartAt(layer, { cx, cy }) {
  const plane = document.createElement('i');
  plane.className = 'bs-dart';
  plane.innerHTML = DART_SVG;
  Object.assign(plane.style, { left: `${cx - DART_PX / 2}px`, top: `${cy - DART_PX / 2}px`, width: `${DART_PX}px` });
  layer.after(plane);
  return plane;
}
// The dart taking over from the folded sheet and flying on its arc into the face, shrinking as it goes
function flight(plane, { dx, dy, turn, lift }) {
  return plane.animate(
    [
      { offset: 0, transform: at(0, -10, turn, 1), opacity: 0 },
      { offset: 0.46, transform: at(0, -10, turn, 1), opacity: 0 },
      { offset: 0.5, transform: at(0, -10, turn, 1), opacity: 1, easing: 'cubic-bezier(.5,0,.6,1)' },
      { offset: 0.78, transform: at(dx * 0.55, dy * 0.55 - lift, turn - 8, 0.8), opacity: 1 },
      { offset: 0.94, transform: at(dx * 0.95, dy * 0.95, turn + 2, 0.35), opacity: 1 },
      { offset: 1, transform: at(dx, dy, turn + 4, 0.15), opacity: 0 },
    ],
    RUN,
  );
}
// The paper's outlines as it folds, in the layer's own box (w × h px): the sheet (six corners, so it can become the
// plane), the square it folds from, and the dart, its nose up, in that square (box: the square, for its creases)
function outlines(w, h) {
  const m = Math.min(w, h),
    x0 = 50 - (50 * m) / w,
    x1 = 50 + (50 * m) / w,
    y0 = 50 - (50 * m) / h,
    y1 = 50 + (50 * m) / h,
    x = f => `${x0 + (x1 - x0) * f}%`,
    y = f => `${y0 + (y1 - y0) * f}%`,
    polygon = points => `polygon(${points.map(([a, b]) => `${a} ${b}`).join(', ')})`;
  return {
    box: { left: `${x0}%`, top: `${y0}%`, width: `${x1 - x0}%`, height: `${y1 - y0}%` },
    sheet: polygon([
      ['0%', '0%'],
      ['100%', '0%'],
      ['100%', '100%'],
      ['66%', '100%'],
      ['33%', '100%'],
      ['0%', '100%'],
    ]),
    square: polygon([
      [x(0), y(0)],
      [x(1), y(0)],
      [x(1), y(1)],
      [x(0.66), y(1)],
      [x(0.33), y(1)],
      [x(0), y(1)],
    ]),
    dart: polygon([
      [x(0.5), y(0)],
      [x(0.5), y(0)],
      [x(1), y(0.92)],
      [x(0.57), y(0.76)],
      [x(0.43), y(0.76)],
      [x(0), y(0.92)],
    ]),
  };
}
// The face takes it: a small bounce as the plane lands in it
function caught(id) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  faceButton(id)
    ?.querySelector('.bk-av')
    ?.animate([{ scale: '1' }, { scale: '1.22', offset: 0.4 }, { scale: '1' }], {
      duration: 320,
      easing: 'cubic-bezier(.3,1.6,.5,1)',
    });
}
// a soft paper whoosh (the book's only sound), when HQ's sound is on
function whoosh() {
  if (!ready()) return;
  noise(0.05, { vol: 0.03, freq: 3200, type: 'highpass' });
  noise(0.5, { vol: 0.045, freq: 500, sweep: 5, q: 0.7, attack: 0.14, at: 0.03 });
}
