// The eraser's icon and its reach, one copy for review mode's strip (surface.js, and the Pencil's on HQ: pencil.js) and
// HQ's book (bookpalette.js, bookstrokes.js; Ink's folder).

// The strip's eraser: every line its pass touches goes (Undo brings them back). What it draws as it goes is its pass,
// soft and gone as it lifts.
export const ERASER = { name: 'Eraser', color: '#8f88a8', size: 24, alpha: 0.35 };
// Whether a line is the eraser's pass: drawn in its ink (ink.js keeps a line's ink on it)
export const erases = line => line.color === ERASER.color;

// the icon's lines on a 20 px box, for each to draw in its own line width
export const ERASER_PATHS =
  '<path d="M8.2 16.5l-4-4a1.4 1.4 0 0 1 0-2l6.6-6.6a1.4 1.4 0 0 1 2 0l4 4a1.4 1.4 0 0 1 0 2l-6.6 6.6z"/><path d="M7.4 7.4l5.2 5.2"/><path d="M8.2 16.5h8.3"/>';

// A point's distance from the segment a–b
export function fromSegment([x, y], a, b) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len)) : 0;
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}
// The least distance between the segments p–q and a–b (0 when they cross)
export function segmentsApart(p, q, a, b) {
  const side = (o, u, v) => Math.sign((u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0]));
  if (side(p, q, a) * side(p, q, b) < 0 && side(a, b, p) * side(a, b, q) < 0) return 0;
  return Math.min(fromSegment(p, a, b), fromSegment(q, a, b), fromSegment(a, p, q), fromSegment(b, p, q));
}
// Whether the eraser's pass goes over a line: some piece of one within their two half-widths of a piece of the other
export function touches(pass, line) {
  const reach = (pass.size + line.size) / 2,
    pieces = ({ points }) =>
      points.length > 1 ? points.slice(1).map((q, i) => [points[i], q]) : [[points[0], points[0]]];
  return pieces(pass).some(([a, b]) => pieces(line).some(([c, d]) => segmentsApart(a, b, c, d) <= reach));
}
