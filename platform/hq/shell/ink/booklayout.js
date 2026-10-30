// The book's layout on each shape of screen: how wide HQ's page, the cover's edge and the book are, open, folded or
// spread over HQ, where a drag of the cover's edge or a pull of the tab leaves it, and what's remembered of it per shape.
// Plain maths (book.js draws it), so node tests it: booklayout.test.js.
// (a hardcover: its spine just past the screen's right edge, its cover's outer edge the one that resizes it, its pull tab
// the one that opens and closes it.)

// The cover's outer edge: the black board showing past the pages on HQ's side, the width of a finger's grip less what it
// overhangs (book.css). Dragged, it resizes the open book. Its controls float as small islands over its paper
// (bookui.js), so the book has no column of its own beside it: what the page gives up is the edge and the paper.
export const EDGE = 12;
// The page's share of a screen with the book open beside it: 620 of the iPad mini's 1133 landscape points, which
// leaves the book 501 (the concept's layout, section 2). Wider screens give the book at most BOOK.max of it.
const PAGE_SHARE = 620 / 1133;
// The book is never narrower than BOOK.min (too small to draw on): a drag of its edge stops there, never closing it.
// Wider than BOOK.max by default, it takes a desktop's page for nothing (the concept's desktop column, with the rail's 48
// now paper). A drag can make it as wide as leaves HQ's page PAGE_MIN.
export const BOOK = { min: 320, max: 520 };
// At half a split screen (about 560 pt) or less, or in portrait, the book starts folded. In portrait it opens as the
// spread, as on a phone, until the board drags its cover's edge to a width beside the page: beside HQ's page at its
// share it is too narrow to read an answer on (an iPad mini upright, 325 px: under 160 px of paper left of the
// controls).
const NARROW = 560;
// From a laptop's width up, a screen is remembered apart from a tablet's landscape.
const WIDE = 1280;
// The table kept round the book at its head, foot and (the spread's) outer edge, never at the spine past the screen's
// right edge (book.css --bk-gap, less on a screen SMALL px wide or less), and the page block's edge showing past the
// paper on its left (--bk-pages)
const GAP = 24,
  SMALL_GAP = 16,
  SMALL = 600,
  PAGES = 4;
// The controls floating over the paper's right edge, as bookui.css lays them: Undo's column and the tool strip beside
// it, 52 px each with a finger and 8 apart (bookui.js measures them as --bk-controls-width), 12 px in from the paper's
// edge and 12 more kept clear of them. What lies on the paper keeps left of them.
export const CONTROLS = { width: 52 + 8 + 52, clear: 12 + 12 };
// HQ's page narrower than a small phone's is no page: the book opens as the spread instead. A phone's width beside the
// book still is one.
const PAGE_MIN = 320;
// A flick: the tab let go moving faster than this (px per ms) opens or closes the book, however far it went.
const FLICK = 0.5;
// The tab let go without a flick: the book opens (or closes) once it's been drawn this share of its width.
const PULL_SHARE = 1 / 3;

export const MODES = ['open', 'folded', 'spread'];

// Every shape shapeOf names (the store keeps a page's zoom for each, notebook.ts zoomPage.)
export const SCREEN_SHAPES = ['narrow', 'portrait', 'landscape', 'wide'];
// The shape a screen w × h px is remembered under
export function shapeOf(w, h) {
  if (w <= NARROW) return 'narrow';
  if (h > w) return 'portrait';
  return w >= WIDE ? 'wide' : 'landscape';
}

// What a shape starts with before anything's remembered: open beside the page in landscape and on a desktop, folded
// in portrait and at half a split screen. book: the width the board gave it with the cover's edge, or null for the default.
export function initial(shape) {
  return { mode: shape === 'portrait' || shape === 'narrow' ? 'folded' : 'open', book: null };
}

// The parts' widths in px at a screen size and state, left to right: HQ's page, the cover's edge, the book.
// room: what the book's parts take from the screen's right edge, the width HQ's page gives up (none folded). In the
// spread (a phone's, or wherever the open book leaves HQ too little) the book lies on top of the whole screen, its edge
// at the left, and the page keeps its open width under it (shown again as it was, at once); where the open book would
// leave no page (a phone), or in portrait at no width the board gave it, the spread covers HQ at its folded width, never
// a sliver. mode: the state's, or 'spread' where the open book would leave no page or lies over HQ in portrait.
export function layout(w, h, state) {
  const shape = shapeOf(w, h),
    book = bookWidth(w, state.book),
    openPage = w - EDGE - book,
    over = openPage < PAGE_MIN || (shape === 'portrait' && state.book == null);
  if (state.mode === 'folded') return { shape, mode: 'folded', page: w, edge: 0, book: 0, room: 0 };
  if (state.mode === 'spread' || over) {
    const page = over ? w : openPage;
    return { shape, mode: 'spread', page, edge: EDGE, book: w - EDGE, room: w - page };
  }
  return { shape, mode: 'open', page: openPage, edge: EDGE, book, room: Math.min(w, EDGE + book) };
}

// The paper's width at a screen size and state, open or spread: the book less its pages' edges, and on the spread the
// table at its left (book.js); the paper runs on to the screen's right edge.
export function paperWidth(w, h, state) {
  // (upright, no table round the book and no page block's edge, and the spread's paper fills the screen, its cover's
  // edge past the screen's left: book.css, book.js)
  const l = layout(w, h, state),
    upright = h >= w,
    gap = upright ? 0 : w <= SMALL ? SMALL_GAP : GAP;
  if (l.mode === 'spread' && upright) return w;
  return l.book - (l.mode === 'spread' ? gap : 0) - (upright ? 0 : PAGES);
}

// The book's open width: the one the board gave it, within what this screen allows, or the default.
export function bookWidth(w, wanted = null) {
  const most = Math.max(BOOK.min, w - EDGE - PAGE_MIN);
  if (wanted != null) return clamp(Math.round(wanted), BOOK.min, most);
  return clamp(w - EDGE - Math.round(PAGE_SHARE * w), BOOK.min, BOOK.max);
}

// Where the book goes when its cover's edge is let go: where it was let go, as wide as that makes it. dx: how far the
// edge moved (px, + to the right). The edge only resizes: never narrower than BOOK.min (it stops there, open), and
// where it would leave HQ's page narrower than PAGE_MIN the book lies over the whole screen (the spread).
export function released(w, h, state, dx) {
  const now = layout(w, h, state);
  if (now.mode === 'folded') return state;
  const edge = (now.mode === 'spread' ? 0 : now.page) + dx,
    book = Math.max(BOOK.min, w - edge - EDGE);
  if (w - EDGE - book < PAGE_MIN) return { mode: 'spread', book: state.book };
  return { mode: 'open', book: bookWidth(w, book) };
}

// Where the book goes when its pull tab is let go after a drag: dx how far it was drawn (px, + to the right), v its
// speed then (px per ms). Shut, drawn left a third of its open width or flicked left, it opens at the width it had;
// open, drawn right as far or flicked right, it shuts. Else it goes back as it was. (Its open width never changes on
// the way: the book doesn't stretch while it's lifted.)
export function pulled(w, h, state, dx, v) {
  const now = layout(w, h, state),
    shut = now.mode === 'folded',
    far = Math.abs(dx) >= PULL_SHARE * (shut ? layout(w, h, { ...state, mode: 'open' }).book : now.book);
  if (shut) return v < -FLICK || (v <= FLICK && dx < 0 && far) ? { ...state, mode: 'open' } : state;
  return v > FLICK || (v >= -FLICK && dx > 0 && far) ? { mode: 'folded', book: state.book } : state;
}

// What's remembered, per shape: open, folded or spread, and the width the board gave the book. storage: HQ's store
// (get(key, fallback), set(key, value)).
export function recall(storage, shape) {
  const kept = storage.get(`book.${shape}`, null);
  if (!kept || !MODES.includes(kept.mode)) return initial(shape);
  return { mode: kept.mode, book: Number.isFinite(kept.book) ? kept.book : null };
}
export const keep = (storage, shape, state) => storage.set(`book.${shape}`, { mode: state.mode, book: state.book });

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
