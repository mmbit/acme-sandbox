// The foley.js palette, one sound after another: the audition reel for the sound pass.
// node shared/demo/mix.mjs shared/demo/examples/audition.mjs && node shared/demo/ad.mjs shared/demo/examples/audition.html
// Each cue's name is its caption in audition.html; `gap` is the time since the previous hit.
const reel = [
  { name: 'Clockwork tick', sound: 'tick', gap: 0.7 }, { name: '…and tock', sound: 'tick', tock: true, gap: 0.5 },
  { name: 'Ratchet, winding', sound: 'ratchet', gap: 1.2 },
  { name: 'Mechanical key', sound: 'clack', gap: 0.9 },
  { name: 'Wood block', sound: 'knock', note: 'C6', gap: 0.9 }, { name: 'Ceramic', sound: 'hit', material: 'ceramic', gap: 0.7 },
  { name: 'Glass tink', sound: 'tink', note: 'E7', gap: 0.8 },
  { name: 'Bubble pop', sound: 'bubble', gap: 1.1 }, { name: 'Bubbles', sound: 'bubble', bubbles: 6, dur: 0.4, pitch: 4, gap: 0.6 },
  { name: 'Magnetic snap', sound: 'snap', gap: 1.1 },
  { name: 'Pencil tick', sound: 'scratch', gap: 1 }, { name: 'Pencil scribble', sound: 'scribble', dur: 0.9, gap: 0.6 },
  { name: 'Crayon', sound: 'scribble', tool: 'crayon', dur: 0.6, gap: 1.2 },
  { name: 'Paper slide', sound: 'slide', gap: 1.5 },
  { name: 'Page flip', sound: 'flip', gap: 1.1 }, { name: 'Card flip', sound: 'flip', material: 'card', gap: 0.8 },
  { name: 'Card deal', sound: 'deal', count: 3, every: 0.22, gap: 0.8 },
  { name: 'Rubber stamp', sound: 'stamp', gap: 1.2 },
  { name: 'Ink squish', sound: 'squish', gap: 1 },
  { name: 'Cotton ruffle', sound: 'ruffle', gap: 1 },
  { name: 'Crunch', sound: 'crunch', gap: 1.1 },
  { name: 'Pour and fill', sound: 'pour', dur: 1.6, gap: 2.4 },
  { name: 'Lock-in', sound: 'lock', note: 'G6', gap: 1.4 },
];
let t = 0.2;
export default {
  title: 'Foley kit audition', master: { loudness: -14 },
  cues: reel.map(({ gap, ...c }) => ({ ...c, t: +(t += gap).toFixed(2) })),
  duration: +(t + 1.3).toFixed(2),
};
