// The rooftop sign and the birthday bunting, built once per layout.
import { canvas } from '../../util.js';
import { PENT_H, INK, F, SX, SY, wallY, wordmark, onWallY } from './iso.js';

// the sign's colours when brand.yaml leaves them out (the rooftop marquee's, and the entrance plaque's)
export const SIGN = { panel: '#2b2350', frame: '#b8862e', inner: '#3b3355', bulbOn: '#fff3b0', bulbOff: '#8a6a2a', plaque: '#2a2352' };

// The roof sign's face for one phase (0 to 2) of its chasing bulbs: a marquee, the logo on a plum panel in a gold frame,
// ringed with bulbs that chase round it, one lit bulb in three. Cream letters with their lit ones in gold, over a plum
// shadow. Sized to what it says: 16 wider and 11 taller than its pixels. sign: as scene.js dresses brand.sign (its
// pixels and colours); colours: brand.logo.colours. Exported so a company's own art can show the same sign
export function signFace(sign, colours, phase) {
  const w = sign.pixels[0].length + 16, H = sign.pixels.length + 11;
  const ring = []; // bulb positions, clockwise from the top left
  for (let x = 2; x < w - 2; x += 3) ring.push([x, 1]);
  for (let y = 4; y < H - 3; y += 3) ring.push([w - 2, y]);
  for (let x = ring[ring.length - 1 - Math.floor((H - 7) / 3)][0]; x >= 2; x -= 3) ring.push([x, H - 2]);
  for (let y = H - 5; y >= 4; y -= 3) ring.push([1, y]);
  const c = canvas(w, H), fg = c.getContext('2d');
  F(fg, 0, 0, w, H, sign.frame); F(fg, 1, 1, w - 2, H - 2, sign.panel); F(fg, 3, 3, w - 6, H - 6, INK); F(fg, 3, 3, w - 6, 1, sign.inner);
  for (const [x, y] of [[0, 0], [w - 1, 0], [0, H - 1], [w - 1, H - 1]]) fg.clearRect(x, y, 1, 1); // nipped corners
  ring.forEach(([x, y], i) => F(fg, x, y, 1, 1, i % 3 === phase ? sign.bulbOn : sign.bulbOff));
  wordmark(fg, 8, 5, colours.ink, colours.accent, colours.shadow, sign.pixels);
  return c;
}

// The roof's sign and bunting (either null where there's none). brand: as scene.js dresses it
export function roofBits(L, brand, party) {
  let sign = null, bunting = null;
  const P = L.pent, z = L.roofZ;
  if (P) {
    const faces = [0, 1, 2].map(phase => signFace(brand.sign, brand.logo.colours, phase));
    const { width: w, height: H } = faces[0], len = w / 16;
    const x0 = Math.max(1.3, (P.x1 - len) / 2 + 0.6), base = z + PENT_H + 6; // the sign's bottom edge, on posts above the penthouse's back wall
    const l = Math.floor(SX(x0, 0)) - 2, t0 = Math.floor(SY(x0, 0, base + H + 6)) - 2, imgs = faces.map(face => {
      const c = canvas(w + 4, Math.ceil(len * 8) + H + 22), g = c.getContext('2d');
      g.translate(-l, -t0);
      for (const u of [0.4, len - 0.4]) wallY(g, x0 + u, x0 + u + 0.08, 0.1, z + PENT_H, z + PENT_H + 6, '#565a70');
      onWallY(g, face, x0, 0.1, base);
      return c;
    });
    const x1 = x0 + len;
    const hot = { x0: SX(x0, 0.1), x1: SX(x1, 0.1), y0: SY(x0, 0.1, base + H + 2), y1: SY(x1, 0.1, base - 2) };
    sign = { img: imgs[0], imgs, x: l, y: t0, glow: signGlow(faces[0], x0, base), hot };
  }
  if (party) {
    const tr = L.rooms.find(r => r.id === 'terrace-x') || L.rooms.find(r => r.kind === 'terrace');
    if (tr) {
      const X = tr.wing !== 'y', n = X ? tr.x1 - tr.x0 : tr.y1 - tr.y0, cols = ['#e8505b', '#ffd966', '#5b8def', '#7bd389', '#ff8fab'];
      // flags on a line between posts on the front railing, sagging between each pair
      const POST = 30, pt = u => X ? { x: tr.x0 + u, y: 2.92 } : { x: 2.92, y: tr.y0 + u };
      const a = pt(0), b = pt(n), l = Math.floor(Math.min(SX(a.x, a.y), SX(b.x, b.y))) - 4, t0 = Math.floor(Math.min(SY(a.x, a.y, z + POST + 4), SY(b.x, b.y, z + POST + 4))) - 4;
      const c = canvas(Math.abs(SX(b.x, b.y) - SX(a.x, a.y)) + 8, Math.abs(SY(b.x, b.y) - SY(a.x, a.y)) + POST + 12), g = c.getContext('2d');
      g.translate(-l, -t0);
      for (let u = 0; u <= n; u += 2) { const p = pt(Math.min(u, n - 0.05)), sx = SX(p.x, p.y), sy = SY(p.x, p.y, z); F(g, sx, sy - POST, 1, POST, '#fdf3e1'); }
      for (let u = 0.25, i = 0; u < n; u += 0.25, i++) { const p = pt(u), sag = Math.sin(((u % 2) / 2) * Math.PI) * 5, sx = SX(p.x, p.y), sy = SY(p.x, p.y, z + POST - sag); F(g, sx, sy, 4, 1, '#fffaf0'); F(g, sx + 1, sy + 1, 2, 2, cols[i % 5]); F(g, sx + 1, sy + 3, 1, 1, cols[i % 5]); }
      bunting = { img: c, x: l, y: t0 };
    }
  }
  return { sign, bunting };
}
// The rooftop sign at night: `lit` keeps the panel itself out of the night shade (exactly its own shape), and
// `img` is a soft halo round only its bright pixels (letters, bulbs, stars), so the glow doesn't enlarge it.
function signGlow(flat, x0, base) {
  const P = 3, w = flat.width + 2 * P, h = flat.height + 2 * P, bright = canvas(w, h), bg = bright.getContext('2d');
  bg.drawImage(flat, P, P);
  const d = bg.getImageData(0, 0, w, h), px = d.data;
  for (let i = 0; i < px.length; i += 4) { const on = px[i] + px[i + 1] > 380; px[i] = 122; px[i + 1] = 90; px[i + 2] = 20; px[i + 3] = on ? 255 : 0; }
  bg.putImageData(d, 0, 0);
  const halo = canvas(w, h), hg = halo.getContext('2d');
  for (const [dx, dy, a] of [[0, 0, 0.5], [-1, 0, 0.3], [1, 0, 0.3], [0, -1, 0.3], [0, 1, 0.3], [-2, 0, 0.12], [2, 0, 0.12], [0, -2, 0.12], [0, 2, 0.12]]) { hg.globalAlpha = a; hg.drawImage(bright, dx, dy); }
  const place = img => {
    const x = x0 - P / 16, l = Math.floor(SX(x, 0.1)) - 2, t0 = Math.floor(SY(x, 0.1, base + flat.height + P)) - 2, c = canvas(w + 4, h + Math.ceil(w / 2) + 4), g = c.getContext('2d');
    g.translate(-l, -t0); onWallY(g, img, x, 0.1, base - P);
    return { img: c, x: l, y: t0 };
  };
  const panel = canvas(w, h); panel.getContext('2d').drawImage(flat, P, P);
  return { ...place(halo), lit: place(panel) };
}
