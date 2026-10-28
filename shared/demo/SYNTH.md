# Our own sound, in code: foley.js, mix.mjs and synth.mjs

Three tools, pure JavaScript, no dependencies, the same output on every run. House rule 6 applies to all
of it: every sound and note is made here, never sampled, copied or imitated.

**These tools help, they never limit**. Use the sounds, the defaults and the
examples where they serve the work, and leave them where they don't: a sound you make another way (your own code,
another synth, an original's rendered audio) plays in an app and cues in a film like any kit sound. What every sound
answers to is the safeguards: never harsh (`harsh.mjs`) and a pleasant volume (mix.mjs's mastering and `--levels`).

| tool | makes | used for |
|---|---|---|
| `foley.js` | satisfying foley sounds (pencil, paper, card, stamp, ink, cloth, magnets, clockwork, glass, wood, water…), synthesised with physical parameters | the apps (in the browser) and the films (in Node): the same code in both |
| `mix.mjs` | a film's soundtrack: cues on a timeline (kit sounds or any WAV), an optional music bed, mastered for TikTok/Reels | `ad.mjs --audio`, as any track |
| `synth.mjs` | music: songs and beds with a beat grid, plus the older generic SFX | a score or a bed under a film, presentation beds |

**Advice, not a rule:** crafted, "oddly satisfying" sound effects carry an app and its ad well (board, venture cycle
1), so music usually sits under them. A score good enough to carry the film leads it. A film uses
whatever sounds serve it, not only its app's, and the app then follows its film where it can.

## Satisfying sounds: foley.js

Every sound is layered like real foley: a **transient** (the contact), a **body** (the resonance of the
thing) and a **tail** (settling, a small room). The struck objects share one physical model (a contact
pulse exciting a bank of damped modes); textures (pencil, paper, cloth, water) are shaped noise with
grain; bubbles follow the physics of a bubble's resonance. Listen to all of them in
`examples/audition.mp4`, or tap them in `examples/foley.html` (the soundboard).

| sound | what it is | hit (what lands on the cue) | its own params |
|---|---|---|---|
| `tick` | clockwork tick: pallet, wheel, case | the tick | `tock: true` (the lower half of tick-tock) |
| `ratchet` | winding: clicks speeding up and rising | the last click | `clicks` 10, `rate` 16/s, `accel`, `rise` (semitones), `material` |
| `clack` | a good mechanical key: click going down, clack coming up | the press | `hold` 0.085 s (0 = press only), `material` |
| `switch` | a crisp tactile switch: one bright, dry click with a short body, no knock (a button on a page) | the click | `hold` (s to a lighter click letting go, 0 = none) |
| `knock` | wood block | the knock | any `hit` param |
| `tink` | glass tink | the tink | any `hit` param; `note` tunes it |
| `hit` | a struck object | the hit | `material` wood glass metal ceramic plastic card rubber, `force`, `decay`, `note` |
| `bubble` | a round, rising bloop with the pop of the surface | the pop | `bubbles` (a cluster over `dur`), `rise`, `ring` |
| `snap` | magnetic snap: a tiny pull, a hard click, a dead stop | the click | `pull` 0.06 s |
| `lock` | the lock-in when something falls into place: slide, latch, settle, a small glassy "yes" | the latch | `slide` 0.16 s, `ring` 0..1, `note` |
| `mallet` | a tuned bell, bar or chime struck with a soft felt mallet: a rounded swell, no click, a long ring with the upper partials dying first, a small soft room | the strike | `body` bell bar chime, `note`, `ring` (longer), `bright` (a harder mallet), `notes` (a run) |
| `scratch` | one quick pencil stroke, a tick mark | the start | as `scribble` |
| `scribble` | pencil on paper, strokes back and forth | the start | `tool` pencil crayon marker chalk, `dur`, `strokes`/s, `press` |
| `slide` | a sheet or piece slid gently across a table: a soft, quiet breath | where it stops | `material` paper card wood, `dur` |
| `flip` | page flip (paper) or card flip (card) | the landing | `material`, `dur` |
| `deal` | a card dealt: out of the deck, swish, slap | the landing | `surface` felt table, `fly` |
| `stamp` | rubber stamp thunk, then the tacky peel | the contact | `peel` 0..1, `hold` s, `force` |
| `squish` | wet ink squish with tiny bubbles | the press | `wet` 0..1, `dur` |
| `ruffle` | cloth moving | the start | `material` cotton linen silk canvas, `dur`, `density` |
| `crunch` | paper ball, leaves, a biscuit | the bite | `dry` 0..1 (brittle), `dur` |
| `tear` | paper torn: a page torn out, a ticket torn off | the start | `dur` 0.25 s |
| `pour` | pour and fill, the pitch climbing as it fills | full | `dur` 1.8, `fill` 0..0.95 |

**Params every sound takes:** `size` (1 = as designed; 2 = twice as big, lower and longer), `pitch`
(semitones: the struck and tonal sounds, from `tick` to `lock` in the table, retune their resonances; the
textures, from `scratch` to `pour`, play faster or slower like tape, so up is also a little shorter and its
hit a little sooner), `bright` (0..1, 0.5 = as designed), `room` (0..1 of close early reflections, 0.2), `pan`
(-1..1), `vol`, `force` (how hard, where it applies) and `seed` (the same seed is the same sound; another
seed is another take). Repeats: `count`, `every` (s apart), `step` (semitones each) and `fade` (gain each),
for example `{ count: 3, every: 0.22 }` deals three cards. Tonal sounds take `note: 'E6'`, so they can sit
in the key of a beat, and `notes` plays a run, one take per note, `every` s apart:
`{ notes: ['C6', 'D6', 'F6', 'G6', 'A6'], every: 0.05 }` is a pentatonic glissando.

**The mallet: an app that plays like an instrument.** `mallet` is the kit's tuned voice, for an app where every
action is a note (a drop, a step, a word landing). Its `body` sets the partials: `bell` is a bronze bell's hum, prime,
minor third, fifth and octave, with a slow warble; `bar` is a vibraphone or marimba bar (1 : 4 : 10), the plainest
and most melodic; `chime` is a hanging tube (1 : 2.76 : 5.40 : 8.93), the brightest. A felt mallet swells in over 8 ms
(`bright` 0 to 1 takes it from 13 to 3 ms and strikes the upper partials harder), and `room` adds a small, soft tail
to the kit's early reflections. Keep an app's notes on one pentatonic scale, a bigger thing a lower note, so anything
a customer does sounds musical. A cold take renders on the main thread in about 15 ms (a bar) to 50 ms (a bell):
warm the notes an app plays in idle time.

**Make it yours.** The kit is a set of ingredients, not a house sound: products should sound as different as they
look. Start from what your product's moments should feel like, then pick or make the sounds: the kit's, tuned to a
size, pitch and brightness of their own, or sounds of your own (`SOUNDS.x = …`, or a WAV cue in the film). A company
that wants a house sound, every sound in one key and tuned per product, builds a palette on `shared/sound/` (its
README); a product can still leave it.
What makes it satisfying:

- **Anticipation, then a clean stop.** A short lead-in (a slide, a pull) into a crisp hit, then silence.
  `lock`, `snap`, `stamp` and `flip` are built that way; their `hit` is the moment to sync the visual to.
- **Physical, not beeps.** Pick the material that's on screen; keep the room small and close.
- **Never the same twice.** Vary the seed, a little pitch and level (the browser player does it for you).
- **Rising runs.** Repeated actions (words landing, cards dealt, items filling up) climb in pitch: `step`.
- **One hero.** The screen-record moment gets the richest sound, often one made for it alone.
- **Never harsh.** Catching the ear is fine; grating isn't. See below.

Node: `import { render } from './foley.js'`, then `render('stamp', { size: 1.2, seed: 3 }, 44100)` gives
`{ L, R, hit, sr }` (Float32Arrays). To audition one: `node shared/demo/synth.mjs --sfx stamp out.wav --size 1.2`.

## Never harsh: harsh.mjs

A sound may stand out, but it must never grate. Measured against real
recordings of paper slid gently across a table (fine) and a cardboard box dragged over concrete (grating), what grates
is not brightness: real paper is the brighter one. It is **weight** under 500 Hz on a moving thing, **judder** (the
level shaking 15 to 150 times a second, like stick-slip or a fast "tooth" on the noise), **crackle** (clicks standing out
of a rub), a **squeal** (a narrow resonance in noise) and, past the brightest real paper, **sharpness**.

```sh
node shared/demo/harsh.mjs           # every foley.js sound, material and tool, every cue the deck plays and synth.mjs's effects, against their bars, then what the company's products play
node shared/demo/harsh.mjs --products calls.mjs sound.mjs   # only these files: an app's calls, an ad's timeline
node shared/demo/harsh.mjs x.wav     # a recording or a track: as a whole, then its sharpest 0.4 s windows
```

Each sound is held to the bars of its kind: a **glide** (anything that moves: a slide with its stop, a whoosh, the
lead-in of a flip, a deal or a lock) must be light and smooth like the paper; a **texture** (pencil, cloth, ink, and
every noise sound as a whole) may have more grit; a **crunch** and a **tone** (struck and tuned sounds) are held to their
brightness only, and a **string** (a plucked `guitar` or `pluck` note) to its **twang**: the energy above six times its
pitch (1 kHz at least), at most -16 dB of the note (the plain Karplus-Strong string reads -1 to -3 on a low note, the warm string -20 or less). The
gate plays those presets from C1 to C6, at their brightness and at `bright: 1`, and every bed track a product's timeline
plays on one, every note it plays at full velocity. Every take the kit can play is measured on its own (the player's four seeds, at 44.1 and 48 kHz, each
played as the player plays it at five points across its ±0.4 semitone vary) and the worst one counts: an average lets a
harsh take through, and a sound on the bar at pitch 0 can go over it 0.2 semitones down. `foley-check.mjs` fails if
any take misses its bars, or if a noise sound made `bright: 1` and an octave up passes the sharpness bar. mix.mjs
reports the sharpest moment of every track it masters.

**What the products play, as they play it.** The kit's own list can't know a product's params (a small page flip
pitched up six semitones, played by an app's replay), so the gate also holds the files a company names in
`company/sounds.json` (`{ "sounds": [paths or globs from the repository's root] }`):

- an **app's calls**: a module exporting `calls`, `[label, sound, params]` for every call its player can make, over every
  value a param reaches (a replay's step, a letter). Each is measured on every take the player can play, like the kit's
  own. Build the list from the app's own sound code, so it can't drift from what the app plays.
- a **mix.mjs timeline** (an ad, a phone clip's sound): each foley.js cue as mix.mjs renders it, the one take the film
  plays (`calls(spec)` in mix.mjs gives each cue's sound and params with its seed).

A run (`count` > 1) is held sound by sound, as foley.js plays it (the next seed, `step` semitones up): clicks in a row
are a rhythm, and read as crackle and judder by design.

A product's sounds of its own (added to `SOUNDS`, a trailer's instruments ported) are held the same way, once its
calls file registers them as the app does (a name it can't play stops the gate). Each is held as the kind its entry
names (`kind`: `'tone'` for a struck sound that isn't tuned, `'crunch'`, or `'glide'`, held whole), else a `tuned` one
as a tone and any other as a texture; then again as its entry's `also` asks: `'glide'` for a movement (held whole),
`'lead-in'` for a movement up to its hit (a whoosh into a landing), `'string'` for a plucked note (its pitch from the
entry's `f0(params)`). A take of one that is silent (peaking at 0.002 or less), not finite or past 0 dBFS misses as a
`take`. foley-check runs this last; without a `company/sounds.json` there's nothing to add.

**Judder needs a steady stretch.** It's measured where the level holds within 4 dB for 80 ms, longer than the slowest
judder's cycle; a shorter sound reads 0 (it can't shake; crackle, squeal and the rest still hold it). With 60 ms, a short
sound's shape passed as steady: the dip between a page's lift and its flutter read as judder 50 to 80, and real paper
flicks and page turns read anything from 0 to 129.

What keeps the kit soft, and what a sound of your own should do too:

- **A movement stays light:** cut its noise under about 500 Hz (`floor`), and land it with a light stop, not a thud.
- **A movement is a soft breath, well under the hits:** light but bright noise still grated next to the dings
  (blasting, a chalkboard), so slides, swishes and flutters are `air(c, o, at, secs, hz, env)`: noise low-passed to a
  warm band (1 to 2 kHz), cut under 600 Hz, a separate breath on each side, no tooth or fibre clicks, and about 10 dB
  under a glass ding. The swish inside a sound that lands (a flip's lift and flutter, a deal's flight, a
  lock's lead-in) sits `SWISH` (10 dB) further under its landing, every breath eases in over a third of it (60 ms at
  most), and a sound that moves rolls off from 6 kHz (not 9) and eases in over 40 ms: a bright, sudden one sounds like
  someone blowing into a microphone.
- **A movement plays well under the hits** <!-- -->: a pencil across paper or a
  row of brush strokes at the level of a bell grates at full volume. Wherever the kit plays a sound (the player,
  mix.mjs, synth.mjs), one that moves plays at `MOVES` (0.125, 18 dB) of its level: the kit's own marked `moves` (`slide`,
  `scribble`, `scratch`, `ruffle`) and synth.mjs's `whoosh`, a product's own by its `kind` or `also` `'glide'`.
  `render()` leaves the level whole, so a sound built from the kit's (a slide inside a payment's chime) keeps its
  balance. A level is a peak, and a breath held at a ding's peak is far louder than the ding: mark a sound of your own
  that is mostly a breath (a paper plane's flight) `moves` too, or it plays at full level.
- **A texture fluctuates slowly:** `grain(c)(rate)` under about 20; fast grain is judder. A tooth that must be
  fast goes above the band and follows the speed: the pencil's is `grain(c)(500 + 700 * v)` (a fixed 260 read judder 40
  to 73 by stroke length). Narrow noise judders by itself (a resonant squelch), and so do short grains with gaps
  between them: put a broad layer under the one and lengthen the other. A soft onset (30 ms or more) beats a snap.
- **One movement, no gaps:** where a sound hands over from one part to the next (a page's lift to its flutter), let the
  second rise out of the first. A dip between them is a shake once the sound is short or pitched up: the page flip's
  short, lumpy lift read judder up to 79 on small, high flips.
- **Noise loses its fizz above 9 kHz:** render() rolls off every untuned sound there, so `bright` and `pitch` can't push
  it past the sharpness bar.
- **Don't darken a scrape to soften it.** A dark rub reads heavier, like the box. A 2 to 5 kHz cut does little either:
  the sound is normalised to its peak afterwards.

## In the app

Import the kit at its path in the repo: every product host serves `shared/demo/foley.js` there (infra/products.md), so
the same relative import works in the browser and in Node, and no app keeps a copy.
From `app/public/`:

```html
<button id="sound" type="button" aria-label="Sound"></button>
<script type="module">
  import { foley } from '../../../../shared/demo/foley.js';
  const sfx = foley({ key: '<slug>:sound' });  // the mute choice is kept in localStorage under this key
  sfx.bind(document.getElementById('sound'));    // the mute toggle: 🔊/🔇, aria-pressed, remembered
  document.querySelector('#make').addEventListener('click', () => sfx.play('stamp', { size: 1.1 }));
</script>
```

- **Only after a gesture.** Nothing plays (and no AudioContext exists) until the first tap or key press;
  `play()` returns `null` until then, and while muted. A classic script can load it with `import('./foley.js')`.
- **Soft.** The player's output is 0.35 by default (`foley({ volume })`) with a safety compressor. Keep it
  at or under a quiet UI click; `play(name, { vol: 0.6 })` for the small ones. No loops in an app's UI, nothing that
  keeps going.
- **Varied.** Each play takes the next of 4 takes (`variants`) and moves pitch and level by up to `vary` (0.4
  semitones/dB), so repeats never grate. The take after it renders in idle time, so only a sound's first play waits.
  Pass `seed` to pin a take.
- **In sync.** Sounds with a lead-in land their hit later: `play()` returns the seconds until the hit, so
  start the visual's landing then (or give the sound a `delay`).
- **A listening piece** (a soundboard, a scored film) that the listener starts and stops:
  - `sfx.prepare([[name, params], [name, params, { loop: true }]])` renders their first takes in idle time, before any
    tap, so the first play is instant. It resolves once they're all ready.
  - `play(name, { destination, onended })` plays into a node of the piece's own (a gain it moves), and calls
    `onended` when the sound is over.
  - `sfx.loop(name, { dur, destination })` loops a sound that takes `dur` (a bed), its last second crossfaded into its
    start, so it has no seam.
  - `sfx.stop(destination, fade)` fades out over `fade` seconds (0.1 by default) and stops everything playing or
    scheduled into that node, or every sound without one.
- The soundboard (`examples/foley.html`) is the same module in a page; `node shared/demo/foley-check.mjs`
  checks it all in Chromium: silent before a gesture, audible after, mute remembered across a reload, and
  every sound rendered sample for sample as in Node.

## In the ad: mix.mjs

```sh
node shared/demo/mix.mjs products/<slug>/ads/sound.mjs [out.wav] [--levels] [--stems] [--no-bed]
node shared/demo/ad.mjs products/<slug>/ads/ad.html      # its demo config says "audio": "sound.wav"
```

```js
export default {
  duration: 18,                                   // seconds (default: the last sound's end)
  markers: { reveal: 6.2, logo: 15 },             // named times, in seconds
  bed: { song: '../demo/beat.mjs', level: -14 },  // optional: a synth.mjs song or { wav: 'x.wav' }
  cues: [
    { t: 0.6, sound: 'scratch' },                           // the hit lands at 0.6 s
    { t: 1.2, sound: 'deal', count: 3, every: 0.2, step: 2 }, // three cards, climbing
    { at: 'reveal', sound: 'lock', note: 'F6', name: 'locked' }, // on a marker; `name` makes it one
    { at: 'reveal', offset: 0.4, sound: 'bubble', bubbles: 5, vol: 0.6, pan: 0.3 },
    { bar: 6, sound: 'stamp' }, { beat: 30.5, sound: 'tick' }, // on the bed's grid
    { t: 14.4, sound: 'whoosh', align: 'start', dur: 0.6 },     // synth.mjs SFX work too
    { t: 16, wav: 'thunk.wav', hit: 0.05, vol: 0.8 },           // any WAV: its `hit` s in lands on t
  ],
};
```

- **Any sound of our own.** `wav` (relative to the cue file) plays a sound made anywhere, by us (house rule 6): your
  own code's render, another synth, an original's audio. `hit` is the moment in it (s, default 0) that lands on the cue's time; `vol` and `pan` apply.
  harsh.mjs holds it to a texture's bars (sharpness, squeal, judder) and its loudest stretch to sharpness, a silent
  file to nothing.
- **Timing.** Each cue is placed so the sound's **hit** lands on its time (the lead-in of a `flip` or
  `lock` starts before it); `align: 'start'` starts it there instead. Times come from `t` (s), `at` (a
  marker, a bed marker or an earlier cue's `name`), `bar` or `beat` (the bed's grid), plus `offset`.
  Repeats of a sound get a new seed each time, so nothing sounds copy-pasted.
- **The bed** is any music, a synth.mjs song or a WAV: `level` sets it that many LU from the effects that don't move
  (all of them when only movements play; -12, under them, by default; 0 or more when the score carries the film), then it's ducked by every hit (`duck` 8 dB, 0 for none,
  `release` 0.3 s). Also `from`/`to`/`start` (s), `fadeIn`/`fadeOut`, `hp`/`lp` (Hz) and `loop` (automatic for
  synth.mjs beds). A quiet beat with no melody under the effects is one choice (`products/hello/demo/beat.mjs`), a
  score with a tune is another.
- **Mastering** is for TikTok/Reels: -14 LUFS integrated and a -2 dBTP ceiling, which the MP4's AAC
  (192 kbps) lifts to about -1. The effects bus gets a small room (the reverb send: `send` per cue or
  `master.send`, 0.12; every other cue param goes to the sound, so squish's `wet` is squish's) and
  parallel compression (`master.glue` 0.4, on the effects that don't move: it lifts what sits under the hits) for the
  close-up feel; the master is cut at 16 kHz before the limiter so the encoder can't push clicks over. A sparse track
  pushed to its loudness flattens its hits in the limiter and not its movements, so they gain on the hits: when
  `--levels` shows the hits limited 4 dB or more (median), master the film lower. `master: { loudness, ceiling, glue, send, reverb: { size }, hp, lp }`.
- **The app's own sounds on the recording.** record.mjs writes `<recording>.events.json` next to the MP4:
  when each tap, key, scroll and drag shows in it. Read it in the cue list and add the time the scene
  starts the clip (`data-at`), and play the same sounds with the same params as the app does:
  `const rec = JSON.parse(fs.readFileSync(new URL('../ads/<slug>-phone.events.json', import.meta.url), 'utf8'))`
  (see `products/hello/demo/sound.mjs`).
- **Scenes sync to it**: `<name>.beats.json` carries the markers, every cue (`demo.cues`: `{ t, start,
  sound, name }`) and the bed's beat grid, so `demo.marker('locked')` and `demo.beat(n)` just work.
- **Check it.** The summary line gives the loudness, how far under the effects the bed sits, and how much
  the limiter took off the hits; `--levels` lists every cue with its share. Sparse, sharp hits need a lot
  of limiting to reach -14 LUFS; past about 12 dB, turn the loudest cues down or put texture between hits.
  `--stems` writes `out.sfx.wav` and `out.bed.wav`. On the finished MP4:
  `ffmpeg -i ad.mp4 -af ebur128=peak=true -f null -` should read about -14 LUFS and a peak around -1 dBTP. The
  summary also names the sharpest moment (acum, at its time) and notes one past the bar.

**The reference.** `products/hello/ads/hello-ad.mp4` is a sound-led ad made this way: every visible action
has its own sound (`products/hello/demo/sound.mjs`, 20 cues over a quiet beat), and the scene
(`examples/hello-ad.html`) syncs to its markers. `examples/audition.mp4` plays the whole palette with the
call that makes each sound.

Known gaps: a sound is rendered once per take (a few ms, then cached), so nothing follows a gesture
continuously (the speed of a drag, say): give it a `dur` instead.

## Music: synth.mjs

An offline synth and sequencer. A song is a small JS module; rendering it writes a 44.1 kHz stereo 16-bit
WAV (mastered to -14 LUFS with a -1 dBFS peak by default) plus `<name>.beats.json` so ads can cut on the
beat. A 30 s track renders in about 4 s. Write your own melodies and chords, and never copy a real song or
imitate a living artist.

```sh
node shared/demo/synth.mjs products/<slug>/demo/music.mjs products/<slug>/demo/music.wav [--levels] [--solo bass,keys] [--mute drums]
node shared/demo/synth.mjs --sfx whoosh out.wav [--dur 0.8]   # whoosh riser pop tap click ding chime sparkle boom vinyl, or any foley.js sound
node shared/demo/synth.mjs --help                             # lists instruments, kits, drum lanes, sounds
```

Starting points in `examples/`: `lofi.mjs` (80 bpm, swung, tape wobble), `chiptune.mjs` (150 bpm,
pulse waves and LFSR drums), `pop.mjs` (124 bpm, riser into a pumping drop), `cinematic.mjs`
(70 bpm, swells and impacts). `products/hello/demo/music.mjs` is a 10 s ad track with a logo sting,
`bed.mjs` is a seamless loop bed, and `beat.mjs` is the quiet, melody-free beat under the sound-led ad.
They show what the synth can do; a song of your own from a blank file sounds like nobody else's.

## A song

```js
export default ({ voice, roots, arp, rep }) => ({
  bpm: 110, bars: 4, swing: 0.2, humanize: 0.5,  // swing delays odd 16ths (0 to 0.5)
  markers: { logo: 3 }, sections: { intro: 0, main: 1 },  // in bars; exported to beats.json in seconds
  master: { reverb: { size: 0.6 }, delay: { time: 0.75 /* beats */, fb: 0.3 }, loudness: -14 },
  tracks: [
    { name: 'keys', inst: 'epiano', step: 1, notes: voice('Cmaj7 Am7 Fmaj7 G7sus4'), reverb: 0.3 },
    { name: 'bass', inst: 'bass', step: 8, notes: 'C2 - . C3? . . G2 .', duck: 0.6 },
    { name: 'drums', kit: 'punchy', drums: { kick: 'x...x...x...x...', clap: '....x.......x...', hat: 'x.x.x.xox.x.x.xo' } },
  ],
  sfx: [{ type: 'whoosh', to: 3 }, { type: 'lock', at: 3 }],  // `to` lands the sound's peak on that bar; foley.js sounds too
});
```

**Notes:** one token per step, and `step` sets the steps per bar (16 = sixteenths, 8, 4, 1 = one
token per bar). A token can be a note (`C4`, `F#3`), a chord (`A3m7`, `C4maj9`) or a stack
(`C4+E4+B4`). `-` holds the previous note, `.` is a rest and `|` is ignored. Add `!` for an accent
and `?` for a ghost note. A pattern loops to fill the track's `from`/`to` window, given in bars.
**Drums:** one grid per lane: `X` accent, `x` hit, `o` ghost, anything else is a rest. The lanes
are kick tom snare clap hat ohat crash rim shaker cowbell block, and a trailing digit gives a second
copy (for example `tom2`). The kits are `punchy`, `808`, `lofi` and `chip`. To tweak one, write
`kit: { preset: 'lofi', kick: { tune: 48, decay: 0.5 } }`.
**Helpers:** `voice(prog, {low, rootless})` gives smooth-voice-led chord stacks. `roots(prog, oct)`
gives the bass roots. `arp(prog, {steps, order: up|down|updown|random, span})` builds arpeggios, and
`rep(s, n)` repeats a pattern.

**Instruments:** `inst` takes a preset name or an object. The presets are sine bass sub reese lead
supersaw pad glass strings brass organ chip chipsquare chipbass epiano bell mallet kalimba pluck
guitar harp. Override any field with `{ preset: 'pad', cutoff: 600 }`. The fields are
`osc` (sine saw square pulse tri tri4 organ noise), `pw`, `unison`, `detune` (cents), `spread`,
`env: [a, d, s, r]`, `cutoff`, `res`, `fenv`, `fdecay`, `track`, `sub`, `noise`, `drive`,
`vib: [rate, cents, delay]`, `oct`, `gain`, FM `fm: {ratio, index, decay, ratio2, index2, decay2}`
and Karplus-Strong `type: 'pluck'` with `bright` and `decay` (plus `warm: true`, below).

**Plucked strings: warm, never tinny**. The plain Karplus-Strong string rings every
harmonic up to 5 kHz for seconds, so half a low note's energy sits above 1 kHz and its fundamental well under it: tinny.
`guitar` and `pluck` play a warm string (`warm: true`): a finger rather than a pick (a soft, rounded excitation), a 6 ms
onset and a lowpass that opens to a few harmonics and closes on the lower ones within 0.1 s. A bass note's centroid is
about 0.2 kHz, its 1-2.5 kHz band about -36 dB. `bright` still moves it, within that warm range. `harp` keeps the bright
ring. A song written for the plain string changes on a re-render: its bass is warmer and more of it sits under 150 Hz,
where a phone or tablet speaker plays little, so there it reads softer. `harsh.mjs` holds it (a **string**'s twang, above).

**Track mix:** `vol`, `pan`, `reverb` and `delay` (send amounts), `duck` (sidechain from every kick),
`hp`/`lp` in Hz, `drive`, `crush: {bits, rate}`, `gate`, `strum` (seconds between chord notes),
`width` (chord spread), `transpose`. `vol`, `hp` and `lp` also accept `[from, to]`, which ramps
across the track's window for fade-ins and filter sweeps. **Master:** `reverb {size, damp, predelay}`,
`delay {time, fb, lp, pingpong}`, `lofi {wow, flutter, hiss, crackle}`, `lp`, `hp`, `width`,
`loudness` (LUFS), `ceiling` (dBFS) and `duckRelease` (beats). With `loop: true` the tail wraps to
the start for a seamless loop bed.

## beats.json

```json
{"bpm":120,"beatsPerBar":4,"duration":9.9,"musicEnd":9.5,"tail":0.4,"loop":false,
 "beats":[0,0.5,...],"bars":[0,2,4,6,8],"markers":[{"t":8,"name":"logo"}],"sections":[{"name":"intro","start":0,"end":2}]}
```
All times are in seconds from the start of the WAV. `shared/demo/ad.mjs` loads it automatically as
`window.demo.beats`. A mix.mjs track's beats.json also lists every sound under `cues`
(`[{"t":1.2,"start":1.05,"sound":"flip","name":"page"}]`, `t` being its hit), exposed as `demo.cues`.

## Mixing checks

`--levels` prints each track's energy relative to the whole mix. Aim for bass and drums around -4
to -7 dB and the lead a little below. To check the result:
`ffmpeg -i x.wav -af ebur128=peak=true -f null -` for loudness and
`ffmpeg -i x.wav -lavfi showspectrumpic=s=800x400 spec.png` for a spectrogram.

Known gaps: no automation beyond linear ramps, no glide or portamento, no tempo changes, and the
reverb is a Freeverb (good enough for ads, not for a concert hall). Library use:
`import { render, renderSfx, readWav, writeWav } from './synth.mjs'`.
