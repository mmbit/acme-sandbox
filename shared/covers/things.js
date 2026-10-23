// The cover kit's things: props drawn front-on (or from above, for the `above` place) at the kit's one pixel size.
// They draw no outline themselves: draw them inside fg() (several in one fg share one silhouette). Guideline: README.md.
// (everything but plant)
import { rng } from '../../platform/hq/util.js';
import { C, lite, dark, R, P, box, disc, line, text, textWidth, sprite } from './paint.js';

// A plant pot's terracotta, for a cover that pots its own plant
export const POT = '#e07a5f';
export function plant(g, x, y) { box(g, x, y - 5, 6, 5, POT); for (const [dx, dy, c] of [[1, -9, C.leaf], [3, -12, C.grass], [-1, -12, C.leaf], [4, -8, C.grass], [2, -15, C.leaf], [0, -7, C.grass]]) R(g, x + dx, y + dy, 3, 4, c); }

// A sign: a lit board with a short word on it, sized to the word. Returns its width.
export function sign(g, words, x, y, { c = C.teal, ink = C.cream, pad = 3 } = {}) {
  const w = textWidth(words) + pad * 2;
  box(g, x, y, w, 9, c); text(g, words, x + pad, y + 2, ink);
  return w;
}

// The delivery van, side on, facing right, its wheels on `foot` (in the street, y 69). label: a short word on its side.
// open: the back door swung open, for loading.
export function van(g, x, foot, { c = C.cream, stripe = C.teal, label = '', open = false } = {}) {
  const top = foot - 25;
  box(g, x, top, 34, 20, c);                                                     // the load box
  box(g, x + 34, top + 6, 14, 14, c); R(g, x + 34, top + 6, 1, 14, c);            // the cab
  R(g, x + 36, top + 8, 9, 6, C.sky); R(g, x + 36, top + 8, 3, 2, lite(C.sky, 0.5)); // its window
  R(g, x + 45, top + 15, 3, 2, C.gold);                                          // the headlight
  R(g, x, top + 13, 48, 3, stripe);
  if (label) text(g, label, x + ((34 - textWidth(label)) >> 1), top + 4, dark(stripe, 0.2));
  R(g, x + 38, top + 15, 3, 1, dark(c, 0.3));                                    // the door handle
  R(g, x - 1, foot - 6, 50, 2, C.slate); R(g, x, foot - 9, 2, 3, C.red);         // the bumper, a tail light
  for (const wx of [x + 9, x + 39]) { disc(g, wx, foot - 4, 4, C.ink); disc(g, wx, foot - 4, 2, C.grey); P(g, wx, foot - 4, C.mist); }
  if (open) { box(g, x - 9, top + 1, 9, 18, dark(c, 0.12)); R(g, x - 7, top + 3, 5, 5, C.sky); R(g, x, top + 1, 1, 18, C.ink); }
}

// A parcel: a cardboard box with tape down its middle (from above, `top`: tape both ways) and an optional label.
export function parcel(g, x, y, w, h, { c = C.woodL, tape = C.sand, label = '', top = false } = {}) {
  box(g, x, y, w, h, c);
  R(g, x + (w >> 1) - 1, y, 2, h, tape);
  if (top) R(g, x, y + (h >> 1) - 1, w, 2, tape);
  if (label) { const lw = textWidth(label) + 2; R(g, x + w - lw - 2, y + h - 8, lw, 7, C.cream); text(g, label, x + w - lw - 1, y + h - 7, C.ink); }
}

// The big printer of the print floor, its feet on `foot`. Returns where its paper comes out ({ x, y }), on the right.
export function printer(g, x, foot, { c = C.cream, light = C.green } = {}) {
  const top = foot - 32;
  box(g, x + 2, top, 36, 7, dark(c, 0.15)); disc(g, x + 10, top + 3, 2, C.grey);   // the roll housing
  box(g, x, top + 7, 40, 21, c);                                                // the body
  R(g, x + 4, top + 10, 12, 7, C.ink); R(g, x + 5, top + 11, 10, 5, C.teal);    // the panel's screen
  R(g, x + 6, top + 12, 6, 1, lite(C.teal, 0.5)); R(g, x + 6, top + 14, 4, 1, lite(C.teal, 0.3));
  for (let i = 0; i < 3; i++) R(g, x + 19 + i * 4, top + 12, 2, 2, [C.red, C.mustard, light][i]); // its buttons
  R(g, x + 22, top + 19, 18, 3, C.ink);                                         // the slot
  R(g, x + 4, top + 28, 4, 4, C.slate); R(g, x + 32, top + 28, 4, 4, C.slate);  // the feet
  return { x: x + 40, y: top + 20 };
}

// A street lamp, its foot on `foot`. on: lit, for dusk and night.
export function streetLamp(g, x, foot, { on = false } = {}) {
  R(g, x, foot - 34, 2, 34, C.slate); R(g, x - 1, foot - 2, 4, 2, C.slate);
  R(g, x - 4, foot - 37, 10, 3, C.slate); R(g, x - 3, foot - 34, 8, 2, on ? C.gold : C.mist);
}

// A tree in leaf, its trunk on `foot`.
export function tree(g, x, foot, { seed = 'tree', c = C.grass } = {}) {
  const r = rng(seed);
  R(g, x - 1, foot - 12, 3, 12, C.woodD);
  for (const [dx, dy, s] of [[-5, -16, 6], [5, -17, 6], [0, -22, 7], [r() * 4 - 2, -14, 5]]) disc(g, x + Math.round(dx), foot + dy, s, dark(c, 0.2));
  for (const [dx, dy, s] of [[-4, -18, 4], [3, -24, 4], [6, -18, 3]]) disc(g, x + dx, foot + dy, s, c);
  for (const [dx, dy] of [[-6, -20], [1, -27], [-1, -22]]) R(g, x + dx, foot + dy, 2, 1, lite(c, 0.4));
}

// The moon: full, or a crescent cut by the sky's colour behind it (`sky`).
export function moon(g, x, y, r, { crescent = false, sky = C.night } = {}) {
  disc(g, x, y, r, C.cream);
  if (crescent) { disc(g, x + Math.ceil(r / 2), y - 1, r, sky); return; }
  disc(g, x - (r >> 2), y - (r >> 2), r >> 2, C.paper); P(g, x + (r >> 1), y + (r >> 2), C.paper); P(g, x - 1, y + (r >> 1), C.paper);
}

// A water tower for the roof, its legs on `foot`.
export function waterTower(g, x, foot, { c = C.wood } = {}) {
  for (const lx of [x + 2, x + 13]) R(g, lx, foot - 12, 2, 12, C.slate);
  line(g, x + 3, foot - 12, x + 14, foot - 1, C.slate); line(g, x + 14, foot - 12, x + 3, foot - 1, C.slate);
  box(g, x, foot - 28, 17, 16, c);
  for (const by of [foot - 24, foot - 17]) R(g, x, by, 17, 1, C.slate);
  for (let i = 0; i < 5; i++) R(g, x + 2 + i * 1.5 | 0, foot - 29 - i, 13 - i * 3, 1, dark(c, 0.25));
}

// A telescope on its tripod, its feet on `foot`, looking up and to the right.
export function telescope(g, x, foot, { c = C.navy } = {}) {
  line(g, x + 6, foot - 12, x, foot, C.woodD); line(g, x + 6, foot - 12, x + 12, foot, C.woodD); line(g, x + 6, foot - 12, x + 6, foot, C.woodD);
  for (let i = 0; i < 16; i++) R(g, x + i, foot - 10 - (i >> 1) - (i < 4 ? 1 : 2), 1, i < 4 ? 3 : 4, i < 4 ? dark(c, 0.2) : c);
  R(g, x + 15, foot - 19, 2, 5, C.gold);                                        // its brass end
}

// A mug, side on (its foot on y), or from above (`above`: the rim around the coffee, x and y its middle).
export function mug(g, x, y, { c = C.cream, above = false } = {}) {
  if (above) { R(g, x + 5, y - 2, 4, 5, c); disc(g, x, y, 6, c); disc(g, x, y, 4, C.woodD); R(g, x - 2, y - 2, 2, 1, lite(C.woodD, 0.3)); return; }
  box(g, x, y - 7, 6, 7, c); R(g, x + 6, y - 6, 2, 1, c); R(g, x + 7, y - 6, 1, 4, c); R(g, x + 6, y - 3, 2, 1, c);
}

// A sheet of paper with lines of writing, for a desk seen from above or a close-up.
export function sheet(g, x, y, w, h, { c = C.cream, lines = true } = {}) {
  box(g, x, y, w, h, c);
  if (lines) for (let ly = y + 3, i = 0; ly < y + h - 2; ly += 3, i++) R(g, x + 3, ly, Math.max(2, w - 6 - (i * 7) % 9), 1, C.grey);
}

// A pencil lying flat, pointing right: rubber, ferrule, wood, lead.
export function pencil(g, x, y, length = 22, { c = C.mustard } = {}) {
  R(g, x, y, 3, 3, C.pink); R(g, x + 3, y, 2, 3, C.grey);
  R(g, x + 5, y, length - 10, 3, c); R(g, x + 5, y, length - 10, 1, lite(c));
  R(g, x + length - 5, y, 3, 3, C.sand); R(g, x + length - 2, y + 1, 2, 1, C.ink);
}

// A map on paper, seen from above: sea, a coastline, roads and a river, folded in three. Pins and routes go on top.
export function map(g, x, y, w, h, { seed = 'map' } = {}) {
  const r = rng(seed), a = r() * 6, b = r() * 6;
  R(g, x, y, w, h, lite(C.sky, 0.45));
  for (let i = 0; i < w; i++) {                                                 // the land, from a wavy coast on the left
    const coast = Math.round(w * 0.3 + Math.sin(i / 7 + a) * 5 + Math.sin(i / 3 + b) * 2);
    for (let j = 0; j < h; j++) if (i + Math.sin(j / 6 + b) * 6 > coast) P(g, x + i, y + j, lite(C.green, 0.45));
  }
  for (let j = 4; j < h; j += 13) line(g, x + (w * 0.35 | 0), y + j, x + w - 1, y + j + ((r() * 8) | 0) - 4, C.cream); // the roads
  line(g, x + (w * 0.6 | 0), y, x + (w * 0.55 | 0), y + h - 1, C.cream);
  for (let j = 0; j < h; j++) P(g, x + (w * 0.8 | 0) + Math.round(Math.sin(j / 4) * 2), y + j, lite(C.blue, 0.3)); // the river
  for (const fx of [x + (w / 3 | 0), x + (2 * w / 3 | 0)]) R(g, fx, y, 1, h, dark(lite(C.green, 0.45), 0.08)); // the folds
  R(g, x, y, w, 1, lite(C.cream, 0.3)); R(g, x + w - 1, y, 1, h, dark(C.cream, 0.15)); R(g, x, y + h - 1, w, 1, dark(C.cream, 0.15));
}

// A map pin: a round head on a short needle, its point at x, y.
export function pin(g, x, y, c = C.red) { R(g, x, y - 3, 1, 3, C.slate); disc(g, x, y - 5, 2, c); P(g, x - 1, y - 6, lite(c, 0.5)); }

// A small bird in flight, two pixels of wing either side, for a sky.
export const bird = (g, x, y, c = C.ink) => sprite(g, ['b...b', '.b.b.', '..b..'], x, y, { b: c });

// A sparkle: a star with four short rays.
export function star(g, x, y, c = C.gold) { P(g, x, y, C.cream); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) P(g, x + dx, y + dy, c); }
