// HQ's stage under the board's book (stage.js; a guest's book has none), as the book moves and rests. While it moves,
// the stage holds still (its cover). A moment after it comes to rest, while nothing moves, HQ's page at the pull's
// other end (open, or shut) is laid out ahead by the stage's scene, so the landing or the shut costs it no layout. A
// move started meanwhile (a swing, a drag of the cover's edge or a slide) puts that off to the next rest.
import { layout } from './booklayout.js';

const AHEAD_MS = 1000;
let aheadTimer = 0;

export function moving(stage, on) {
  stage?.cover(on, 'book');
  if (on) held();
}
// The book moving by the board's hand or sliding: no layout ahead till it rests again
export const held = () => clearTimeout(aheadTimer);
// state: what the book asks for. mode: the one drawn. given: the room HQ's page gives up for a layout (book.js's)
export function resting(stage, state, mode, given) {
  held();
  if (!stage || !mode) return;
  aheadTimer = setTimeout(() => {
    const other = layout(innerWidth, innerHeight, { ...state, mode: mode === 'folded' ? 'open' : 'folded' });
    stage.prepare(innerWidth - given(other));
  }, AHEAD_MS);
}
