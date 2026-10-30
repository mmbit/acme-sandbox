// An agent's answer written in by a small pen: how fast its letters come. No DOM, so node tests it.

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
