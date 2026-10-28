// An agent's answer written in by a small pen: how fast its letters come, and where a versions page lays its frames.
// No DOM, so node tests it.

// A letter this often, as a quick hand writes; a long answer speeds up so it's whole within WHOLE_MS, never slower
export const LETTER_MS = 22,
  WHOLE_MS = 1500;

// How long writing count letters takes
export const writingMs = count => Math.min(count * LETTER_MS, WHOLE_MS);
// How many of count letters are written ms after the pen starts (all of them once it's done)
export function lettersAt(ms, count) {
  const total = writingMs(count);
  if (ms >= total) return count;
  return Math.max(0, Math.floor((ms / total) * count));
}

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
  const area = f =>
    Math.max(0, Math.min(ink.x1, f.x + f.w) - Math.max(ink.x0, f.x)) *
    Math.max(0, Math.min(ink.y1, f.y + f.h) - Math.max(ink.y0, f.y));
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
