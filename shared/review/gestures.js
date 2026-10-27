// The Pencil's gestures (pencil.js): a scribble over a mark wipes it, a ring marks what's inside it.
import { boxOfLines } from './mark.js';
import { under } from './layer.js';

// A scribble: a line going back and forth over itself, far longer than the box it fills
export function scribbled(points) {
  if (points.length < 8) return false;
  let length = 0,
    turns = 0,
    dir = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0],
      dy = points[i][1] - points[i - 1][1];
    length += Math.hypot(dx, dy);
    const d = Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : 2 * Math.sign(dy);
    if (d && dir && d === -dir) turns++;
    if (d) dir = d;
  }
  const b = boxOfLines([{ points }]);
  return turns >= 4 && length > 3.5 * Math.max(b.w, b.h, 1);
}
// A ring: a line that comes back near where it started, round something bigger than a dot
export function ringed(points) {
  if (points.length < 8) return false;
  const b = boxOfLines([{ points }]),
    [x0, y0] = points[0],
    [x1, y1] = points[points.length - 1];
  return Math.min(b.w, b.h) > 24 && Math.hypot(x1 - x0, y1 - y0) < 0.25 * Math.max(b.w, b.h);
}
// What a ring holds: the biggest element inside it, from the one under its middle out
export function inside(r, area) {
  let el = under(r, area.x + area.w / 2, area.y + area.h / 2);
  const fits = e => {
    const b = e.getBoundingClientRect();
    return (
      b.left >= area.x - area.w * 0.1 &&
      b.right <= area.x + area.w * 1.1 &&
      b.top >= area.y - area.h * 0.1 &&
      b.bottom <= area.y + area.h * 1.1
    );
  };
  while (el.parentElement && el.parentElement !== document.body && fits(el.parentElement)) el = el.parentElement;
  return el;
}
