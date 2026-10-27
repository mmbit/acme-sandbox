// The page as the book's paper shows it: where it's panned to and how far it's zoomed, the paper and its dots drawn
// under it to match (so the page has no edge anywhere), a point on screen as the page's px, a quick slide to a place,
// and its dry ink drawn sharp again at the zoom it comes to rest at.
//
// book (bookpages.js): { desk, world, views, cur, size, pan, scale, drawn }. The paper's px are CSS px from the desk's
// top-left; the page's are its own (bookrow.js).
import { clampPan, clampScale, drawScale, leastScale, pageAt, shownBox, zoomAt } from './bookrow.js';

// the paper's dot grid, one dot every DOT_PX of the page (book.css's --bk-dots)
const DOT_PX = 22;
// how long a slide to a place or a zoom by the controls takes: quick, eased out
const SLIDE_MS = 200;
// once the zoom has stayed put this long, the ink is drawn again for it, sharp
const REST_MS = 140;

// The page shown
export const viewOf = book => book.views[book.cur] ?? null;

// The view set: the page panned to pan at zoom scale, kept on the page, drawn. (a
// pinch never goes past the page's zoom on its way to the overview)
export function setView(book, { pan = book.pan, scale = book.scale } = {}) {
  const v = viewOf(book);
  if (!v || !book.size.w) return;
  scale = clampScale(scale, v.page, book.size);
  const zoomed = scale !== book.scale;
  book.scale = scale;
  book.pan = clampPan(pan, v.page, book.size, scale);
  draw(book);
  if (zoomed) {
    clearTimeout(book.rest);
    book.rest = setTimeout(() => sharpen(book), REST_MS);
    book.zoomed?.();
  }
}
// The page and the paper under it where the view is: the world moved and scaled, the dots with it, the tiles near the
// paper drawn
export function draw(book) {
  const { pan, scale: s } = book,
    desk = book.desk.style;
  book.world.style.transform = `translate3d(${-pan.x * s}px, ${-pan.y * s}px, 0) scale(${s})`;
  // (the zoom for what keeps its size on screen over the page: a selection's frame.)
  book.world.style.setProperty('--bk-scale', s);
  desk.backgroundSize = `${DOT_PX * s}px ${DOT_PX * s}px`;
  desk.backgroundPosition = `${-pan.x * s}px ${-pan.y * s}px`;
  book.drawn ??= drawScale(s);
  book.views.forEach((v, i) => v.show(i === book.cur ? shown(book) : null, book.drawn));
}
// The zoom came to rest: the ink drawn again for it
function sharpen(book) {
  const r = drawScale(book.scale);
  if (r === book.drawn) return;
  book.drawn = r;
  draw(book);
}

// What of the page the paper shows: a box in the page's px
export const shown = book => shownBox(book.pan, book.scale, book.size);

// The page under a point on screen and the point in its px (pan and zoom undone): { i, view, x, y }, or null off the
// paper or when no page shows
export function at(book, clientX, clientY) {
  const v = viewOf(book);
  if (!v || !book.size.w || book.far?.()) return null;
  const r = book.desk.getBoundingClientRect(),
    on = { x: clientX - r.left, y: clientY - r.top };
  if (on.x < 0 || on.y < 0 || on.x > r.width || on.y > r.height) return null;
  return { i: book.cur, view: v, ...pageAt(book.pan, book.scale, on) };
}

// The view slides to a place ({ pan, scale }), quickly, and comes to rest there; then(), once it has
export function slideTo(book, to, then = () => {}) {
  halt(book);
  const from = { pan: { ...book.pan }, scale: book.scale },
    end = { pan: to.pan ?? from.pan, scale: to.scale ?? from.scale },
    start = performance.now();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setView(book, end);
    return then();
  }
  const step = now => {
    const t = Math.min(1, (now - start) / SLIDE_MS),
      e = 1 - (1 - t) ** 3,
      // (the zoom eased as a ratio, so a zoom in and out feel alike)
      scale = from.scale * (end.scale / from.scale) ** e;
    // (the pan follows the zoom so that the place it ends at stays put on screen: both reach their end together)
    const pan = { x: from.pan.x + (end.pan.x - from.pan.x) * e, y: from.pan.y + (end.pan.y - from.pan.y) * e };
    setView(book, { pan, scale });
    if (t < 1) book.slide = requestAnimationFrame(step);
    else {
      book.slide = 0;
      then();
    }
  };
  book.slide = requestAnimationFrame(step);
}
export const halt = book => {
  cancelAnimationFrame(book.slide);
  book.slide = 0;
};

// The zoom changed by a factor, keeping a point on the paper (CSS px from its top-left; its middle when none) where it
// is, sliding there (the controls and keys) or at once (a wheel). Returns false when it would go past the page's least
// zoom: the overview's to take (bookzoom.js). (least: was the page's width)
export function zoomBy(book, k, { at: point = null, slide = true } = {}) {
  const v = viewOf(book);
  if (!v) return true;
  const least = leastScale(v.page, book.size),
    from = book.scale;
  if (k < 1 && from <= least + 1e-6) return false;
  const scale = clampScale(from * k, v.page, book.size),
    mid = point ?? { x: book.size.w / 2, y: book.size.h / 2 },
    pan = zoomAt(book.pan, from, scale, mid);
  if (slide) slideTo(book, { pan, scale }, () => book.remember());
  else setView(book, { pan, scale });
  return true;
}
// The zoom at 100% about the paper's middle
export const actualSize = book => zoomBy(book, 1 / book.scale);
