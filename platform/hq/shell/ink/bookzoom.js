// The book zoomed out past a page: the overview. First the notebook's pages as a grid; zoomed out again, the Shelf of
// every notebook, with the Archive beside it (both drawn by bookshelf.js). A page tapped there opens it; a notebook
// tapped opens its pages; zoomed in, it comes back to the page. Two fingers' pinch over the overview, a trackpad's
// pinch (a wheel with Ctrl), Safari's gesture events and the view's controls (bookcontrols.js) step it; each step
// turns a leaf within the notebook (bookflip.js), as a page change does. A pinch on the page itself never opens the
// overview (only its button and the keys do: bookpages.js). To and from the Shelf, the view zooms instead (bookflip.js),
// into the notebook's own tile there and back out to it.
import { mountScreens } from './bookshelf.js';

// the views, nearest first: the page itself (bookpages.js), the notebook's pages, the Shelf
const LEVELS = ['page', 'pages', 'shelf'];
// how far two fingers close (or open) before the overview steps out (or in): one step a pinch
const OUT = 0.78,
  IN = 1.28;
// a trackpad's pinch: this much wheel in one direction is a step, and a pause this long ends the pinch
const WHEEL_STEP = 50,
  WHEEL_REST_MS = 260;

// paper: the book's pages (bookpages.js's .bk-pages). desk: the page's own layer in it, what the view zooms in to
// from the Shelf. dev: on mock data. notebook(): the notebook the book shows now
// (its id, or a promise of it; null: none on the Shelf); page(): the page it shows (its id); saved(): what's drawn
// saved in the store, a promise. open(page, notebook): that page shown, of that notebook (notebookdata.js's page).
// turn(dir, midway): a leaf turned over the paper, midway() swapping what's under it (bookflip.js). zoom(coming,
// midway, dir, at): the same swap with the view zooming out (dir -1) or in (dir 1), at() the notebook's tile on the
// Shelf it zooms round. changed(level): the overview opened,
// stepped or closed.
export function mountZoom(paper, { desk, dev, notebook, page, saved, open, turn, zoom, changed, scope = null }) {
  const far = document.createElement('div');
  far.className = 'bk-far';
  far.hidden = true;
  paper.append(far);
  const z = {
    far,
    desk,
    open,
    turn,
    zoom,
    changed,
    level: 0,
    notebook: null,
    used: false,
    max: scope?.singlePage ? 0 : scope ? 1 : 2,
  };
  Object.assign(z, { touches: new Map(), wheel: 0, rest: 0 });
  z.screens = mountScreens(far, {
    dev,
    scope,
    current: notebook,
    page,
    saved,
    open: (page, id) => back(z, { page, id }),
    shelf: () => go(z, 2),
    notebook: id => go(z, 1, id),
  });
  pinches(paper, z);
  return {
    // 'page', 'pages' or 'shelf'
    level: () => LEVELS[z.level],
    // read and drawn again (the book's pages changed)
    again: () => z.level && z.screens.again(),
    // back to the page at once, no leaf (a find, New page)
    near: () => z.level && close(z),
    // a step out (the controls and keys), or in (back to the page from the notebook's pages)
    out: () => step(z, 1),
    in: () => step(z, -1),
    // the overview from the page, or back to it (the overview's button)
    toggle: () => (z.level ? back(z) : step(z, 1)),
  };
}

// ---- the gestures

function pinches(paper, z) {
  fingers(paper, z);
  trackpads(paper, z);
}
// Two fingers on an iPad, as pointers, over the overview. (split from pinches)
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
  const level = Math.max(0, Math.min(z.max, z.level + by));
  if (level === z.level) return;
  if (!level) return back(z);
  go(z, level, z.notebook);
}

// ---- the views

// The overview at a level (the notebook's pages: that notebook's, the book's own (null) by default): out to the Shelf
// the view zooms, in from the Shelf it zooms back. Within the notebook a leaf turns
function go(z, level, id = null) {
  const from = z.level,
    dir = level > from ? -1 : 1;
  z.level = level;
  z.notebook = id ?? z.notebook;
  z.changed(LEVELS[level]);
  if (LEVELS[level] === 'shelf' || LEVELS[from] === 'shelf')
    return z.zoom(
      z.far,
      () => show(z),
      dir,
      () => tileOf(z),
    );
  return z.turn(dir, () => show(z));
}
// The notebook's tile on the Shelf (the one the book shows where it names none), as a box on the screen: what the
// view zooms into and back out to
const tileOf = z =>
  z.far
    .querySelector(
      z.notebook == null ? '.bk-book[aria-current]' : `.bk-book[data-book="${CSS.escape(String(z.notebook))}"]`,
    )
    ?.getBoundingClientRect() ?? null;
function show(z) {
  z.far.hidden = false;
  z.far.dataset.level = LEVELS[z.level];
  return z.screens.show(LEVELS[z.level], z.notebook);
}
// Back to the page: a page tapped in the grid (to: { page, id }), or the page as it was. From the notebook's pages a
// leaf turns to it; from the Shelf the view zooms in to it.
function back(z, to = null) {
  const midway = () => {
    close(z);
    if (to) return z.open(to.page, to.id);
  };
  if (LEVELS[z.level] === 'shelf') return z.zoom(z.desk, midway, 1, () => tileOf(z));
  return z.turn(1, midway);
}
function close(z) {
  z.level = 0;
  z.notebook = null;
  z.far.hidden = true;
  delete z.far.dataset.level;
  z.screens.hide();
  z.changed('page');
}
