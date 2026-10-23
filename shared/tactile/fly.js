// A card opened out of its tile and closed back into it: it flies from the tile's place and grows into its own, and
// shrinks back, fading, on close. The caller fades the tile under it (README: the fades).
import { reducedMotion } from './motion.js';

export const OPEN_MS = 420;
export const OPEN_EASING = 'cubic-bezier(.2, .9, .3, 1.08)'; // (a touch past its place, and settled)
export const CLOSE_MS = 240;
export const CLOSE_EASING = 'cubic-bezier(.5, 0, .75, .4)';
// A card whose tile is out of view grows in where it is instead
export const ZOOM_MS = 300;
export const ZOOM_EASING = 'cubic-bezier(.2, .8, .2, 1)';
export const ZOOM_FROM_SCALE = 0.94;

// card, already in its place, flown out of tile's. Returns its Animation.
export function flyOut(card, tile) {
  return card.animate([{ transform: from(card, tile), opacity: 0.6 }, { transform: 'none' }], {
    duration: reducedMotion() ? 0 : OPEN_MS,
    easing: OPEN_EASING,
  });
}

// card flown back into tile's place, fading out on the way: remove it when the Animation finishes
export function flyBack(card, tile) {
  return card.animate(
    [{ transform: 'none' }, { opacity: 0.2, offset: 0.6 }, { transform: from(card, tile), opacity: 0 }],
    {
      duration: reducedMotion() ? 0 : CLOSE_MS,
      easing: CLOSE_EASING,
    },
  );
}

// card, opened with no tile in view to fly from
export function zoomIn(card) {
  return card.animate(
    [
      { opacity: 0, transform: `scale(${ZOOM_FROM_SCALE})` },
      { opacity: 1, transform: 'none' },
    ],
    {
      duration: reducedMotion() ? 0 : ZOOM_MS,
      easing: ZOOM_EASING,
    },
  );
}

// the transform that puts card over tile: their centres together, card at tile's width
function from(card, tile) {
  const a = tile.getBoundingClientRect(),
    b = card.getBoundingClientRect(),
    dx = a.left + a.width / 2 - b.left - b.width / 2,
    dy = a.top + a.height / 2 - b.top - b.height / 2;
  return `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${(a.width / b.width).toFixed(3)})`;
}
