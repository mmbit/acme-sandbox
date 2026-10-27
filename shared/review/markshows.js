// Whether a mark on an HQ page shows now: HQ keeps one address whatever screen is open, so a mark belongs to what it was
// drawn on, and shows only while that is on the screen, as it was, with nothing over it. Its element is found again
// (anchor.js: the element itself while the page still holds it, else its selector), its words are mostly the words
// it had (sameWords), it takes room on the screen, and at the mark's middle the page's top element is it or inside it.
// A mark on nothing in particular (a note about the whole page) shows on the page. The maths is plain
// (markshows.test.js).
import { found, textOf } from './anchor.js';

// How many of the words a mark's element had must still be in it now: a card whose time moved on is still the card, and
// a screen drawn into the same box is another
export const KEPT = 2 / 3;

// Whether an element's words now are mostly its words then (anchor.js textOf's; none then: nothing to tell by)
export function sameWords(then, now) {
  const words = wordsOf(then);
  if (!words.length) return true;
  const there = new Set(wordsOf(now));
  return words.filter(w => there.has(w)).length >= KEPT * words.length;
}
const wordsOf = text => (text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

// The point a mark is tested at: the middle of where it is now (box), kept inside its element's box (el, both in the
// screen's px)
export function middleIn(box, el) {
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  return [clamp(box.x + box.w / 2, el.left + 1, el.right - 1), clamp(box.y + box.h / 2, el.top + 1, el.bottom - 1)];
}

// Whether a mark shows: its anchor, its element while the page holds it (live), where it is on the screen now (box, or
// null), and the page's element on top at a point (surface.js under: review mode's own layer covers nothing)
export function shows(anchor, live, box, topAt) {
  const selector = anchor.el?.selector;
  if (!selector) return true;
  const el = live?.isConnected ? live : found(selector, document);
  if (!el || !sameWords(anchor.el.text, textOf(el))) return false;
  const b = el.getBoundingClientRect();
  if (!b.width && !b.height) return false;
  if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return false;
  const [x, y] = middleIn(box ?? { x: b.left, y: b.top, w: b.width, h: b.height }, b);
  // (scrolled out of sight, nothing can cover it there)
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true;
  return holds(el, topAt(x, y));
}
// Whether an element is or holds another, through open shadow roots
function holds(el, other) {
  for (let e = other; e; e = e.parentElement ?? e.getRootNode?.().host) if (e === el) return true;
  return false;
}
