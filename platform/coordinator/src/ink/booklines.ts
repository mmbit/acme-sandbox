// Strokes in lines of writing: the Notebook carries an old page's ink into drawings by them (notebookcarry.ts). (the
// sheet's writing read into words beside its notes gone: the pen's ink stays handwriting, read by whoever reads the
// page. board, call 176)
import type { Stroke } from '../pagechecks.ts';

type Box = { x0: number; y0: number; x1: number; y1: number };

// strokes this near (page px) are one line of writing
const NEAR_PX = 24;

// The strokes in lines of writing: strokes whose boxes come within NEAR_PX of each other, and theirs, are one
export function linesOf(strokes: Stroke[]) {
  const boxes = strokes.map(s => boxOf([s])),
    group = strokes.map((_, i) => i);
  const top = (i: number): number => (group[i] === i ? i : (group[i] = top(group[i])));
  for (let i = 0; i < strokes.length; i++)
    for (let j = i + 1; j < strokes.length; j++) if (apart(boxes[i], boxes[j]) <= NEAR_PX) group[top(j)] = top(i);
  const lines = new Map<number, Stroke[]>();
  strokes.forEach((s, i) => lines.set(top(i), [...(lines.get(top(i)) ?? []), s]));
  return [...lines.values()];
}
const boxOf = (strokes: Stroke[]): Box => {
  const pts = strokes.flatMap(s => s.points.map(p => [p[0], p[1], (s.size ?? 4) / 2]));
  return {
    x0: Math.min(...pts.map(p => p[0] - p[2])),
    y0: Math.min(...pts.map(p => p[1] - p[2])),
    x1: Math.max(...pts.map(p => p[0] + p[2])),
    y1: Math.max(...pts.map(p => p[1] + p[2])),
  };
};
// How far apart two boxes are: 0 when they touch
const apart = (a: Box, b: Box) =>
  Math.hypot(Math.max(0, a.x0 - b.x1, b.x0 - a.x1), Math.max(0, a.y0 - b.y1, b.y0 - a.y1));
