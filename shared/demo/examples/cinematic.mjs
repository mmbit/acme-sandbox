// "First Light": slow ambient/cinematic swell, 70 bpm. Wide pads, pulsing strings, impacts, a bell motif.
export default ({ voice }) => {
  const prog = 'Dm9 Bbmaj7 Fadd9 C6/9';
  const pads = voice(prog.replace('C6/9', 'Csus2'), { low: 'D3' }).split(' ');
  return {
    title: 'First Light', bpm: 70, bars: 4, tail: 2.5,
    master: { reverb: { size: 0.9, damp: 0.3, predelay: 0.04 }, delay: { time: 1.5, fb: 0.45, lp: 2500 }, loudness: -16 },
    markers: { rise: 2, hit: 4 },
    sfx: [{ type: 'boom', at: 0, vol: 0.6 }, { type: 'riser', dur: 6.8, to: 4, vol: 0.3 }, { type: 'boom', at: 4, vol: 0.8 }, { type: 'chime', at: 4, vol: 0.3 }],
    tracks: [
      { name: 'pad', inst: 'pad', step: 1, gate: 1, vol: [0.6, 0.9], reverb: 0.5, lp: [500, 4000], width: 0.8, notes: pads.join(' ') },
      { name: 'pulse', inst: { preset: 'strings', env: [0.01, 0.15, 0.5, 0.1] }, step: 8, vol: [0.25, 0.8], reverb: 0.35, from: 1,
        notes: 'D3+A3 D3+A3 D3+A3 D3+A3 D3+A3 D3+A3 D3+A3 D3+A3 | Bb2+F3 Bb2+F3 Bb2+F3 Bb2+F3 Bb2+F3 Bb2+F3 Bb2+F3 Bb2+F3 | F3+C4 F3+C4 F3+C4 F3+C4 F3+C4 F3+C4 F3+C4 F3+C4' },
      { name: 'low', inst: { preset: 'sub', env: [0.4, 0.5, 0.9, 1.5] }, step: 1, gate: 1, vol: 0.18, notes: 'D2 Bb1 F1 C2' },
      { name: 'bells', inst: 'bell', step: 4, vol: 0.75, pan: -0.2, delay: 0.4, reverb: 0.5,
        notes: 'A5 . F5 . | . . D5 . | C6 . A5 . | G5 - - -' },
      { name: 'toms', kit: { tom: { decay: 0.6 }, tom2: { tune: 150, punch: 90 } }, vol: 0.6, reverb: 0.3, from: 2, to: 4,
        drums: { tom: 'x.......x.......x.......x...x.x.', tom2: '............x.............xxxxxx' },
        mix: { tom2: 0.6 }, pans: { tom2: 0.3 } },
    ],
  };
};
