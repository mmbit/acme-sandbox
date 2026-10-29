// Where a versions page lays its frames, and which frame a mark on it is on. No DOM, so node tests it
// (bookversionframes.test.js). (out of bookanswerpace.js)
import { overlapOf } from './bookgroupmath.js';

// The frames on a versions page, side by side and wrapping down within width: the note's snip first, then one frame
// per version (written or still coming). As many across as fit at frame wide, and two at least while each can be
// least wide. Each { x, y, w, h } from the frames' top-left; height: what they take down.
export function framesLaid(count, width, { frame = 210, least = 140, ratio = 0.75, gap = 22, caption = 46 } = {}) {
  const fit = w => Math.max(1, Math.floor((width + gap) / (w + gap))),
    across = fit(frame) > 1 ? fit(frame) : Math.min(2, fit(least)),
    w = Math.floor(Math.min(frame, (width - gap * (across - 1)) / across)),
    h = Math.round(w * ratio),
    step = { x: w + gap, y: h + caption + gap };
  const frames = Array.from({ length: count }, (_, i) => ({
    x: (i % across) * step.x,
    y: Math.floor(i / across) * step.y,
    w,
    h,
  }));
  return { frames, height: count ? Math.ceil(count / across) * step.y - gap : 0 };
}

// Which frame a mark on a versions page is on: the one its box covers most (a ring round a frame covers it whole, a
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
