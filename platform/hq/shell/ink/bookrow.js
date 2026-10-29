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

// A page's sides as the store makes one, and the most a page grows to either way (pagechecks.ts PAGE and GROWN_MAX)
export const SIDE = { min: 100, max: 4000 };
export const GROWN_MAX = 20_000;
// the closest the zoom goes in. The furthest out shows the whole page, and at least half size, so a page no bigger than
// the paper still shows paper round it to draw big on. (was the page's width,
// past which the overview took over)
export const ZOOM_MAX = 4,
  ZOOM_OUT = 0.5;
// The zooms a page is kept at for a screen's shape (bookpagezoom.js; the store's notebook.ts zoomPage): ZOOM_MAX in, and
// out as far as a page GROWN_MAX long shows whole on a screen 100 px tall
export const ZOOM_KEPT = { least: 100 / GROWN_MAX, most: ZOOM_MAX };
// a page grows to hold what's on it with this much paper to spare beyond it
export const ROOM_PX = 40;
// a page's dry ink is drawn in square tiles TILE_PX CSS px a side on screen (at the zoom they were drawn for), so no
// canvas is ever bigger than a browser allows, and only those near the paper are kept
export const TILE_PX = 512;

// A page's box in its own px.
export const pageBox = page => {
  const x0 = page.x ?? 0,
    y0 = page.y ?? 0;
  return { x0, y0, x1: x0 + page.w, y1: y0 + page.h };
};

// The furthest out a page zooms: the whole of it on the paper, and half size at least
export const leastScale = (page, view) =>
  Math.min(ZOOM_OUT, view.w / Math.max(1, page.w), view.h / Math.max(1, page.h));
// A zoom kept within the page's
export const clampScale = (s, page, view) => Math.min(ZOOM_MAX, Math.max(leastScale(page, view), s));

// A pan kept on the page: the paper's middle never off the page's box, so every way the paper shows half a paper of
// fresh page past what's on it (the page grows as it's written on there, so the paper never shows an end)
export function clampPan(pan, page, view, scale) {
  const w = view.w / scale,
    h = view.h / scale,
    box = pageBox(page),
    keep = (v, from, to) => Math.min(Math.max(from, v), to);
  return {
    x: keep(pan.x, box.x0 - w / 2, box.x1 - w / 2),
    y: keep(pan.y, box.y0 - h / 2, box.y1 - h / 2),
  };
}

// The pan that keeps a point on the paper (CSS px from its top-left) over the same spot of the page as the zoom goes
// from s0 to s1: a pinch's middle, the pointer under a wheel
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

// A new page: the paper's size, whole px within the store's sides
export const newPageSize = view => ({ w: side(view.w), h: side(view.h) });
const side = v => Math.min(SIDE.max, Math.max(SIDE.min, Math.round(v)));

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
// Two boxes of the same page as one that holds both (a page read again, merged with this side's)
export function spanOf(a, b) {
  const p = pageBox(a),
    q = pageBox(b),
    x = Math.min(p.x0, q.x0),
    y = Math.min(p.y0, q.y0);
  return { x, y, w: Math.max(p.x1, q.x1) - x, h: Math.max(p.y1, q.y1) - y };
}

// Where a stroke's ink is, in its page's px: { x0, y0, x1, y1 }, its widest line's half on every side (ink.js draws a
// point at most three quarters of the ink's size across)
export function boxOf(stroke) {
  const r = stroke.size * 0.75 + 1,
    xs = stroke.points.map(p => p[0]),
    ys = stroke.points.map(p => p[1]);
  return { x0: Math.min(...xs) - r, y0: Math.min(...ys) - r, x1: Math.max(...xs) + r, y1: Math.max(...ys) + r };
}
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
// A tile's side in the page's px when drawn for zoom r
export const tileSide = r => TILE_PX / r;

// The tiles of a page a box touches, for tiles of side t (page px) laid from 0,0: their [column, row], row by row
export function tilesIn(page, box, t) {
  const on = pageBox(page),
    c0 = Math.max(Math.floor(on.x0 / t), Math.floor(box.x0 / t)),
    r0 = Math.max(Math.floor(on.y0 / t), Math.floor(box.y0 / t)),
    c1 = Math.min(Math.ceil(on.x1 / t) - 1, Math.floor(box.x1 / t)),
    r1 = Math.min(Math.ceil(on.y1 / t) - 1, Math.floor(box.y1 / t));
  const tiles = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) tiles.push([c, r]);
  return tiles;
}
// A box grown by k of its own size on every side (the tiles kept beyond what shows, to pan into)
export const around = (box, k) => {
  const dx = (box.x1 - box.x0) * k,
    dy = (box.y1 - box.y0) * k;
  return { x0: box.x0 - dx, y0: box.y0 - dy, x1: box.x1 + dx, y1: box.y1 + dy };
};
