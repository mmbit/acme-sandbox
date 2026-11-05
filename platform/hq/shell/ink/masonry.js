// A notebook page as a masonry of scrap units (scrapunit.js): as many columns as its width holds, and each unit, in
// its order on the page, at the foot of the shortest column. Pure: a width and heights in, places out, no DOM.
import { UNIT_W } from './scrapunit.js';

// Between two columns, and between two units in a column, at scale 1 in CSS px: clearly more than between a note and
// what hangs under it (an answer, a slip, a prototype's versions: bookunder.js), so notes that just happen to stand
// together never read as one.
export const GAP = 48;
// Round the grid, at scale 1: off the page's edges
export const MARGIN = 24;

// The least a page's columns are drawn at to fit one more: a scrap's 14 px words no smaller than about 11 px, so an
// upright iPad holds two (a scrap is opened to draw on, bookscrapopen.js).
export const LEAST = 0.8;
// The most they're drawn at: their own size. A page wider than its columns keeps the rest as paper at its right, so a
// note's words are never bigger than the screen's other type
export const MOST = 1;

// How many columns a page this wide (CSS px) holds: as many as fit at LEAST of their size, one at least
export const columnsOf = width => Math.max(1, Math.floor((width / LEAST - 2 * MARGIN + GAP) / (UNIT_W + GAP)));

// The width a page needs for n columns at scale 1, with rightMargin at its right (MARGIN unless given)
export const widthFor = (n, rightMargin = MARGIN) => n * UNIT_W + (n - 1) * GAP + MARGIN + rightMargin;

// The margin at a page's right, at scale 1. It is MARGIN where one column fits at LEAST of its size with both margins.
// On narrower paper (the narrowest book's, beside its tools) it shrinks, to none at least, so the column keeps LEAST.
// The left margin stays, under the page's title and clear of the strip a finger's swipe closes the book from (book.css
// .bk-stack).
export const rightMarginOf = width => Math.max(0, Math.min(MARGIN, width / LEAST - UNIT_W - MARGIN));

// The scale a page this wide (CSS px) draws its columns at: as wide as the page, between LEAST and MOST, or less on a
// page too narrow for one column with no margin at its right
export const scaleOf = (width, columns = columnsOf(width)) =>
  Math.min(MOST, width / widthFor(columns, rightMarginOf(width)));

// A day's header across the page, where a day's units start: as tall as its date and the space under it
export const DAY_H = 48;

// The page's layout at width (CSS px), its units in order: [{ id, h, w?, day?, follows?, column? }]. A unit's h is its
// height at scale 1 with whatever the page draws under it. Its w is its width with the ink beside it (UNIT_W where none
// is given). A unit takes every column its w reaches into, starting at its own, so no note laid after it covers that
// ink. A unit whose day differs from the one before starts that day
// under a header across every column. The page's first day has no header: it's the page's own. A unit that follows
// (never the first) is laid right under the one before it, in its column, at every width. A unit with a column stays in
// it where the page has that column (the board's drawing, the page's last, in the column it was drawn in: bookunits.js).
// Returns the columns, the scale (scaleOf), each unit's place { id, column, x, y, w, h } and each header's { day, y, h }
// in the page's CSS px, and the page's height. The grid sits at the page's left, under its title.
export function layout(units, width) {
  const columns = columnsOf(width),
    scale = scaleOf(width, columns),
    left = MARGIN * scale,
    feet = Array(columns).fill(MARGIN * scale),
    headers = [];
  let day;
  const places = [];
  for (const u of units) {
    if (u.day !== undefined && u.day !== day) {
      // (the page's first day is its own, in its head with its title: bookunitcards.js)
      if (day !== undefined) {
        const top = Math.max(...feet);
        headers.push({ day: u.day, y: top, h: DAY_H * scale });
        feet.fill(top + DAY_H * scale);
      }
      day = u.day;
    }
    const span = Math.min(columns, spanOf(u.w)),
      column = u.column < columns ? u.column : u.follows ? places.at(-1).column : lowest(feet, span),
      // (the columns the ink beside it reaches into, starting at its own)
      taken = feet.slice(column, column + span),
      y = Math.max(...taken),
      place = { id: u.id, column, x: left + column * (UNIT_W + GAP) * scale, y, w: UNIT_W * scale };
    feet.fill(y + (u.h + GAP) * scale, column, column + taken.length);
    places.push({ ...place, h: u.h * scale });
  }
  const foot = places.length ? Math.max(...feet) - GAP * scale : MARGIN * scale;
  return { columns, scale, places, headers, height: foot + MARGIN * scale };
}

// How many columns a unit w wide (scale 1, from its left) reaches into: one, or more where the ink beside it reaches
// past the space between columns
const spanOf = (w = UNIT_W) => Math.max(1, Math.ceil(w / (UNIT_W + GAP)));
// The first of span columns side by side whose highest foot is the lowest: the shortest column for a unit one wide
function lowest(feet, span) {
  let best = 0;
  for (let c = 1; c + span <= feet.length; c++)
    if (Math.max(...feet.slice(c, c + span)) < Math.max(...feet.slice(best, best + span))) best = c;
  return best;
}

// The column under x (the masonry's px at scale 1, from the page's left) on a page laid columns wide: the nearest
// where x is beside the grid
export const columnUnder = (x, columns) =>
  Math.max(0, Math.min(columns - 1, Math.floor((x - MARGIN + GAP / 2) / (UNIT_W + GAP))));

// The placed unit under a point on the page (CSS px), or undefined in the space between units
export const placeAt = (places, x, y) => places.find(p => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h);
