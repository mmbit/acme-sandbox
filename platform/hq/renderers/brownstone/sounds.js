// The brownstone's sounds: the chiptune, its sounds and its music.
import { tone, noise, note, strike } from '../../shell/audio.js';
import { ring, micOn, micOff } from '../../shell/desksounds.js';

export const sfx = {
  blip: () => tone(note(84), 0.06, { vol: 0.08 }),
  open: () => {
    tone(note(76), 0.07, { vol: 0.09 });
    tone(note(83), 0.1, { vol: 0.09, at: 0.06 });
  },
  close: () => {
    tone(note(79), 0.07, { vol: 0.07 });
    tone(note(72), 0.1, { vol: 0.07, at: 0.06 });
  },
  tick: () => noise(0.02, { vol: 0.05, freq: 3000 + Math.random() * 3000 }),
  pop: () => tone(note(72), 0.08, { type: 'triangle', vol: 0.12, slide: 2 }),
  whoosh: () => {
    noise(0.35, { vol: 0.08, freq: 1200 });
    tone(note(67), 0.3, { type: 'sine', vol: 0.05, slide: 1.8 });
  },
  jingle: () =>
    [72, 76, 79, 84, 88].forEach((n, i) => {
      tone(note(n), 0.18, { at: i * 0.09, vol: 0.1 });
      tone(note(n + 12), 0.1, { type: 'triangle', at: i * 0.09 + 0.04, vol: 0.05 });
    }),
  ding: (v = 1) => {
    tone(note(93), 0.9, { type: 'sine', vol: 0.18 * v });
    tone(note(105), 0.5, { type: 'sine', vol: 0.05 * v });
  },
  meow: () => {
    tone(note(79), 0.35, { type: 'sawtooth', vol: 0.05, slide: 1.35 });
    tone(note(83), 0.25, { type: 'triangle', vol: 0.08, at: 0.2, slide: 0.7 });
  },
  fanfare: () =>
    [60, 64, 67, 72, 67, 72, 76, 79].forEach((n, i) =>
      tone(note(n + 12), 0.16, { at: i * 0.11, vol: 0.1, type: i % 2 ? 'square' : 'triangle' }),
    ),
  // a firework far over the skyline: a muffled thump, then a soft crackle
  boom: () => {
    tone(note(40), 0.5, { type: 'sine', vol: 0.025, slide: 0.6 });
    noise(0.5, { vol: 0.02, freq: 400, type: 'lowpass' });
    for (let i = 0; i < 18; i++)
      noise(0.02, {
        vol: 0.006 + Math.random() * 0.014,
        at: 0.25 + Math.random() ** 1.5 * 1.1,
        freq: 1500 + Math.random() * 3500,
      });
  },
  rewind: () => tone(note(60), 0.6, { vol: 0.06, slide: 4 }),
  thump: n => {
    tone(note(40 + n * 3), 0.18, { type: 'triangle', vol: 0.28, slide: 0.5 });
    noise(0.08, { vol: 0.06, freq: 300, type: 'lowpass' });
  },
  // the delivery van: a soft electric whirr that winds down as it pulls in, and up as it leaves
  whirr: (up = false) =>
    tone(up ? 70 : 140, 2.4, { type: 'triangle', vol: 0.035, attack: 0.96, slide: up ? 150 / 70 : 60 / 140, cut: 500 }),
  honk: () => {
    tone(note(62), 0.28, { type: 'sawtooth', vol: 0.06 });
    tone(note(66), 0.28, { type: 'sawtooth', vol: 0.05 });
    tone(note(62), 0.2, { type: 'sawtooth', vol: 0.06, at: 0.34 });
  },
  // two quick squeaks and a longer one falling away, softened so they chirp rather than buzz
  squawk: () =>
    [
      [86, 0, 1.3],
      [88, 0.11, 1.3],
      [91, 0.22, 0.7],
    ].forEach(([n, at, slide], i) => tone(note(n), i < 2 ? 0.09 : 0.24, { vol: 0.05, cut: 2600, at, slide })),
  quack: () => {
    tone(note(58), 0.14, { type: 'sawtooth', vol: 0.07, slide: 0.8 });
    tone(note(57), 0.16, { type: 'sawtooth', vol: 0.06, at: 0.18, slide: 0.75 });
  },
  blub: () =>
    [0, 0.09, 0.2, 0.28].forEach((at, i) => tone(note(60 + i * 5), 0.09, { type: 'sine', vol: 0.12, at, slide: 2.2 })),
  chirp: () => {
    const b = 94 + Math.random() * 6;
    [0, 0.12, 0.2].forEach((at, i) => tone(note(b + (i % 2) * 3), 0.07, { type: 'sine', vol: 0.025, at, slide: 1.25 }));
  },
  flap: () => noise(0.25, { vol: 0.05, freq: 900 }),
  ring,
  twinkle: () => [96, 100, 103, 108].forEach((n, i) => tone(note(n), 0.25, { type: 'sine', vol: 0.06, at: i * 0.07 })),
  // a call minimised into its bubble: a soft whoop falling away as it shrinks; opened again, rising; the bubble
  // settling into a corner, a little bump
  minimise: () => {
    tone(note(81), 0.16, { type: 'triangle', vol: 0.08, slide: 0.5 });
    tone(note(88), 0.08, { type: 'square', vol: 0.035, at: 0.02, slide: 0.6 });
  },
  restore: () => {
    tone(note(69), 0.16, { type: 'triangle', vol: 0.08, slide: 2 });
    tone(note(76), 0.08, { type: 'square', vol: 0.035, at: 0.06, slide: 1.6 });
  },
  dock: () => {
    tone(note(64), 0.07, { type: 'triangle', vol: 0.1, slide: 0.8 });
    noise(0.03, { vol: 0.03, freq: 900, type: 'lowpass' });
  },
  // a call watched back (callplayer.js): a tape deck's key going down and two notes stepping up to play, down to pause;
  // a jump, a quick glide; the scrubber crossing a moment, the faintest tick
  watchPlay: () => {
    noise(0.02, { vol: 0.035, freq: 1800 });
    tone(note(72), 0.05, { vol: 0.06, at: 0.012 });
    tone(note(79), 0.08, { vol: 0.06, at: 0.06 });
  },
  watchPause: () => {
    noise(0.02, { vol: 0.035, freq: 1500 });
    tone(note(79), 0.05, { type: 'triangle', vol: 0.08, at: 0.012 });
    tone(note(72), 0.08, { type: 'triangle', vol: 0.08, at: 0.06 });
  },
  watchJump: () => tone(note(76), 0.07, { type: 'triangle', vol: 0.07, slide: 1.5 }),
  watchTick: () => noise(0.012, { vol: 0.022, freq: 5200 }),
  // the intercom's mic (desksounds.js)
  micOn,
  micOff,
  // a switch in Settings flicked: a tiny click, then two notes stepping up for on, down for off
  toggle: (on = true) => {
    noise(0.015, { vol: 0.04, freq: 4000 });
    tone(note(on ? 79 : 84), 0.05, { vol: 0.07, at: 0.01 });
    tone(note(on ? 86 : 77), 0.07, { vol: 0.07, at: 0.05 });
  },
  // a big key swiped on to the next, and turned over
  swipe: () => noise(0.12, { vol: 0.05, freq: 2200 }),
  flip: () => {
    noise(0.06, { vol: 0.05, freq: 1600 });
    tone(note(76), 0.06, { vol: 0.06, at: 0.05 });
  },
  // a key dropping onto a table (v: how hard, p: semitones up), a key pressed, and one settling.
  clack: (v = 1, p = 0) => {
    noise(0.03, { vol: 0.06 * v, freq: 1400 + p * 60 });
    tone(note(60 + p), 0.05, { type: 'triangle', vol: 0.1 * v, slide: 0.7 });
  },
  press: () => {
    noise(0.02, { vol: 0.05, freq: 2400 });
    tone(note(67), 0.04, { type: 'triangle', vol: 0.08 });
  },
  land: () => tone(note(79), 0.05, { type: 'triangle', vol: 0.06 }),
  // a cocktail shaken for dur s from at: ice rattling in a tin, seven strokes a second, each a tumble of small clicks
  // and a soft knock at its end
  shake: (at = 0, dur = 1.1) => {
    for (let s = 0; s < dur - 0.05; s += 1 / 7) {
      noise(0.03, { vol: 0.05, freq: 900, q: 1.2, at: at + s });
      for (let i = 0; i < 4; i++)
        noise(0.012 + Math.random() * 0.01, {
          vol: 0.025 + Math.random() * 0.03,
          freq: 2800 + Math.random() * 2600,
          q: 3,
          at: at + s + 0.01 + Math.random() * 0.05,
        });
    }
  },
  // then served: a pour for pour s, the glass slid along the wood for slide s, and a glassy tink where it stops
  serve: (at = 0, pour = 0.35, slide = 0.55) => {
    noise(pour, { vol: 0.02, freq: 1700, q: 2.5, sweep: 1.35, attack: 0.04, at });
    [0.06, 0.17, 0.26].forEach((b, i) =>
      tone(note(86 + i * 2), 0.05, { type: 'sine', vol: 0.02, slide: 1.5, at: at + b }),
    );
    noise(slide, { vol: 0.04, freq: 1300, q: 0.9, sweep: 0.7, attack: 0.06, at: at + pour });
    strike(
      note(96),
      0.6,
      [
        [1, 1],
        [2.32, 0.4],
      ],
      { vol: 0.045, at: at + pour + slide },
    );
    tone(note(108), 0.2, { type: 'sine', vol: 0.02, at: at + pour + slide + 0.1 });
  },
};

// ---- the music: an I-vi-IV-V loop, a B section (IV-V-iii-vi) and an arpeggio bridge, in eighth notes at 92 bpm, a
// little slower and softer in the rain, with a faint twinkle on top when it snows
const CHORDS = [
  [60, 64, 67],
  [57, 60, 64],
  [53, 57, 60],
  [55, 59, 62],
];
const CHORDS_B = [
  [53, 57, 60],
  [55, 59, 62],
  [52, 55, 59],
  [57, 60, 64],
];
const MELODY = [0, -1, 2, 1, -1, 0, 2, -1, 1, 2, -1, 0, 1, -1, 3, -1];
const MELODY_B = [2, -1, 1, 0, 2, -1, 3, -1, 1, 0, -1, 2, 0, -1, -1, -1];
export const score = {
  step: ({ rain }) => 60 / (92 - 6 * rain) / 2,
  play(step, at, { bus, rain, snow, holidays }) {
    const spb = score.step({ rain }),
      hush = 1 - 0.6 * rain,
      december = holidays.has('sinterklaas') || holidays.has('christmas');
    const section = (step >> 6) % 3,
      B = section === 2,
      bar = (step >> 3) % 4,
      ch = (B ? CHORDS_B : CHORDS)[bar],
      s = step % 8;
    if (holidays.has('halloween')) hauntedBass(step, s, ch[0], at, spb, bus);
    else if (s % 4 === 0) tone(note(ch[0] - 24), spb * 3.5, { type: 'triangle', vol: 0.5, at, bus });
    tone(note(ch[(B ? s : s % 3) % 3] + 12 + (B && s > 3 ? 12 : 0)), spb * 0.6, { vol: 0.12, at, bus });
    const mel = B ? MELODY_B : MELODY,
      m = mel[(step + bar * 3) % 16];
    if (m >= 0 && (section === 1 || B))
      tone(note(ch[m % 3] + 24 + (m === 3 ? 12 : 0)), spb * 1.4, { type: 'triangle', vol: 0.35, at, bus });
    if (s % 2 === 1) noise(0.03, { vol: 0.12 * hush, at, freq: 8000, bus });
    if (s === 4 && section > 0) noise(0.09, { vol: 0.1 * hush, at, freq: 1800, bus });
    if (snow > 0.3 && s === 6 && bar % 2 === 0)
      tone(note(ch[(step >> 3) % 3] + 36), spb * 2, { type: 'sine', vol: 0.06 * snow, at, bus });
    if (december && (s % 2 === 0 || s % 4 === 3)) sleighBells(s, ch[s % 3] + 36, at, spb, hush, bus);
  },
};
// Halloween's bass walks the root, its fifth and the root again, all in the chord, then creeps in from a semitone
// above the next bar's root and slides down onto it: one dark note a bar, on its weakest beat, and it always lands
function hauntedBass(step, s, root, at, spb, bus) {
  if (s % 2) return;
  const next = step + 8 - s,
    nextRoot = ((next >> 6) % 3 === 2 ? CHORDS_B : CHORDS)[(next >> 3) % 4][0];
  const from = note((s === 6 ? nextRoot + 1 : root + [0, 7, 0][s / 2]) - 24);
  tone(from, spb * 1.9, { type: 'triangle', vol: 0.4, at, slide: s === 6 ? note(nextRoot - 24) / from : 0, bus });
}
// December's sleigh bells: a shake of three tiny jingles on each beat, and a softer, swung one at the end of each half bar
function sleighBells(s, ringNote, at, spb, hush, bus) {
  const beat = s % 2 === 0,
    t = at + (beat ? 0 : spb / 3),
    vol = (beat ? 0.08 : 0.045) * hush;
  [0, 0.011, 0.026].forEach((d, i) => noise(0.06 - i * 0.015, { vol, at: t + d, freq: 4500, bus }));
  if (beat) tone(note(ringNote), 0.15, { type: 'sine', vol: vol * 0.35, at: t, bus });
}
