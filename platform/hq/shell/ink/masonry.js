// A notebook page as a masonry of scrap units (scrapunit.js): as many columns as its width holds, and each unit, in
// its order on the page, at the foot of the shortest column. Pure: a width and heights in, places out, no DOM.
import { UNIT_W } from './scrapunit.js';

// Between two columns, and between two units in a column, at scale 1 in CSS px: always some space between scraps
export const GAP = 24;
// Round the grid, at scale 1: off the page's edges
export const MARGIN = 24;

// How many columns a page this wide (CSS px) holds: one at least, however narrow
export const columnsOf = width => Math.max(1, Math.floor((width - 2 * MARGIN + GAP) / (UNIT_W + GAP)));

// The width a page needs for n columns at scale 1 (a picture of a page drawn n columns wide)
export const widthFor = n => n * UNIT_W + (n - 1) * GAP + 2 * MARGIN;

// A day's header across the page, where a day's units start: as tall as its date and the space under it
export const DAY_H = 48;

// The page's layout at width (CSS px), its units in order: [{ id, h, day? }], h a unit's height at scale 1 with
// whatever its page draws under it. A unit whose day differs from the one before starts that day under a header
// across every column. Returns the columns, the scale (1, or less on a page too narrow for one column), each unit's
// place { id, column, x, y, w, h } and each header's { day, y, h } in the page's CSS px, and the page's height. Extra
// width centres the grid.
export function layout(units, width) {
  const columns = columnsOf(width),
    scale = Math.min(1, width / widthFor(1)),
    left = Math.max(0, (width - widthFor(columns) * scale) / 2) + MARGIN * scale,
    feet = Array(columns).fill(MARGIN * scale),
    headers = [];
  let day;
  const places = units.map(u => {
    if (u.day !== undefined && u.day !== day) {
      day = u.day;
      const top = Math.max(...feet);
      headers.push({ day, y: top, h: DAY_H * scale });
      feet.fill(top + DAY_H * scale);
    }
    const column = feet.indexOf(Math.min(...feet)),
      place = { id: u.id, column, x: left + column * (UNIT_W + GAP) * scale, y: feet[column], w: UNIT_W * scale };
    feet[column] += (u.h + GAP) * scale;
    return { ...place, h: u.h * scale };
  });
  const foot = places.length ? Math.max(...feet) - GAP * scale : MARGIN * scale;
  return { columns, scale, places, headers, height: foot + MARGIN * scale };
}

// The placed unit under a point on the page (CSS px), or undefined in the space between units
export const placeAt = (places, x, y) => places.find(p => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h);
