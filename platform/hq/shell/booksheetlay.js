// Where a sheet page's notes lie: down the page in their order, as a scrapbook's cuttings, never on the board's own
// writing or pictures on that paper, nor on each other. A note keeps the place it was first given (the board writes
// round it, or on it, from then on), unless the note before it is another one now, or it has grown into writing below
// it. No DOM, so node tests it.

// the paper kept clear round writing, and between a note and the next (px)
export const CLEAR_PX = 10;
// a line's points per box: short runs, so a ring's empty middle isn't taken for writing
const RUN = 4;

// The boxes the board's writing and pictures take on a page (its px), each a short run of a line's points widened by
// its pen and CLEAR_PX: [{ x0, y0, x1, y1 }]. ink: shared/review/ink.js strokes; scraps: [{ x, y, w, h }].
export function takenBoxes(ink = [], scraps = []) {
  const out = [];
  for (const line of ink) {
    const pts = line.points ?? [],
      r = (line.size ?? 4) / 2 + CLEAR_PX;
    for (let i = 0; i < pts.length; i += RUN) {
      const run = pts.slice(Math.max(0, i - 1), i + RUN),
        xs = run.map(p => p[0]),
        ys = run.map(p => p[1]);
      out.push({ x0: Math.min(...xs) - r, y0: Math.min(...ys) - r, x1: Math.max(...xs) + r, y1: Math.max(...ys) + r });
    }
  }
  for (const s of scraps)
    out.push({ x0: s.x - CLEAR_PX, y0: s.y - CLEAR_PX, x1: s.x + s.w + CLEAR_PX, y1: s.y + s.h + CLEAR_PX });
  return out;
}

// Where each note lies (its top, page px). notes: in their order, [{ id, top, h, after }]: top, where the page's flow
// puts it with no note moved; h, its height now; after, the id of the note before it (null for the first). column:
// { x0, x1 }, the notes' width on the page. taken: takenBoxes'. kept: id → { y, h, after }, the places given before.
// held: the id of a note whose words are being written, which stays where it is. Returns id → { y, h, after }, each at
// or below where the flow puts it (a note only ever goes down the page to find room).
export function laidOut(notes, column, taken, kept = new Map(), held = null) {
  const across = taken.filter(b => b.x1 > column.x0 && b.x0 < column.x1),
    hits = (y0, y1) => across.filter(b => b.y1 > y0 && b.y0 < y1);
  // the first top at or below y where a note h high touches nothing
  const roomAt = (y, h) => {
    for (let near = hits(y, y + h); near.length; near = hits(y, y + h)) y = Math.max(...near.map(b => b.y1));
    return y;
  };
  const out = new Map();
  let shift = 0;
  for (const { id, top, h, after } of notes) {
    const flow = top + shift,
      was = kept.get(id);
    const stays =
      was &&
      was.y >= flow &&
      (id === held || (was.after === after && (h <= was.h || !hits(was.y + was.h, was.y + h).length)));
    const y = stays ? was.y : roomAt(flow, h);
    out.set(id, { y, h, after });
    shift += y - flow;
  }
  return out;
}
