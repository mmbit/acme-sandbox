// Wire's sounds: a crisp dry switch, like a key pressed (the platform's sound kit, /foley.js: the same click, a
// bigger key the deeper), never a ding; the creatures' own calls; and its own music: a slow, warm loop under the sound of
// work being done (see score).
import { tone, noise, note, strike, sample } from '../../shell/audio.js';

const WOOD = [
  [1, 1],
  [3.9, 0.18],
  [9.2, 0.04],
]; // a soft wooden key's
const key = (n, dur, o) => strike(note(n), dur, WOOD, { vol: 0.08, cut: 2600, ...o });

// A sound of the kit, rendered once per take (four takes each, picked at random, so repeats don't grate). Silent until
// the kit has loaded, and without it.
const kit = import('../../foley.js').catch(() => null),
  takes = new Map();
function foley(name, params = {}, { vol = 1, at = 0 } = {}) {
  kit.then(k => {
    if (!k) return;
    const look = `${name}${JSON.stringify(params)}#${1 + Math.floor(Math.random() * 4)}`;
    if (!takes.has(look)) takes.set(look, k.render(name, { ...params, seed: Number(look.at(-1)) }));
    sample(takes.get(look), { vol: vol * 0.5, at });
  });
}
const click = (size, pitch = 0, vol = 1) => foley('switch', { size, pitch }, { vol });

export const sfx = {
  blip: () => click(0.9, 2, 0.8),
  open: () => click(1.2),
  close: () => click(1.1, -2),
  pop: () => click(1.3, -3),
  // a step lands on the key in focus: the faintest click
  tick: () => click(0.6, 5, 0.3),
  whoosh: () => click(0.7, 5, 0.6), // (the tour's next key: a swipe's tink)
  jingle: () => foley('mallet', { body: 'chime', notes: ['C6', 'E6', 'G6'] }, { vol: 0.5 }),
  ding: (v = 1) => foley('mallet', { body: 'bell', note: 'E6' }, { vol: 0.5 * v }),
  meow: () => {
    tone(note(79), 0.3, { type: 'sine', vol: 0.05, slide: 1.35, attack: 0.02 });
    tone(note(83), 0.25, { type: 'sine', vol: 0.06, at: 0.2, slide: 0.7 });
  },
  squawk: () =>
    [86, 88, 91].forEach((n, i) =>
      tone(note(n), i < 2 ? 0.08 : 0.22, { type: 'sine', vol: 0.06, at: i * 0.11, slide: i < 2 ? 1.4 : 0.7 }),
    ),
  twinkle: () => foley('mallet', { body: 'chime', notes: ['E6', 'G6', 'B6'] }, { vol: 0.4 }),
  // Wire's own, played by its scene: a key dropping onto the board (v: how hard; p: semitones, so a row of them isn't
  // one note), a key pressed, the big key turned over, a message landing on a key
  clack: (v = 1, p = 0) => foley('clack', { hold: 0, size: 1.2, pitch: p - 4 }, { vol: v }),
  press: () => click(1.1),
  flip: () => {
    click(1, 2, 0.8);
    foley('flip', { material: 'card' }, { vol: 0.35 });
  },
  land: () => click(0.8, 3, 0.6),
  // a switch in Settings: a ceramic rocker, the knob seating with a firmer click going on than coming off
  toggle: (on = true) => {
    click(0.8, 4, 0.5);
    foley('switch', { size: on ? 1.2 : 1, pitch: on ? 0 : -3 }, { at: 0.045 });
  },
  swipe: () => click(0.7, 5, 0.6),
};
// ---- the score: four warm chords in F, eight seconds each, half a minute round. Soft electric-piano chords (two sines
// a few cents apart per note, either side) bloom on each chord and ring on into the next; wooden keys pick out a few of
// its notes, never on a grid you could tap to; underneath, now and then, the quiet click of keys, as of someone typing.
const STEP_S = 0.25,
  CHORD_STEPS = 32;
const CHORDS = [
  // [bass, chord, melody notes]
  [41, [57, 60, 64, 65], [72, 76, 77, 81]], // Fmaj7
  [45, [57, 60, 64, 67], [72, 76, 79, 81]], // Am7
  [38, [57, 60, 62, 65], [69, 72, 74, 77]], // Dm9
  [46, [58, 62, 65, 69], [70, 74, 77, 81]], // B♭maj7
];
const KEYS = [
  [
    [3, 0],
    [9, 2],
    [14, 3],
    [22, 1],
  ],
  [
    [5, 1],
    [11, 3],
    [18, 2],
    [26, 0],
  ],
];
const rhodes = (n, dur, at, bus, level = 1) =>
  [-1, 1].forEach(r =>
    tone(note(n) * (1 + r * 0.0025), dur, { type: 'sine', vol: 0.05 * level, attack: 0.03, pan: r * 0.4, at, bus }),
  );
export const score = {
  step: STEP_S,
  play(step, at, { bus, rain }) {
    const s = step % (CHORD_STEPS * CHORDS.length),
      c = Math.floor(s / CHORD_STEPS),
      k = s % CHORD_STEPS,
      [bass, chord, tune] = CHORDS[c];
    const hush = 1 - 0.4 * rain;
    if (k === 0) {
      for (const n of chord) rhodes(n, 12, at, bus);
      tone(note(bass), 10, { type: 'sine', vol: 0.12, attack: 1.5, at, bus });
    }
    if (k === 16) for (const n of chord.slice(1)) rhodes(n, 8, at, bus, 0.5);
    for (const [when, i] of KEYS[c % 2])
      if (k === when) key(tune[i], 1.6, { vol: 0.06 * hush, at, pan: i % 2 ? 0.3 : -0.3, bus });
    // the typing: a few soft clicks in a run, now and then
    if (k % 8 === 6 && Math.random() < 0.5)
      for (let i = 0; i < 3 + Math.floor(Math.random() * 4); i++)
        noise(0.02, {
          vol: 0.008 * hush,
          freq: 2800 + Math.random() * 1200,
          q: 1.5,
          type: 'bandpass',
          at: at + i * (0.07 + Math.random() * 0.06),
          bus,
        });
  },
};
