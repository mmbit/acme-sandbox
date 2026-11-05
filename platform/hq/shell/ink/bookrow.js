// The book's page as plain numbers: how far it pans and zooms, how it grows to hold what's on it, and which of its
// tiles to draw. No DOM, so node tests it. (one endless page; was a row of pages
// on a table)
//
// One page fills the book's paper. The page has its own px, its CSS px at a zoom of 1, with its origin at 0,0.
// What's on it may lie any way from there, above and left too: the page is the box { x, y, w, h } that holds it, its
// top-left (x, y) at or above and left of 0,0 (a page with no x and y starts at 0,0). The view is { pan, scale }: pan
// is the page's point at the paper's top-left, scale how many CSS px a page px is on screen. A point on the paper (CSS
// px from its top-left) is the page's pan + point / scale. (the page grows every
// way)

import { MARGIN } from './masonry.js';
import { UNIT_W } from './scrapunit.js';

// A page's sides as the store makes one, and the most a page grows to either way (pagechecks.ts PAGE and GROWN_MAX)
export const SIDE = { min: 100, max: 4000 };
export const GROWN_MAX = 20_000;
// the closest the zoom goes in (zoomWithin)
export const ZOOM_MAX = 4;
// The zooms a page is kept at for a screen's shape (bookpagezoom.js; the store's notebook.ts zoomPage): ZOOM_MAX in, and
// out as far as a page GROWN_MAX long shows whole on a screen 100 px tall
export const ZOOM_KEPT = { least: 100 / GROWN_MAX, most: ZOOM_MAX };
// a page grows to hold what's on it with this much paper to spare beyond it
export const ROOM_PX = 40;

// A page's box in its own px.
export const pageBox = page => {
  const x0 = page.x ?? 0,
    y0 = page.y ?? 0;
  return { x0, y0, x1: x0 + page.w, y1: y0 + page.h };
};

// An opened scrap's zoom (bookview.js.): in to ZOOM_MAX, and out to ZOOM_OUT, or further where what's drawn needs it to
// show whole in SHOWN_IN of the paper's width and height, so the board sees all of it with paper round it however far
// it's drawn on.
export const ZOOM_OUT = 1 / 8;
const SHOWN_IN = 1 / 3;
export const zoomWithin = (s, page, view) =>
  Math.min(ZOOM_MAX, Math.max(Math.min(ZOOM_OUT, (SHOWN_IN * view.w) / page.w, (SHOWN_IN * view.h) / page.h), s));
// How far an opened scrap pans at a zoom of s (bookscrapopen.js): any way past what's on it by half a screen, so it's
// endless every way, a screen of fresh paper beside what's drawn at each edge. view: the paper's { w, h }.
export function scrapPans(page, view, s) {
  const p = pageBox(page),
    w = view.w / s,
    h = view.h / s;
  return { x0: p.x0 - w / 2, x1: p.x1 - w / 2, y0: p.y0 - h / 2, y1: p.y1 - h / 2 };
}
// A page of scraps' zoom (bookview.js.): out to its masonry's fit, the paper's
// width (bookunits.js), and in to ZOOM_MAX, or its fit where that's closer, so the board writes big on a scrap. Within
// SNAP of the fit it's the fit: two fingers scrolling never zoom the page by their wobble.
const SNAP = 1.03;
export const unitsZoom = (s, fit) => (s < fit * SNAP ? fit : Math.min(Math.max(ZOOM_MAX, fit), s));
// How far a page of scraps pans at a zoom of s: never above or left of its top-left or of what's drawn beyond it
// (drawnReach), the room above it (view.top) in sight; across its width as far as it's zoomed past the paper's left of
// the tools (view.right), and down to its foot with foot px (on screen) of it left. → { x0, x1, y0, y1 }, the pan's
// least and most
export function unitsPans(page, view, s, foot) {
  const reach = drawnReach(page);
  return {
    x0: reach.x0,
    x1: Math.max(0, page.w - (view.w - view.right) / s),
    y0: reach.y0 - view.top / s,
    y1: page.h - Math.min(view.h, foot) / s,
  };
}
// How far what's on a page reaches, in its px: its ink, scraps, units at their places and what hangs under them, the
// units with the margin a canvas keeps round them (bookunits.js canvasSize). Their own reach, not the page's box: its ROOM_PX to spare would creep the limits out with
// each line drawn at the edge. → { x0, y0 }, the top-left a page pans to, 0,0 (where the view's title lies at rest) or
// further where they lie above or left of it, and x1, the right edge they reach, 0 at least. A page's ink is null until
// it's read (bookpage.js).
function drawnReach(page) {
  const reach = { x0: 0, y0: 0, x1: 0 },
    units = (page.places ?? []).flatMap(({ hung: h, ...p }) => [
      { x0: p.x - MARGIN, y0: p.y - MARGIN, x1: p.x + UNIT_W + MARGIN },
      ...(h ? [{ x0: h.x - MARGIN, y0: h.y - MARGIN, x1: h.x + h.w + MARGIN }] : []),
    ]);
  for (const box of [...(page.ink ?? []).map(boxOf), ...page.scraps.map(scrapBoxOf), ...units]) {
    reach.x0 = Math.min(reach.x0, box.x0);
    reach.y0 = Math.min(reach.y0, box.y0);
    reach.x1 = Math.max(reach.x1, box.x1);
  }
  return reach;
}
// The pan that keeps a point on the paper (CSS px from its top-left) over the same spot of the page as the zoom goes
// from s0 to s1: a pinch's middle, the pointer under a trackpad's pinch
export const zoomAt = (pan, s0, s1, at) => ({ x: pan.x + at.x / s0 - at.x / s1, y: pan.y + at.y / s0 - at.y / s1 });

// A point on the paper (CSS px from its top-left) as the page's px
export const pageAt = (pan, scale, at) => ({ x: pan.x + at.x / scale, y: pan.y + at.y / scale });

// What of the page the paper shows: a box in its px
export const shownBox = (pan, scale, view) => ({
  x0: pan.x,
  y0: pan.y,
  x1: pan.x + view.w / scale,
  y1: pan.y + view.h / scale,
});
// Whether the paper shows any of a box on the page
export const showsBox = (box, pan, scale, view) => overlap(box, shownBox(pan, scale, view));
const overlap = (a, b) => a.x1 > b.x0 && a.x0 < b.x1 && a.y1 > b.y0 && a.y0 < b.y1;

// Where a remembered place ({ page: an id or 'new', x, y }) opens in the day's pages by their ids: { i, at }, its page
// and the place on it, or the day's last page with no place when it's gone or nothing was remembered
export function placeIn(ids, place) {
  const i = place ? ids.indexOf(place.page) : -1;
  return i >= 0 ? { i, at: place } : { i: ids.length - 1, at: null };
}

// A page's box ({ x, y, w, h }) grown any way to hold a box on it (a stroke, a picture), with ROOM_PX to spare past it,
// to GROWN_MAX a side at most; it never shrinks
export function grownTo(page, box) {
  const now = pageBox(page),
    side = (from, to, low, high) => {
      const end = Math.min(Math.max(to, Math.ceil(high + ROOM_PX)), from + GROWN_MAX),
        start = Math.max(Math.min(from, Math.floor(low - ROOM_PX)), end - GROWN_MAX);
      return [start, end - start];
    };
  const [x, w] = side(now.x0, now.x1, box.x0, box.x1),
    [y, h] = side(now.y0, now.y1, box.y0, box.y1);
  return { x, y, w, h };
}
// Where a stroke's ink is, in its page's px: { x0, y0, x1, y1 }, its widest line's half on every side (ink.js draws a
// point at most three quarters of the ink's size across). Found once for its points (a changed stroke has new ones,
// a line still drawn only grows): every paint and every pass of the eraser asks it of each stroke on the page
// (bookstrokes.js).
export function boxOf(stroke) {
  const pts = stroke.points,
    held = boxes.get(pts);
  if (held?.n === pts.length && held.size === stroke.size) return { ...held.box };
  const r = stroke.size * 0.75 + 1,
    box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const [x, y] of pts) {
    if (x < box.x0) box.x0 = x;
    if (x > box.x1) box.x1 = x;
    if (y < box.y0) box.y0 = y;
    if (y > box.y1) box.y1 = y;
  }
  Object.assign(box, { x0: box.x0 - r, y0: box.y0 - r, x1: box.x1 + r, y1: box.y1 + r });
  boxes.set(pts, { n: pts.length, size: stroke.size, box });
  return { ...box };
}
const boxes = new WeakMap();
// A scrap's reach on its page, turned any way: its centre and half its diagonal
export function scrapBoxOf(s) {
  const cx = s.x + s.w / 2,
    cy = s.y + s.h / 2,
    r = Math.hypot(s.w, s.h) / 2;
  return { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r };
}

// How much of the paper's dots shows at a zoom of s: drawn to the zoom, they ease out as they shrink (0 at
// DOT_FADE.gone, whole from DOT_FADE.whole) and are gone before they'd be under a pixel across (2.8 px at a zoom of 1:
// bookdesk.css)
const DOT_FADE = { gone: 0.4, whole: 0.8 };
export const dotsShown = s => {
  const t = Math.min(1, Math.max(0, (s - DOT_FADE.gone) / (DOT_FADE.whole - DOT_FADE.gone)));
  return t * t * (3 - 2 * t);
};

// The zoom a page's tiles are drawn for at a zoom of s: the power of two at or above it, so the ink is never drawn
// coarser than it shows, and a zoom only a little different keeps the tiles it has
export const drawScale = s => 2 ** Math.ceil(Math.log2(Math.max(1 / 64, s)) - 1e-9);
