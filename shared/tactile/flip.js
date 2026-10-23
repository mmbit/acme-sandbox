// A card turned over whole: edge on, its other face shown at the edge, and back flat with a small overshoot.
import { reducedMotion } from './motion.js';

// To the edge, and from the edge back to flat
export const FLIP_HALF_MS = 170;
export const FLIP_BACK_MS = 320;
export const FLIP_MS = FLIP_HALF_MS + FLIP_BACK_MS;
// What the turn hides (a close button) is gone for a little longer than the turn
export const FLIP_HIDE_MS = 520;
export const FLIP_PERSPECTIVE_PX = 1400;

const turning = new WeakSet();

// Turns el over: onTurn() as it starts (for its sound), onEdge() at the edge, where the caller swaps its faces, and
// hide's elements faded out meanwhile. A second turn before the first has ended is refused: false. Flat at rest, so
// what scrolls inside it still scrolls.
export function flip(el, { onTurn = () => {}, onEdge, hide = [] }) {
  if (turning.has(el)) return false;
  onTurn();
  if (reducedMotion()) {
    onEdge();
    return true;
  }
  turning.add(el);
  for (const part of hide)
    part.animate(
      [{ opacity: 1 }, { opacity: 0, offset: 0.2 }, { opacity: 0, offset: 0.7 }, { opacity: 1 }],
      FLIP_HIDE_MS,
    );
  const turned = angle => ({ transform: `perspective(${FLIP_PERSPECTIVE_PX}px) rotateY(${angle}deg)` });
  el.animate([turned(0), turned(90)], { duration: FLIP_HALF_MS, easing: 'ease-in' }).onfinish = () => {
    onEdge();
    el.animate([turned(-90), { transform: 'none' }], {
      duration: FLIP_BACK_MS,
      easing: 'cubic-bezier(.3, 1.25, .45, 1)',
    }).onfinish = () => turning.delete(el);
  };
  return true;
}
