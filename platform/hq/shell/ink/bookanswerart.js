// What an agent's answer is drawn with: the pencil dots of an answer still coming, and ink strokes as SVG lines a pen
// can draw along.

// Three pencil dots: an answer is being written
export const DOTS = `<svg class="bk-answer-dots" viewBox="0 0 34 10" aria-hidden="true">
  <path d="M3.4 5.3c-.1-1.5 2.4-1.9 2.6-.3.2 1.7-2.5 1.9-2.6.3z"/><path d="M15.6 4.9c0-1.6 2.6-1.6 2.6 0 .1 1.7-2.6 1.8-2.6 0z"/>
  <path d="M27.7 5.1c-.1-1.6 2.5-1.8 2.6-.2.1 1.6-2.4 1.9-2.6.2z"/>
</svg>`;

// A stroke's line through its points, smoothed as a pen moves (points: [[x, y, …], …]), in the stroke's own px
export function lineOf(points) {
  if (!points.length) return '';
  const [first, ...rest] = points,
    at = ([x, y]) => `${round(x)} ${round(y)}`;
  if (!rest.length) return `M${at(first)}l0 .01`;
  let d = `M${at(first)}`;
  for (let i = 0; i < rest.length - 1; i++) {
    const mid = [(rest[i][0] + rest[i + 1][0]) / 2, (rest[i][1] + rest[i + 1][1]) / 2];
    d += `Q${at(rest[i])} ${at(mid)}`;
  }
  return `${d}L${at(rest.at(-1))}`;
}
const round = n => Math.round(n * 10) / 10;

// Strokes as SVG lines ({ color, size, alpha, points }), each its own path so a pen can draw them one by one
export const pathsOf = strokes =>
  strokes
    .map(
      s =>
        `<path d="${lineOf(s.points)}" stroke="${s.color}" stroke-width="${round(s.size * 0.9)}"${
          s.alpha < 1 ? ` stroke-opacity="${s.alpha}"` : ''
        } fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join('');

// The box round some strokes, in their px: { x0, y0, x1, y1 }, or null for none
export function inkBox(strokes) {
  const points = strokes.flatMap(s => s.points.map(([x, y]) => [x, y, s.size / 2]));
  if (!points.length) return null;
  return {
    x0: Math.min(...points.map(([x, , r]) => x - r)),
    y0: Math.min(...points.map(([, y, r]) => y - r)),
    x1: Math.max(...points.map(([x, , r]) => x + r)),
    y1: Math.max(...points.map(([, y, r]) => y + r)),
  };
}

// A drawing answer's strokes on its slip under its words: the box round them, at their own px (a width of its own over
// HQ's icon size for every svg), narrower when the slip is (bookanswers.css).
export function slipInkHtml(strokes) {
  const box = inkBox(strokes);
  if (!box) return '';
  const [x, y] = [Math.floor(box.x0), Math.floor(box.y0)],
    [w, h] = [Math.ceil(box.x1) - x, Math.ceil(box.y1) - y];
  return `<svg class="bk-slip-ink" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}" style="width:${w}px" aria-hidden="true">${pathsOf(
    strokes,
  )}</svg>`;
}
