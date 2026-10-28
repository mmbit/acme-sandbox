// What an agent's answer is drawn with: the hand-drawn bulb, the small pen nib that writes it in, the pencil dots of an
// answer still coming, and ink strokes as SVG lines a pen can draw along.

// The bulb, as a quick hand draws one in ink: a glass that doesn't quite close (gone over once on one side), its neck, three base lines, a filament
// and a few rays, over a warm wash in the glass (the drawing's one accent)
export const BULB = `<i class="bk-answer-bulb" aria-hidden="true"><svg viewBox="0 0 24 28">
  <path class="bk-bulb-glow" d="M8.4 17.6C6.2 15.9 5 13.6 5.2 10.9 5.5 6.8 8.6 4 12.3 4.1c3.8.1 6.6 3.1 6.5 6.9-.1 2.7-1.3 4.6-3.2 6.3z"/>
  <path d="M8.3 17.8C6.1 15.9 4.9 13.5 5.1 10.8 5.4 6.7 8.7 3.8 12.4 4c3.9.2 6.7 3.3 6.5 7.1-.1 2.6-1.4 4.6-3.3 6.2"/>
  <path class="bk-bulb-sketch" d="M9 17.1C7 15.4 5.8 13.1 6 10.4 6.3 7 9.1 4.5 12.6 4.6"/>
  <path d="M8.4 17.7l.5 2.6M15.7 17.2l-.4 2.9"/>
  <path d="M8.6 20.5c2.1-.4 4.6-.3 6.9-.4M9 22.5c1.9-.3 4-.2 5.9 0M10.4 24.5c1 .4 2.2.4 3.1-.1"/>
  <path class="bk-bulb-wire" d="M10.3 17.4l.3-4.8 1 1.3.8-1.5.9 1.4.6-1.3-.2 4.7"/>
  <path d="M12.2 .9l.1 1.4M3.3 4.1l1.1 1.1M21.1 3.9l-1 1.2M1.1 11.2l1.4.1M22.9 10.9l-1.4.2"/>
</svg></i>`;

// The nib riding the caret: a fountain pen's, tilted as a hand holds it, its tip at the element's bottom-left
export const NIB = `<svg class="bk-answer-pen" viewBox="0 0 18 26" aria-hidden="true">
  <g transform="rotate(32 1.5 24.5)"><path class="bk-nib" d="M1.5 24.5L-2.6 13.2C-2.6 9.4-1.2 6-0.8 1.6h4.6c.4 4.4 1.8 7.8 1.8 11.6z"/>
  <path class="bk-nib-slit" d="M1.5 23.8v-9.6"/><circle class="bk-nib-hole" cx="1.5" cy="13.2" r="1.1"/></g>
</svg>`;

// Three pencil dots: an answer is being written
export const DOTS = `<svg class="bk-answer-dots" viewBox="0 0 34 10" aria-hidden="true">
  <path d="M3.4 5.3c-.1-1.5 2.4-1.9 2.6-.3.2 1.7-2.5 1.9-2.6.3z"/><path d="M15.6 4.9c0-1.6 2.6-1.6 2.6 0 .1 1.7-2.6 1.8-2.6 0z"/>
  <path d="M27.7 5.1c-.1-1.6 2.5-1.8 2.6-.2.1 1.6-2.4 1.9-2.6.2z"/>
</svg>`;

// A pencil's scribble while a version is still being made
export const SQUIGGLE =
  '<svg class="bk-version-squiggle" viewBox="0 0 120 24" aria-hidden="true"><path d="M4 14c10-12 20-12 28 0s20 12 28 0 20-12 28 0 20 12 28 0"/></svg>';

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
