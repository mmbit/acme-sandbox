// Tiles a sideways swipe steps through (Wire's big key) show it: a small filled triangle just outside each side, in the
// look's own icon style, and a tap or click on one is the swipe's step. Both step round, so with two tiles or more each
// side has one to go to, and with fewer neither shows. Its place is style.css's .sides.
import { icon } from './icons.js';

// The two triangles as markup, for a box laid over the tile (cls: the place's own class); data-side: the step, as a
// swipe's (-1 the one before, 1 the next)
export const sides = (cls = '') =>
  `<div class="sides${cls ? ` ${cls}` : ''}"><button type="button" data-side="-1" aria-label="Previous">${icon('prev')}</button><button type="button" data-side="1" aria-label="Next">${icon('next')}</button></div>`;
