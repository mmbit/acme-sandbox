// The book's eraser as plain numbers: cutting strokes where it passes, and how near two marks on a page come. No DOM,
// so node tests it (bookstrokes.test.js); bookerase.js and bookunitfor.js use it. Its shapes are bookinkmath.js's.
//
// A stroke is ink.js's { color, size, alpha?, fill?, points: [[x, y, pressure, t], ...] } in its page's px.
// (review mode's eraser reaches by the same distances)
import { fromSegment, segmentsApart } from '/__review/eraser.js';
import { boxOf } from './bookrow.js';
import { meets } from './bookselectmath.js';

// ink.js's line: a point's radius at its pressure (inkshape.js's radius)
export const radius = (size, p) => (size * (0.3 + 1.2 * Math.min(1, Math.max(0.05, p)))) / 2;
const round = n => Math.round(n * 100) / 100;
// A new number for the pieces of one see-through stroke (`cut`): any whole number to 2^31 - 1, so a page's two are as
// good as never the same
export const newCut = () => 1 + Math.floor(Math.random() * (2 ** 31 - 1));

// ---- the eraser

// What the eraser does to a page's strokes as it passes from a to b (page px), r its radius: each line it touches is
// cut where it passed (the pieces either side kept as strokes of their own), and a filled shape it touches goes whole
// (its inside is one thing). Returns null when it touched nothing, else { ink: the page's strokes now (those it didn't
// touch the same objects), box: what changed on the page, made: [stroke, piece] for each piece cut from a stroke }.
// A line cut changes the page only round the pass and the bits of it given more points, so that's the box, never the
// whole line's: where its pieces overlap they look as it did (a see-through one's filled as one, below).
export function rub(strokes, a, b, r) {
  let touched = false;
  const ink = [],
    made = [],
    box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const s of strokes) {
    const done = cut(s, a, b, r);
    if (!done) {
      ink.push(s);
      continue;
    }
    const { pieces } = done;
    touched = true;
    grow(box, done.box);
    ink.push(...pieces);
    made.push(...pieces.map(piece => [s, piece]));
  }
  return touched ? { ink, box, made } : null;
}
// A stroke after the eraser's pass, or null when it isn't touched: { pieces, box: where its ink changed on the page }
export function cut(s, a, b, r) {
  const reach = radius(s.size, 1);
  if (!meets(boxOf(s), capsule(a, b, r + reach))) return null;
  if (s.fill)
    return touches(s, a, b, r) || inside(s.points, a) || inside(s.points, b) ? { pieces: [], box: boxOf(s) } : null;
  // (the points near the pass made closer together, so the cut is as clean as the eraser's edge. What it took lies
  // within its radius, twice the line's widest half and a step of those points of the pass; what was given points,
  // within the line's half of those bits)
  const box = capsule(a, b, r + 2 * reach + Math.max(1, r / 4) + 1),
    pts = closer(s, a, b, r, box),
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
  // (a see-through stroke's pieces share a number, so they're filled as one, as it was: inkshape.js fills.)
  const whole = s.alpha < 1 ? { cut: s.cut ?? newCut() } : {},
    made = pieces.map(points => ({ ...s, ...whole, points }));
  return { pieces: made, box };
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
// eraser's radius or a px, whichever is more, the pressure and time between theirs. box: grown to hold each bit of the
// line given points, with its widest half round it
function closer(s, a, b, r, box) {
  const pts = s.points,
    step = Math.max(1, r / 4),
    reach = radius(s.size, 1) + 1,
    near = r + radius(s.size, 1) + step,
    out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1],
      q = pts[i],
      len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len > step && segmentsApart(p, q, a, b) < near) {
      grow(box, capsule(p, q, reach));
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

// ---- how near

// How far apart two marks on a page come (page px; 0 where they meet): a mark is a stroke ({ points, fill? }: its
// line, and a filled shape's inside) or a box ({ x0, y0, x1, y1 }: typed words, a picture, all of it). A stroke's
// box is never the stroke: a word written in a drawing's empty frame is as far from it as from its nearest line
// (bookunitfor.js).
export function apart(a, b) {
  if (within(a, b) || within(b, a)) return 0;
  let d = Infinity;
  for (const [p, q] of piecesOf(a)) for (const [c, e] of piecesOf(b)) d = Math.min(d, segmentsApart(p, q, c, e));
  return d;
}
// A mark's line as segments: a stroke's, one point a segment of none; a box's four sides
function piecesOf(m) {
  const pts = m.points ?? [
    [m.x0, m.y0],
    [m.x1, m.y0],
    [m.x1, m.y1],
    [m.x0, m.y1],
    [m.x0, m.y0],
  ];
  return pts.length > 1 ? pts.slice(1).map((q, i) => [pts[i], q]) : [[pts[0], pts[0]]];
}
// Whether mark a lies wholly inside what b fills (a box, a filled shape): with no line of the two crossing, its first
// point is in it
function within(a, b) {
  const [x, y] = a.points?.[0] ?? [a.x0, a.y0];
  if (b.points) return !!b.fill && inside(b.points, [x, y]);
  return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
}

// ---- geometry

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
