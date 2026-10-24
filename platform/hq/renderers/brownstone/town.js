// Townsfolk round HQ, and now and then a car or bus: scenery, never tappable
import { canvas, rng, pick, clamp, rand } from '../../util.js';
import { SX, SY, box, ellipse, F, sprite, INK } from './iso.js';

const MAX_PEOPLE = 5;
const KINDS = [['walker', 0.45, 1.0], ['walker', 0.45, 1.0], ['jogger', 0.2, 2.1], ['dog', 0.2, 0.9], ['cyclist', 0.15, 2.6]]; // kind, share, speed (tiles/s)
const COATS = ['#8a93b0', '#b08a8a', '#8aa89a', '#a89a78', '#9a8ab0', '#7f8fa0'];

// How busy the streets are, 0..1: nobody in the small hours, rush hours busiest, fewer in the rain.
function footfall(hour, rain) {
  const h = hour % 24, day = h < 5 ? 0 : h < 7 ? (h - 5) / 2 * 0.5 : h < 9 ? 0.9 : h < 12 ? 0.5 : h < 14 ? 0.8 : h < 17 ? 0.5 : h < 19.5 ? 0.9 : h < 23 ? 0.35 - (h - 19.5) * 0.08 : 0.04;
  return Math.max(0, day) * (1 - rain * 0.6);
}

export const createTown = () => ({ people: [], car: null, spawnT: 2, carT: rand(15, 30) });

export function updateTown(T, S, dt) {
  const isl = S.island, R = isl.routes, f = footfall(S.hour, S.weather.rain);
  // new passers-by, one at a time
  if ((T.spawnT -= dt) <= 0) {
    T.spawnT = f > 0.02 ? rand(3, 9) / f : 30;
    if (T.people.length < Math.round(MAX_PEOPLE * f + 0.4) && Math.random() < 0.85) {
      let x = Math.random(), kind = 'walker', speed = 1;
      for (const [k, share, s] of KINDS) if ((x -= share) < 0) { kind = k; speed = s; break; }
      const path = R.sidewalk.slice(), back = Math.random() < 0.5;
      if (back) path.reverse();
      // some walkers do a lap of the park loop on the way
      let pts = path;
      if ((kind === 'walker' || kind === 'dog') && Math.random() < 0.5) { // a lap of the park loop on the way
        const lap = [...R.loop, R.loop[0]];
        pts = back ? [path[0], R.loopIn, ...lap, R.loopIn, path[1], path[2]] : [path[0], path[1], R.loopIn, ...lap, R.loopIn, path[2]];
      }
      T.people.push({ kind, speed: speed * rand(0.9, 1.1), pts, k: 1, x: pts[0].x, y: pts[0].y, t: Math.random() * 9, seed: Math.random() * 1e9 | 0, coat: pick(Math.random, COATS), umbrella: S.weather.rain > 0.3 && kind !== 'jogger' && kind !== 'cyclist', dog: kind === 'dog' ? { x: pts[0].x, y: pts[0].y } : null, fade: 0 });
    }
  }
  for (const p of T.people) {
    p.t += dt; p.fade = Math.min(1, p.fade + dt * 2);
    const q = p.pts[p.k]; if (!q) { p.done = true; continue; }
    const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy), v = p.speed * dt;
    if (d <= v) { p.x = q.x; p.y = q.y; p.k++; } else { p.x += dx / d * v; p.y += dy / d * v; p.front = dx + dy > 0; p.right = dx - dy > 0; }
    if (p.dog) { const ex = p.x - p.dog.x, ey = p.y - p.dog.y, e = Math.hypot(ex, ey); if (e > 0.35) { p.dog.x += ex / e * (e - 0.35); p.dog.y += ey / e * (e - 0.35); p.dog.right = ex - ey > 0; } }
  }
  T.people = T.people.filter(p => !p.done);
  // a car or the bus: in from the island's edge, a U-turn short of the loading bay, and out again
  if (!T.car && (T.carT -= dt) <= 0) {
    T.carT = rand(25, 60) / Math.max(0.15, f);
    if (S.van.state === 'away' && f > 0.05) T.car = { bus: Math.random() < 0.3, u: R.street.len + 2, lane: 2.3, state: 'in', color: pick(Math.random, ['#e8505b', '#5b8def', '#f2c14e', '#7bd389', '#c9ccd8', '#565a70']), t: 0 };
  }
  const c = T.car;
  if (c) {
    c.t += dt;
    const turnAt = c.bus ? 4.2 : 3.4;
    if (c.state === 'in') { c.u -= dt * 2.4; if (c.bus && Math.abs(c.u - R.street.len * 0.6) < 0.05 && !c.stopped) { c.state = 'stop'; c.stopped = 1; c.wait = 3; } if (c.u <= turnAt) { c.state = 'turn'; c.turn = 0; } }
    else if (c.state === 'stop') { if ((c.wait -= dt) <= 0) c.state = 'in'; }
    else if (c.state === 'turn') { c.turn += dt / 1.2; c.lane = 2.3 - 1.2 * clamp(c.turn, 0, 1); if (c.turn >= 1) c.state = 'out'; }
    else { c.u += dt * 2.6; if (c.u > R.street.len + 2.5) T.car = null; }
  }
}

// ---- drawing: small, faceless, muted figures, so the board never mistakes them for staff, cached per look and frame
const cache = new Map();
function figure(p, frame) {
  const key = `${p.kind}${p.coat}${p.seed % 4}${frame}${p.front}${p.umbrella}`;
  let c = cache.get(key);
  if (c) return c;
  c = canvas(12, 20); const g = c.getContext('2d'), r = rng(p.seed % 4 + p.kind), R2 = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const skin = pick(r, ['#e0b89a', '#c89878', '#9c7458', '#f0caa8']), hair = pick(r, ['#3b3355', '#6e4a36', '#a8927a', '#565a70']);
  const legs = p.kind === 'jogger' ? '#3b3355' : '#565a70', top = p.kind === 'jogger' ? pick(r, ['#ff8fab', '#7bd389', '#8fd3ff']) : p.coat;
  const step = frame % 2, lift = p.kind === 'jogger' ? 1 : 0;
  R2(4, 14 - lift * step, 2, 5, legs); R2(6, 14 - lift * (1 - step), 2, 5, legs);   // legs, swinging
  if (step) R2(4, 18, 2, 1, INK); else R2(6, 18, 2, 1, INK);
  R2(3, 8, 6, 7, top); R2(3, 14, 6, 1, 'rgba(29,26,47,.25)');                   // coat
  R2(4, 4, 4, 4, skin); R2(4, 3, 4, 2, hair);                                     // head: no face, just a shape
  if (!p.front) R2(4, 4, 4, 3, hair);
  if (p.umbrella) { R2(0, 0, 12, 2, '#565a70'); R2(2, -1, 8, 1, '#565a70'); R2(8, 2, 1, 8, '#3b3355'); }
  cache.set(key, c);
  return c;
}
const dogImg = (right, step) => { const k = `dog${right}${step}`; let c = cache.get(k); if (!c) { c = canvas(8, 6); const g = c.getContext('2d'); if (!right) { g.translate(8, 0); g.scale(-1, 1); } g.fillStyle = '#a8693f'; g.fillRect(1, 2, 5, 2); g.fillRect(5, 0, 2, 3); g.fillRect(1, 4, 1, 2 - step); g.fillRect(5, 4, 1, 1 + step); g.fillRect(0, 1, 1, 2); g.fillStyle = INK; g.fillRect(6, 1, 1, 1); cache.set(k, c); } return c; };

// items for the outdoor depth sort
export function townItems(T, isl) {
  const out = [];
  for (const p of T.people) out.push({ town: p, d: p.x + p.y });
  const c = T.car;
  if (c) { const p = isl.routes.street.E(c.u, c.lane); out.push({ car: c, at: p, len: isl.routes.street.len, d: p.x + p.y + 0.8 }); }
  return out;
}
export function drawTownsfolk(g, p, t, dark) {
  const sx = Math.round(SX(p.x, p.y)), sy = Math.round(SY(p.x, p.y)), frame = (p.t * p.speed * 5 | 0);
  g.globalAlpha = p.fade;
  ellipse(g, sx, sy, 3, 1, 'rgba(29,26,47,.18)');
  if (p.kind === 'cyclist') { // on a bike: two wheels and a frame, the rider leaning in
    F(g, sx - 5, sy - 3, 3, 3, INK); F(g, sx + 2, sy - 3, 3, 3, INK); F(g, sx - 3, sy - 5, 6, 1, '#e8505b');
    const img = figure({ ...p, kind: 'walker' }, 0); g.drawImage(img, 0, 0, 12, 14, sx - 6, sy - 18, 12, 14);
  } else {
    const img = figure(p, frame), bob = p.kind === 'jogger' ? frame % 2 : 0;
    if (p.right === false) { g.save(); g.translate(sx, 0); g.scale(-1, 1); g.drawImage(img, -6, sy - 19 - bob); g.restore(); } else g.drawImage(img, sx - 6, sy - 19 - bob);
  }
  if (p.dog) { const dx = Math.round(SX(p.dog.x, p.dog.y)), dy = Math.round(SY(p.dog.x, p.dog.y)); g.drawImage(dogImg(p.dog.right, frame % 2), dx - 4, dy - 6); F(g, Math.min(dx, sx), Math.min(dy - 4, sy - 9), 1, 1, INK); }
  if (dark > 0.5 && p.kind === 'cyclist') F(g, sx + (p.right ? 5 : -6), sy - 5, 1, 1, '#fff3b0');
  g.globalAlpha = 1;
}
const carCache = new Map();
export function drawCar(g, it, axis, dark) {
  const c = it.car, X = axis === 'x', out = c.state === 'out' || (c.state === 'turn' && c.turn > 0.5), L = c.bus ? 2.6 : 1.3, W = c.bus ? 0.8 : 0.6;
  const key = `${c.bus}${c.color}${X}${out}`;
  let s = carCache.get(key);
  if (!s) {
    const [x0, y0, x1, y1] = X ? [-L / 2, -W / 2, L / 2, W / 2] : [-W / 2, -L / 2, W / 2, L / 2];
    s = sprite(x0, y0, x1, y1, 0, c.bus ? 24 : 14, g2 => {
      ellipse(g2, 0, 2, c.bus ? 30 : 16, c.bus ? 10 : 6, 'rgba(29,26,47,.22)');
      const B = (a0, b0, a1, b1, z0, z1, col) => X ? box(g2, a0, b0, z0, a1, b1, z1, col) : box(g2, b0, a0, z0, b1, a1, z1, col);
      if (c.bus) { B(-L / 2, -W / 2, L / 2, W / 2, 3, 20, ['#fff3b0', '#f2c14e', '#d9a441']); B(-L / 2 + 0.1, -W / 2, L / 2 - 0.1, W / 2 + 0.01, 11, 17, ['#bfe6ff', '#8fd3ff', '#5b8def']); }
      else { B(-L / 2, -W / 2, L / 2, W / 2, 2, 8, c.color); B(-L / 4, -W / 2 + 0.05, L / 4, W / 2 - 0.05, 8, 13, ['#bfe6ff', '#8fd3ff', '#5b8def']); }
    });
    carCache.set(key, s);
  }
  const ox = SX(it.at.x, it.at.y), oy = SY(it.at.x, it.at.y);
  g.globalAlpha = clamp(1.8 - Math.max(0, c.u - it.len), 0, 1);
  g.drawImage(s.img, Math.round(ox + s.x), Math.round(oy + s.y));
  if (dark > 0.4) { const hx = ox + (out === X ? 1 : -1) * (c.bus ? 20 : 10), hy = oy + (out ? 4 : -4) * (X ? 1 : -1); F(g, Math.round(hx), Math.round(hy) - 5, 2, 1, '#fff3b0'); }
  g.globalAlpha = 1;
}
