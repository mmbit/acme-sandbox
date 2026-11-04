// A sketch page as a canvas: every unit at its own place on the page, whatever the page's width, so nothing drawn there
// ever rearranges. Pure, shared by HQ's page (bookunits.js), the store (notebookplaces.ts), the played store
// (notebookplaygroups.js) and the page's picture (bookpicture.ts).
import { GAP, MARGIN, layout } from './masonry.js';
import { UNIT_W } from './scrapunit.js';
import { boxOf } from './notebookstack.js';
import { shifted } from './notebookparts.js';

// Whether a page in this chapter (notebookchapters.js) is a canvas: the board's own sketches are. A page of scraps (its
// Asks, a call's notes, a round's guests) stays a masonry.
export const isCanvas = chapter => chapter === 'sketch';
// Whether a request's place is one: { x, y }, finite page px
/** @param {any} v @returns {v is { x: number, y: number }} */
export const isPlace = v => typeof v === 'object' && Number.isFinite(v?.x) && Number.isFinite(v?.y);
// Whether a request's push is one: { top, from, x0, x1, by }, finite page px, by above 0
/** @param {any} v @returns {v is { top: number, from: number, x0: number, x1: number, by: number }} */
export const isPush = v =>
  typeof v === 'object' && ['top', 'from', 'x0', 'x1', 'by'].every(k => Number.isFinite(v?.[k])) && v.by > 0;

// How far above a dated scrap's top its date's line starts (its words 14 px down it, bookgroups.css .bk-day), and the
// room a scrap of a later day gets above it to hold it, as it lands (page px)
export const DATE_ABOVE = 34;
const DATED = 20;

// The dates on a canvas: over each of our scraps that's the first of a later day than the page's so far (first: the
// page's own, in its head), that day's date just above its top-left, as a scrap taped into a sketchbook on another day
// gets its date; the board's own drawing never dates anything, so free drawing puts no dates on the page (README, Our
// scraps). units: [{ id, day?, drawn? }] in the page's order; places: id → { x, y }. → [{ day, x, y }] (page px).
export function daysOf(units, places, first) {
  let shown = first;
  const out = [];
  for (const u of units) {
    const at = places.get(u.id);
    if (u.drawn || !u.day || (shown && u.day <= shown) || !at) continue;
    if (shown) out.push({ day: u.day, x: at.x, y: at.y - DATE_ABOVE });
    shown = u.day;
  }
  return out;
}

// A note's room dragged taller on a canvas opens room on the page: everything placed at or below its foot as it was
// (push.from, page px), and whatever starts under the note itself (below its top, push.top, across its width, x0 to
// x1), moves down as far as the room grew (push.by), so it never runs one note under another; whatever starts beside it
// stays where it is (README, Our scraps). Shrinking moves nothing. places: [{ id, place }] → the moved ones, [{ id,
// place }].
export function pushedDown(places, push) {
  if (!isPush(push)) return [];
  const under = ({ x, y }) => y >= push.from || (y > push.top && x < push.x1 && x + UNIT_W > push.x0);
  return places
    .filter(u => u.place && under(u.place))
    .map(u => ({ id: u.id, place: { ...u.place, y: u.place.y + push.by } }));
}

// The units' places on a canvas. units: [{ id, h, w, below, place?, day?, follows?, column? }] in the page's order, h
// tall and w wide (what's drawn on it too, from its place's left) in page px, below: how tall what hangs under it is
// (bookunder.js: an answer, a waiting face, a try's versions; 0 for nothing), place ({ x, y }, page px) where it has
// one. The rest are laid as the masonry lays them at width (CSS px), each with the room for what hangs under it, under
// every placed one and what hangs under it: a page from before canvases looks as it did at that width, and a scrap just
// come lands under everything. edge: where the masonry starts, x in CSS px and y in page px. → { places: [{ id, x, y,
// hung }], fresh: the ids placed now, to keep their places from then on }. hung: the box what hangs under a unit takes
// ({ x, y, w, h, tie? }, page px): by its own unit, never covering another unit or what hangs under one, nor under one
// it doesn't belong to; tied to it where it hangs past its row (tiedTo), always.
export function canvasOf(units, width, edge = { x: 0, y: 0 }) {
  const placed = units.filter(u => u.place).sort((a, b) => a.place.y - b.place.y),
    taken = placed.map(u => ({ ...u.place, w: u.w, h: u.h })),
    hung = new Map(),
    hang = (u, box) => {
      hung.set(u.id, box);
      taken.push(box);
    };
  for (const u of placed) if (!u.below) hung.set(u.id, footOf(u));
  // (first every one with clear paper at its foot or beside it, so a boxed-in note never takes the spot by another one)
  for (const u of placed.filter(u => u.below)) {
    const box = hangBy(taken, u);
    if (box) hang(u, box);
  }
  // (then the ones boxed in, past their rows, the shortest way first: one tie runs inside another, never across it)
  for (let rest = placed.filter(u => !hung.has(u.id)); rest.length; rest = rest.filter(u => !hung.has(u.id))) {
    const [u, { box, tie }] = rest.map(u => [u, tiedTo(taken, u)]).sort(([, a], [, b]) => a.cost - b.cost)[0];
    hang(u, { ...box, tie });
    taken.push(...linesOf(tie));
  }
  const loose = units.filter(u => !u.place).map((u, k) => ({ ...u, h: u.h + u.below, ...(!k && { follows: false }) })),
    // (a scrap come on a later day than everything placed lands with room above it for its date: daysOf)
    latest = placed.reduce((d, u) => (u.day > d ? u.day : d), ''),
    dated = placed.length && loose[0] && !loose[0].drawn && loose[0].day > latest ? DATED : 0,
    top = Math.max(edge.y, ...taken.map(b => b.y + b.h + GAP - MARGIN)) + dated,
    laid = layout(loose, width),
    s = laid.scale,
    at = new Map(laid.places.map(p => [p.id, { x: (p.x + edge.x) / s, y: p.y / s + top }]));
  return {
    places: units.map(u => {
      if (u.place) return { id: u.id, ...u.place, hung: hung.get(u.id) };
      const p = at.get(u.id);
      return { id: u.id, ...p, hung: { x: p.x, y: p.y + u.h, w: UNIT_W, h: u.below } };
    }),
    fresh: loose.map(u => u.id),
  };
}
// Whether two boxes ({ x, y, w, h }) cover some of each other (touching edges don't)
const covers = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
// Where what hangs under a placed unit u goes, clear of the boxes taken: at its foot where that paper is clear, else
// level with it beside it (right, then left), so an answer stays by its own note and never covers the board's next
// note or sketch; none where both sides are taken too (canvasOf hangs it past its row then, tied to it)
function hangBy(taken, u) {
  const clear = box => !taken.some(b => covers(b, box));
  return [footOf(u), ...besideOf(u)].find(clear);
}
// (the boxes beside placed unit u, level with it: at its right, at its left)
const besideOf = u => [u.place.x + u.w + GAP, u.place.x - GAP - UNIT_W].map(x => ({ ...footOf(u), x, y: u.place.y }));
// (the box at placed unit u's foot)
const footOf = u => ({ x: u.place.x, y: u.place.y + u.h, w: UNIT_W, h: u.below });
// The boxes level with unit u past the ends of the boxes taken level with it: right of the rightmost, left of the
// leftmost
function pastRow(taken, u) {
  const box = besideOf(u)[0],
    row = rowOf(taken, box);
  return [Math.max(...row.map(b => b.x + b.w)) + GAP, Math.min(...row.map(b => b.x)) - GAP - box.w].map(x => ({
    ...box,
    x,
  }));
}
// (the boxes taken level with box)
const rowOf = (taken, box) => taken.filter(b => b.y < box.y + box.h && box.y < b.y + b.h);
// Where what hangs under unit u goes past its row, with the tie that reads it as u's wherever it hangs: points (page
// px) from the middle of u's top to the box's top over where every card hanging starts, TIE_IN from its left (drawn in
// the book's ink: bookunder.js), at the row's end with the shorter way. A card always reads as its own note's first,
// then its tie over no note: over clear paper wherever a way is clear, else over as few notes as it can (wayOver), so
// never a card left untied. → { box, tie, cost }
function tiedTo(taken, u) {
  const from = [u.place.x + u.w / 2, u.place.y];
  return pastRow(taken, u)
    .map(box => ({ box, ...wayOver(taken, from, [box.x + TIE_IN, box.y], box) }))
    .sort((a, b) => a.cost - b.cost)[0];
}
// (where a card hanging starts, from the box's left, page px: the middle of the agent's face while an answer comes,
// bookanswers.css .bk-answer-face, and a slip's clipped corner)
const TIE_IN = 11;
// (a tie's lanes: a sixth of a gap apart, the tie that far clear of every box taken and every other tie)
const LANE = GAP / 6;
// (a bend in a tie counted as this much more of its length: the fewest bends that keep it clear)
const BEND = GAP;
// (a line over a box counted as this much more of its length: any way over clear paper before one over a note)
const OVER = 1e6;
// The shortest way from a to b (points, page px) up, down and across clear paper, clear of the boxes taken and of box
// (where b's card hangs): in lanes along the middles of the gaps round every box taken and the lanes either side of
// them, a lane off a gap's middle a little longer, so a second tie runs beside the first, never across it. Where no
// way is clear (the board's own drawing closes every gap) the way over the fewest boxes, never along or across another
// tie. → { tie: its points, the ends and every bend, cost }
function wayOver(taken, a, b, box) {
  const { size, at, point, step } = paperOf([...taken, box], a, b),
    [start, goal] = [at(a), at(b)],
    // (how far a node is from b at the least: what's left of the way there, A*'s guess)
    left = node => {
      const [x, y] = point(node);
      return Math.abs(b[0] - x) + Math.abs(b[1] - y);
    },
    // (states: a node and the direction it was come to in, 4 for the start's)
    cost = new Float64Array(size * 5).fill(Infinity),
    from = new Int32Array(size * 5).fill(-1),
    open = [[left(start), start * 5 + 4, 0]];
  cost[start * 5 + 4] = 0;
  while (open.length) {
    const [, state, c] = pop(open),
      node = Math.floor(state / 5);
    if (c > cost[state]) continue;
    if (node === goal) {
      const nodes = [];
      for (let s = state; s !== -1; s = from[s]) nodes.unshift(Math.floor(s / 5));
      return { tie: bendsOf(nodes.map(point)), cost: c };
    }
    for (let d = 0; d < 4; d++) {
      const next = step(node, d);
      if (!next) continue;
      const to = next[0] * 5 + d,
        total = c + next[1] + (state % 5 === 4 || state % 5 === d ? 0 : BEND);
      if (total >= cost[to]) continue;
      cost[to] = total;
      from[to] = state;
      push(open, [total + left(next[0]), to, total]);
    }
  }
}
// The paper round boxes as a grid of nodes where its lanes (lanesOf) meet, a and b among them. → { size: how many
// nodes, at: a point's node, point: a node's point, step(node, d): from a node one lane on in one of four directions,
// the node there and how long the way to it counts (OVER more for each box its line runs over), or none where that
// line runs along or across a tie }
function paperOf(boxes, a, b) {
  const [xs, ys] = [0, 1].map(k => lanesOf(boxes, k, [a[k], b[k]])),
    n = ys.length,
    point = node => [xs[Math.floor(node / n)][0], ys[node % n][0]],
    // (what the line from a node one lane on in direction d runs over: how many boxes, -1 a tie, -2 not looked at yet)
    over = new Int32Array(xs.length * n * 4).fill(-2);
  return {
    size: xs.length * n,
    at: ([x, y]) => xs.findIndex(l => l[0] === x) * n + ys.findIndex(l => l[0] === y),
    point,
    step(node, d) {
      const [i, j] = [Math.floor(node / n) + [1, -1, 0, 0][d], (node % n) + [0, 0, 1, -1][d]];
      if (!xs[i] || !ys[j]) return null;
      const [[x0, y0], [x1, y1]] = [point(node), point(i * n + j)],
        across = y0 === y1,
        line = across
          ? { x: Math.min(x0, x1), y: y0 - LANE, w: Math.abs(x1 - x0), h: 2 * LANE }
          : { x: x0 - LANE, y: Math.min(y0, y1), w: 2 * LANE, h: Math.abs(y1 - y0) };
      if (over[node * 4 + d] === -2) {
        const under = boxes.filter(o => covers(o, line));
        over[node * 4 + d] = under.some(o => !(o.w && o.h)) ? -1 : under.length;
      }
      if (over[node * 4 + d] === -1) return null;
      return [
        i * n + j,
        (across ? line.w : line.h) * (1 + (across ? ys[j] : xs[i])[1] / 32) + OVER * over[node * 4 + d],
      ];
    },
  };
}
// (a way's points where it bends, and its ends)
const bendsOf = points =>
  points.filter((p, k) => {
    const [before, after] = [points[k - 1], points[k + 1]];
    return !before || !after || (before[0] !== after[0] && before[1] !== after[1]);
  });
// The lanes along one axis (k: 0 x, 1 y) round the boxes (not the ties' lines): through ends, and the middle of the
// gap at each side of every box and two lanes either side of it. → [[at, lanes off a gap's middle]], sorted by at
function lanesOf(boxes, k, ends) {
  const [at, size] = k ? ['y', 'h'] : ['x', 'w'],
    lanes = new Map(ends.map(v => [v, 0]));
  for (const b of boxes.filter(b => b.w && b.h))
    for (const middle of [b[at] - GAP / 2, b[at] + b[size] + GAP / 2])
      for (const off of [-2, -1, 0, 1, 2]) {
        const v = middle + off * LANE;
        lanes.set(v, Math.min(lanes.get(v) ?? Infinity, Math.abs(off)));
      }
  return [...lanes].sort(([p], [q]) => p - q);
}
// (a tie's lines as boxes as wide as a line: taken, so no box or tie after it covers or crosses it)
const linesOf = tie =>
  tie.slice(1).map(([x1, y1], k) => {
    const [x0, y0] = tie[k];
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  });
// A queue's least entry ([cost, …]) taken off it, and an entry put on it: a binary heap in an array
function pop(heap) {
  const least = heap[0],
    last = heap.pop();
  if (!heap.length) return least;
  heap[0] = last;
  for (let i = 0; ;) {
    const m = [i, 2 * i + 1, 2 * i + 2].filter(c => c < heap.length).sort((p, q) => heap[p][0] - heap[q][0])[0];
    if (m === i) return least;
    [heap[i], heap[m]] = [heap[m], heap[i]];
    i = m;
  }
}
function push(heap, entry) {
  heap.push(entry);
  for (let i = heap.length - 1, up; i && heap[(up = (i - 1) >> 1)][0] > heap[i][0]; i = up)
    [heap[i], heap[up]] = [heap[up], heap[i]];
}

// Parts lifted out of a unit at place as a unit of their own, left where they are: moved to their box's top-left and
// the place moved as far, never scaled to a unit's width (a canvas has no columns). → { parts, h, place }
export function liftedOut(parts, place) {
  const box = boxOf(parts);
  return {
    parts: shifted(parts, -box.x, -box.y),
    h: Math.ceil(box.h),
    place: place && { x: place.x + box.x, y: place.y + box.y },
  };
}
