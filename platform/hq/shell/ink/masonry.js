// A notebook page as a masonry of scrap units (scrapunit.js): as many columns as its width holds, and each unit, in
// its order on the page, at the foot of the shortest column. Pure: a width and heights in, places out, no DOM.
import { UNIT_W } from './scrapunit.js';

// Between two columns, and between two units in a column, at scale 1 in CSS px: always some space between scraps
export const GAP = 24;
// Round the grid, at scale 1: off the page's edges
export const MARGIN = 24;

// The least a page's columns are drawn at to fit one more: a scrap's 14 px words no smaller than about 12.5 px
export const LEAST = 0.9;

// How many columns a page this wide (CSS px) holds: as many as fit at LEAST of their size, one at least
export const columnsOf = width => Math.max(1, Math.floor((width / LEAST - 2 * MARGIN + GAP) / (UNIT_W + GAP)));

// The width a page needs for n columns at scale 1 (a picture of a page drawn n columns wide)
export const widthFor = n => n * UNIT_W + (n - 1) * GAP + 2 * MARGIN;

// A day's header across the page, where a day's units start: as tall as its date and the space under it
export const DAY_H = 48;

// The page's layout at width (CSS px), its units in order: [{ id, h, day?, follows?, column? }], h a unit's height at
// scale 1 with whatever its page draws under it. A unit whose day differs from the one before starts that day under a
// header across every column (the first day has none: it's the page's own). One that follows (never the first) is laid right under the unit before it, in its
// column, at every width. One with a column stays in it where the page has it (the board's drawing, the page's last,
// in the column it was drawn in: bookunits.js). Returns the columns, the scale
// (the columns drawn to the page's width: from LEAST up, or less on a page too narrow for one column), each unit's
// place { id, column, x, y, w, h } and each header's { day, y, h } in the page's CSS px, and the page's height.
export function layout(units, width) {
  const columns = columnsOf(width),
    scale = width / widthFor(columns),
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
    const column = u.column < columns ? u.column : u.follows ? places.at(-1).column : feet.indexOf(Math.min(...feet)),
      place = { id: u.id, column, x: left + column * (UNIT_W + GAP) * scale, y: feet[column], w: UNIT_W * scale };
    feet[column] += (u.h + GAP) * scale;
    places.push({ ...place, h: u.h * scale });
  }
  const foot = places.length ? Math.max(...feet) - GAP * scale : MARGIN * scale;
  return { columns, scale, places, headers, height: foot + MARGIN * scale };
}

// The placed unit under a point on the page (CSS px), or undefined in the space between units
export const placeAt = (places, x, y) => places.find(p => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h);
