// The book's layout on each shape of screen: how wide HQ's page, the book's spine, the book and the rail are, open,
// folded or spread, where a drag of the spine leaves it, and what's remembered of it per shape. Plain maths (book.js
// draws it), so node tests it: booklayout.test.js.

// The rail is the open book's own column (its faces, Search, Undo and the arrow): folded, the book takes nothing from
// HQ's page, and only its lip shows at the screen's edge, over the page (book.css).
export const RAIL = 48;
export const SPINE = 10;
// The page's share of a screen with the book open beside it: 620 of the iPad mini's 1133 landscape points, which
// leaves the book 455 (the concept's layout, section 2). Wider screens give the book at most BOOK.max of it.
const PAGE_SHARE = 620 / 1133;
// A book narrower than BOOK.min can't hold a note's snip beside its words; wider than BOOK.max by default, it takes a
// desktop's page for nothing (the concept's desktop column, 420-480 pt). A drag can make it wider, up to half the screen.
const BOOK = { min: 300, max: 480 };
// At half a split screen (about 560 pt) or less, or in portrait, the book starts folded and opens beside the page.
const NARROW = 560;
// From a laptop's width up, a screen is remembered apart from a tablet's landscape.
const WIDE = 1280;
// A page narrower than four of HQ's 44 pt keys and their gaps is no page: the book opens as the spread instead (a
// phone). Half an iPad mini's split screen still keeps a page beside the book.
const PAGE_MIN = 200;
// A flick: the spine let go moving faster than this (px per ms) folds the book or brings back the spread's page.
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

// The parts' widths in px at a screen size and state, left to right: HQ's page, the spine, the book, the rail.
// room: what the book's parts take from the screen's right edge, the width HQ's page gives up (none folded). In the
// spread the book covers the whole screen, its rail too, and the page keeps its open width under it (shown again as it
// was, at once); where the open book would leave no page (a phone) the spread covers HQ at its folded width, never a
// sliver. mode: the state's, or 'spread' where the open book would leave no page. facing: whether the spread's paper
// holds two facing pages, each a book's least; narrower, it's one page across it.
export function layout(w, h, state) {
  const shape = shapeOf(w, h),
    book = bookWidth(w, state.book),
    openPage = w - RAIL - SPINE - book;
  if (state.mode === 'folded')
    return { shape, mode: 'folded', page: w, spine: 0, book: 0, rail: 0, room: 0, facing: false };
  if (state.mode === 'spread' || openPage < PAGE_MIN) {
    const page = openPage < PAGE_MIN ? w : openPage;
    return {
      shape,
      mode: 'spread',
      page,
      spine: 0,
      book: w - RAIL,
      rail: RAIL,
      room: w - page,
      facing: w - RAIL - SPINE >= 2 * BOOK.min,
    };
  }
  const room = Math.min(w, RAIL + SPINE + book);
  return { shape, mode: 'open', page: openPage, spine: SPINE, book, rail: RAIL, room, facing: false };
}

// The book's open width: the one the board gave it, within what this screen allows, or the default.
export function bookWidth(w, wanted = null) {
  const most = Math.max(BOOK.min, Math.floor((w - RAIL) / 2) - SPINE);
  if (wanted != null) return clamp(Math.round(wanted), BOOK.min, most);
  return clamp(w - RAIL - SPINE - Math.round(PAGE_SHARE * w), BOOK.min, BOOK.max);
}

// Where the spread goes back to: open beside the page, or folded where the open book would be the spread again (a phone).
export const outOfSpread = (w, h, state) =>
  layout(w, h, { ...state, mode: 'open' }).mode === 'open' ? 'open' : 'folded';

// Where the book goes when the spine is let go. dx: how far the spine moved (px, + to the right); v: its speed then
// (px per ms, + to the right). Open: a flick right, or the spine carried past the middle of the book, folds it; the
// spine carried left past the middle of the screen opens the spread; anywhere else the book keeps the width it was
// dragged to. The spread: a flick right, or a drag right past a quarter of the screen, brings the page back (folds the
// book where there's no room for a page).
export function released(w, h, state, dx, v) {
  const now = layout(w, h, state);
  if (now.mode === 'spread')
    return v > FLICK || dx > (w - RAIL) / 4
      ? { mode: outOfSpread(w, h, state), book: state.book }
      : { ...state, mode: 'spread' };
  if (now.mode !== 'open') return state;
  if (v > FLICK || dx > now.book / 2) return { mode: 'folded', book: state.book };
  const spine = now.page + dx;
  if (spine < (w - RAIL) / 2 - SPINE) return { mode: 'spread', book: state.book };
  return { mode: 'open', book: bookWidth(w, now.book - dx) };
}

// Where the book opens when its lip is dragged left (dx < 0) and let go: past a third of the book's width,
// or flicked left, it opens; else it stays folded.
export function pulled(w, h, state, dx, v) {
  const book = bookWidth(w, state.book);
  return -dx > book / 3 || v < -FLICK ? { ...state, mode: 'open' } : { ...state, mode: 'folded' };
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
