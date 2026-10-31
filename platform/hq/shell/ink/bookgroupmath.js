// A Notebook page's groups as plain numbers (bookgroups.js): what a scratch-out deletes, and what a page's change asks of the store (a group's box: the store's own, notebookstack.js). No DOM, so
// node tests it (bookgroupmath.test.js).
import { boxOf } from './notebookstack.js';

// a scratch-out deletes a group it covers this much of
const COVERS = 0.5;

const KINDS = ['ink', 'texts', 'pictures'];
export const emptyParts = () => ({ ink: [], texts: [], pictures: [] });

// How much of two boxes lies in both (px², 0 when they don't overlap)
export const overlapOf = (a, b) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
// The open group a scratch-out (a line scribbled back and forth: review mode's gestures.js tells, bookgroups.js) deletes:
// the one it covers most of, at least half; null when it covers none enough
export function scratched(points, groups) {
  const line = boxOf({ ink: [{ size: 0, points }] });
  let best = null,
    most = COVERS;
  for (const g of groups) {
    if (!g.box || !g.box.w || !g.box.h) continue;
    const share = overlapOf(line, g.box) / (g.box.w * g.box.h);
    if (share >= most) [best, most] = [g, share];
  }
  return best;
}

// What a page's change asks of the store: for each group the page had (base: id → its elements as last saved, each
// kind a list of JSON strings), its elements now (now: id → parts) changed, an edit; none left, a delete.
export function changesOf(base, now) {
  const edits = [],
    deletes = [];
  for (const [id, was] of base) {
    const parts = now.get(id) ?? emptyParts();
    // (a unit of words alone, an agent's note, had nothing to lose: it stays. job #14672)
    if (!KINDS.some(k => was[k].length)) continue;
    if (!KINDS.some(k => parts[k].length)) deletes.push(id);
    else if (KINDS.some(k => !same(was[k], parts[k].map(keyOf)))) edits.push({ id, parts });
  }
  return { edits, deletes };
}
// An element as the store keeps it, for comparing (what HQ adds to one to draw it left out; one drawn to fit this
// screen's paper, the one it was drawn from: bookscrapfit.js). Its numbers to a thousandth: a unit's ink laid on the
// page and taken back to its own px (bookunits.js localOf) comes back a float's last digits off, and is the same
// element.
export const keyOf = el =>
  JSON.stringify(el.fit ?? el, (k, v) =>
    k === 'g' || k === 'img' || k === 'url' ? undefined : typeof v === 'number' ? Math.round(v * 1000) / 1000 : v,
  );
// Whether an element of a page is held off it while it lands (bookarrive.js)
export const landing = (page, el) => !!page.landing?.size && page.landing.has(keyOf(el));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
