// The book's ink as plain numbers, for its tools and the store alike: a shape as ink.js's stroke (an ellipse, a
// rectangle, a line, an arrow, outlined or filled), and the highlighter's colours, widths and alpha. No DOM and no
// imports, so node tests it (bookstrokes.test.js) and the coordinator draws a call's agent's shapes and highlights with
// it (ink/callpage.ts). bookshapes.js and bookpalette.js use it.
//
// A stroke is ink.js's { color, size, alpha?, fill?, points: [[x, y, pressure, t], ...] } in its page's px. A shape's
// line is even: every point at SHAPE_P, which ink.js draws exactly `size` wide.

// The highlighter's colours, the widths a line comes in (page px; the middle one review mode's pen) and the
// highlighter's alpha
export const MARKERS = [
  { name: 'Yellow', color: '#ffd23f' },
  { name: 'Pink', color: '#ff7eb3' },
  { name: 'Green', color: '#7fe08a' },
  { name: 'Blue', color: '#7cc8ff' },
];
export const WIDTHS = { pen: [2.5, 5, 9], highlighter: [11, 18, 28] },
  MARKER_ALPHA = 0.42;
// A stroke's line, as thin and as thick as the store keeps it: a page with one past it is refused (pagechecks.ts).
export const LINE = { min: 0.5, max: 200 };

export const SHAPES = ['ellipse', 'rect', 'line', 'arrow'];
export const SHAPE_P = 0.58;
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
