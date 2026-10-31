// The assign gesture's maths (bookassign.js), as plain numbers: where a Pencil's stroke came back round to close a ring,
// whether it has since left that ring far enough to be a line out of it, and the points a copy flies along. No DOM, so
// node tests it (bookassignmath.test.js). Points are [x, y] (more after them is kept out of the way).
import { inside } from './bookselectmath.js';

// The ring a stroke closed at its point `at`: the earliest point before it that `at` came back within `close` of, at
// least `round` along the stroke from it. → { from, to } (indexes into path), or null
export function ringAt(path, at, close, round) {
  let along = 0,
    from = -1;
  for (let i = at - 1; i >= 0; i--) {
    along += gap(path[i], path[i + 1]);
    if (along >= round && gap(path[i], path[at]) <= close) from = i;
  }
  return from < 0 ? null : { from, to: at };
}

// Whether a point has left a ring (its points, as a polygon): outside it, and further than `far` from all of it
export const leftRing = (ring, p, far) => !inside(ring, p) && ring.every(q => gap(q, p) > far);

// n + 1 points spaced evenly along a line (a list of points), its ends among them
export function evenly(line, n) {
  const at = [0];
  for (let i = 1; i < line.length; i++) at.push(at[i - 1] + gap(line[i - 1], line[i]));
  const length = at.at(-1),
    points = [];
  for (let k = 0, i = 1; k <= n; k++) {
    const want = (length * k) / n;
    while (i < line.length - 1 && at[i] < want) i++;
    const span = at[i] - at[i - 1],
      t = span ? Math.min(1, Math.max(0, (want - at[i - 1]) / span)) : 1;
    points.push(between(line[i - 1] ?? line[0], line[i] ?? line[0], t));
  }
  return points;
}

// n + 1 points on a curve from a to b, bowed to its left by a share of its length (a flight where no line was drawn)
export function bowed(a, b, n, bow = 0.2) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]],
    control = [(a[0] + b[0]) / 2 + dy * bow, (a[1] + b[1]) / 2 - dx * bow];
  return Array.from({ length: n + 1 }, (_, k) => {
    const t = k / n,
      u = 1 - t;
    return [0, 1].map(j => u * u * a[j] + 2 * u * t * control[j] + t * t * b[j]);
  });
}

const gap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const between = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
