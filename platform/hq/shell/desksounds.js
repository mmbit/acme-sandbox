// The desk phone's ring and the intercom's mic in the brownstone's chiptune, shared by the brownstone's and Wire's
// packs (renderers/<name>/sounds.js), since a look doesn't import another look's pack.
import { tone, noise, note } from './audio.js';

export const ring = () =>
  [0, 0.18, 0.5, 0.68].forEach(at => {
    tone(note(88), 0.12, { type: 'square', vol: 0.05, at });
    tone(note(91), 0.12, { type: 'square', vol: 0.04, at: at + 0.06 });
  });
// the mic: a soft radio key-up, and a squelch when it lets go
export const micOn = () => {
  noise(0.05, { vol: 0.035, freq: 2400 });
  tone(note(79), 0.07, { type: 'sine', vol: 0.07, at: 0.02 });
  tone(note(86), 0.1, { type: 'sine', vol: 0.07, at: 0.08 });
};
export const micOff = () => {
  tone(note(86), 0.07, { type: 'sine', vol: 0.06 });
  tone(note(79), 0.12, { type: 'sine', vol: 0.06, at: 0.06 });
  noise(0.16, { vol: 0.025, freq: 1500, at: 0.1 });
};
