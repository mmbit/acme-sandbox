# shared/sound: the sound engine for a company's own palette

A company's apps and ads sound like the company when its sounds come from one palette: the same materials, one key,
one loudness for each kind of sound. This engine plays such a palette on top of the demo kit's `foley.js` (the same
renderer, browser player and mute toggle). Every tonal sound sits in one major key, soft materials are struck in code,
and one tuning moves the whole palette at once, so a product can make it its own without replacing it. The engine
holds no sounds of its own: the palette is the company's, in its own folder (`kits/`), and the engine reads it.

A palette helps, it never limits: a product picks from it, tunes it, adds
sounds of its own or leaves it, and a film uses whatever sounds serve it. The check holds a palette to the levels and
the softness the company chose for it; any sound, in a palette or not, answers to the demo kit's harshness bars
(`shared/demo/SYNTH.md`).


| File | What it is |
|---|---|
| `engine.js` | The engine: the key, soft materials and building blocks to make sounds from, `use()` to put a palette in play, `tune()` |
| `check.mjs` | The sound check: renders and measures every sound in every tuning, then drives the palette's soundboard in Chromium |
| `beds.mjs` | Renders a palette's beds (quiet synth.mjs loops for ads) in each tuning, as MP3s for the soundboard |
| `board.js`, `board.css` | The soundboard: every sound, the tunings and the beds, phone-first, on the company's own page |
| `audition.js`, `audition.css` | The audition film's scene: each sound with its caption and a shape that lands on its hit |
| `foley.js` | In the repo only: points `engine.js` at `shared/demo/foley.js` |

## Setting your palette

A palette is one module in your own folder (say `kits/sound/sound.js`) that builds its sounds with the engine and
hands them to `use()`. It imports `./engine.js`: in the repo, make that a one-line file that points here
(`export * from '../../shared/sound/engine.js';`). In an app it is the real copy.

```js
import { use, strike, tone, low, bus } from './engine.js';
export { tune, tuning, note } from './engine.js';

function pat(c, p) { // a soft wooden tap on the key's fifth: (c, p) -> { o: bus, hit: s to the moment to sync on }
  const o = bus(c, 0.25);
  o.add(strike(c, p.body, tone(p, 4, 5), { force: 0.7, decay: 0.8 }), 0, 1);
  o.add(low(c, 210, 140, 0.006, 0.3), 0, 1);
  return { o, hit: 0 };
}

use({
  sounds: { pat: { fn: pat, role: 'tap', level: 0.36, about: 'a tap' } },
  roles: { tap: { group: 'Taps', loud: [-28, 1], centroid: 2500, tail: 0.3 } },
  tunings: { plain: { key: 'D', body: 'wood' }, warm: { key: 'F', body: 'felt', trim: { pat: 0.7 } } },
});
```

- `sounds`: each sound's `fn(c, p)` adds layers into a `bus` and returns `{ o, hit }`. `role` is one of `roles`.
  `level` is its peak after render, set so the role lands on its loudness. `about` says what it is.
- `roles`: what each kind of sound is held to by the check (below), and its heading on the soundboard (`group`;
  roles can share one). `wide: true` gives its tiles the board's full width.
- `tunings`: the params every sound gets as its defaults. The first is the default, and every other tuning, or an
  object passed to `tune()`, sits on top of it. It needs a `key` (C to B, `F#`, `Bb`). `octave`, `size`, `bright` and
  `room` move every sound. Anything else (`body` above) is your sounds' own. `trim` is dB per sound, to put a
  tuning's sounds back on their role's loudness: the check measures it for you.
- `materials` (optional): materials of your own for `strike()`, beside the engine's `wood`, `clay`, `felt`, `bar`,
  `ceramic` and `glass`.
- `check` (optional): more for the check to hold the palette to (below).

The building blocks: `tone(p, degree, octave)` is the Hz of a scale degree in the sound's key, so `pitch` and the
tuning move it exactly. `strike(c, material, hz, { force, decay, size, weight })` is one soft strike. `hush()` is dark
moving noise (air, felt, paper), `low()` the weight of a landing, `bloop()` a bubble in key. `bus`, `grain`, `blip`,
`thump`, `SVF`, `pulse` and `modes` come from foley.js. `note(key, degree, octave)` names a note for a synth.mjs song.
`PENTA` is the pentatonic as scale degrees.

A palette's names must not be foley.js's own sounds: `use()` refuses them.

## Tuning it for a product

```js
tune('warm');                        // one of the palette's tunings
tune({ key: 'A', size: 0.8 });       // or your own, on top of the default
```

Call `tune()` once, before the first sound: the browser player keeps rendered takes by their call params, so a later
`tune()` would keep replaying the old ones. To switch live, pass the tuning along with each play, as the board does.

## In an app

Copy `shared/sound/engine.js` and your palette into the app's public folder, side by side, with a `foley.js` there that
points at the kit where every product host serves it: `export * from '../../../../shared/demo/foley.js';` (not
`shared/sound/foley.js` or your palette's `engine.js` pointer: they point elsewhere in the repo). Then:

```html
<button id="sound" type="button" aria-label="Sound"></button>
<button id="tap" type="button">Tap</button>
<script type="module">
  import { foley } from './foley.js';
  import { tune } from './sound.js';      // your palette: importing it puts it in play
  tune('warm');                           // optional, once, before the first sound
  const sfx = foley({ key: '<slug>:sound' });
  sfx.bind(document.getElementById('sound'));
  document.getElementById('tap').addEventListener('click', () => sfx.play('pat'));
</script>
```

Everything in the demo kit's SYNTH.md ("In the app") still holds: nothing plays before the first tap, mute is
remembered, and every play varies a little.

## In an ad

A mix.mjs cue file imports the palette and then uses its names: `{ t: 0.5, sound: 'pat' }`. A bed is a synth.mjs
song that reads the key from `tuning()` as it renders (`note(tuning().key, 0, 3)`), so it follows the palette's
tuning. Call `tune()` in the cue file, before the bed renders.

```sh
node shared/sound/beds.mjs kits/sound/sound.js kits/sound/beds/*.mjs   # each bed in each tuning, as <bed>-<tuning>.mp3
```

## The check

```sh
node shared/sound/check.mjs kits/sound/sound.js                  # everything, Chromium included
node shared/sound/check.mjs kits/sound/sound.js --node           # skips the browser
node shared/sound/check.mjs kits/sound/sound.js --node --tuning '{"key":"A"}'   # your tuning too, and its trim
node shared/sound/check.mjs kits/sound/sound.js --trim           # prints every tuning's trim
node shared/sound/check.mjs kits/sound/sound.js --wav /tmp/sound # also every sound as a WAV with a spectrogram (slow)
```

It holds every sound, in every tuning, to these:

- the same take for the same seed, and a different one for a different seed;
- peaks under 0 dBFS;
- its role's loudness (`loud: [target, tolerance]`, LUFS): the loudest 400 ms, K-weighted, at render level, over four
  takes. A role's `spread` is how many LU its sounds may differ;
- its role's `centroid` ceiling (Hz) and `tail` (s from the hit to -40 dB);
- `dark`: under -45 dB above 8 kHz from 20 ms after the hit;
- `phone`: at least 45% of its energy at 400 Hz to 5 kHz (-3.5 dB), so it still carries on a phone speaker;
- `attack`: at least 2 ms from the hit to its loudest moment, never a 0 ms click (`[min, max]` in ms).

A role can set its own `dark`, `phone` and `attack`. The palette's `check` adds:

- `gaps`: `{ quieter, louder, db: [least, most] }`, one sound sits that much under another;
- `lengths`: `{ name: [least, most] }` in s;
- `pitched`: a sound with one clear note, the check measures the key on it;
- `mastered`: `[target, tolerance]` in LUFS, how loud mix.mjs masters three of its sounds. Without it the check only
  asks for more than -30 LUFS, since three soft taps can't reach -14.

It also checks that the key, `tune()` and `pitch` move every sound, that `tune()` is the same as passing the tuning
as params, and that mix.mjs plays the palette by name, mastered. In Chromium it opens the palette's soundboard
(`board.html` beside the palette, or `--board <page>`) at iPhone Air size: silent before a gesture, plays after one,
the tuning switch and a bed work, mute is stored and remembered, and the browser renders sample for sample what
Node renders.

Loudness is matched by measurement, not by ear. That's the point: nobody here can hear, and the check makes sure what
can't be heard is still right.

## The soundboard

Every sound in the palette as a tile, grouped by role, with the tuning switch and the beds, phone-first. The page is
the company's (its words and colours), and `board.js` builds the board in it:

```html
<link rel="stylesheet" href="../../shared/sound/board.css">
<button id="mute" type="button" aria-label="Sound"></button>
<main id="board"></main>
<script type="module">
  import './sound.js';                                 // your palette
  import { board } from '../../shared/sound/board.js';
  board({ at: document.getElementById('board'), storageKey: '<company>:soundboard', beds: { brush: 'a brushed beat' } });
</script>
```

- `at` (required): the element the board is built in. `storageKey` (required): where the mute choice is kept.
- `mute`: the mute button (`#mute` by default). `soundOn`, `soundOff`: its labels.
- `tuningAbout`: `{ tuning: a short line under its name }`.
- `beds`: `{ bed: what it is }`, played from `<bedFolder><bed>-<tuning>.mp3` (`bedFolder` is `./beds/` by default, as
  `beds.mjs` writes them). `bedTitle`: their heading.
- `tuneSound`, `unmuteSound`: a palette sound to play when a tuning is picked, and when sound comes back on.

`board.css` takes the colours from custom properties the page sets on `:root`: `--card`, `--ink`, `--muted`, `--line`,
`--accent`, `--shade` (behind the tuning switch) and `--name-font` (the tiles' names). The check drives the tiles by
`data-sound`, `data-tuning` and `data-bed`, and `#mute`: keep them if you build your own.

## The audition film

A 9:16 film for `shared/demo/ad.mjs`: each sound of the palette with its caption, the code that plays it, and a shape
that lands on its hit. The reel lives in the company's mix.mjs cue file (exported as `reel`, beside the cues it
makes), so the pictures follow the real cue times. The page is the company's (its `#demo` settings, words and colours),
and `audition.js` draws the scene in it:

```html
<script type="application/json" id="demo">{ "audio": "audition.wav", "out": "audition.mp4" }</script>
<link rel="stylesheet" href="../../shared/sound/audition.css">
<script>
  window.ready = Promise.all([import('../../shared/sound/audition.js'), import('./audition.mjs')])
    .then(([{ audition }, { reel }]) => audition({ reel }));
</script>
```

Each reel item takes:

- `kind`: its shape, one of `key`, `row`, `dial`, `toggle`, `pop`, `flick`, `drawer`, `card`, `sheet`, `drop`,
  `nope`, `bell`, `check`, `bloom`, `tune` and `sting`.
- `name` and `line`: the caption.
- `t`: when its first cue hits (s), and `cues: [{ sound, at }]`, each `at` seconds after `t`, as mix.mjs plays them.
- `call` (optional): the code shown under the caption, instead of its cues' `sfx.play()` calls.
- `big` (`check`): the bigger success. `tint` (`tune`): the colour its keys rest in. `label` (`sting`): the line
  under the mark.

`audition()` also takes `title` and `kicker`, elements of the page's own: the title rides over the first sound, then
the kicker takes its place. `audition.css` takes the colours and fonts from `--paper`, `--card`, `--ink`, `--muted`,
`--line`, `--faint`, `--accent`, `--name-font`, `--text-font` and `--code-font`.

```sh
node shared/demo/mix.mjs kits/sound/audition.mjs && node shared/demo/ad.mjs kits/sound/audition.html
```
