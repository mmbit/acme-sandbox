// The mascots as drawn on the brownstone's roof. Who they are: world/mascots.js
import { SX, SY, CORE, CORE_X, roundWell, ellipse, text } from './iso.js';
import { pick, rand } from '../../util.js';
import { catFrame, penguinFrame } from './sprites.js';

// the kinds the brownstone draws: their frames (sit, loaf, sleep, walk1, walk2) and what they say to a pat; any other
// kind isn't in the building
export const ART = { cat: { frame: catFrame, sound: 'meow' }, penguin: { frame: penguinFrame, sound: 'squawk' } };
const pickR = arr => pick(Math.random, arr);

// L.pets (the mascots drawn here) on the roof by the penthouse, a step apart; each that sleeps at night gets a bed
export function addMascots(S) {
  const L = S.L, beds = bedSpots(L, L.pets.filter(m => m.rules.night === 'sleep').length);
  S.mascots = L.pets.map((m, i) => ({ data: m, x: 5.9 + i * 0.7, y: 1.3, lvl: L.nUp, goal: null, right: true, moves: m.moves,
    bed: m.rules.night === 'sleep' ? beds.shift() : null }));
}
// The first sleeper's is the basket rooms.js puts out on the roof garden; the next ones get the next clear spots along it.
function bedSpots(L, n) {
  const r = L.rooms.find(x => x.art?.anchors.basket);
  if (!r) return [];
  const out = [r.art.anchors.basket], X = r.wing !== 'y', len = X ? r.x1 - r.x0 : r.y1 - r.y0, d = 1.6;
  for (let a = 0.5; a < len - 0.3 && out.length < n; a += 0.1) {
    const p = X ? { x: r.x0 + a, y: d } : { x: d, y: r.y0 + a };
    if (r.art.space.clear(a - 0.3, d - 0.3, a + 0.3, d + 0.3) && out.every(b => Math.hypot(b.x - p.x, b.y - p.y) > 0.8)) out.push(p);
  }
  return out;
}

// From one arm of the roof's L to the other, a straight line would cut across the corner, off the building: go by
// way of the penthouse, and round the stairwell on every stretch.
const HUB = { x: 2.3, y: 2.6 }, arm = p => p.x >= CORE_X ? 'x' : p.y >= CORE ? 'y' : 'core';
const leg = (p, q) => [...roundWell(p, q), q];
const route = (c, to) => arm(c) !== arm(to) && arm(c) !== 'core' && arm(to) !== 'core' ? [...leg(c, HUB), ...leg(HUB, to)] : leg(c, to);
// Where each is off to: its bed while it sleeps, else a new spot on a terrace each time it moves on (world.mascots).
// It stays put once there, and where a pat stops it.
export function updateMascots(S, dt) {
  for (const c of S.mascots) {
    const bed = c.data.activity === 'sleep' && c.bed;
    if (bed ? c.to !== bed : c.moves !== c.data.moves) {
      c.moves = c.data.moves; c.to = bed || spot(S.L);
      c.path = c.to ? route(c, c.to) : []; c.goal = c.path.shift();
    }
    if (!c.goal) continue;
    const dx = c.goal.x - c.x, dy = c.goal.y - c.y, d = Math.hypot(dx, dy), v = 0.5 * dt;
    if (d <= v) { c.x = c.goal.x; c.y = c.goal.y; c.goal = c.path.shift(); }
    else { c.x += dx / d * v; c.y += dy / d * v; c.right = dx - dy > 0; }
  }
}
// A spot on a terrace (null: none clear). Near the penthouse: the ends of the terraces that touch it; never where
// something stands (the jacuzzi, the loungers), so it doesn't end up sitting on the water.
function spot(L) {
  const terr = L.rooms.filter(r => r.level === L.nUp && r.kind === 'terrace'), r = pickR(terr.length ? terr : [L.level(L.nUp).rooms[0]]), X = r.wing !== 'y';
  for (let k = 0; k < 12; k++) {
    const a = Math.min(rand(0.3, 4.5), (X ? r.x1 - r.x0 : r.y1 - r.y0) - 0.3), d = rand(1.1, 2.7), at = (X ? r.x0 : r.y0) + a;
    if (!r.art?.space || r.art.space.clear(a - 0.3, d - 0.3, a + 0.3, d + 0.3)) return X ? { x: at, y: d } : { x: d, y: at };
  }
  return null;
}

// z: the roof's
export function drawMascot(g, c, t, z) {
  const sx = Math.round(SX(c.x, c.y)), sy = Math.round(SY(c.x, c.y, z));
  const a = c.data.activity, frame = c.goal ? ((t * 6 | 0) % 2 ? 'walk1' : 'walk2') : a === 'sleep' || a === 'nap' ? 'sleep' : a === 'loaf' ? 'loaf' : 'sit';
  ellipse(g, sx, sy, 5, 2, 'rgba(29,26,47,.2)');
  g.drawImage(ART[c.data.kind].frame(frame, c.right), sx - 7, sy - 10);
  c.hit = { x0: sx - 8, y0: sy - 14, x1: sx + 8, y1: sy + 2, sx, sy: sy - 12 };
  if (frame === 'sleep') for (let k = 0; k < 2; k++) { const p = (t * 0.35 + k / 2) % 1; g.globalAlpha = 1 - p; text(g, 'z', sx + 4 + Math.round(p * 5), sy - 12 - Math.round(p * 10), '#8fd3ff'); g.globalAlpha = 1; }
}
