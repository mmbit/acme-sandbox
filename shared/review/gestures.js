// Gestures told from a line's points: a ring marks what's inside it (pencil.js). No scribble deletes anything: it's ink
// (HQ's book).
import { boxOfLines } from './mark.js';
import { under } from './layer.js';

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
