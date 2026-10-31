// Which of a try's frames a mark on them is on (bookversions.js), and whether a reply's frame is fit to keep (the
// coordinator's notebooksend.ts and its play, notebookplay.js). No DOM, so node
// tests it (bookversionframes.test.js).
import { overlapOf } from './bookgroupmath.js';

// Which frame a mark on the versions is on: the one its box covers most (a ring round a frame covers it whole, a
// tick on it covers part), else the nearest, by their centres; -1 with no frames. Where the mark is, never its shape:
// what it means is the judge's to read. ink: { x0, y0, x1, y1 }, frames: { x, y, w, h }, in the same px.
export function frameUnder(ink, frames) {
  const area = f => overlapOf({ x: ink.x0, y: ink.y0, w: ink.x1 - ink.x0, h: ink.y1 - ink.y0 }, f);
  const away = f => Math.hypot((ink.x0 + ink.x1) / 2 - (f.x + f.w / 2), (ink.y0 + ink.y1) / 2 - (f.y + f.h / 2));
  let best = -1;
  frames.forEach((f, i) => {
    if (best < 0) return (best = i);
    const a = area(f),
      b = area(frames[best]);
    if (a > b || (a === b && away(f) < away(frames[best]))) best = i;
  });
  return best;
}

// A version's frame as HQ sends it with a reply (the box its picture shows in, page px, sides up to FRAME_MAX), or null
// for none fit to use.
const FRAME_MAX = 4000;
export function frameOf(v) {
  if (!v || typeof v !== 'object') return null;
  const ok = (n, max, min = -max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
  return ok(v.x, 1e5) && ok(v.y, 1e5) && ok(v.w, FRAME_MAX, 1) && ok(v.h, FRAME_MAX, 1)
    ? { x: v.x, y: v.y, w: v.w, h: v.h }
    : null;
}
