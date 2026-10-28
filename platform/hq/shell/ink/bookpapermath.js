// The paper effects' plain numbers (bookpaper.js, bookpaperdraw.js, bookdogear.js): how fast words are written, the
// outline of a sheet balling up, of a page torn out at the spine, and words wrapped in a box. No DOM.

// Writing: a letter this often, and a whole line done within this however long it is
export const LETTER_MS = 25,
  WRITTEN_MS = 600;

// The time between letters when count letters are written: LETTER_MS, or less so the last is down by WRITTEN_MS
export const letterStep = count => (count > 0 ? Math.min(LETTER_MS, WRITTEN_MS / count) : 0);

// A sheet balling up, as an outline of n points in its own box (0–100 across and down) at t from flat (0, its edge) to
// a crumpled ball (1, a jagged round about its middle, BALL across). The same seed balls the same way each time, so the
// points move smoothly from one t to the next.
export const BALL = 46;
export function crumpleOutline(t, seed = 1, n = 28) {
  const random = seeded(seed);
  return Array.from({ length: n }, (_, i) => {
    const [ex, ey] = onEdge(i / n),
      // (each point in towards the middle by its own amount: a ball's edge is folds, never a circle)
      angle = Math.atan2(ey - 50, ex - 50),
      r = (BALL / 2) * (0.72 + 0.28 * random()),
      bx = 50 + r * Math.cos(angle),
      by = 50 + r * Math.sin(angle);
    return [ex + (bx - ex) * t, ey + (by - ey) * t];
  });
}
// A page torn out along the spine (its right edge), as an outline in its own box (0–100 across and down) for a sheet
// w by h px with its top-right corner turned down ear px. The tear runs down the spine's side as t goes from 0 (whole,
// the edge straight) to 1 (torn top to bottom): a line wandering in and out up to TEAR_PX, ragged with small bites,
// never two alike. fibres: the paper's torn fibres instead, reaching up to FIBRE_PX further out, drawn lighter under the
// sheet. The same seed tears the same way at every t, with as many points, so the outlines move smoothly between them.
export const TEAR_PX = 6,
  FIBRE_PX = 2.5;
export function tornOutline(w, h, { t = 1, seed = 1, ear = 0, fibres = false } = {}) {
  const random = seeded(seed),
    run = h / 4,
    // (the wander: two slow waves of their own lengths and phases, 0–1)
    waves = [0, 1].map(() => ({ length: 25 + 50 * random(), phase: 2 * Math.PI * random() })),
    wander = y => waves.reduce((sum, { length, phase }) => sum + Math.sin((2 * Math.PI * y) / length + phase), 2) / 4,
    edge = [];
  for (let y = ear; y < h; y += 1.5 + 3.5 * random()) {
    // (a bite here and there, otherwise a ragged px or so)
    const bite = random() < 0.12 ? 0.25 + 0.3 * random() : 0.12 * random(),
      reach = FIBRE_PX * random() ** 0.6,
      torn = Math.min(1, Math.max(0, t * (h + run) - y) / run),
      x = w - (FIBRE_PX + Math.min(1, 0.7 * wander(y) + bite) * TEAR_PX) * torn;
    edge.push([fibres ? x + reach * torn : x, y]);
  }
  const [last] = edge.at(-1);
  return [[0, 0], [w - ear, 0], [w, ear], ...edge, [last, h], [0, h]].map(([x, y]) => [(100 * x) / w, (100 * y) / h]);
}

// A point at f (0–1) round a box's edge, clockwise from its top-left corner
function onEdge(f) {
  const d = (f % 1) * 400;
  if (d < 100) return [d, 0];
  if (d < 200) return [100, d - 100];
  if (d < 300) return [300 - d, 100];
  return [0, 400 - d];
}
// Numbers from a seed, the same run each time (mulberry32)
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Words as the lines they take in a box width wide (measure(words) → their width): each line ends where the next word
// wouldn't fit, a line break kept, a word wider than the box broken where it must be
export function wrapLines(text, width, measure) {
  const lines = [];
  for (const para of String(text ?? '').split('\n')) {
    let line = '';
    for (const word of para.split(/ +/)) {
      const tried = line ? `${line} ${word}` : word;
      if (measure(tried) <= width || !line) line = tried;
      else {
        lines.push(line);
        line = word;
      }
      while (measure(line) > width && line.length > 1) {
        const cut = longestFit(line, width, measure);
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}
// How many of a word's first letters fit in width: one at least
function longestFit(word, width, measure) {
  let n = 1;
  while (n < word.length && measure(word.slice(0, n + 1)) <= width) n++;
  return n;
}
