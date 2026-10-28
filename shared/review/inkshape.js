// The stroke's shapes: where its ink is, as an SVG path, which ink.js draws dry and inklive.js live, and the
// coordinator draws the book's page picture with (through ink.js's outline). It imports nothing, so ink.js and
// inklive.js both stand on it and inklive.js never imports ink.js back.

// a line's radius at a point: a light touch draws about a third of the ink's size, a firm press half again as wide
export const radius = (size, pressure) => (size * (0.3 + 1.2 * Math.min(1, Math.max(0.05, pressure)))) / 2;
export const HALO = 2; // px of white around review mode's ink, so it shows on any page (not under a highlighter)
export const HALO_ALPHA = 0.9; // (the white's, a little see-through; a pen's under canvas has it as its opacity)

// Where a stroke's ink is: one disc per point and the band between each two, filled together (nonzero), which gives
// round ends and joins at any width. As an SVG path, so a canvas (Path2D) and an SVG <path> draw the very same shape.
export function outline(stroke, grow = 0) {
  const pts = stroke.points,
    size = stroke.size;
  let d = '';
  for (let i = 0; i < pts.length; i++) {
    const [x, y, p] = pts[i],
      r = radius(size, p) + grow;
    d += disc(x, y, r);
    if (i) d += band(pts[i - 1], radius(size, pts[i - 1][2]) + grow, x, y, r);
  }
  return stroke.fill ? d + inside(pts) : d;
}
// A filled shape's inside: its points as one polygon, turned clockwise on screen like the discs and bands, so the
// nonzero rule adds it to them and never cuts a hole where they overlap
function inside(pts) {
  if (pts.length < 3) return '';
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i],
      [bx, by] = pts[(i + 1) % pts.length];
    area += ax * by - bx * ay;
  }
  const round = area < 0 ? pts.slice().reverse() : pts;
  return `M${round.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`;
}
const f = n => Math.round(n * 100) / 100;
// (both turn the same way, clockwise on screen, so the nonzero rule joins them and never cuts a hole)
export const disc = (x, y, r) =>
  `M${f(x - r)} ${f(y)}a${f(r)} ${f(r)} 0 1 1 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 1 ${f(-2 * r)} 0Z`;
export function band([ax, ay], ra, bx, by, rb) {
  const dx = bx - ax,
    dy = by - ay,
    len = Math.hypot(dx, dy);
  if (len < 0.01) return '';
  const nx = -dy / len,
    ny = dx / len;
  return `M${f(ax - nx * ra)} ${f(ay - ny * ra)}L${f(bx - nx * rb)} ${f(by - ny * rb)}L${f(bx + nx * rb)} ${f(by + ny * rb)}L${f(ax + nx * ra)} ${f(ay + ny * ra)}Z`;
}
