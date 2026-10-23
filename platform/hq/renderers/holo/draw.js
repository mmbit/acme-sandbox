// The hologram, frame by frame, as glowing lines, triangles and points (gl.js' batches): the core and the board on
// its rings, each room's platform and its people, hand-offs, parcels, mascots, the radar, the crown, the room around
// the table, the sky's weather and the particles.
import { rng, rgb } from '../../util.js';
import { TAU, add, sub, scl, mix3, nrm, polar, sstep, begin, line, pt, tri, arc, dashes, disc } from './gl.js';
import { TABLE_Y, TABLE_R, RING_R, CORE, CROWN_Y, CYAN, TEAL, AMBER, MAG, WHITE, GOLD, VIOLET, CORAL, MASCOT, built, agentAt, agentColour, coreRing, mascotAt } from './deck.js';

const C4 = (c, a) => [c[0], c[1], c[2], a];
const hash = n => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const PARTY = [MAG, GOLD, TEAL, CORAL, VIOLET];
// the crown's dashes on the days the company decorates for (in turn)
const HOLIDAY = { halloween: [AMBER, VIOLET], christmas: [CORAL, TEAL], sinterklaas: [CORAL, GOLD], pakjesavond: [CORAL, GOLD], newYear: [GOLD, WHITE], birthday: [MAG, GOLD] };

// the icosphere at the heart of the core (its vertices and edges, made once)
const ICO = (() => {
  const t = (1 + Math.sqrt(5)) / 2, v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(nrm);
  const faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const mid = new Map(), m = (a, b) => { const k = a < b ? `${a},${b}` : `${b},${a}`; if (!mid.has(k)) { v.push(nrm(scl(add(v[a], v[b]), 0.5))); mid.set(k, v.length - 1); } return mid.get(k); };
  const edges = new Set();
  for (const [a, b, c] of faces) { const ab = m(a, b), bc = m(b, c), ca = m(c, a); for (const [x, y, z] of [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]) for (const [p, q] of [[x, y], [y, z], [z, x]]) edges.add(p < q ? `${p},${q}` : `${q},${p}`); }
  return { v, e: [...edges].map(s => s.split(',').map(Number)) };
})();
// Seeded specks: dust in the beam and the room, stars past the walls
const R = rng('holo');
const DUST = Array.from({ length: 640 }, (_, i) => ({ a: R() * TAU, rf: Math.sqrt(R()), y0: R(), sp: 0.03 + R() * 0.07, tw: R() * TAU, s: 0.008 + R() * 0.018, room: i >= 460 }));
const STARS = Array.from({ length: 140 }, () => ({ a: R() * TAU, y: 1.2 + R() * 2.2, tw: R() * TAU, s: 0.04 + R() * 0.08 }));

export function hologram(S, t, eye, detail) {
  begin();
  core(S, t, eye);
  for (const [i, r] of S.rooms.entries()) room(S, r, t, S.party > 0 ? mix3(r.col, PARTY[(i + Math.floor(t * 3)) % 5], Math.min(1, S.party)) : r.col);
  for (const f of S.flights) flight(S, f, t);
  for (const p of S.parcels) parcel(p, S.t);
  if (S.machine) rig(S, t);
  for (const c of S.mascots) mascot(c, t);
  for (const p of S.parts) if (p.k === 'spark') { pt(p.p, C4(p.c, 2.2 * Math.min(1, p.life)), 0.04); line(p.p, sub(p.p, scl(p.v, 0.05)), C4(p.c, 0.8 * Math.min(1, p.life))); }
  for (const u of S.pulses) { const f = (S.t - u.t0) / 0.9; if (f < 1) arc(u.c, u.r * (1 + f * 1.4), C4(u.col, 1.6 * (1 - f)), 0, TAU, 48); }
  blade(S.sweep);
  crown(S, t);
  walls(S, t);
  weather(S, t);
  dust(t, detail);
}

// ---- the core: the board, a wireframe sphere with its members riding its rings; coral while requests wait
function core(S, t, eye) {
  const turn = t * 0.28, at = v => add(CORE, scl(rotY(v, turn), 0.34)), pulse = 0.8 + 0.2 * Math.sin(t * 3.1);
  for (const [a, b] of ICO.e) {
    const pa = at(ICO.v[a]), pb = at(ICO.v[b]), facing = 0.35 + 0.65 * Math.max(0, Math.min(1, 0.5 + 0.5 * dotN(sub(scl(add(pa, pb), 0.5), CORE), sub(eye, CORE))));
    line(pa, pb, C4(CYAN, 0.55 * facing));
  }
  for (const v of ICO.v) pt(at(v), C4(WHITE, 0.7), 0.035);
  const flash = S.core?.flash ?? 0;
  pt(CORE, C4(WHITE, (3.0 + flash * 3) * pulse), 0.20); pt(CORE, C4(CYAN, 0.55), 1.1); pt(CORE, C4(CYAN, 0.12), 3.2);
  for (let k = 0; k < 3; k++) {
    const rr = 0.52 + k * 0.08;
    let prev = null;
    for (let i = 0; i <= 96; i++) { const p = add(CORE, coreRing(k, t, polar(rr, i / 96 * TAU, 0))); if (prev) line(prev, p, C4(k === 1 ? AMBER : CYAN, k === 1 ? 0.35 : 0.45)); prev = p; }
  }
  if (S.requests) { const b = 0.5 + 0.5 * Math.sin(t * 4); arc(add(CORE, [0, -0.02, 0]), 0.78 + 0.03 * b, C4(CORAL, 0.6 + 1.2 * b), 0, TAU, 96); pt(CORE, C4(CORAL, 0.25 * b), 2.2); }
  // the pillar of light from the lens, data rising up it
  line([0, TABLE_Y + 0.01, 0], add(CORE, [0, -0.36, 0]), C4(CYAN, 0.9), C4(CYAN, 0.4));
  for (let i = 0; i < 26; i++) { const f = (i / 26 + t * 0.35) % 1; pt([0, TABLE_Y + 0.02 + (CORE[1] - 0.3 - TABLE_Y) * f, 0], C4(CYAN, 0.8 * Math.sin(f * Math.PI)), 0.035); }
  pt([0, TABLE_Y + 0.03, 0], C4(CYAN, 0.9), 0.9);
  if (S.core) for (const P of S.people.values()) if (P.room === S.core) person(S, P, t, P.room.col);
}
const rotY = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; };
const dotN = (a, b) => { const x = nrm(a), y = nrm(b); return x[0] * y[0] + x[1] * y[1] + x[2] * y[2]; };

// ---- a room: its glass plate and rings, printing itself while new, dim while everyone in it sleeps
function room(S, r, t, col) {
  const C = r.pos, a = r.a, np = built(S, r), RP = r.rp;
  let ringP = 1, vis = 1, flick = 1;
  if (np < 1) {
    // a scan plane rises from the table, printing the column under it; the core's beam commissions it; then the rings draw in
    const sp = sstep(0.05, 0.62, np), top = TABLE_Y + (C[1] - TABLE_Y) * sp, S0 = [C[0], top, C[2]], R2 = RP * 1.45, fade = 1 - 0.75 * sstep(0.9, 1, np);
    ringP = sstep(0.58, 0.85, np); vis = sstep(0, 0.1, np); flick = hash(Math.floor(t * 24) + r.a) > 0.25 ? 1 : 0.25;
    if (sp < 1) {
      arc(S0, R2, C4(MAG, 1.8), 0, TAU, 72); arc(S0, R2 * 1.08, C4(MAG, 0.5), 0, TAU, 72); disc(S0, 0, R2, C4(MAG, 0.2), C4(MAG, 0.05), 40);
      const tg = [Math.cos(a), 0, -Math.sin(a)], out = polar(1, a, 0);
      for (let k = -7; k <= 7; k++) { const o = k / 7 * R2, hw = Math.sqrt(Math.max(R2 * R2 - o * o, 0)); line(add(S0, add(scl(out, o), scl(tg, -hw))), add(S0, add(scl(out, o), scl(tg, hw))), C4(MAG, 0.35)); }
      pt(S0, C4(MAG, 0.5), 1.2);
    }
    for (let y = TABLE_Y + 0.04; y < top; y += 0.045) arc([C[0], y, C[2]], RP * 0.42, C4(MAG, (0.1 + 0.5 * Math.exp(-(top - y) * 6)) * flick * fade), 0, TAU, 32);
    for (let k = 0; k < 6; k++) { const o = polar(RP * 0.42, k / 6 * TAU + t * 0.3, 0); line(add([C[0], TABLE_Y, C[2]], o), add(S0, o), C4(MAG, 0.35 * flick * fade)); }
    line(CORE, S0, C4(MAG, 0.35 * flick), C4(MAG, 0.9));
    for (let i = 0; i < 8; i++) { const f = (i / 8 + t * 0.9) % 1; pt(mix3(CORE, S0, f), C4(MAG, 1.2 * Math.sin(f * Math.PI)), 0.05); }
    if (ringP <= 0) { arc([C[0], TABLE_Y + 0.004, C[2]], RP * 0.7, C4(MAG, 0.8), a, a + TAU * sstep(0, 0.2, np), 64); return; }
    col = mix3(MAG, col, sstep(0.85, 1, np));
  }
  const dark = r.w.asleep ? 0.35 : 1, I = (0.55 + 0.7 * r.act + 1.2 * r.flash) * vis * flick * dark;
  const I2 = I * (1 + Math.exp(-(((S.sweep - a) % TAU + TAU) % TAU) * 2) * 0.8), hue = r.w.asleep ? mix3(col, VIOLET, 0.6) : col;
  disc(C, 0, RP, C4(hue, 0.03 * I2), C4(hue, 0.16 * I2), 48, a, a + TAU * ringP);
  arc(C, RP, C4(hue, I2), a, a + TAU * ringP, 72);
  dashes(C, RP * 0.66, C4(hue, 0.55 * I), 20, 0.5, -t * 0.5 + r.a * 3);
  for (let k = 0; k < 3; k++) { const s = t * 0.35 + k * TAU / 3 + r.a * 3; arc(C, RP * 1.14, C4(hue, 0.45 * I), s, s + 0.9 * ringP, 32); }
  for (let k = 0; k < 36 * ringP; k++) { const o = polar(1, k / 36 * TAU - t * 0.1, 0); line(add(C, scl(o, RP * 1.22)), add(C, scl(o, RP * (k % 3 ? 1.26 : 1.31))), C4(hue, 0.35 * I)); }
  // the load gauge (amber): how many here are working
  const load = 0.2 + 0.75 * r.act;
  arc([C[0], C[1] - 0.012, C[2]], RP * 1.38, C4(AMBER, 0.9 * vis * flick * dark), a - Math.PI * load, a - Math.PI * load + TAU * load * ringP, 64);
  if (r.flash > 0) arc(C, RP * (1 + (1 - r.flash) * 1.3), C4(AMBER, 1.6 * r.flash), 0, TAU, 64);
  // its tether to the table, footprint, and the projector's rays up to it
  const G = [C[0], TABLE_Y + 0.004, C[2]], tg = [Math.cos(a), 0, -Math.sin(a)], L0 = polar(0.3, a, TABLE_Y + 0.01);
  line(G, [C[0], C[1] - 0.01, C[2]], C4(hue, 0.18 * vis), C4(hue, 0.6 * vis));
  for (let i = 0; i < 5; i++) { const f = (i / 5 + t * 0.6 + r.a) % 1; pt(mix3([C[0], C[1] - 0.02, C[2]], G, f), C4(hue, 0.9 * Math.sin(f * Math.PI) * vis), 0.03); }
  arc(G, RP * 0.7, C4(hue, 0.55 * vis), a, a + TAU * ringP, 48); arc(G, RP * 0.25, C4(hue, 0.8 * vis), 0, TAU, 24);
  line(L0, add(C, scl(tg, RP)), C4(hue, 0.035 * vis), C4(hue, 0.1 * vis)); line(L0, add(C, scl(tg, -RP)), C4(hue, 0.035 * vis), C4(hue, 0.1 * vis));
  if (ringP < 1) return;
  for (const P of S.people.values()) if (P.room === r) person(S, P, t, col);
}

// ---- a person: a light with a trail, as high, quick and bright as they're busy, and their blip on the radar
function person(S, P, t, col) {
  const m = P.m, p = agentAt(S, P), c = agentColour(P), pulse = 0.75 + 0.25 * Math.sin(t * 7 + P.yaw * 3), bright = 0.18 + 0.82 * m.glow * (0.6 + 0.4 * pulse);
  const blink = m.rim > 0.5 ? 0.6 + 0.4 * Math.sin(t * 5 + P.yaw) : 1, breathe = m.sleep > 0.5 ? 0.6 + 0.4 * Math.sin(t * 1.2 + P.yaw) : 1;
  pt(p, C4(c, 4 * bright * blink * breathe), 0.06); pt(p, C4(col, 0.3 * bright), 0.28);
  const n = Math.round(22 * m.trail), stepA = P.sp * (0.06 + 0.94 * m.spin) * 0.038;
  let prev = p;
  for (let k = 1; k <= n; k++) { const q = agentAt(S, P, P.ang - k * stepA), f = 1 - k / (n + 1); line(prev, q, C4(mix3(col, WHITE, 0.3), 1.6 * f * bright)); pt(q, C4(col, 0.8 * f * f * bright), 0.03 * f + 0.008); prev = q; }
  const age = S.t - P.spawn;
  if (age >= 0 && age < 0.6) { const f = 1 - age / 0.6; pt(p, C4(WHITE, 1.4 * f), 0.22 * f + 0.06); arc(p, 0.05 + age * 0.6, C4(MAG, 2 * f), 0, TAU, 32); }
  if (P.room !== S.core) { const since = (((S.sweep - Math.atan2(p[0], p[2])) % TAU) + TAU) % TAU; pt([p[0], TABLE_Y + 0.006, p[2]], C4(CYAN, 1.4 * Math.exp(-since * 1.2) + 0.08), 0.035); }
}

// ---- a hand-off: an arc of light from one person to another (or the board), its head leaving a tail
export function flightEnds(S, f) {
  const at = (id, or) => id === 'board' || S.people.get(id)?.room === S.core ? add(CORE, [0, -0.1, 0]) : S.people.has(id) ? agentAt(S, S.people.get(id)) : or;
  const src = at(f.a, add(CORE, [0, -0.1, 0])), dst = at(f.b, f.room ? add(f.room.pos, [0, 0.12, 0]) : [0, CROWN_Y, 0]), mid = scl(add(src, dst), 0.5), dist = Math.hypot(...sub(src, dst));
  return [src, [mid[0] * 0.45, Math.max(src[1], dst[1]) + 0.35 + dist * 0.32, mid[2] * 0.45], dst];
}
const bez = (p0, p1, p2, s) => { const u = 1 - s; return add(add(scl(p0, u * u), scl(p1, 2 * u * s)), scl(p2, s * s)); };
const easeIO = s => s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2;
function flight(S, f, t) {
  const s = (S.t - f.t0) / f.dur, [p0, p1, p2] = flightEnds(S, f), fade = sstep(-0.1, 0.1, s) * (1 - sstep(1, 1.25, s));
  let prev = p0;
  for (let i = 1; i <= 40; i++) { const q = bez(p0, p1, p2, i / 40); line(prev, q, C4(f.col, 0.2 * fade)); prev = q; }
  if (s < 0 || s > 1) return;
  const e = easeIO(s), tail = Math.max(0, e - 0.4);
  prev = bez(p0, p1, p2, tail);
  for (let i = 1; i <= 24; i++) { const k = i / 24, q = bez(p0, p1, p2, tail + (e - tail) * k); line(prev, q, C4(f.col, 2.2 * k * k)); pt(q, C4(f.col, 0.9 * k * k), 0.035); prev = q; }
  const head = bez(p0, p1, p2, e);
  pt(head, C4(mix3(f.col, WHITE, 0.5), 5), 0.07); pt(head, C4(f.col, 0.45), 0.4);
  if (s < 0.2) pt(p0, C4(f.col, 2.5 * (1 - s / 0.2)), 0.2);
}

// ---- a parcel from a busy loading dock: down the tether, then out along the table and over the edge
export const PARCEL_S = 3;
function parcel({ room, t0 }, now) {
  const f = (now - t0) / PARCEL_S, C = room.pos, out = polar(1, room.a, 0);
  const p = f < 0.3 ? [C[0], C[1] - (C[1] - TABLE_Y - 0.03) * sstep(0, 0.3, f), C[2]] : polar(RING_R + (TABLE_R + 0.25 - RING_R) * (f - 0.3) / 0.7, room.a, TABLE_Y + 0.03);
  const a = 1.4 * (1 - sstep(0.85, 1, f)), s = 0.035, x = scl(out, s), z = scl([out[2], 0, -out[0]], s), y = [0, s, 0];
  const v = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]].map(([i, j, k]) => add(p, add(add(scl(x, i), scl(y, j)), scl(z, k))));
  for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) line(v[i], v[j], C4(AMBER, a));
  pt(p, C4(AMBER, 0.4 * a), 0.2);
}

// ---- the rig (the company's lent machine, world.machine): a wireframe box beside the server room's platform, as big as
// the build is and in its lights' colour (violet without one), dim while it waits for work, dark while it's away, pulsing
// with data down its link while a run is on it.
const RIG_SIZE = { 1: 0.035, 2: 0.045, 3: 0.056 };
function rig(S, t) {
  const r = S.rooms.find(x => x.w.kind === 'server');
  if (!r || built(S, r) < 1) return;
  const out = polar(1, r.a, 0), C = add(r.pos, add(scl(out, r.rp * 1.7), [0, 0.07, 0])), run = !!S.machine.running;
  const a = run ? 1.3 + 0.5 * Math.sin(t * 6) : S.machine.present ? 0.55 : 0.12, s = RIG_SIZE[S.machine.size];
  const col = S.machine.glow ? rgb(S.machine.glow).map(v => v / 255) : VIOLET;
  const x = scl(out, s), z = scl([out[2], 0, -out[0]], s), y = [0, s, 0];
  const v = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]].map(([i, j, k]) => add(C, add(add(scl(x, i), scl(y, j)), scl(z, k))));
  for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) line(v[i], v[j], C4(col, a));
  pt(C, C4(col, 0.35 * a), run ? 0.35 : 0.15);
  const P = add(r.pos, scl(out, r.rp * 1.15));
  line(C, P, C4(col, 0.25 * a));
  if (run) for (let i = 0; i < 4; i++) { const f = (i / 4 + t * 0.8) % 1; pt(mix3(C, P, f), C4(WHITE, 1.2 * Math.sin(f * Math.PI)), 0.04); }
}

// ---- mascots: a wireframe of the kinds the deck knows (side-view lines, stood up in 3D), a crystal for any other
const ring8 = (cx, cy, r) => Array.from({ length: 11 }, (_, i) => [cx + Math.cos(i / 10 * TAU) * r, cy + Math.sin(i / 10 * TAU) * r]);
const CAT = {
  sit: [[[-0.04, 0], [-0.055, 0.05], [-0.03, 0.1], [0.015, 0.12]], [[0.03, 0], [0.04, 0.06], [0.03, 0.11]], [[-0.04, 0], [0.03, 0]], [[-0.04, 0.005], [-0.01, -0.005], [0.05, 0.01]],
    ring8(0.035, 0.145, 0.028), [[0.018, 0.162], [0.02, 0.19], [0.035, 0.172]], [[0.042, 0.172], [0.055, 0.19], [0.058, 0.16]]],
  walk: w => [[[-0.09, 0.07], [-0.05, 0.085], [0.03, 0.085], [0.07, 0.075]], [[-0.09, 0.05], [0.07, 0.05]],
    [[-0.07, 0.05], [-0.07 + w, 0]], [[-0.05, 0.05], [-0.05 - w, 0]], [[0.04, 0.05], [0.04 + w, 0]], [[0.06, 0.05], [0.06 - w, 0]],
    ring8(0.095, 0.1, 0.028), [[0.078, 0.117], [0.08, 0.145], [0.093, 0.127]], [[0.1, 0.127], [0.112, 0.145], [0.113, 0.113]], [[-0.09, 0.07], [-0.12, 0.09], [-0.13, 0.12], [-0.12, 0.14]]],
  sleep: [Array.from({ length: 13 }, (_, i) => [Math.cos(i / 12 * TAU) * 0.07, 0.035 + Math.sin(i / 12 * TAU) * 0.035]), ring8(0.05, 0.05, 0.024),
    [[0.038, 0.066], [0.04, 0.085], [0.05, 0.072]], [[-0.07, 0.03], [-0.06, 0.0], [0.0, -0.005], [0.04, 0.005]]],
};
// a penguin stood up: an egg of a body, the white front inside it, a flipper, a beak, feet; asleep, the head sinks and the
// beak tucks in; walking, it rocks from foot to foot (w, -1 to 1: the lean, sheared from the feet up, and the foot it's off)
const egg = (cy, rx, ry) => Array.from({ length: 15 }, (_, i) => [Math.cos(i / 14 * TAU) * rx * (Math.sin(i / 14 * TAU) > 0 ? 0.85 : 1), cy + Math.sin(i / 14 * TAU) * ry]);
const penguin = (w, asleep) => {
  const h = asleep ? -0.02 : 0, lean = poly => poly.map(([x, y]) => [x + w * y * 0.15, y]);
  return [egg(0.07, 0.042, 0.07), [[0.012, 0.012], [0.034, 0.05], [0.032, 0.1], [0.02, 0.125 + h]], [[-0.022, 0.11], [-0.05, 0.05], [-0.03, 0.075]],
    ring8(0.004, 0.155 + h, 0.029), asleep ? [[0.026, 0.13], [0.04, 0.11], [0.02, 0.115]] : [[0.03, 0.163], [0.064, 0.155], [0.03, 0.146]],
    asleep ? [[0.008, 0.14], [0.02, 0.138]] : ring8(0.016, 0.165, 0.005), [[0.0, Math.max(0, w) * 0.012], [0.035, 0]], [[-0.025, Math.max(0, -w) * 0.012], [0.01, 0]]].map(lean);
};
const PENGUIN = { sit: penguin(0, false), sleep: penguin(0, true) };
export const ART = { cat: { lines: (c, t) => c.data.activity === 'sleep' || c.data.activity === 'nap' ? CAT.sleep : c.walking ? CAT.walk(Math.sin(t * 12) * 0.014) : CAT.sit, sound: 'meow' },
  penguin: { lines: (c, t) => c.data.activity === 'sleep' || c.data.activity === 'nap' ? PENGUIN.sleep : c.walking ? penguin(Math.sin(t * 12), false) : PENGUIN.sit, sound: 'squawk' } };
function mascot(c, t) {
  const p = mascotAt(c), art = ART[c.data.kind], love = c.data.love > 0, col = love ? MAG : c.data.activity === 'sleep' ? mix3(MASCOT, VIOLET, 0.5) : MASCOT;
  arc(p, 0.1, C4(col, 0.35), 0, TAU, 32);
  if (!art) { // a crystal, turning
    const y = 0.12 + 0.02 * Math.sin(t * 2), v = [0, 1, 2, 3].map(i => add(p, polar(0.05, i / 4 * TAU + t, y))), top = add(p, [0, y + 0.07, 0]), bot = add(p, [0, y - 0.07, 0]);
    for (let i = 0; i < 4; i++) { line(v[i], v[(i + 1) % 4], C4(col, 1.2)); line(v[i], top, C4(col, 1)); line(v[i], bot, C4(col, 1)); }
    pt(add(p, [0, y, 0]), C4(col, 1.2), 0.12);
    return;
  }
  const head = c.a + (c.right ? Math.PI / 2 : -Math.PI / 2), fwd = polar(1.3, head, 0), side = polar(1.3, head + Math.PI / 2, 0);
  const place = ([x, y], z) => add(p, add(add(scl(fwd, x), [0, y * 1.3, 0]), scl(side, z)));
  for (const poly of art.lines(c, t)) for (let i = 1; i < poly.length; i++) {
    for (const z of [-0.018, 0.018]) line(place(poly[i - 1], z), place(poly[i], z), C4(col, 1.1));
    if (i % 2) line(place(poly[i], -0.018), place(poly[i], 0.018), C4(col, 0.4));
  }
}

// ---- the radar's blade: a curtain of light sweeping round with the table's radar
function blade(sweep) {
  for (let k = 0; k < 14; k++) {
    const a0 = sweep - k * 0.045, a1 = sweep - (k + 1) * 0.045, P = (a, y) => polar(2.25, a, y), z = C4(CYAN, 0);
    tri(P(a0, TABLE_Y), P(a0, TABLE_Y + 1.55), P(a1, TABLE_Y + 1.55), C4(CYAN, 0.07 * Math.exp(-k * 0.22)), z, z);
    tri(P(a0, TABLE_Y), P(a1, TABLE_Y + 1.55), P(a1, TABLE_Y), C4(CYAN, 0.07 * Math.exp(-k * 0.22)), z, C4(CYAN, 0.07 * Math.exp(-(k + 1) * 0.22)));
  }
  const P = (r, y) => polar(r, sweep, y);
  for (let i = 0; i < 12; i++) { const r = 0.45 + 1.8 * i / 11; line(P(r, TABLE_Y + 0.01), P(r, TABLE_Y + 0.9 * (1 - i / 11 * 0.3)), C4(CYAN, 0.14), C4(CYAN, 0)); }
  tri(P(0.45, TABLE_Y), P(2.25, TABLE_Y), P(2.25, TABLE_Y + 1.2), C4(CYAN, 0.12), C4(CYAN, 0.12), C4(CYAN, 0));
  tri(P(0.45, TABLE_Y), P(2.25, TABLE_Y + 1.2), P(0.45, TABLE_Y + 1.2), C4(CYAN, 0.12), C4(CYAN, 0), C4(CYAN, 0));
}

// ---- the crown: the top of the projected volume, in the holiday's colours; the sun (or moon) rides it with the hour
function crown(S, t) {
  const R = 2.45, pair = [...S.holidays].map(h => HOLIDAY[h]).find(Boolean);
  for (let i = 0; i < 60; i++) { const a = t * 0.05 + i / 60 * TAU; arc([0, CROWN_Y, 0], R, pair ? C4(pair[i % 2], 0.5) : C4(CYAN, 0.22), a, a + 0.6 * TAU / 60, 4); }
  arc([0, CROWN_Y + 0.05, 0], R, C4(CYAN, 0.08), 0, TAU, 160);
  for (let k = 0; k < 4; k++) { const a = t * 0.05 + k * TAU / 4; arc([0, CROWN_Y, 0], R * 1.02, C4(AMBER, 0.6), a, a + 0.3, 24); }
  for (let k = 0; k < 8; k++) { const a = k / 8 * TAU + 0.2; line(polar(2.5, a, TABLE_Y + 0.02), polar(R, a, CROWN_Y), C4(CYAN, 0.09), C4(CYAN, 0.02)); }
  const sun = polar(R * 1.02, S.hour / 24 * TAU + Math.PI, CROWN_Y), day = S.day;
  pt(sun, C4(mix3(WHITE, GOLD, day), 1.5 + day), 0.09 + 0.05 * day); pt(sun, C4(mix3(CYAN, GOLD, day), 0.3), 0.5);
}

// ---- the room round the table: dark wall panels catching the glow, daylight in its high windows or the stars
function walls(S, t) {
  const day = S.day, r = 15;
  for (let i = 0; i < 72; i++) { const p = polar(r, i / 72 * TAU, 0); line(p, [p[0], 7, p[2]], C4(CYAN, 0.1 + 0.05 * day), C4(CYAN, 0)); }
  for (const y of [0.6, 3.2, 3.35]) arc([0, y, 0], r, C4(CYAN, y > 3 ? 0.07 : 0.12), 0, TAU, 144);
  if (day > 0.02) for (let i = 0; i < 72; i += 2) {
    const a0 = i / 72 * TAU, a1 = (i + 1.6) / 72 * TAU, lo = C4(mix3(WHITE, GOLD, 0.2), 0.05 * day), hi = C4(WHITE, 0.012 * day);
    tri(polar(r, a0, 0.8), polar(r, a1, 0.8), polar(r, a1, 3.1), lo, lo, hi); tri(polar(r, a0, 0.8), polar(r, a1, 3.1), polar(r, a0, 3.1), lo, hi, hi);
  }
  if (day < 0.98) for (const s of STARS) pt(polar(r + 3, s.a, s.y), C4(WHITE, (1 - day) * (0.35 + 0.35 * Math.sin(t * 2 + s.tw))), s.s);
}

// ---- the weather, over the whole room: rain streaks that splash on the floor or the table, snow, a haze of cloud
function weather(S, t) {
  const w = S.weather, drops = Math.round(240 * w.rain), flakes = Math.round(260 * w.snow), wind = 0.04 + 0.06 * w.rain;
  for (let i = 0; i < drops; i++) {
    const r = 0.6 + Math.sqrt(hash(i)) * 8.5, a = hash(i + 0.5) * TAU, f = (t * 0.9 + hash(i + 0.25)) % 1, floor = r < TABLE_R ? TABLE_Y : 0, y = floor + (1 - f) * 6;
    const p = polar(r, a, y);
    if (y > floor + 0.25) line(p, add(p, [wind, 0.28, 0]), C4(CYAN, 0.22), C4(CYAN, 0));
    else arc(polar(r, a, floor + 0.01), 0.1 * (1 - (y - floor) / 0.25), C4(CYAN, 0.5 * (y - floor) / 0.25 + 0.1), 0, TAU, 12);
  }
  for (let i = 0; i < flakes; i++) {
    const r = 0.4 + Math.sqrt(hash(i + 7)) * 8, a = hash(i + 7.5) * TAU + Math.sin(t * 0.3 + i) * 0.02, f = (t * 0.045 + hash(i + 7.25)) % 1;
    pt(add(polar(r, a, (1 - f) * 6), [Math.sin(t * 0.8 + i) * 0.12, 0, 0]), C4(WHITE, 0.5), 0.03 + hash(i) * 0.02);
  }
  if (w.cloud > 0.02) for (let i = 0; i < 40; i++) pt(polar(3 + hash(i + 3) * 7, hash(i + 3.5) * TAU + t * 0.01, 5.2 + hash(i) * 0.8), C4(mix3(CYAN, WHITE, 0.5), 0.05 * w.cloud), 1.4 + hash(i + 1) * 1.2);
}

// ---- dust in the beam and the room; detail < 1 (a small screen) draws less of it
function dust(t, detail) {
  for (let i = 0; i < DUST.length; i += detail < 1 ? 2 : 1) {
    const q = DUST[i];
    if (q.room) { const r = 3 + q.rf * 7, a = q.a + t * 0.01; pt(polar(r, a, ((q.y0 + t * q.sp * 0.3) % 1) * 4.5), C4(CYAN, 0.1 * (0.5 + 0.5 * Math.sin(t * 2 + q.tw))), q.s * 1.3); continue; }
    const f = (q.y0 + t * q.sp) % 1, rad = (0.3 + 2.15 * Math.pow(f, 0.8)) * q.rf, tw = Math.pow(0.5 + 0.5 * Math.sin(t * 3 + q.tw * 5), 4);
    pt(polar(rad, q.a + t * 0.04, TABLE_Y + 0.02 + (CROWN_Y - TABLE_Y) * f), C4(CYAN, (0.12 + 0.9 * tw) * Math.sin(f * Math.PI) * (1 - f)), q.s);
  }
}
