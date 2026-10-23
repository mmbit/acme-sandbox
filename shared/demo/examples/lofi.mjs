// "Sunday Paper": dusty lo-fi, 80 bpm, swung. Rootless 9th voicings on e-piano, tape wobble.
export default ({ voice }) => {
  const prog = 'Fmaj9 Em7 Am9 Dm9';
  const keys = voice(prog, { low: 'E3', rootless: true }).split(' ');
  return {
    title: 'Sunday Paper', bpm: 80, bars: 4, swing: 0.32, humanize: 1, tail: 2,
    master: { reverb: { size: 0.55, damp: 0.6 }, delay: { time: 0.75, fb: 0.35, lp: 2200 }, lofi: { wow: 1, crackle: 1.2, hiss: 0.7 }, lp: 9000, loudness: -15 },
    tracks: [
      { name: 'keys', inst: 'epiano', step: 8, vol: 0.7, reverb: 0.3, strum: 0.012, width: 0.5,
        notes: keys.map(c => `${c} - - - . ${c}? - -`).join(' ') },
      { name: 'bass', inst: { preset: 'bass', cutoff: 180, fenv: 500, res: 0.1, sub: 0.8 }, step: 8, vol: 0.45,
        notes: 'F2 - - - . . C3? - | E2 - - - . . B2? - | A2 - - - . . E2 G2? | D2 - - - . A2? C3 - ' },
      { name: 'melody', inst: { preset: 'kalimba', gain: 0.9 }, step: 8, vol: 0.5, pan: 0.2, delay: 0.35, reverb: 0.35,
        notes: '. . E5 - G5 E5 C5 - | D5 - . B4? - . G4 . | . . C5 E5 - D5 C5 B4? | A4 - - - . . . .' },
      { name: 'drums', kit: 'lofi', vol: 0.75, crush: { bits: 10, rate: 22050 }, lp: 7000, reverb: 0.08, pans: { hat: 0.25 },
        mix: { hat: 0.45, rim: 0.5 },
        drums: { kick: 'X......x..X..... X......x..x...o.',
                 snare: '....X.......X... ....X.......X..o',
                 hat: 'x.xox.x.x.xox.xo',
                 rim: '..............o. ......o.........' } },
    ],
  };
};
