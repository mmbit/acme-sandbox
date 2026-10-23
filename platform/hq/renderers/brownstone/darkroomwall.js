// The flat drawings on the darkroom's back wall (darkroom.js shears them onto it): the drying line with its prints and
// strips of negatives, and the safelight.
import { canvas, mix } from '../../util.js';
import { F, INK, disc } from './iso.js';

export const PRINT_W = 6,
  PRINT_H = 7,
  PITCH = 7;
// the little product photos on the line: a pastel backdrop and a product in front, one pair a print
const BACKDROPS = ['#bfe3ff', '#ffe1ea', '#fff3b0', '#d8efe0', '#e3dcf5'];
const PRODUCTS = ['#e8505b', '#5b8def', '#f2a65a', '#4fb5a5', '#9b72cf', '#ffd966'];
const flat = (w, h, draw) => {
  const c = canvas(w, h);
  draw(c.getContext('2d'));
  return c;
};

// the line with its first n prints pegged on
export function lineFlat(st, n) {
  const L = st.line;
  return flat(L.w, 12, f => {
    for (let x = 0; x < L.w; x++) F(f, x, sag(x, L.w), 1, 1, '#c9ccd8');
    F(f, 0, 0, 1, 3, '#8b8fa3');
    F(f, L.w - 1, 0, 1, 3, '#8b8fa3'); // its hooks
    for (let i = 0; i < n; i++) {
      const x = 1 + i * PITCH;
      f.drawImage(printFlat(i), x, sag(x + 3, L.w) - 1);
    }
    // strips of negatives drying at its far end, where no print hangs yet
    for (const x of [L.w - 8, L.w - 15, L.w - 24]) if (x > n * PITCH + 2) f.drawImage(NEGATIVE, x, sag(x + 2, L.w) - 1);
  });
}
// a strip of negatives on its clip: amber film, its frames, its sprocket holes down both edges
const NEGATIVE = flat(4, 11, f => {
  F(f, 1, 0, 2, 2, '#c9ccd8');
  F(f, 0, 2, 4, 9, '#5a3a26');
  for (let y = 3; y < 11; y += 2) {
    F(f, 0, y, 1, 1, '#8e6a48');
    F(f, 3, y, 1, 1, '#8e6a48');
  }
  for (const y of [3, 7]) F(f, 1, y, 2, 3, '#b08a5e');
  F(f, 1, 4, 1, 1, '#5a3a26');
});
export const sag = (x, w) => 1 + Math.round(Math.sin((x / Math.max(1, w - 1)) * Math.PI) * 2);
// one print with its peg: a white border round a little product photo (each print its own)
const prints = new Map();
export function printFlat(i) {
  if (!prints.has(i))
    prints.set(
      i,
      flat(PRINT_W, PRINT_H + 2, f => {
        F(f, 2, 0, 2, 2, '#cf9460'); // the peg
        F(f, 0, 2, PRINT_W, PRINT_H, '#fffaf0');
        F(f, 0, PRINT_H + 1, PRINT_W, 1, '#d9d4c8');
        F(f, 1, 3, PRINT_W - 2, PRINT_H - 3, BACKDROPS[i % BACKDROPS.length]);
        const c = PRODUCTS[(i * 2 + 1) % PRODUCTS.length];
        F(f, 2, 5, 2, 3, c);
        F(f, 2, 5, 1, 1, mix(c, '#ffffff', 0.4));
        F(f, 1, 7, 4, 1, mix(BACKDROPS[i % BACKDROPS.length], INK, 0.2));
      }),
    );
  return prints.get(i);
}
// the safelight: a little lamp on a bracket, its domed red lens lit or not; lit, its light lies on the wall round it in
// two stepped bands
const lamps = {};
export function safelightFlat(on) {
  return (lamps[on] ??= flat(15, 13, f => {
    if (on) {
      f.globalAlpha = 0.25;
      disc(f, 7, 7, 6, '#ff3b4a');
      f.globalAlpha = 0.3;
      disc(f, 7, 7, 4, '#ff3b4a');
      f.globalAlpha = 1;
    }
    F(f, 7, 1, 1, 3, '#8b8fa3');
    F(f, 6, 1, 3, 1, '#8b8fa3'); // the bracket
    F(f, 4, 4, 7, 6, '#2b2230');
    F(f, 5, 3, 5, 1, '#2b2230');
    F(f, 4, 10, 7, 1, '#1d1a2f');
    const lens = on ? '#ff3b4a' : '#6e2632';
    F(f, 5, 5, 5, 4, lens);
    F(f, 6, 4, 3, 1, lens);
    F(f, 6, 5, 2, 1, on ? '#ffd0d4' : '#8e3b4a');
    if (on) F(f, 6, 6, 3, 2, '#ff7b84');
  }));
}
