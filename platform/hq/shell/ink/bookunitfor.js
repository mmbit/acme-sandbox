// Which unit what's put on a page goes to (bookunits.js inkUnit, pointUnit and the elements it homes): the one it starts
// on, else the scrap it's drawn across, else the board's own drawing it comes near, else on a page of scraps the scrap
// it's drawn beside, else a new one (bookunits.js, its header has the whole rule). Split from bookunits.js as it grew.
import { layout } from './masonry.js';
import { isCanvas } from './sketchcanvas.js';
import { columnAt, drawing, newUnit, reachOn, unitAt } from './bookunits.js';

// how near (page px) a stroke comes to the board's own drawing to be part of it
const NEAR = 64;

// The unit what's in a box (page px) starting at [x, y] goes to
export function unitFor(page, [x, y], box) {
  const on = unitAt(page, x, y);
  // (a scrap's paper takes what starts on it; the board's drawing, no paper, only what moves nothing)
  if (on !== undefined && (!drawing(page, on) || takes(page, on, box))) return on;
  // (a canvas has no columns: what's drawn beside a scrap is the board's own)
  const beside = () => (isCanvas(page.chapter) ? undefined : scrapBeside(page, box));
  return scrapAcross(page, box) ?? nearDrawing(page, box) ?? beside() ?? newUnit(page, box);
}
// The scrap a box (page px) is drawn across, the one it covers most; undefined when it covers none
const scrapAcross = (page, box) =>
  bestScrap(page, p => {
    const [w, h] = overlap(box, p);
    return w > 0 && h > 0 ? w * h : undefined;
  });
// The scrap a box is drawn beside: the nearest in its column, but one it's wholly below by more than NEAR; undefined
// when none
function scrapBeside(page, box) {
  const column = columnAt(page, (box.x0 + box.x1) / 2);
  return bestScrap(page, p => {
    if (p.column !== column || box.y0 > p.y + p.h + NEAR) return undefined;
    const [w, h] = overlap(box, p);
    return Math.min(0, w) + Math.min(0, h);
  });
}
// The scrap with the highest score (undefined: not a candidate)
function bestScrap(page, score) {
  let best, most;
  for (const p of page.places ?? []) {
    const s = drawing(page, p.id) ? undefined : score(p);
    if (s !== undefined && (most === undefined || s > most)) [best, most] = [p.id, s];
  }
  return best;
}
// How far a box and a place overlap across and down (negative: the gap between them)
const overlap = (box, p) => [
  Math.min(box.x1, p.x + p.w) - Math.max(box.x0, p.x),
  Math.min(box.y1, p.y + p.h) - Math.max(box.y0, p.y),
];
// The board's own drawing nearest a box, within NEAR of what's drawn on it, that takes it with nothing moved; undefined
// when none is that near
function nearDrawing(page, box) {
  let best,
    gap = NEAR;
  for (const p of page.places ?? []) {
    if (!drawing(page, p.id)) continue;
    const r = reachOn(page, p),
      d = Math.max(0, r.x0 - box.x1, box.x0 - r.x1) + Math.max(0, r.y0 - box.y1, box.y0 - r.y1);
    if (d <= gap && takes(page, p.id, box)) [best, gap] = [p.id, d];
  }
  return best;
}
// Whether the board's drawing id takes what's drawn in a box (page px): grown to the box's foot and its right, it moves
// none of the board's drawings. Widened alone, it moves no note at all, so an arrow from it onto a note beside it is
// that note's
function takes(page, id, box) {
  // (nothing on a canvas moves for another unit)
  if (page.laid.canvas) return true;
  const o = page.origins.get(id),
    tall = u => ({ ...u, h: Math.max(u.h, Math.ceil(box.y1 - o.y)) }),
    wide = u => ({ ...u, w: Math.max(u.w, Math.ceil(box.x1 - o.x)) }),
    both = u => wide(tall(u)),
    grown = f => page.laid.units.map(u => (u.id === id ? f(u) : u)),
    drawings = p => drawing(page, p.id),
    every = () => true;
  return movesNone(page, grown(both), drawings) && movesNone(page, grown(wide), every);
}
// Whether the page's units laid so (page.laid's with one grown) leave every place kept picks where page.laid has it
function movesNone(page, units, kept) {
  const now = new Map(layout(units, page.laid.width).places.map(p => [p.id, p]));
  return layout(page.laid.units, page.laid.width)
    .places.filter(kept)
    .every(p => now.get(p.id).x === p.x && now.get(p.id).y === p.y);
}
