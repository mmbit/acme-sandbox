// Which unit what's put on a page goes to (bookunits.js inkUnit, pointUnit and the elements it homes): the one it starts
// on, else the scrap it's drawn across, else the board's own drawing it comes near, else on a page of scraps the scrap
// it's drawn beside, else a new one (bookunits.js, its header has the whole rule). Split from bookunits.js as it grew.
import { layout } from './masonry.js';
import { isCanvas } from './sketchcanvas.js';
import { LISTS, columnAt, drawing, newUnit, reachOn, unitAt } from './bookunits.js';
import { boxOf } from './bookunitbox.js';
import { apart } from './bookstrokes.js';

// how near (page px) a stroke comes to the board's own drawing to be part of it
const NEAR = 64;

// The unit what's in a box (page px) starting at [x, y] goes to; mark: what it is (a stroke, else its box), measured
// against the board's drawings' own ink (bookstrokes.js apart).
export function unitFor(page, [x, y], box, mark = box) {
  const on = unitAt(page, x, y);
  // (a scrap's paper takes what starts on it; the board's drawing, no paper, only what starts on its ink, never in the
  // empty frame round it, and moves nothing)
  const start = { points: [[x, y]] },
    near = () => inkApart(page, on, start, { x0: x, y0: y, x1: x, y1: y }) <= NEAR;
  if (on !== undefined && (!drawing(page, on) || (near() && takes(page, on, box)))) return on;
  // (a canvas has no columns: what's drawn beside a scrap is the board's own)
  const beside = () => (isCanvas(page.chapter) ? undefined : scrapBeside(page, box));
  return scrapAcross(page, box) ?? nearDrawing(page, box, mark) ?? beside() ?? newUnit(page, box);
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
// The board's own drawing nearest a mark in a box, within NEAR of its ink (never of the frame round it), that takes it
// with nothing moved; undefined when none is that near
function nearDrawing(page, box, mark) {
  let best,
    gap = NEAR;
  for (const p of page.places ?? []) {
    if (!drawing(page, p.id) || boxesApart(reachOn(page, p), box) > gap) continue;
    const d = inkApart(page, p.id, mark, box);
    if (d <= gap && takes(page, p.id, box)) [best, gap] = [p.id, d];
  }
  return best;
}
// How near a mark (in box) comes to what's drawn on unit id: its strokes, typed words and pictures, each as itself
function inkApart(page, id, mark, box) {
  let d = Infinity;
  for (const [kind, list] of Object.entries(LISTS))
    for (const el of page[list] ?? []) {
      if (el.g !== id) continue;
      const b = boxOf(kind, el);
      if (boxesApart(b, box) <= Math.min(d, NEAR)) d = Math.min(d, apart(mark, kind === 'ink' ? el : b));
    }
  return d;
}
// How far apart two boxes are, across and down added (0 where they meet)
const boxesApart = (a, b) => Math.max(0, a.x0 - b.x1, b.x0 - a.x1) + Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
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
