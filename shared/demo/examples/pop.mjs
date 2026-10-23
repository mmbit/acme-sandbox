// "Bright Side": sunny dance-pop, 124 bpm. Filtered intro with a riser, then a pumping drop.
export default ({ voice, roots, rep }) => {
  const prog = 'D A Bm G';
  const chords = voice(prog, { low: 'F#3' }).split(' ');
  const stabs = chords.map(c => `. . ${c} - . . ${c} - . . ${c} - . ${c}? ${c} -`).join(' ');
  const bass = roots(prog, 2).split(' ').map(r => `${r} - ${r.replace('2', '3')}? . ${r} - ${r.replace('2', '3')}? . ${r} - ${r.replace('2', '3')}? . ${r} - ${r.replace('2', '3')}? .`).join(' ');
  return {
    title: 'Bright Side', bpm: 124, bars: 8, tail: 1.5,
    master: { reverb: { size: 0.6, damp: 0.35 }, delay: { time: 0.75, fb: 0.35, lp: 4000 }, loudness: -13, duckRelease: 0.55 },
    sections: { intro: 0, drop: 2, outro: 8 },
    markers: { drop: 2 },
    sfx: [{ type: 'riser', dur: 3.6, to: 2, vol: 0.45 }, { type: 'whoosh', to: 2, vol: 0.5 }, { type: 'sparkle', at: 7.5, vol: 0.35 }],
    tracks: [
      { name: 'pad', inst: 'supersaw', step: 1, gate: 1, vol: 0.7, reverb: 0.25, to: 2, lp: [350, 5000], notes: chords.slice(0, 2).join(' ') },
      { name: 'stabs', inst: 'supersaw', step: 16, vol: 0.75, reverb: 0.2, delay: 0.12, duck: 0.8, from: 2, width: 0.6, notes: stabs },
      { name: 'hook', inst: { preset: 'pluck', gain: 1.6 }, step: 16, vol: 0.8, pan: 0.15, delay: 0.3, reverb: 0.2, from: 2,
        notes: `F#5 . A5 . B5 - A5 . F#5 . E5 . D5 - E5 . | E5 . C#5 . E5 - F#5 . A5 . E5 . C#5 - . . |
                F#5 . D5 . F#5 - B5 . A5 . F#5 . D5 - B4 . | D5 - E5 - F#5 - G5 - A5 - B5 - A5 - F#5 -` },
      { name: 'bass', inst: { preset: 'bass', cutoff: 380, fenv: 1800 }, step: 16, vol: 0.55, duck: 0.9, from: 2, notes: bass },
      { name: 'drums', kit: 'punchy', vol: 0.6, reverb: 0.06, from: 2, mix: { hat: 0.4, ohat: 0.35, clap: 0.7 }, pans: { hat: -0.2, shaker: 0.3 },
        drums: { kick: 'x...x...x...x...', clap: '....x.......x...', ohat: '..x...x...x...x.', hat: rep('x.xxx.xxx.xxx.xx', 5) + ' x.xxx.xxx.xxxxxx',
                 crash: 'X...............' + rep('................', 3) } },
      { name: 'intro-drums', kit: 'punchy', vol: 0.5, to: 2, lp: [800, 6000], drums: { kick: 'x...x...x...x...', shaker: 'o.x.o.x.o.x.o.xx', snare: '................ ....x...x.x.xxxx' } },
    ],
  };
};
