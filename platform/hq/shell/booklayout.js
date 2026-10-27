// The book's layout on each shape of screen: how wide HQ's page, the book's spine, the book and the rail are, open,
// folded or spread, where a drag of the spine leaves it, and what's remembered of it per shape. Plain maths (book.js
// draws it), so node tests it: booklayout.test.js.

// The book's spine: its cloth, the width of a finger's grip less what it overhangs (book.css). Its controls float as
// small islands over its paper (bookui.js), so the book has no column of its own beside it: what the page gives up is
// the spine and the paper. (the rail's column gone)
export const SPINE = 12;
// The page's share of a screen with the book open beside it: 620 of the iPad mini's 1133 landscape points, which
// leaves the book 501 (the concept's layout, section 2). Wider screens give the book at most BOOK.max of it.
const PAGE_SHARE = 620 / 1133;
// A book narrower than BOOK.min is too small to draw on: let go narrower, it folds. Wider than BOOK.max by default, it
// takes a desktop's page for nothing (the concept's desktop column, with the rail's 48 now paper). A drag can make it as
// wide as leaves HQ's page PAGE_MIN.
const BOOK = { min: 320, max: 520 };
// At half a split screen (about 560 pt) or less, or in portrait, the book starts folded and opens beside the page.
const NARROW = 560;
// From a laptop's width up, a screen is remembered apart from a tablet's landscape.
const WIDE = 1280;
// HQ's page narrower than a small phone's is no page: the book opens as the spread instead. A phone's width beside the
// book still is one.
const PAGE_MIN = 320;
// A flick: the spine let go moving faster than this (px per ms) folds the book or spreads it.
const FLICK = 0.5;

export const MODES = ['open', 'folded', 'spread'];

// The shape a screen's size is remembered under
export function shapeOf(w, h) {
  if (w <= NARROW) return 'narrow';
  if (h > w) return 'portrait';
  return w >= WIDE ? 'wide' : 'landscape';
}

// What a shape starts with before anything's remembered: open beside the page in landscape and on a desktop, folded
// in portrait and at half a split screen. book: the width the board gave it with the spine, or null for the default.
export function initial(shape) {
  return { mode: shape === 'portrait' || shape === 'narrow' ? 'folded' : 'open', book: null };
}

// The parts' widths in px at a screen size and state, left to right: HQ's page, the spine, the book's paper.
// room: what the book's parts take from the screen's right edge, the width HQ's page gives up (none folded). In the
// spread the book covers the whole screen, its spine at the left edge, and the page keeps its open width under it
// (shown again as it was, at once); where the open book would leave no page (a phone) the spread covers HQ at its
// folded width, never a sliver. mode: the state's, or 'spread' where the open book would leave no page.
export function layout(w, h, state) {
  const shape = shapeOf(w, h),
    book = bookWidth(w, state.book),
    openPage = w - SPINE - book;
  if (state.mode === 'folded') return { shape, mode: 'folded', page: w, spine: 0, book: 0, room: 0 };
  if (state.mode === 'spread' || openPage < PAGE_MIN) {
    const page = openPage < PAGE_MIN ? w : openPage;
    return { shape, mode: 'spread', page, spine: SPINE, book: w - SPINE, room: w - page };
  }
  return { shape, mode: 'open', page: openPage, spine: SPINE, book, room: Math.min(w, SPINE + book) };
}

// The book's open width: the one the board gave it, within what this screen allows, or the default.
export function bookWidth(w, wanted = null) {
  const most = Math.max(BOOK.min, w - SPINE - PAGE_MIN);
  if (wanted != null) return clamp(Math.round(wanted), BOOK.min, most);
  return clamp(w - SPINE - Math.round(PAGE_SHARE * w), BOOK.min, BOOK.max);
}

// Where the spread goes back to: open beside the page, or folded where the open book would be the spread again (a phone).
export const outOfSpread = (w, h, state) =>
  layout(w, h, { ...state, mode: 'open' }).mode === 'open' ? 'open' : 'folded';

// Where the book goes when the spine is let go: where it was let go. dx: how far
// the spine moved (px, + to the right); v: its speed then (px per ms, + to the right). A flick right folds it (from the
// spread: back to the page), a flick left spreads it. Else the book keeps the width it was let go at: narrower than
// BOOK.min it folds, leaving HQ's page narrower than PAGE_MIN it spreads.
export function released(w, h, state, dx, v) {
  const now = layout(w, h, state);
  if (now.mode === 'folded') return state;
  if (v > FLICK) return now.mode === 'spread' ? { mode: outOfSpread(w, h, state), book: state.book } : folded(state);
  if (v < -FLICK) return { mode: 'spread', book: state.book };
  const spine = (now.mode === 'spread' ? 0 : now.page) + dx;
  return letGo(w, state, w - spine - SPINE);
}

// Where the book goes when its lip, pulled left (dx < 0), is let go: the book's edge stays where it was let go, as the
// spine's would. A flick left opens it at its own width, a flick right puts it back.
export function pulled(w, h, state, dx, v) {
  if (v < -FLICK) return { ...state, mode: 'open' };
  if (v > FLICK) return folded(state);
  return letGo(w, state, -dx - SPINE);
}

// The book let go this wide: folded when too narrow to draw on, the spread when HQ's page would be too narrow, else open
// at that width (kept to the screen). A fold keeps the width it had to open at again.
function letGo(w, state, book) {
  if (book < BOOK.min) return folded(state);
  if (w - SPINE - book < PAGE_MIN) return { mode: 'spread', book: state.book };
  return { mode: 'open', book: bookWidth(w, book) };
}
const folded = state => ({ mode: 'folded', book: state.book });

// What's remembered, per shape: open, folded or spread, and the width the board gave the book. storage: HQ's store
// (get(key, fallback), set(key, value)).
export function recall(storage, shape) {
  const kept = storage.get(`book.${shape}`, null);
  if (!kept || !MODES.includes(kept.mode)) return initial(shape);
  return { mode: kept.mode, book: Number.isFinite(kept.book) ? kept.book : null };
}
export const keep = (storage, shape, state) => storage.set(`book.${shape}`, { mode: state.mode, book: state.book });

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
