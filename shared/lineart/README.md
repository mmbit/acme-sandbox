# Isometric line art


A small kit for drawing in the isometric line-art style: clean outlines at one weight, a lot of empty ground, the shade
in dots, hatching or flat tones, and one shape in the accent where the picture's story is. It draws pictures as SVG
(covers, pages, decks) and draws on a 2D canvas. No dependencies, the same in Node and a browser.
`shared/craft/line-art.md` says what makes the style work and how to check a picture.

```js
import { drawing } from '../../shared/lineart/lineart.js';

const svg = drawing(
  s => {
    s.plate(-2, -2, 12, 10); // a green base plate under it all
    s.room(0, 0, 0, 8, 6, 3, { windows: 1 }); // a room cut away: its floor and two far walls
    s.box(1, 1, 0, 3, 1.2, 1.1); // a desk
    s.quad(
      [
        [1.5, 1.3, 1.3],
        [3.5, 1.3, 1.3],
        [3.5, 1.3, 2.4],
        [1.5, 1.3, 2.4],
      ],
      'left',
      { accent: true },
    ); // the screen
    s.figure(2.5, 3, 0, { pose: 'sit', reach: [2.5, 1.6, 1.2] });
    s.tree(9, 7, 0, 0.8);
  },
  'soft',
  { W: 1600, H: 900, title: 'Someone at work at a desk' },
);
```

`node shared/lineart/render.mjs` draws the three examples in `examples/examples.js` (a house cut away, a block of flats,
a desk in a room) in every palette, as `examples/<name>-<palette>.svg`. Look at them before you start.

## Building a scene (`scene.js`)

`scene()` gives a builder whose calls chain. x runs to the lower right, y to the lower left, z up, in any unit. Items
draw in the order they're added: add them back to front (further back is smaller x + y).

- `box(x, y, z, w, d, h, { tone, accent })`: from its far corner; `accent` names the face in the accent (`top`,
  `left`, `right`).
- `cylinder(x, y, z, r, h, { tone, accent })`, `ball(x, y, z, r, { tone, accent })`.
- `quad(points, face, { tone, accent })`: a flat panel (a window, a door, a screen) shaded like the face it lies on.
- `line(points, { thin })`: an arm, a cable, a mullion; `thin` at half the weight.
- `shadow(points, z)` on the ground, and `pool(x, y, rx, ry)`: a patch of sparse dots under a scene.
- `plate(x, y, w, d, h, { z, tone })`: a base plate, its top at `z` (0).
- `room(x, y, z, w, d, h, { wall, floor, windows, tone })`: a room cut away, its floor slab and two far walls.
- `wall(x, y, z, length, 'x' | 'y', h, { door, windows })`, `roof(x, y, z, w, d, h, { ridge, over, cut })`: a gable,
  or cut away to its far slope.
- `tree(x, y, z, r)`, `figure(x, y, z, { pose: 'stand' | 'sit', accent, reach, lift, mark })`. `PERSON` has a
  person's sizes for placing furniture round them.

Tones name what a face is made of: `plain`, `glass`, `roof`, `leaf`, `base`, `skin`, `dark` (always the ink), or a
company's own, which its palette colours.

## Drawing it (`shapes.js`, `draw.js`)

`shapesOf(items)` gives the flat shapes, each with its `role` (`plain-left`, `accent`, `shadow`...). `fit(shapes,
{ W, H, pad, focus, zoom })` gives `{ k, ox, oy }` to place them in a frame. `svg(shapes, palette, { W, H, k, ox, oy,
title, line, id })` writes the SVG: `line` is the weight in px (W x 0.0028 by default), `id` prefixes its patterns
(give each palette on one page its own). `paint(ctx, shapes, palette, { k, line })` paints on a canvas whose transform
places the view's units `k` px apart; it keeps a Path2D on each shape, so a scene that keeps its shapes repaints them
cheaply. `drawing(build, palette, frame)` does all of it in one call.

## Palettes (`palettes.js`)

`PALETTES` has `soft` (flat soft colours, even dark lines, a green plate), `blueprint` (one ink on white, hatched) and
`line` (ink and dots on a warm paper). A company passes its own as data over one of them:

```js
paletteOf({
  base: 'line',
  ground: 'var(--ground)',
  ink: 'var(--ink)',
  paper: 'var(--ground)',
  accent: 'var(--accent)',
  accentSide: 'var(--side)',
});
```

Any CSS colour goes in an SVG, `var()` included: a drawing in variables repaints itself with the page's colours, so one
drawing serves every colour scheme a site offers. A canvas needs real colours. The keys: `ground`, `ink`, `paper`,
`accent`, `accentSide`, `shade` (`dots`, `hatch` or `flat`), and for flat looks `tones` (a tone's `[top, left, right]`),
`shadow` and `pool`.
