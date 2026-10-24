// The company on the holo deck: rooms, people, mascots, growth
import { rng, clamp, lerp } from '../../util.js';
import { TAU, polar, mix3, add } from './gl.js';

export const TABLE_Y = 0.9, TABLE_R = 2.62, RING_R = 1.85, CORE = [0, 3.05, 0], CROWN_Y = 3.9;
export const CYAN = [0.30, 0.86, 1.0], TEAL = [0.12, 1.0, 0.78], AMBER = [1.0, 0.56, 0.18], MAG = [1.0, 0.22, 0.72],
  WHITE = [0.85, 0.97, 1.0], GOLD = [1.0, 0.80, 0.42], VIOLET = [0.52, 0.42, 1.0], CORAL = [1.0, 0.36, 0.34], MASCOT = [1.0, 0.72, 0.45];
const SIZE = { s: 0.85, m: 1, l: 1.15 };
const BUILD_S = 4.6, INTRO_S = 1.6, INTRO_STEP = 0.22; // a new room prints in this long; the intro's rooms quicker, one after another
// what each state looks like, eased towards: lift (how high over the plate), spin, glow, trail, rim (waiting in
// line round the plate's edge, amber) and sleep (settled on the plate, violet)
const MOTION = {
  working: { lift: 1, spin: 1, glow: 1, trail: 1, rim: 0, sleep: 0 },
  idle: { lift: 0.1, spin: 0.08, glow: 0.22, trail: 0, rim: 0, sleep: 0 }, // low, dim, nearly still
  waiting: { lift: 0.08, spin: 0.18, glow: 0.7, trail: 0, rim: 1, sleep: 0 },
  sleeping: { lift: 0, spin: 0.04, glow: 0.14, trail: 0, rim: 0, sleep: 1 },
};
export const introLength = n => n * INTRO_STEP + INTRO_S + 0.3;

// The deck for the world's rooms now. Rooms and people already here keep where they are and what they were doing,
// and glide to their new places; a new room prints itself (or, in the intro, every room does, in turn); a newcomer
// flashes in.
export function layout(S, world, intro) {
  const ring = world.rooms.filter(r => !r.board), n = ring.length, fresh = !S.rooms, old = new Map((S.rooms || []).map(r => [r.id, r]));
  const rp = Math.min(0.36, RING_R * Math.sin(Math.PI / Math.max(n, 3)) * 0.8);
  S.half = Math.min(0.27, Math.PI / Math.max(n, 3) * 0.85); // a room's wedge on the table, either side of its angle
  let dept = 0;
  S.rooms = ring.map((w, i) => {
    const a = i / n * TAU + 0.12, y = 2.05 + 0.3 * Math.sin(i * 1.9 + 0.7), r = old.get(w.id) ?? { id: w.id, a, y, act: 0, flash: 0, ...born(S, fresh) };
    return Object.assign(r, { w, goal: a, yGoal: y, pos: polar(RING_R, r.a, r.y), rp: rp * (SIZE[w.size] ?? 1), col: !w.deptId ? GOLD : mix3(CYAN, TEAL, (dept++ % 3) / 2 * 0.8) });
  });
  if (fresh && intro) printIn(S);
  const board = world.rooms.find(r => r.board);
  S.core = board && { id: board.id, w: board, pos: CORE, rp: 0.34, col: WHITE, act: 0, flash: 0, built: 1 };
  const people = new Map();
  for (const room of [S.core, ...S.rooms].filter(Boolean)) room.w.agentIds.forEach((id, k) => {
    const P = S.people.get(id) ?? orbit(Object.create(world.agents.get(id)), fresh ? -99 : S.t);
    people.set(id, Object.assign(P, { room, k }));
  });
  S.people = people;
}
// when a room starts printing, and for how long: now when the org grows, long ago on a fresh deck (printIn: the intro)
const born = (S, fresh) => fresh ? { born: -99, dur: 1 } : { born: S.t, dur: BUILD_S, grown: true };
// every room prints itself in again, one after another, from now (the intro and the tour)
export function printIn(S) { S.rooms.forEach((r, i) => Object.assign(r, { born: S.t + 0.3 + i * INTRO_STEP, dur: INTRO_S, grown: false })); }
// an agent's own orbit (seeded by their id, so they fly the same way after a reload) and how they fly now
function orbit(P, spawn) {
  const R = rng(P.id);
  return Object.assign(P, {
    r: 0.3 + R() * 0.55, sp: (0.7 + R() * 1.1) * (R() < 0.5 ? -1 : 1), ang: R() * TAU, tilt: (R() - 0.5) * 0.9, yaw: R() * TAU,
    h: 0.1 + R() * 0.22, spawn, m: { ...MOTION[P.state] ?? MOTION.idle }, hit: null,
  });
}
// how far room r has printed: 0 .. 1 (done)
export const built = (S, r) => r.built ?? clamp((S.t - r.born) / r.dur, 0, 1);

// ---- motion
export function update(S, dt, world) {
  const k = 1 - Math.exp(-dt * 2), kk = 1 - Math.exp(-dt * 3);
  for (const r of S.rooms) {
    r.a += (((r.goal - r.a) % TAU + TAU * 1.5) % TAU - Math.PI) * kk; r.y = lerp(r.y, r.yGoal, kk);
    r.pos = polar(RING_R, r.a, r.y);
  }
  for (const r of [S.core, ...S.rooms].filter(Boolean)) {
    const people = r.w.agentIds.map(id => world.agents.get(id)).filter(Boolean);
    r.act = lerp(r.act, people.length ? people.filter(A => A.state === 'working').length / people.length : 0, k);
    r.flash = Math.max(0, r.flash - dt / 0.8);
  }
  for (const P of S.people.values()) {
    const want = MOTION[P.state] ?? MOTION.idle;
    for (const key in want) P.m[key] = lerp(P.m[key], want[key], k);
    P.ang += dt * P.sp * (0.06 + 0.94 * P.m.spin);
  }
}
// Where an agent is at orbit angle ang: round their room's platform, or on one of the core's rings for the board
export function agentAt(S, P, ang = P.ang) {
  const { room, m } = P;
  if (room === S.core) return add(CORE, coreRing(P.k % 3, S.t, polar(0.52 + (P.k % 3) * 0.08, ang, 0)));
  const rad = lerp(room.rp * P.r * (1 - 0.5 * m.sleep), room.rp * 0.92, m.rim), c = Math.cos(ang) * rad, s = Math.sin(ang) * rad;
  const cy = Math.cos(P.yaw), sy = Math.sin(P.yaw), free = 1 - Math.max(m.rim, m.sleep);
  const lift = 0.03 + P.h * m.lift + 0.02 * Math.sin(S.t * 1.3 + P.yaw) * free;
  return [room.pos[0] + c * cy - s * sy, room.pos[1] + lift + s * P.tilt * 0.3 * free, room.pos[2] + c * sy + s * cy];
}
// the core's three tilted rings, turning: p (in the ring's own plane) placed on ring k at time t
export function coreRing(k, t, p) {
  const rx = 1.2 + k * 0.5, rz = 0.4 * k + t * (0.2 + 0.1 * k), ry = k * 2.0 + t * 0.15;
  let [x, y, z] = p;
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  return [x * Math.cos(ry) + z * Math.sin(ry), y, -x * Math.sin(ry) + z * Math.cos(ry)];
}
// an agent's colour: their room's, amber while they wait, violet asleep
export const agentColour = P => mix3(mix3(mix3(P.room.col, WHITE, 0.55), AMBER, P.m.rim), VIOLET, P.m.sleep);

// ---- mascots: on the table top, by the rooms they favour; each kind the deck draws has a wireframe (draw.js), any
// other kind a small glowing crystal
export function addMascots(S, world) {
  const old = new Map((S.mascots || []).map(c => [c.data.id, c]));
  S.mascots = world.mascots.map((m, i) => old.get(m.id) ?? { data: m, r: 1.25, a: roomAngle(S, m.home) + 0.3 + i * 0.25, to: null, right: true, moves: -1 });
}
const roomAngle = (S, id) => S.rooms.find(r => r.id === id)?.a ?? 0;
// Off to a new spot each time it moves on (world.mascots): by the room it wants, or its home to sleep. It walks
// round the table (never through the projector), and stops where a pat stops it.
export function updateMascots(S, dt) {
  for (const c of S.mascots) {
    const m = c.data, sleep = m.activity === 'sleep';
    if (c.moves !== m.moves || sleep !== c.asleep) {
      const R = rng(`${m.id}${m.moves}`);
      c.moves = m.moves; c.asleep = sleep;
      c.to = sleep ? { r: 1.35, a: roomAngle(S, m.home) + 0.2 } : { r: 1.05 + R() * 0.95, a: roomAngle(S, m.want) + (R() - 0.5) * S.half * 2 };
    }
    if (!c.to || m.love) { c.walking = false; continue; }
    const da = ((c.to.a - c.a) % TAU + TAU * 1.5) % TAU - Math.PI, dr = c.to.r - c.r, arcLen = Math.abs(da) * c.r, d = Math.hypot(arcLen, dr), v = 0.22 * dt;
    c.walking = d > v;
    if (!c.walking) { c.a = c.to.a; c.r = c.to.r; c.to = null; continue; }
    c.a += da / d * v / c.r; c.r += dr / d * v; c.right = da > 0;
  }
}
export const mascotAt = c => polar(c.r, c.a, TABLE_Y + 0.005);
