// The book's table as plain numbers: where a day's pages lie in a row, how far the table pans, which page is shown,
// how a page grows and which of its tiles to draw. No DOM, so node tests it.
//
// The table has its own px, the pages' CSS px at 1:1: the row's first page has its top-left at 0,0 and the others follow
// it to the right, GAP apart. The pan is the table's point at the paper's top-left.

export const GAP = 28;
// how much of the row stays on the paper however far it's panned, so it's never lost off the table
export const KEEP_PX = 72;
// a page's left edge this close to the paper's comes to rest on it, so a page panned to sits square in the book
export const SNAP_PX = 40;
// A page's sides as the store makes one, and the most it grows to (pagechecks.ts PAGE and GROWN_MAX)
export const SIDE = { min: 100, max: 4000 };
export const GROWN_MAX = 20_000;
// a page's dry ink is drawn in strips this tall, so a long page never needs one canvas taller than a browser allows
export const TILE_PX = 512;

// The pages' places on the table: [{ x, y, w, h }] in the row's order. Facing, they lie edge to edge, two pages
// meeting at the paper's middle.
export function rowOf(pages, facing = false) {
  const gap = facing ? 0 : GAP;
  let x = 0;
  return pages.map(p => {
    const place = { x, y: 0, w: p.w, h: p.h };
    x += p.w + gap;
    return place;
  });
}
// The pan's x that shows page i: filling the paper; facing, its right edge at the paper's middle with the next page
// facing it, or (right: true) its left edge there with the page before facing it. A page wider than half the paper (a
// sheet as wide as the screen it was written on) starts at the paper's left edge instead, where its head and a sheet's
// notes are.
export function panTo(row, i, view, facing, { right = false } = {}) {
  const r = row[i];
  if (!facing || r.w > view.w / 2) return r.x;
  return right ? r.x - view.w / 2 : r.x + r.w - view.w / 2;
}
// The row's size on the table
export const extentOf = row => ({
  w: row.length ? row[row.length - 1].x + row[row.length - 1].w : 0,
  h: Math.max(0, ...row.map(r => r.h)),
});

// A pan kept within reach of the row: KEEP_PX of it stays on a paper of view { w, h }
export function clampPan(pan, row, view) {
  const { w, h } = extentOf(row);
  return {
    x: Math.min(Math.max(pan.x, KEEP_PX - view.w), w - KEEP_PX),
    y: Math.min(Math.max(pan.y, KEEP_PX - view.h), h - KEEP_PX),
  };
}

// The pan's x at rest: a page's left edge within SNAP_PX of the paper's lands on it, or facing a page's edge within
// SNAP_PX of the paper's middle
export function settleX(x, row, view, facing = false) {
  const rests = facing ? row.flatMap(r => [r.x - view.w / 2, r.x + r.w - view.w / 2]) : row.map(r => r.x);
  const near = rests.find(rest => Math.abs(rest - x) <= SNAP_PX);
  return near ?? x;
}

// Where a remembered place ({ page: an id or 'new', x, y }) opens in a row of those ids: { i, at }, its page and the
// offset into it, or the row's last page with no offset when it's gone or nothing was remembered
export function placeIn(ids, place) {
  const i = place ? ids.indexOf(place.page) : -1;
  return i >= 0 ? { i, at: place } : { i: ids.length - 1, at: null };
}

// The page under a point on the table, or -1 on the bare table
export const pageAt = (row, x, y) => row.findIndex(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);

// Whether the paper shows any of a box on page r (the box in the page's px)
export const showsBox = (r, box, pan, view) =>
  r.x + box.x1 > pan.x && r.x + box.x0 < pan.x + view.w && r.y + box.y1 > pan.y && r.y + box.y0 < pan.y + view.h;

// The page that fills most of the paper, or -1 when only the table shows
export function shownAt(row, pan, view) {
  let best = -1,
    most = 0;
  row.forEach((r, i) => {
    const w = Math.min(r.x + r.w, pan.x + view.w) - Math.max(r.x, pan.x),
      h = Math.min(r.y + r.h, pan.y + view.h) - Math.max(r.y, pan.y),
      area = Math.max(0, w) * Math.max(0, h);
    if (area > most) [best, most] = [i, area];
  });
  return best;
}

// A new page: as wide as the paper (one side of it facing) and as tall as it shows, whole px within the store's sides
export const newPageSize = (view, facing = false) => ({ w: side(facing ? view.w / 2 : view.w), h: side(view.h) });
const side = v => Math.min(SIDE.max, Math.max(SIDE.min, Math.round(v)));

// A page's height after a stroke whose lowest ink is at `lowest`: within half the paper's height of its foot, it
// grows by half the paper's height (up to the store's most)
export function grownHeight(h, lowest, viewH) {
  const half = Math.round(viewH / 2);
  return lowest > h - half ? Math.min(GROWN_MAX, h + half) : h;
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

// The tiles of a page of height h that the band from top to bottom (page px) touches: their numbers, in order
export function tilesIn(h, top, bottom) {
  const first = Math.max(0, Math.floor(top / TILE_PX)),
    last = Math.min(Math.ceil(h / TILE_PX) - 1, Math.floor(bottom / TILE_PX));
  const tiles = [];
  for (let t = first; t <= last; t++) tiles.push(t);
  return tiles;
}
