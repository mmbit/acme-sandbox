// Where a Notebook page's next scrap goes, one rule for the coordinator (notebookscraps.ts), the dev mock
// (notebookplaygroups.js) and the ink lifted into the book to land there before the scrap is read: pure maths, in the
// page's px.

// this far from the left and this far down from the origin on an empty page, this far from what's next to it, at most
// this wide
export const STACK = { x: 40, gap: 32, w: 360, top: 80 };

// The next scrap, h tall, goes where the board last added something: under the page's newest group (the highest id),
// at its left edge, and on down past any group in its way. An empty page has it near its origin.
// groups: { id, box: { x, y, w, h } | null }
export function nextScrap(groups, h = 0) {
  const boxes = groups.filter(g => g.box);
  if (!boxes.length) return { x: STACK.x, y: STACK.top, w: STACK.w };
  const newest = boxes.reduce((a, b) => (b.id > a.id ? b : a)).box,
    spot = { x: newest.x, y: newest.y + newest.h + STACK.gap, w: STACK.w, h };
  // (each pass moves it past at least one group, so at most one pass a group)
  for (let i = 0; i < boxes.length; i++) {
    const inWay = boxes.map(g => g.box).filter(b => inWayOf(spot, b));
    if (!inWay.length) break;
    spot.y = Math.max(...inWay.map(b => b.y + b.h)) + STACK.gap;
  }
  return { x: Math.round(spot.x), y: Math.round(spot.y), w: STACK.w };
}
// whether box b is over the spot, or closer under it than the gap
const inWayOf = (spot, b) =>
  spot.x < b.x + b.w && b.x < spot.x + spot.w && spot.y < b.y + b.h && b.y < spot.y + spot.h + STACK.gap;
