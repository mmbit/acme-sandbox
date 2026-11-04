// A notebook page's elements as its units measure them (bookunits.js): what each covers on the page, where it starts,
// and each moved with its unit. Elements are the page's lists' (page.ink, page.texts, page.scraps), in the page's px.
// (split from bookunits.js)
import { boxOf as inkBox } from './bookrow.js';
import { scrapBox } from './bookselectmath.js';

// An element moved by dx, dy in place (its points or its box)
export function shift(kind, el, dx, dy) {
  if (kind === 'ink') el.points = el.points.map(([x, y, ...r]) => [x + dx, y + dy, ...r]);
  else Object.assign(el, { x: el.x + dx, y: el.y + dy });
}
// Where an element starts on the page (its px): a line's first point, else its box's corner
export const startOf = (kind, el) => (kind === 'ink' ? el.points[0] : [el.x, el.y]);
// What an element covers on the page (its px): a line's width round its points, a picture's corners as it's turned
export function boxOf(kind, el) {
  if (kind === 'ink') return inkBox(el);
  if (kind === 'pictures') return scrapBox(el);
  return { x0: el.x, y0: el.y, x1: el.x + el.w, y1: el.y + (el.h ?? typedHeight(el)) };
}
export const bottomOf = (kind, el) => boxOf(kind, el).y1;
// How tall typed words stand as they wrap at their box's width (booktexts.js TEXT: 18 px type, lines 1.4 apart, about
// half an em a letter), with their box's room round them
const typedHeight = t =>
  Math.max(
    1,
    ...String(t.text ?? '')
      .split('\n')
      .map(l => Math.ceil((l.length * 9.5) / Math.max(40, t.w - 8))),
  ) *
    25.2 +
  8;
