// The eraser's icon and its reach, one copy for review mode's strip (surface.js) and HQ's book (bookpalette.js,
// bookstrokes.js; Ink's folder).

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
