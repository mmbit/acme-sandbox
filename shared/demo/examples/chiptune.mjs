// "Pixel Parcel": 8-bit adventure, 150 bpm. Pulse-wave lead, stepped-triangle bass, LFSR noise drums.
export default ({ arp, rep }) => ({
  title: 'Pixel Parcel', bpm: 150, bars: 8, tail: 1,
  master: { reverb: { size: 0.3, damp: 0.5 }, delay: { time: 0.75, fb: 0.3, lp: 5000 }, loudness: -14 },
  sections: { intro: 0, theme: 2, outro: 7 },
  markers: { hook: 4 },
  tracks: [
    { name: 'lead', inst: 'chip', step: 8, vol: 0.55, delay: 0.25, reverb: 0.1, from: 2,
      notes: `E5 - G5 - B5 - A5 G5 | E5 - - - G5 - E5 D5 | D5 - B4 - G4 - B4 D5 | F#5 - - - A5 - F#5 -
              E5 - G5 - B5 - E6 - | D6 - C6 B5 C6 - G5 - | A5 - F#5 - D5 - F#5 A5 | B5! - - - E6! - - .` },
    { name: 'arp', inst: { preset: 'chipsquare', pw: 0.125, osc: 'pulse' }, step: 16, vol: [0.22, 0.4], pan: -0.25,
      notes: arp('Em C G D Em C D Em', { steps: 16, order: 'updown', low: 'E4', span: 2 }) },
    { name: 'bass', inst: 'chipbass', step: 8, vol: 0.35,
      notes: rep('E2 E3 E2 E3 E2 E3 D3 B2', 1) + ' ' + rep('C2 C3 C2 C3 C2 C3 G2 C3', 1) + ' ' + rep('G2 G3 G2 G3 G2 G3 D3 G2', 1) + ' ' + rep('D2 D3 D2 D3 D2 D3 A2 F#2', 1) +
             ' E2 E3 E2 E3 E2 E3 B2 E3 C2 C3 C2 C3 E2 G2 C3 E3 D2 D3 D2 D3 F#2 A2 D3 F#3 E2 - - - E2! . . .' },
    { name: 'drums', kit: 'chip', vol: 0.95, crush: { bits: 6, rate: 22050 }, mix: { hat: 0.5, ohat: 0.4 },
      drums: { kick: '................ ................ ' + rep('x.......x.x.....', 5) + ' X...............',
               snare: '............x.x. ....x.......xxxx ' + rep('....x.......x...', 4) + ' ....x.....x.x.x. X...............',
               hat: '................ ................ ' + rep('x.x.x.x.x.x.x.xo', 5) + ' ................' } },
  ],
});
