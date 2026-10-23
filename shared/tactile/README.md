# Tactile

The motion of keys and cards, in plain browser modules: a press that holds, a card turned over, a card flown out of
its tile and back, open cards swiped through, and tiles dropped in. HQ's Slate look and the brand guide run this same
code, so they move alike. Nothing here has a colour, a word or a sound: each module calls back at the moment a sound
belongs, and the page plays its own. With reduced motion asked for, everything lands at once and the callbacks still
run.

HQ serves the modules at `/shared/tactile/<name>.js`. A product imports them by their repo path, listed in its server's
`repoFiles` and the company's `SERVED_FROM_REPO`.

The timings are exported in milliseconds (and distances in pixels), so a design system can state them.

## press.js

```js
import { holdPresses, pressBriefly } from '/shared/tactile/press.js';

holdPresses(document.body, { keys: '.key', onDown: key => play('switch') });
pressBriefly(card, { soft: true }); // a message landed on it
```

A key wears `down` from the moment it's pressed (a finger, a mouse, Enter or Space) until its click has landed, never for
less than `PRESS_MIN_MS`. A real input under a key (a choice: its label holds the input and the key) presses that key
by Space, and a radio chosen by an arrow presses the one chosen; Enter on a choice presses nothing. A phone sends the click a moment after the finger lifts, so a key let go waits up to
`CLICK_WAIT_MS` for it: a tap goes down once, not twice. The page's CSS styles `.down`. `pressBriefly` moves a key by
the transform in its `--press-tile` (`--hover-tile` when soft), wearing `down` (`nudged`) meanwhile.

## flip.js

```js
import { flip } from '/shared/tactile/flip.js';

flip(card.querySelector('.faces'), {
  onTurn: () => play('flip'),
  onEdge: () => card.classList.toggle('flipped'),
  hide: [card.querySelector('.close')],
});
```

The element turns whole to its edge in `FLIP_HALF_MS`, `onEdge` swaps the faces there, and it comes back flat in
`FLIP_BACK_MS` with a small overshoot. A tap during a turn starts no second one (`flip` returns false).

## fly.js

```js
import { flyOut, flyBack, zoomIn } from '/shared/tactile/fly.js';

tile.classList.add('away');
if (tileInView) flyOut(card, tile);
else zoomIn(card);
// closing:
tile.classList.remove('away');
flyBack(card, tile).onfinish = () => card.remove();
```

The card, already in its own place, flies from the tile's place and grows into it (`OPEN_MS`, `OPEN_EASING`), and
shrinks back into it, fading (`CLOSE_MS`). The fades are the page's: the tile under an open card fades out while it's
open, as Slate's `.away` does in CSS (`opacity: 0; scale: 0.9`, both with a 0.3 s transition).

## swipe.js

```js
import { followSwipes, slideIn } from '/shared/tactile/swipe.js';

const swipes = followSwipes(overlay, { card: () => openCard, onStep: by => open(index + by, by) });
overlay.addEventListener('click', event => {
  if (swipes.wasSwipe()) return; // the end of a drag, not a tap
});
// in open(i, by), the new card:
slideIn(card, by);
```

The open card follows the finger sideways one to one, tilting a degree for every `TILT_PX_PER_DEG`. Let go past
`SWIPE_PX` and `onStep` gets 1 (dragged left: the next) or -1; shorter, it springs back. A drag of more than `DRAG_PX`
isn't a tap, so its ending click is reported by `wasSwipe()`.

## drop.js

```js
import { dropTiles } from '/shared/tactile/drop.js';

dropTiles(tilesInView, { onBounce: (index, bounce) => bounce < 2 && play('clack', bounce ? 0.35 : 1) });
```

Each tile falls from above the screen under `GRAVITY_PX_S2`, `DROP_STAGGER_MS` after the one before, leaning up to
`DROP_TILT_DEG` and straight by the time it lands, and bounces (`BOUNCE` of its speed back) until it's slower than
`REST_PX_S`. `fall(height)` gives the frames, for a page that draws them itself.

## The check

`node shared/tactile/tactile-check.mjs` presses, turns, opens, swipes and drops on a small page in Chromium.

