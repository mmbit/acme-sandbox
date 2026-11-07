// Select's Bring forward and Send backward (the bar beside what's picked, bookselectclip.js; ⌘] and ⌘[): what's picked
// on an opened scrap goes one step up or down its stack (booklayers.js), past the next picture or line over or under
// it that it overlaps: a step past something it doesn't touch would change nothing on the paper (README, Layers in a
// scrap). The words stay over it all. Every thing on the scrap then keeps its place (its `layer`), saved with it; one
// step, which Undo takes back.
import { stackOf } from './booklayers.js';
import { boxOf } from './bookrow.js';
import { meets, scrapBox } from './bookselectmath.js';

// The stack in its new order, bottom first, with what's picked (a Set) a step up (up) or down: just over the first
// thing above it that meets it (meetsPicked), or just under the first below it; the picked kept in their own order.
// null when nothing there is to pass: it's on top, or at the bottom, of all it overlaps.
function stepped(order, picked, up, meetsPicked) {
  const at = order.flatMap((x, i) => (picked.has(x) ? [i] : []));
  if (!at.length) return null;
  const passes = (x, i) => !picked.has(x) && meetsPicked(x) && (up ? i > at.at(-1) : i < at[0]);
  const past = up ? order.find(passes) : order.findLast(passes);
  if (!past) return null;
  const rest = order.filter(x => !picked.has(x)),
    k = rest.indexOf(past) + (up ? 1 : 0);
  return [...rest.slice(0, k), ...order.filter(x => picked.has(x)), ...rest.slice(k)];
}

// A page's pictures and ink (an opened scrap's) with what's picked of them ({ ink, scraps }) a step up or down: a Map of
// each thing whose place changed to the thing at its new place ({ ...it, layer }), every thing on it given its place;
// null when nothing moves
export function restacked(page, { ink, scraps }, up) {
  const picked = new Set([...ink, ...scraps]),
    boxes = [...picked].map(boxOfThing);
  const order = stepped(
    stackOf(page.scraps, page.ink).map(x => x.it),
    picked,
    up,
    x => boxes.some(b => meets(boxOfThing(x), b)),
  );
  if (!order) return null;
  return new Map(order.flatMap((x, layer) => (x.layer === layer ? [] : [[x, { ...x, layer }]])));
}
// A picture's box as it's turned, a line's round its ink (page px)
const boxOfThing = x => (x.points ? boxOf(x) : scrapBox(x));
