// The select tool's maths (bookselect.js), as plain numbers: whether a drag was a lasso or a box, what a loop takes in,
// the thing on top under a point and the rest of its group, the selection's bounds, and things moved and scaled about
// a corner. No DOM, so node tests it (bookselectmath.test.js).
//
// Everything is in its page's px. A stroke is ink.js's { color, size, alpha, fill, points: [[x, y, p, t]] }, a picture
// sketchscraps.js's { x, y, w, h, tilt }, a box of typed words booktexts.js's { x, y, w, text, color }, whose box on the
// page (its words' own extent) is measured by the caller: boxOfText(t) → { x0, y0, x1, y1 }.
import { boxOf } from './bookrow.js';
import { scrapAt } from './bookscrap.js';

// a drag that strays from the line between its ends by less than this share of that line (or its slop) is a box
const STRAIGHT = 0.18;
// a box is at least this small a selection on its smaller side, in screen px
const MIN_SIDE_PX = 12;
// a stroke's line, as thin and as thick as the store keeps it (pagechecks.ts SIZE: a page with one past it is refused)
const LINE = { min: 0.5, max: 200 };

// Whether a point [x, y] is inside a polygon (a list of points, closed back to its first)
export function inside(poly, [x, y]) {
  let isIn = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i],
      [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) isIn = !isIn;
  }
  return isIn;
}

// What a drag on bare paper draws (its path, page px): { kind: 'box', poly } when it went roughly straight from one
// corner to the other, else { kind: 'lasso', poly }. slop: how far from straight still counts, in page px (a few
// screen px at the zoom).
export function gestureOf(path, slop) {
  const a = path[0],
    b = path.at(-1),
    span = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const off = Math.max(0, ...path.map(p => offLine(p, a, b, span)));
  if (span > 0 && off <= Math.max(slop, STRAIGHT * span)) return { kind: 'box', poly: boxPoly(a, b) };
  return { kind: 'lasso', poly: path };
}
// A point's distance from the line through a and b (span long)
const offLine = ([x, y], a, b, span) =>
  span ? Math.abs((b[0] - a[0]) * (a[1] - y) - (a[0] - x) * (b[1] - a[1])) / span : Math.hypot(x - a[0], y - a[1]);
// The box from one corner to the other, as a polygon
export const boxPoly = ([x0, y0], [x1, y1]) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

// What a loop takes in of a page's things: { ink, scraps, texts }, each a list of the page's own objects. A stroke is in
// when most of its points are, a picture or a box of words when its middle is.
export function picked(poly, { ink, scraps, texts }, boxOfText) {
  const most = s => s.points.filter(p => inside(poly, p)).length * 2 > s.points.length;
  return {
    ink: ink.filter(most),
    scraps: scraps.filter(s => inside(poly, [s.x + s.w / 2, s.y + s.h / 2])),
    texts: texts.filter(t => inside(poly, middle(boxOfText(t)))),
  };
}
const middle = b => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];

// The thing on top under a point of the page: { kind: 'ink' | 'scraps' | 'texts', item }, or null. The words are over
// the ink, a pen's ink over a highlighter's, and those over the pictures (bookpage.js), the last drawn on top. near: how
// close to a line counts as on it, in page px.
export function topAt(at, { ink, scraps, texts }, boxOfText, near) {
  const text = texts.findLast(t => within(boxOfText(t), at));
  if (text) return { kind: 'texts', item: text };
  const on = s => onStroke(s, at, near);
  const stroke = ink.findLast(s => !(s.alpha < 1) && on(s)) ?? ink.findLast(s => s.alpha < 1 && on(s));
  if (stroke) return { kind: 'ink', item: stroke };
  const k = scrapAt(scraps, at);
  return k >= 0 ? { kind: 'scraps', item: scraps[k] } : null;
}
export const within = (b, [x, y]) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
// A thing on a page with the rest of its group ({ ink, scraps, texts }), or the thing alone when it has none yet (not
// saved) or the page has no groups
export function groupOf(page, { kind, item }) {
  const g = item.g;
  if (g === undefined || !page.groups?.has(g)) return { [kind]: [item] };
  return membersOf(page, g);
}
// Everything on a page in group g ({ ink, scraps, texts }): its elements with the group's id (el.g, booksave.js). What
// a press picks and what a live move carries whole (bookselectlift.js)
export function membersOf(page, g) {
  const of = k => (page[k] ?? []).filter(x => x.g === g);
  return { ink: of('ink'), scraps: of('scraps'), texts: of('texts') };
}
// Whether a point is on a stroke's line (within its half width and near), or inside a filled one
function onStroke(s, p, near) {
  const reach = s.size / 2 + near,
    pts = s.points;
  if (s.fill && pts.length > 2 && inside(pts, p)) return true;
  if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) <= reach;
  for (let i = 1; i < pts.length; i++) if (toSegment(p, pts[i - 1], pts[i]) <= reach) return true;
  return false;
}
function toSegment([x, y], [ax, ay], [bx, by]) {
  const dx = bx - ax,
    dy = by - ay,
    long = dx * dx + dy * dy,
    t = long ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / long)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

// ---- bounds

// Where a selection is on its page: the box round its ink (boxOf: its line's width included), its pictures (as they're
// turned) and its words, or null when it's empty
export function boundsOf({ ink = [], scraps = [], texts = [] }, boxOfText) {
  const boxes = [...ink.map(boxOf), ...scraps.map(scrapBox), ...texts.map(t => boxOfText(t))];
  return boxes.length ? boxes.reduce(union) : null;
}
export const union = (a, b) => ({
  x0: Math.min(a.x0, b.x0),
  y0: Math.min(a.y0, b.y0),
  x1: Math.max(a.x1, b.x1),
  y1: Math.max(a.y1, b.y1),
});
// A picture's box as it's turned (its corners'), border included
export function scrapBox(s) {
  const a = (s.tilt * Math.PI) / 180,
    rx = (Math.abs(Math.cos(a)) * s.w + Math.abs(Math.sin(a)) * s.h) / 2,
    ry = (Math.abs(Math.sin(a)) * s.w + Math.abs(Math.cos(a)) * s.h) / 2,
    cx = s.x + s.w / 2,
    cy = s.y + s.h / 2;
  return { x0: cx - rx, y0: cy - ry, x1: cx + rx, y1: cy + ry };
}

// ---- moved and scaled

// A change of place: every point p goes to anchor + (p - anchor) × k + d. { k: 1, ax: 0, ay: 0 } is a plain move.
export const moveBy = (dx, dy) => ({ k: 1, ax: 0, ay: 0, dx, dy });
export const mapped = ({ k, ax, ay, dx, dy }, x, y) => [ax + (x - ax) * k + dx, ay + (y - ay) * k + dy];
// A box moved and scaled
export function mapBox(tr, b) {
  const [x0, y0] = mapped(tr, b.x0, b.y0),
    [x1, y1] = mapped(tr, b.x1, b.y1);
  return { x0, y0, x1, y1 };
}

// A new stroke, its points moved and its line scaled with it; every other field kept (a pen's pressure and time, a
// shape's fill), rounded to 2 decimals as ink.js keeps them
export function movedStroke(s, tr) {
  const points = s.points.map(([x, y, ...rest]) => {
    const [mx, my] = mapped(tr, x, y);
    return [round(mx), round(my), ...rest];
  });
  return { ...s, points, size: round(s.size * tr.k) };
}
// A new picture, moved and scaled about its middle's new place (its picture and turn kept)
export function movedScrap(s, tr) {
  const [cx, cy] = mapped(tr, s.x + s.w / 2, s.y + s.h / 2),
    w = round(s.w * tr.k),
    h = round(s.h * tr.k);
  return { ...s, x: round(cx - w / 2), y: round(cy - h / 2), w, h };
}
// A new box of words, its middle where the change takes it, its words their own size (anywhere: the paper is endless
// every way.)
export function movedText(t, tr, box) {
  const [mx, my] = middle(box),
    [cx, cy] = mapped(tr, mx, my);
  return { ...t, x: round(t.x + cx - mx), y: round(t.y + cy - my) };
}
const round = n => Math.round(n * 100) / 100;
// Things ({ ink, scraps, texts }) moved and scaled: a map from each to its new self
export function movedThings({ ink = [], scraps = [], texts = [] }, tr, boxOfText) {
  return new Map([
    ...ink.map(s => [s, movedStroke(s, tr)]),
    ...scraps.map(s => [s, movedScrap(s, tr)]),
    ...texts.map(t => [t, movedText(t, tr, boxOfText(t))]),
  ]);
}

// The scale a corner handle dragged to a point gives (proportional, about the opposite corner): how far along the
// diagonal the point has come. Never so small that the selection's smaller side is under MIN_SIDE_PX on screen, nor so
// far either way that a picked stroke's line (ink, scaled with it) leaves what the store keeps. (no stop at the page's top-left) corner: 0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left.
export function scaleAt(b, corner, [x, y], scale = 1, ink = []) {
  const c = cornersOf(b)[corner],
    a = cornersOf(b)[(corner + 2) % 4],
    dx = c[0] - a[0],
    dy = c[1] - a[1],
    k = ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1),
    least = MIN_SIDE_PX / scale / Math.max(1e-6, Math.min(b.x1 - b.x0, b.y1 - b.y0));
  let thinnest = 0,
    thickest = Infinity;
  for (const s of ink) {
    thinnest = Math.max(thinnest, LINE.min / s.size);
    thickest = Math.min(thickest, LINE.max / s.size);
  }
  const kept = Math.min(thickest, Math.max(Math.min(1, least), thinnest, k));
  return { k: kept, ax: a[0], ay: a[1], dx: 0, dy: 0 };
}
export const cornersOf = b => [
  [b.x0, b.y0],
  [b.x1, b.y0],
  [b.x1, b.y1],
  [b.x0, b.y1],
];

// Where a paste lands: the clip's middle on the point (page px), shifted by `again` steps of `step` when the same
// spot has had one already (anywhere, the paper endless every way)
export function pasteAt(b, [x, y], again = 0, step = 0) {
  return moveBy(round(x - (b.x0 + b.x1) / 2 + again * step), round(y - (b.y0 + b.y1) / 2 + again * step));
}
