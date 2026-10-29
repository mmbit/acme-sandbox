// The book's drawing tools as plain numbers: a shape as ink.js's stroke (an ellipse, a rectangle, a line, an arrow,
// outlined or filled), and the eraser cutting strokes where it passes. No DOM, so node tests it (bookstrokes.test.js);
// bookshapes.js and bookerase.js use it.
//
// A stroke is ink.js's { color, size, alpha?, fill?, points: [[x, y, pressure, t], ...] } in its page's px. A shape's
// line is even: every point at SHAPE_P, which ink.js draws exactly `size` wide.
// (review mode's eraser reaches by the same distances)
import { fromSegment, segmentsApart } from '/__review/eraser.js';

export const SHAPES = ['ellipse', 'rect', 'line', 'arrow'];
export const SHAPE_P = 0.58;
// ink.js's line: a point's radius at its pressure (inkshape.js's radius)
export const radius = (size, p) => (size * (0.3 + 1.2 * Math.min(1, Math.max(0.05, p)))) / 2;
// a shape smaller than this (page px) on both sides is a click, not a shape
const LEAST = 3;
// an ellipse's points: about one every STEP px round it, from FEWEST to MOST
const STEP = 5,
  FEWEST = 24,
  MOST = 180;
// an arrow's head: its barbs this far off the line, and this long (a share of the arrow, within the ink's size)
const BARB = (28 * Math.PI) / 180;
// a replay draws a shape as a hand would, one point every T_STEP ms
const T_STEP = 6;

const round = n => Math.round(n * 100) / 100;

// The shape from a press at a to b (page px). even: a square, a circle, or a line at a multiple of 45°. fill: an
// ellipse's or a rectangle's inside too. ink: { color, size, alpha? }. null when it's too small to be one.
export function shape(kind, [x0, y0], [x1, y1], ink, { even = false, fill = false } = {}) {
  let dx = x1 - x0,
    dy = y1 - y0;
  if (Math.abs(dx) < LEAST && Math.abs(dy) < LEAST) return null;
  if (even && (kind === 'line' || kind === 'arrow')) [dx, dy] = snapped(dx, dy);
  else if (even) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    [dx, dy] = [side * (Math.sign(dx) || 1), side * (Math.sign(dy) || 1)];
  }
  const to = [x0 + dx, y0 + dy];
  const pts =
    kind === 'ellipse'
      ? ellipse([x0, y0], to)
      : kind === 'rect'
        ? [[x0, y0], [to[0], y0], to, [x0, to[1]], [x0, y0]]
        : kind === 'arrow'
          ? arrow([x0, y0], to, ink.size)
          : [[x0, y0], to];
  const filled = fill && (kind === 'ellipse' || kind === 'rect');
  return {
    color: ink.color,
    size: ink.size,
    ...(ink.alpha < 1 ? { alpha: ink.alpha } : {}),
    ...(filled ? { fill: true } : {}),
    points: pts.map(([x, y], i) => [round(x), round(y), SHAPE_P, i * T_STEP]),
  };
}
// A line's run turned to the nearest multiple of 45°, its length kept
function snapped(dx, dy) {
  const len = Math.hypot(dx, dy),
    a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [len * Math.cos(a), len * Math.sin(a)];
}
// The ellipse in a box from a to b, round from its right, back to where it began
function ellipse([x0, y0], [x1, y1]) {
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2,
    rx = Math.abs(x1 - x0) / 2,
    ry = Math.abs(y1 - y0) / 2;
  // (Ramanujan's length round it)
  const around = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry))),
    n = Math.min(MOST, Math.max(FEWEST, Math.ceil(around / STEP)));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}
// An arrow from a to its tip b: the line, then each barb out and back to the tip, so it's one stroke with round joins
function arrow(a, b, size) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]),
    head = Math.min(len * 0.45, 9 + size * 2.4),
    back = Math.atan2(a[1] - b[1], a[0] - b[0]);
  const barb = turn => [b[0] + head * Math.cos(back + turn), b[1] + head * Math.sin(back + turn)];
  return [a, b, barb(BARB), b, barb(-BARB)];
}

// ---- the eraser

// What the eraser does to a page's strokes as it passes from a to b (page px), r its radius: each line it touches is
// cut where it passed (the pieces either side kept as strokes of their own), and a filled shape it touches goes whole
// (its inside is one thing). Returns null when it touched nothing, else { ink: the page's strokes now (those it didn't
// touch the same objects), box: what changed on the page }.
export function rub(strokes, a, b, r) {
  let touched = false;
  const ink = [],
    box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const s of strokes) {
    const pieces = cut(s, a, b, r);
    if (!pieces) {
      ink.push(s);
      continue;
    }
    touched = true;
    grow(box, reachOf(s));
    ink.push(...pieces);
  }
  return touched ? { ink, box } : null;
}
// A stroke's pieces after the eraser's pass, or null when it isn't touched
export function cut(s, a, b, r) {
  const reach = radius(s.size, 1);
  if (!meets(reachOf(s), capsule(a, b, r + reach))) return null;
  if (s.fill) return touches(s, a, b, r) || inside(s.points, a) || inside(s.points, b) ? [] : null;
  // (the points near the pass made closer together, so the cut is as clean as the eraser's edge)
  const pts = closer(s, a, b, r),
    out = p => fromSegment(p, a, b) >= r + radius(s.size, p[2]);
  if (pts.every(out)) return null;
  const pieces = [];
  let run = [];
  for (const p of pts) {
    if (out(p)) run.push(p);
    else if (run.length) {
      pieces.push(run);
      run = [];
    }
  }
  if (run.length) pieces.push(run);
  // (a closed line, an outlined shape, cut open is one line round from the cut: its last piece and its first joined)
  const closed = pts.length > 2 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1];
  if (closed && pieces.length > 1 && out(pts[0])) pieces[0] = [...pieces.pop(), ...pieces[0].slice(1)];
  return pieces.map(points => ({ ...s, points }));
}
// Whether the pass comes within reach of a stroke's line
function touches(s, a, b, r) {
  const pts = s.points;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i],
      q = pts[i + 1] ?? p;
    if (segmentsApart(p, q, a, b) < r + radius(s.size, p[2])) return true;
  }
  return false;
}
// The stroke's points, with points added between two where the pass comes near them: spaced a quarter of the
// eraser's radius or a px, whichever is more, the pressure and time between theirs
function closer(s, a, b, r) {
  const pts = s.points,
    step = Math.max(1, r / 4),
    near = r + radius(s.size, 1) + step,
    out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1],
      q = pts[i],
      len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len > step && segmentsApart(p, q, a, b) < near) {
      const n = Math.ceil(len / step);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        out.push([
          round(p[0] + (q[0] - p[0]) * t),
          round(p[1] + (q[1] - p[1]) * t),
          round(p[2] + (q[2] - p[2]) * t),
          Math.round(p[3] + (q[3] - p[3]) * t),
        ]);
      }
    }
    out.push(q);
  }
  return out;
}

// ---- geometry

// A stroke's box with its widest line round it
export function reachOf(s) {
  const r = radius(s.size, 1) + 1,
    box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const [x, y] of s.points) grow(box, { x0: x - r, y0: y - r, x1: x + r, y1: y + r });
  return box;
}
const capsule = (a, b, r) => ({
  x0: Math.min(a[0], b[0]) - r,
  y0: Math.min(a[1], b[1]) - r,
  x1: Math.max(a[0], b[0]) + r,
  y1: Math.max(a[1], b[1]) + r,
});
function grow(box, by) {
  box.x0 = Math.min(box.x0, by.x0);
  box.y0 = Math.min(box.y0, by.y0);
  box.x1 = Math.max(box.x1, by.x1);
  box.y1 = Math.max(box.y1, by.y1);
}
const meets = (p, q) => p.x0 <= q.x1 && q.x0 <= p.x1 && p.y0 <= q.y1 && q.y0 <= p.y1;
// Whether a point is inside a closed run of points (even-odd)
export function inside(pts, [x, y]) {
  let yes = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i],
      [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) yes = !yes;
  }
  return yes;
}
