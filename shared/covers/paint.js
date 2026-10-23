// The cover kit's paint box: the 128×72 canvas, HQ's palette and the drawing primitives every place, thing and person
// is made of. Guideline: README.md.
// (split out of kit.js; sprite)
import { text as font, textW } from '../../platform/hq/renderers/brownstone/iso.js';
import { mix } from '../../platform/hq/util.js';

export const W = 128, H = 72, FLOOR = 52; // indoors and in the street the floor starts at FLOOR; feet stand around y 62

// The palette: HQ's colours. Use these, and shades of them (lite, dark), nothing else.
export const C = {
  ink: '#1d1a2f', plum: '#3b3355', plum2: '#4f4670', slate: '#565a70', grey: '#8b8fa3', mist: '#c9ccd8', pave: '#d4cfe0',
  cream: '#fffaf0', paper: '#f6e7c1', sand: '#d4c7ae', wood: '#a8693f', woodL: '#cf9460', woodD: '#6e4029',
  red: '#e8505b', pink: '#ff8fab', orange: '#ffb86b', gold: '#ffd966', mustard: '#f2c14e',
  green: '#7bd389', grass: '#5cc26a', leaf: '#3f9b5c', teal: '#4fb5a5', sky: '#8fd3ff', blue: '#5b8def', navy: '#34508f', purple: '#9b72cf',
  night: '#2b2740',
};
export const lite = (c, t = 0.35) => mix(c, '#ffffff', t);
export const dark = (c, t = 0.3) => mix(c, C.ink, t);

export const R = (g, x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
export const P = (g, x, y, c) => R(g, x, y, 1, 1, c);
export const text = (g, s, x, y, c = C.ink) => font(g, s, x, y, c);
export const textWidth = s => textW(s);
export function disc(g, cx, cy, r, c) { g.fillStyle = c; for (let y = -r; y <= r; y++) { const w = Math.round(Math.sqrt(r * r - y * y)); g.fillRect(cx - w, cy + y, w * 2 + 1, 1); } }
export function shadow(g, cx, cy, rx, ry = 2) { g.fillStyle = 'rgba(29,26,47,.22)'; for (let y = -ry + 0.5; y < ry; y++) { const w = Math.round(rx * Math.sqrt(1 - (y / ry) ** 2)); g.fillRect(cx - w, Math.floor(cy + y), w * 2, 1); } }
export function line(g, x0, y0, x1, y1, c) { const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) || 1; for (let i = 0; i <= n; i++) P(g, Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), c); }

// A lit block: flat colour, a highlight along the top and left, a shade along the bottom and right (light from the top left).
export function box(g, x, y, w, h, c) {
  R(g, x, y, w, h, c); R(g, x, y, w, 1, lite(c)); R(g, x, y, 1, h, lite(c, 0.2));
  R(g, x, y + h - 1, w, 1, dark(c)); R(g, x + w - 1, y + 1, 1, h - 1, dark(c, 0.2));
}

// Foreground: everything drawn inside gets one ink outline around its silhouette. Backgrounds stay unoutlined.
export function fg(g, draw) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const t = c.getContext('2d'); draw(t);
  const d = t.getImageData(0, 0, W, H).data, a = (x, y) => x >= 0 && y >= 0 && x < W && y < H && d[(y * W + x) * 4 + 3] > 127;
  g.fillStyle = C.ink;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!a(x, y) && (a(x - 1, y) || a(x + 1, y) || a(x, y - 1) || a(x, y + 1))) g.fillRect(x, y, 1, 1);
  g.drawImage(c, 0, 0);
}

// Sketch a small thing as rows of characters, one per pixel, with a colour for each character ('.' or a space is
// empty): sprite(g, ['.rr.', 'rrrr'], x, y, { r: C.red }). Readable in the source, like the craft note says.
export function sprite(g, rows, x, y, colours) {
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => { if (colours[ch]) P(g, x + dx, y + dy, colours[ch]); }));
}
