// Open cards swiped through: the card follows the finger sideways, tilting a little, and a drag that lets go past
// SWIPE_PX steps to the next or the one before. A shorter one, or one the browser takes over (pointercancel), springs
// back. The next card slides in from the side it comes from.
import { reducedMotion } from './motion.js';

export const SWIPE_PX = 70;
// A drag this short is still a tap
export const DRAG_PX = 8;
// The tilt: a degree for every this many pixels dragged
export const TILT_PX_PER_DEG = 60;
export const SLIDE_IN_MS = 300;
export const SLIDE_IN_PX = 48;
export const SLIDE_IN_EASING = 'cubic-bezier(.2, .8, .2, 1)';

// Drags on area carry card() (the card open now, or null) and call onStep(by) when one lets go past SWIPE_PX: 1 for
// the next card (a drag to the left), -1 for the one before. Returns wasSwipe(), true once for the click that ends a
// drag (not a tap), and off() to stop.
export function followSwipes(area, { card, onStep }) {
  let drag = null,
    swiped = false;
  const listeners = {
    pointerdown: event => {
      swiped = false;
      if (card()) drag = { x: event.clientX, dragged: false };
    },
    pointermove: event => {
      const el = card();
      if (!drag || !el) return;
      const dx = event.clientX - drag.x;
      if (Math.abs(dx) <= DRAG_PX) return;
      drag.dragged = true;
      Object.assign(el.style, {
        transition: 'none',
        transform: `translateX(${dx}px) rotate(${(dx / TILT_PX_PER_DEG).toFixed(2)}deg)`,
      });
    },
    pointerup: event => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      swiped = drag.dragged || Math.abs(dx) > DRAG_PX;
      drag = null;
      if (Math.abs(dx) > SWIPE_PX) onStep(-Math.sign(dx));
      else springBack();
    },
    pointercancel: () => {
      if (!drag) return;
      drag = null;
      springBack();
    },
  };
  const springBack = () => {
    if (card()) Object.assign(card().style, { transition: '', transform: '' });
  };
  for (const [type, listener] of Object.entries(listeners)) area.addEventListener(type, listener);
  return {
    wasSwipe() {
      const was = swiped;
      swiped = false;
      return was;
    },
    off() {
      for (const [type, listener] of Object.entries(listeners)) area.removeEventListener(type, listener);
    },
  };
}

// card, the one stepped to, slid in from the side it comes from (by: as onStep's)
export function slideIn(card, by) {
  return card.animate(
    [
      { opacity: 0, transform: `translateX(${Math.sign(by) * SLIDE_IN_PX}px)` },
      { opacity: 1, transform: 'none' },
    ],
    {
      duration: reducedMotion() ? 0 : SLIDE_IN_MS,
      easing: SLIDE_IN_EASING,
    },
  );
}
