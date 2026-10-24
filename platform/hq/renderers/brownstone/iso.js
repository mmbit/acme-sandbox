// Isometric maths and pixel-exact rasterisers (no anti-aliasing anywhere).
// World: x, y in tiles on the ground plane, z in pixels up. A tile is 32×16 px.
// World pixels: sx = 16(x - y), sy = 8(x + y) - z.
import { mix, canvas } from '../../util.js';

export const INK = '#1d1a2f';
// Building dimensions, in px up and tiles across.
export const FH = 88, SLAB = 8;          // floor-to-floor height and slab thickness
export const WALL_H = FH - SLAB;         // full wall height (the floor above hides all but the lowest ~40 px)
export const INNER_WALL_H = 50;          // walls of rooms that aren't at a wing's open end: the visible part is enough
export const PENT_H = 56;                // the penthouse's glass walls, open to the sky
// The core: elevator and stairs in the building's back corner. The wings are CORE tiles deep (a tile
// more below ground); the core runs CORE_X tiles along x.
export const SHAFT = [0.15, 1.25];       // the elevator shaft's footprint, x and y; its door faces +y
export const DOOR = { x: 0.7, y: 1.8 };  // where people wait for the elevator
// A spiral stair in an open well at the front of the core, right of the elevator: n wedge treads round a pole
// at (cx, cy), from r to R, one full turn per floor (world radians: 0 is +x, π/2 is +y), so every flight starts
// and ends on the left of the well (a0 = π) and together they make one helix from the lowest floor to the roof.
// Nothing hides it: every floor above has a well, a U-shaped bay cut into the front of its slab (round at the
// back, radius RW, open to the front at y = CORE), so the whole helix shows. People step on and off at the
// well's left rim (foot, head, reached from lane) and walk round behind it, along the back wall (via).
// Scale: a floor is ~6.8 m, so a turn has headroom to spare; with 26 treads a riser is ~3.4 px (~29 cm), and
// a tread, out on the walking line, about as deep.
const SPIRAL = { cx: 4.15, cy: 2.1, r: 0.08, R: 0.85, n: 26, a0: Math.PI };
const dA = 2 * Math.PI / SPIRAL.n, RW = SPIRAL.R + 0.15, RIM = RW + 0.12;
const rim = a => ({ x: +(SPIRAL.cx + RIM * Math.cos(a)).toFixed(2), y: +(SPIRAL.cy + RIM * Math.sin(a)).toFixed(2) });
const LANE = { x: 2.75, y: 2.45 }, FOOT = rim(SPIRAL.a0 + dA / 2), HEAD = rim(SPIRAL.a0 - dA / 2);
export const STAIR = { ...SPIRAL, da: dA, RW, x0: SPIRAL.cx - RW, x1: SPIRAL.cx + RW, lane: LANE, foot: FOOT, head: HEAD,
  via: [{ x: 2.85, y: 0.5 }, { x: SPIRAL.cx + RW + 0.4, y: 0.5 }],
  at: () => ({ a0: SPIRAL.a0, foot: FOOT, head: HEAD, toFoot: [LANE, FOOT], toHead: [LANE, HEAD] }) };
// is (x, y) in the well (or within m of its sides and back)?
export const inWell = (x, y, m = 0) => x > STAIR.x0 - m && x < STAIR.x1 + m && y < CORE && (y >= SPIRAL.cy || Math.hypot(x - SPIRAL.cx, y - SPIRAL.cy) < RW + m);
// the waypoints that take a straight walk from p to q round the well instead of through it: behind it, or
// (from in front of it: the basement's hall, the sidewalk) round its nearer front corner
export function roundWell(p, q) {
  let hit = false;
  for (let k = 0; k <= 32 && !hit; k++) hit = inWell(p.x + (q.x - p.x) * k / 32, p.y + (q.y - p.y) * k / 32, 0.1);
  if (!hit) return [];
  const [W0, W1] = STAIR.via, front = a => a.y >= CORE;
  // round the back, coming forward to the lane on each side, so the way on into a wing is through its doorway
  const L0 = { x: W0.x, y: LANE.y }, L1 = { x: W1.x, y: LANE.y };
  if (!front(p) && !front(q)) return p.x < q.x ? [L0, W0, W1, L1] : [L1, W1, W0, L0];
  const [o, left] = front(p) ? [q, q.x < SPIRAL.cx] : [p, p.x < SPIRAL.cx], F = { x: left ? STAIR.x0 - 0.3 : STAIR.x1 + 0.3, y: CORE + 0.08 };
  const via = o.x > STAIR.x0 - 0.1 && o.x < STAIR.x1 + 0.1 ? [F, left ? W0 : W1] : [F]; // (to somewhere behind it: round the corner, then along the back)
  return front(p) ? via : via.reverse();
}
export const CORE = 3, CORE_X = 7;
export const PLAZA = { x: CORE + 0.45, y: CORE + 0.45 }; // where the two sidewalks meet, in the inner corner of the L
export const ENTRANCE = CORE_X - 0.9; // the front door, along the core's front beside the stairwell (not over it)
export const SX = (x, y) => 16 * (x - y);
export const SY = (x, y, z = 0) => 8 * (x + y) - z;
export const toTile = (sx, sy, z = 0) => ({ x: sx / 32 + (sy + z) / 16, y: (sy + z) / 16 - sx / 32 });

// fill the pixels whose centres fall in [L, R) on row r
const span = (g, r, L, R) => { const a = Math.ceil(L - 0.5), b = Math.ceil(R - 0.5); if (b > a) g.fillRect(a, r, b - a, 1); };

// horizontal quad [x0,x1)×[y0,y1) at height z
export function top(g, x0, y0, x1, y1, z, c) {
  if (c) g.fillStyle = c;
  for (let r = Math.floor(8 * (x0 + y0) - z), end = Math.ceil(8 * (x1 + y1) - z); r < end; r++) {
    const s = r + 0.5 + z;
    span(g, r, Math.max(32 * x0 - 2 * s, 2 * s - 32 * y1), Math.min(32 * x1 - 2 * s, 2 * s - 32 * y0));
  }
}
// vertical quad in the plane y = Y (its visible side faces south-west)
export function wallY(g, x0, x1, Y, z0, z1, c) {
  if (c) g.fillStyle = c;
  for (let r = Math.floor(8 * (x0 + Y) - z1), end = Math.ceil(8 * (x1 + Y) - z0); r < end; r++) {
    const s = r + 0.5;
    span(g, r, Math.max(16 * (x0 - Y), 2 * (z0 + s - 16 * Y)), Math.min(16 * (x1 - Y), 2 * (z1 + s - 16 * Y)));
  }
}
// vertical quad in the plane x = X (its visible side faces south-east)
export function wallX(g, y0, y1, X, z0, z1, c) {
  if (c) g.fillStyle = c;
  for (let r = Math.floor(8 * (X + y0) - z1), end = Math.ceil(8 * (X + y1) - z0); r < end; r++) {
    const s = r + 0.5;
    span(g, r, Math.max(16 * (X - y1), 2 * (16 * X - s - z1)), Math.min(16 * (X - y0), 2 * (16 * X - s - z0)));
  }
}
const shades = c => [mix(c, '#ffffff', 0.18), c, mix(c, '#1d1a2f', 0.28)];
// a solid box. Its colours are [top, south-west face, south-east face], or one base colour
export function box(g, x0, y0, z0, x1, y1, z1, c) {
  const [t, l, r] = Array.isArray(c) ? c : shades(c);
  wallY(g, x0, x1, y1, z0, z1, l); wallX(g, y0, y1, x1, z0, z1, r); top(g, x0, y0, x1, y1, z1, t);
}

// Paint a flat, front-on drawing onto a wall, shearing it column by column.
// onWallY: plane y = Y, starting at tile x0. onWallX: plane x = X, ending at tile y1 (the screen-left end).
export function onWallY(g, flat, x0, Y, zb) {
  for (let u = 0; u < flat.width; u++) g.drawImage(flat, u, 0, 1, flat.height, ...wallYCol(x0, Y, zb, flat.height, u), 1, flat.height);
}
export function onWallX(g, flat, y1, X, zb) {
  for (let u = 0; u < flat.width; u++) g.drawImage(flat, u, 0, 1, flat.height, ...wallXCol(y1, X, zb, flat.height, u), 1, flat.height);
}
// where column u of a flat drawing H px tall lands on screen: [x, the y of its top row] (so a frame's lights can hit its
// pixels exactly).
export function wallYCol(x0, Y, zb, H, u) { const c = Math.round(16 * (x0 - Y)) + u; return [c, Math.floor(c / 2 - 0.25 + 16 * Y - zb) - H + 1]; }
export function wallXCol(y1, X, zb, H, u) { const c = Math.round(16 * (X - y1)) + u; return [c, Math.floor(16 * X - c / 2 - 0.75 - zb) - H + 1]; }
// flat pixel helpers
export const F = (g, x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
// A sprite's shape in one flat colour
export function silhouette(src, color) { const c = canvas(src.width, src.height), g = c.getContext('2d'); g.drawImage(src, 0, 0); g.globalCompositeOperation = 'source-in'; F(g, 0, 0, c.width, c.height, color); return c; }
// a 1 px line from point a to point b ([x, y])
export function line(g, [x1, y1], [x2, y2], c) {
  const n = Math.max(1, Math.round(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1))));
  for (let k = 0; k <= n; k++) F(g, Math.round(x1 + (x2 - x1) * k / n), Math.round(y1 + (y2 - y1) * k / n), 1, 1, c);
}
export const disc = (g, cx, cy, rad, c) => { g.fillStyle = c; for (let y = -rad; y <= rad; y++) { const w = Math.round(Math.sqrt(rad * rad - y * y)); g.fillRect(cx - w, cy + y, w * 2, 1); } };
// a small canvas holding one iso object, drawn in world coordinates: { img, x, y } (its world position)
export function sprite(x0, y0, x1, y1, z0, z1, draw, pad = 3) {
  const l = Math.floor(SX(x0, y1)) - pad, r = Math.ceil(SX(x1, y0)) + pad, t = Math.floor(SY(x0, y0, z1)) - pad, b = Math.ceil(SY(x1, y1, z0)) + pad;
  const c = canvas(r - l, b - t), g = c.getContext('2d');
  g.translate(-l, -t); draw(g);
  return { img: c, x: l, y: t };
}

// pixel ellipse on the ground (shadows, light pools, puddles)
export function ellipse(g, cx, cy, rx, ry, c) {
  if (c) g.fillStyle = c;
  for (let dy = -ry + 0.5; dy < ry; dy++) {
    const w = Math.round(rx * Math.sqrt(1 - (dy / ry) ** 2));
    if (w > 0) g.fillRect(Math.round(cx - w), Math.floor(cy + dy), w * 2, 1);
  }
}

// ---- a 3×5 pixel font ----
const GLYPHS = {
  A: '25755', B: '65656', C: '34443', D: '65556', E: '74647', F: '74644', G: '34553', H: '55755', I: '72227', J: '11152',
  K: '55655', L: '44447', M: '57755', N: '65555', O: '25552', P: '65644', Q: '25563', R: '65655', S: '34216', T: '72222',
  U: '55557', V: '55552', W: '55775', X: '55255', Y: '55222', Z: '71247', 0: '75557', 1: '26227', 2: '61247', 3: '61216',
  4: '55711', 5: '74616', 6: '34757', 7: '71222', 8: '75757', 9: '75716', ' ': '00000', '.': '00002', '!': '22202',
  '?': '61202', '-': '00700', ':': '02020', "'": '22000', '/': '11244', '+': '02720', '&': '25253', '·': '00200', '↑': '27222', '↓': '22272',
};
export const textW = (s, k = 1) => String(s).length * 4 * k - k;
// the logo's colours when brand.yaml leaves them out: cream letters, the accent ('o' pixels) gold, a plum shadow
export const LOGO_COLOURS = { ink: '#fffaf0', accent: '#ffd966', shadow: '#4f4670' };
// wordmark() draws logo pixels (rows) at 1 px per pixel, with an optional 1 px shadow
export function wordmark(g, x, y, ink, one, shadow, rows) {
  for (let v = 0; v <= rows.length; v++) for (let u = 0; u < rows[0].length; u++) {
    const ch = rows[v]?.[u] ?? '.';
    if (ch !== '.') F(g, x + u, y + v, 1, 1, ch === 'o' ? one : ink);
    else if (shadow && v && rows[v - 1][u] !== '.') F(g, x + u, y + v, 1, 1, shadow);
  }
}
// s in the pixel font at 2 px per pixel, as logo pixels, with each word's columns as a line
export function lettering(s) {
  s = String(s).toUpperCase();
  const glyph = ch => GLYPHS[ch] || GLYPHS['?'];
  const pixels = Array.from({ length: 10 }, (_, v) => [...s].map(ch => [4, 2, 1, 0].map(b => +glyph(ch)[v >> 1] & b ? '##' : '..').join('')).join('').slice(0, -2));
  return { pixels, lines: [...s.matchAll(/\S+/g)].map(m => [m.index * 8, (m.index + m[0].length) * 8 - 2]) };
}
export function text(g, s, x, y, c, k = 1) {
  g.fillStyle = c;
  [...String(s).toUpperCase()].forEach((ch, i) => {
    const gl = GLYPHS[ch] || GLYPHS['?'];
    for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++)
      if (+gl[row] & (4 >> col)) g.fillRect(x + (i * 4 + col) * k, y + row * k, k, k);
  });
}
// s in the pixel font at (x, y) of a drawing for a wall, each letter shifted against the wall's slant so it stands
// upright once drawn onto it (rows: the screen row each column of the drawing lands on, from a frame's cols or from
// wallYCol/wallXCol). The slant steps a pixel every second column, inside a letter as often as not: drawn flat, its
// bars break, and P reads F and M reads H. A letter takes the rows y to y + 5.
export function upright(g, s, x, y, c, rows) {
  const flat = canvas(textW(s), 5);
  text(flat.getContext('2d'), s, 0, 0, c);
  for (let u = 0; u < flat.width; u++) {
    const x0 = x + u - (u % 4), low = Math.max(rows[x0], rows[x0 + 1], rows[x0 + 2]);
    g.drawImage(flat, u, 0, 1, 5, x + u, y + low - rows[x + u], 1, 5);
  }
}
