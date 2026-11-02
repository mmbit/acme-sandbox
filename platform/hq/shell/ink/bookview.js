// The page as the book's paper shows it: where it's panned to and how far it's zoomed, the paper and its dots drawn
// under it to match (so the page has no edge anywhere), a point on screen as the page's px, a quick slide to a place,
// and its dry ink drawn sharp again at the zoom it comes to rest at.
//
// book (bookpages.js): { desk, world, views, cur, size, pan, scale, drawn, heldPastEnd }. The paper's px are CSS px
// from the desk's top-left; the page's are its own (bookrow.js).
import { dotsShown, drawScale, pageAt, shownBox } from './bookrow.js';

// the paper's dot grid, one dot every DOT_PX of the page (bookdesk.css)
const DOT_PX = 22;
// how long a slide to a place or a zoom by the controls takes: quick, eased out
const SLIDE_MS = 200;
// once the zoom has stayed put this long, the ink is drawn again for it, sharp
const REST_MS = 140;
// how much of the page's foot (its last note's, screen px) stays in sight at the top of the paper scrolled to its end:
// the rest of the screen below it is empty page, to stretch the note and write under it
const FOOT_SHOWN = 120;

// The page shown
export const viewOf = book => book.views[book.cur] ?? null;

// The view set: the page panned to pan at zoom scale, kept on the page, drawn. (a
// pinch never goes past the page's zoom on its way to the overview)
export function setView(book, { pan = book.pan, scale = book.scale } = {}) {
  const v = viewOf(book);
  if (!v || !book.size.w) return;
  // (a page of units has no zoom of its own: drawn at its masonry's scale, scrolled down only (the paper ends above
  // the tools: bookgroups.css).)
  scale = v.page.scale ?? 1;
  const zoomed = scale !== book.scale;
  book.scale = scale;
  // (scrolled on past the page's foot by about a screen, never moved there by itself: a unit's room dragged shorter
  // leaves the page where it is, past its end, and from there it scrolls back up but no further down.)
  const end = (v.page.h ?? 0) - Math.min(book.size.h, FOOT_SHOWN) / scale,
    held = v.page.resizing || book.heldPastEnd === v.page ? book.pan.y : 0,
    lowest = Math.max(end, held);
  book.pan = { x: 0, y: Math.max(0, Math.min(pan.y, lowest)) };
  book.heldPastEnd = book.pan.y > end ? v.page : null;
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
  // (the zoom for the dots and for what keeps its size on screen over the page: a selection's frame.)
  desk.setProperty('--bk-scale', s);
  desk.setProperty('--bk-dots-shown', dotsShown(s));
  desk.backgroundSize = `${DOT_PX * s}px ${DOT_PX * s}px`;
  desk.backgroundPosition = `${-pan.x * s}px ${-pan.y * s}px`;
  book.drawn ??= drawScale(s);
  book.views.forEach((v, i) => v.show(i === book.cur ? shown(book) : null, book.drawn));
}
// The book out of sight (shut past the screen's edge, book.js) or back: its pages paint nothing meanwhile, and what
// changed is painted as it shows (bookpage.js). Back, it's on the hand, so a finger's first touch moves the page and
// never scribbles on it.
export function away(book, on) {
  book.away = on;
  for (const v of book.views) v.hold(on);
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

// The view slides to a place ({ pan, scale }), quickly, and comes to rest there; then(), once it has, or stopped(), once
// a hand or another slide stops it on the way (halt.)
export function slideTo(book, to, then = () => {}, stopped = () => {}) {
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
  book.stopped = stopped;
}
export const halt = book => {
  if (!book.slide) return;
  cancelAnimationFrame(book.slide);
  book.slide = 0;
  book.stopped();
};
