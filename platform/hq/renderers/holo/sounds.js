// The holo deck's sounds: soft digital chirps, filtered sweeps, sub-bass thumps and shimmering confirms (the chiptune
// plays the rest), and its own music: an ethereal score (see score).
import { tone, noise, note, strike } from '../../shell/audio.js';

const chirp = (n, dur, o) => tone(note(n), dur, { type: 'sine', vol: 0.09, slide: 1.25, attack: 0.004, ...o }); // a pure tone gliding up
const shimmer = (n, dur, o) => [1, 1.006].forEach(r => tone(note(n) * r, dur, { type: 'sine', vol: 0.06, attack: 0.01, ...o })); // two sines a few cents apart, beating
const sweep = o => noise(0.3, { vol: 0.05, freq: 500, sweep: 6, q: 5, attack: 0.08, ...o }); // a resonant filter opening on noise
const sub = (n, o) => tone(note(n), 0.35, { type: 'sine', vol: 0.32, slide: 0.5, ...o });

export const sfx = {
  blip: () => chirp(86, 0.05),
  open: () => { sweep({ vol: 0.04 }); chirp(79, 0.06); chirp(86, 0.08, { at: 0.06 }); },
  close: () => { sweep({ vol: 0.04, freq: 3000, sweep: 1 / 6 }); chirp(84, 0.06, { slide: 0.8 }); chirp(77, 0.08, { slide: 0.8, at: 0.06 }); },
  tick: () => tone(note(98), 0.012, { type: 'sine', vol: 0.025, attack: 0.002 }),
  pop: () => { chirp(79, 0.08, { vol: 0.13, slide: 2 }); sub(43, { vol: 0.06 }); },
  whoosh: () => { noise(0.5, { vol: 0.07, freq: 300, sweep: 8, q: 3, attack: 0.2 }); tone(note(55), 0.45, { type: 'sine', vol: 0.04, slide: 2 }); },
  jingle: () => [72, 76, 79, 84, 88].forEach((n, i) => shimmer(n, 0.35, { vol: 0.055, at: i * 0.09 })),
  ding: (v = 1) => shimmer(88, 1, { vol: 0.1 * v }),
  meow: () => { chirp(79, 0.3, { vol: 0.05, slide: 1.35 }); chirp(83, 0.25, { vol: 0.06, at: 0.2, slide: 0.7 }); },
  squawk: () => { chirp(86, 0.08, { vol: 0.07, slide: 1.4 }); chirp(88, 0.08, { vol: 0.07, at: 0.11, slide: 1.4 }); chirp(91, 0.22, { vol: 0.07, at: 0.22, slide: 0.7 }); },
  fanfare: () => { [72, 76, 79, 84, 79, 84, 88, 91].forEach((n, i) => shimmer(n, 0.25, { vol: 0.04, at: i * 0.11 })); sub(36, { vol: 0.08, at: 0.88 }); [84, 88, 91].forEach(n => shimmer(n, 1, { vol: 0.02, at: 0.88 })); },
  // a firework over the deck: a sub-bass thump, a sweep falling away, a few glints
  boom: () => { sub(28, { vol: 0.035, slide: 0.6 }); sweep({ vol: 0.015, freq: 2000, sweep: 0.2, at: 0.1 }); for (let i = 0; i < 8; i++) chirp(96 + Math.random() * 8, 0.04, { vol: 0.004 + Math.random() * 0.008, at: 0.25 + Math.random() ** 1.5 * 1.1 }); },
  rewind: () => { tone(note(60), 0.6, { type: 'sine', vol: 0.08, slide: 4 }); noise(0.6, { vol: 0.03, freq: 400, sweep: 8, q: 4 }); },
  thump: n => { sub(31 + n * 2, { vol: 0.26 }); noise(0.06, { vol: 0.04, freq: 200, type: 'lowpass' }); },
  whirr: (up = false) => { tone(note(up ? 36 : 43), 2.4, { type: 'sawtooth', cut: 500, vol: 0.04, slide: up ? 2 : 0.5, attack: 1 }); noise(2.4, { vol: 0.015, freq: up ? 400 : 1600, sweep: up ? 4 : 0.25, q: 4, attack: 1 }); },
  honk: () => { tone(note(62), 0.28, { type: 'sawtooth', vol: 0.045, cut: 900 }); tone(note(62) * 1.006, 0.28, { type: 'sawtooth', vol: 0.04, cut: 900 }); tone(note(62), 0.2, { type: 'sawtooth', vol: 0.045, cut: 900, at: 0.34 }); },
  ring: () => [0, 0.18, 0.5, 0.68].forEach(at => [0, 0.04, 0.08].forEach((d, i) => chirp(88 + (i % 2) * 5, 0.04, { vol: 0.075, slide: 0, at: at + d }))),
  twinkle: () => [91, 95, 98, 103].forEach((n, i) => shimmer(n, 0.3, { vol: 0.035, at: i * 0.07 })),
  micOn: () => { sweep({ vol: 0.03 }); chirp(79, 0.07, { at: 0.02 }); chirp(86, 0.1, { at: 0.08 }); },
  micOff: () => { chirp(86, 0.07, { slide: 0.8 }); chirp(79, 0.12, { slide: 0.8, at: 0.06 }); sweep({ vol: 0.025, freq: 3000, sweep: 1 / 6, at: 0.1 }); },
  // a call minimised into its bubble: a sweep closing on a falling chirp; opened again, opening on a rising one; the
  // bubble settling into a corner, a sub's soft knock under a glint
  minimise: () => { sweep({ vol: 0.03, freq: 2600, sweep: 1 / 5 }); chirp(88, 0.12, { slide: 0.6 }); },
  restore: () => { sweep({ vol: 0.03 }); chirp(76, 0.12, { slide: 1.6 }); },
  dock: () => { sub(40, { vol: 0.08 }); chirp(93, 0.04, { vol: 0.04, slide: 1 }); },
  // a call watched back: play, a sweep opening on two chirps climbing; pause, closing on two falling; a jump, a glint
  // gliding; the scrubber crossing a moment, a pin of light
  watchPlay: () => { sweep({ vol: 0.02 }); chirp(79, 0.05); chirp(86, 0.07, { at: 0.05 }); },
  watchPause: () => { sweep({ vol: 0.02, freq: 2600, sweep: 1 / 5 }); chirp(86, 0.05, { slide: 0.8 }); chirp(79, 0.07, { slide: 0.8, at: 0.05 }); },
  watchJump: () => chirp(91, 0.05, { vol: 0.06, slide: 1.4 }),
  watchTick: () => tone(note(100), 0.01, { type: 'sine', vol: 0.018, attack: 0.002 }),
  // a switch flicked: a chirp gliding up for on, down for off
  toggle: (on = true) => chirp(on ? 84 : 89, 0.07, { slide: on ? 1.3 : 0.75 }),
};
// ---- the score: the holo deck's own music, not the brownstone's tune re-voiced. Slow and spacious, a minute round:
// six chords in D with a Lydian lean (so it floats rather than resolves), ten seconds each. Each swells in on detuned
// pads over a sub that breathes with it and a wash of filtered noise, like air moving through the deck; soft glass bells
// walk its notes, each answered by echoes that fade from side to side. Pads and echoes ring on into the next chord, and
// from the last into the first, so the loop has no seam.
const STEP_S = 0.25, CHORD_STEPS = 40; // a step is a quarter second; a chord, ten
const CHORDS = [ // [sub root, pad notes, bell notes]
  [38, [62, 66, 69, 73, 76], [74, 78, 81, 85, 88]], // Dmaj9
  [35, [62, 66, 69, 71, 74], [74, 78, 81, 83, 86]], // Bm11
  [31, [62, 66, 69, 71, 73], [73, 74, 78, 81, 85]], // Gmaj9♯11 (the Lydian colour)
  [40, [62, 66, 67, 71, 74], [74, 78, 79, 83, 86]], // Em9
  [33, [61, 64, 66, 69, 71], [73, 76, 78, 81, 83]], // A6/9
  [31, [59, 62, 66, 67, 69], [71, 74, 78, 79, 81]], // Gmaj9
];
// when in a chord's ten seconds a bell rings (its step) and which of the chord's bell notes: unhurried, never on a grid
// a listener can tap along to; the odd chords answer the even ones a little differently
const BELLS = [[[4, 0], [10, 2], [16, 4], [21, 3], [27, 1], [33, 3]], [[6, 1], [12, 3], [17, 4], [24, 2], [30, 0], [36, 2]]];
const GLASS = [[1, 1], [2.76, 0.26], [5.4, 0.08]]; // a struck glass's partials
function bell(n, at, vol, bus, side) {
  // the note and three echoes, each softer, duller and further to the other side, three quarters of a second apart
  for (let k = 0; k < 4; k++) strike(note(n), 3.2 - k * 0.45, GLASS, { vol: vol * 0.42 ** k, at: at + k * 0.75, cut: 4200 / (k + 1), pan: side * (k % 2 ? -1 : 1) * (0.25 + k * 0.15), bus });
}
const padNote = (n, dur, attack, level, at, bus) =>
  [-1, 1].forEach(r => tone(note(n) * (1 + r * 0.003), dur, { type: 'triangle', vol: 0.065 * level, attack, cut: 1400, pan: r * 0.5, at, bus }));
export const score = {
  step: STEP_S,
  play(step, at, { bus, rain, snow }) {
    const s = step % (CHORD_STEPS * CHORDS.length), c = Math.floor(s / CHORD_STEPS), k = s % CHORD_STEPS, [sub, pad, bells] = CHORDS[c];
    const hush = 1 - 0.5 * rain; // softer in the rain
    if (k === 0) {
      // the pads: two soft triangles a few cents apart per note, either side, swelling in over four seconds and
      // ringing on, slowly fading, through the next two chords; the sub breathes in under them; air moves
      for (const n of pad) padNote(n, 30, 4, 1, at, bus);
      tone(note(sub), 24, { type: 'sine', vol: 0.18, attack: 5, at, bus });
      tone(note(sub + 12), 18, { type: 'sine', vol: 0.07, attack: 5, at, bus });
      noise(12, { vol: 0.03, freq: 700, sweep: 2.4, q: 5, attack: 5, at, bus });
    }
    if (k === 20) for (const n of pad.slice(2)) padNote(n, 20, 4, 0.5, at, bus); // halfway, the top of the chord breathes in again
    for (const [when, i] of BELLS[c % 2]) if (k === when) bell(bells[i], at, 0.08 * hush, bus, i % 2 ? 1 : -1);
    // high above, now and then, a faint glint (more of them when it snows)
    if (k === 22 && (c % 2 === 1 || snow > 0.3)) bell(bells[4] + 12, at, 0.026 * hush, bus, c % 3 ? 1 : -1);
  },
};
