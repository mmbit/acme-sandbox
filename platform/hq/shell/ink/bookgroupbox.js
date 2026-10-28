// Where the coordinator stacks a Notebook page's next scrap (notebookgroups.ts STACK), for the ink lifted into the book
// to land there before the scrap is read: pure maths, in the page's px.

// this far from the left, under what's there by this gap (the first this far down, under the page's heading), at most
// this wide
export const STACK = { x: 40, gap: 32, w: 360, top: 80 };

// Where a page's next scrap goes: under the foot of its groups' boxes, or under its heading when it has none
export function nextScrap(groups) {
  const feet = groups.filter(g => g.box).map(g => g.box.y + g.box.h);
  return { x: STACK.x, y: feet.length ? Math.round(Math.max(...feet) + STACK.gap) : STACK.top, w: STACK.w };
}
