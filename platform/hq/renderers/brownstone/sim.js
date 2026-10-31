// The living part of HQ: agents walking real routes (lanes, doorways, the elevator or the stairs),
// their errands, the elevator itself, the mascots on the roof (mascots.js), the delivery van, birds, ducks, weather
// and particles. Pure simulation: nothing here draws.
import { FH, STAIR, DOOR, PLAZA, ENTRANCE, CORE, roundWell } from './iso.js';
import { clamp, pick, rand } from '../../util.js';
import { darkness, weatherAt, season, today } from './env.js';
import { createTown, updateTown } from './town.js';
import { standBeside } from './layout.js';
import { addMascots, updateMascots } from './mascots.js';

const SPEED = 1.35;       // walking, tiles per second
const CLIMB = 4;          // on the stairs, treads per second: ~6 s a floor
// The elevator: px per second, how long the doors stay open, the longest they're held for people in
// the doorway, riders per trip, and how long anyone waits before taking the stairs instead.
const LIFT = { speed: 75, dwell: 1.6, hold: 6, cap: 4, giveUp: 25 };
const SLOTS = [[0.45, 0.5], [0.95, 0.5], [0.45, 0.95], [0.95, 0.95]]; // where riders stand in the cab
const STUCK = 20;         // s without progress mid-journey before the watchdog re-plans
const RESCUE = 120;       // a second rescue within this many seconds moves the agent to their desk
// Idle people mostly sit at their own desk: this long between errands (s), the
// first one spread over the same span so a fresh building doesn't empty at once. The errands, by how often each comes
// up: mostly a few steps away (the window, the coffee, a colleague's desk), now and then further (the sofa, the park).
const IDLE_SIT = [100, 220];
const IDLE_ERRANDS = ['window', 'window', 'window', 'coffee', 'coffee', 'coffee', 'desk', 'desk', 'plant', 'plant', 'news', 'sofa', 'stroll', 'mail'];
const pickR = arr => pick(Math.random, arr);
const go = p => ({ t: 'go', x: p.x, y: p.y });

// the stairs (see STAIR): round the spiral, from the foot on one floor to the head on the next; walks on a
// floor go round the back of its well

export function createSim(L, island, world) {
  const S = { L, island, world, t: 0, parts: [], lift: { z: 0, lvl: 0, target: null, dir: 0, doorT: 0, openT: 0, door: 0, riders: [], outs: new Set(), calls: new Set(), idle: 3 },
    van: { state: 'away', t: 6, u: 0 }, pigeons: [], flocks: [], weather: { kind: 'clear', rain: 0, snow: 0, wet: 0, cover: 0, wind: 0 }, people: new Map(), party: 0, rescues: 0, town: createTown() };
  // ground pigeons that scatter when someone walks by
  for (let i = 0; i < 4; i++) S.pigeons.push({ home: i % 2 ? island.walk[0] : island.walk[2], x: 0, y: 0, z: 0, fly: 0, t: rand(0, 5), dir: 1 });
  for (const p of S.pigeons) { p.x = p.home.x + rand(-0.6, 0.6); p.y = p.home.y + rand(-0.4, 0.4); }
  addMascots(S);
  // a robot vacuum in every storage room, on the open floor in front of the pallets (the back row)
  S.vacs = L.rooms.filter(r => r.kind === 'storage').map(room => {
    const X = room.wing !== 'y', [a0, a1] = X ? [room.x0, room.x1] : [room.y0, room.y1], d1 = X ? room.y1 : room.x1;
    const zone = { a0: a0 + 0.35, a1: a1 - 0.35, d0: 0.85, d1: d1 - 0.3 }, at = (a, d) => X ? { x: a, y: d } : { x: d, y: a };
    const dock = at(zone.a0 + 0.1, zone.d0 - 0.05);
    return { room, X, zone, at, dock, ...dock, h: 0, mode: 'charge', t: rand(2, 20), pause: 0 };
  });
  // the errands to pick from: with a cocktail bar in the building, a drink there now and then too
  S.errands = L.rooms.some(r => r.art?.anchors.stools?.length) ? [...IDLE_ERRANDS, 'bar', 'bar'] : IDLE_ERRANDS;
  return S;
}
// A new layout keeps the elevator where it was (settling on a floor), but nobody is inside any more.
export function carryLift(S, old) {
  const lvl = clamp(Math.round(old.lift.z / FH), -S.L.nDown, S.L.nUp);
  Object.assign(S.lift, { z: old.lift.z, lvl, target: old.lift.z === lvl * FH ? null : lvl });
  S.party = old.party;
}
// Leaving a building that's kept for later (build.js): nobody holds a place in it any more
export function leave(S) { for (const A of S.people.values()) release(A); }

// ---------------------------------------------------------------- geometry of a level
function zone(S, i, p) {
  const L = S.L, lv = L.level(i);
  if (i === 0 && (p.x >= L.X1 || p.y >= L.Y1 || (p.x >= lv.D && p.y >= lv.D))) {
    if (p.x < lv.D + 1 && p.y < lv.D + 1) return 'plaza';
    return p.y < lv.D + 1 ? 'ox' : 'oy';
  }
  if (p.x < lv.Cx && p.y < lv.Cy) return 'core';
  return p.y < lv.D ? 'x' : 'y';
}
export const outdoors = (S, A) => A.lvl === 0 && (z => z[0] === 'o' || z === 'plaza')(zone(S, 0, A));
function lanePt(S, i, z, p) {
  const lv = S.L.level(i), H = lv.hall.x;
  return { x: { x: p.x, y: lv.lane }, y: { x: lv.lane, y: p.y }, core: { x: H, y: H }, plaza: PLAZA, ox: { x: p.x, y: PLAZA.y }, oy: { x: PLAZA.x, y: p.y } }[z];
}
// the front door, just inside and just outside
const DOOR_IN = { x: ENTRANCE, y: CORE - 0.35 }, DOOR_OUT = { x: ENTRANCE, y: PLAZA.y };
// On one level: out to the lane, along it (through the hall or the plaza), and in again.
function pathSame(S, i, p, q) {
  const lv = S.L.level(i), H = lv.hall;
  const zp = zone(S, i, p), zq = zone(S, i, q), out = z => z[0] === 'o' || z === 'plaza';
  const pts = [lanePt(S, i, zp, p)];
  if (zp !== zq) {
    pts.push(out(zp) ? PLAZA : H);
    if (out(zp) !== out(zq)) pts.push(...(out(zp) ? [DOOR_OUT, DOOR_IN, H] : [DOOR_IN, DOOR_OUT, PLAZA]));
  }
  pts.push(lanePt(S, i, zq, q), q);
  const out2 = [];
  pts.filter((a, k) => !k || Math.hypot(a.x - pts[k - 1].x, a.y - pts[k - 1].y) > 0.05).forEach((a, k, arr) => out2.push(...roundWell(k ? arr[k - 1] : p, a), a));
  return out2.map(go);
}
// Walking steps from p on level `from` to level `to` by the stairs, one flight at a time. Returns the
// steps and where they end (on `to`).
function stairSteps(S, from, to, p) {
  const steps = [], up = to > from;
  for (let l = from; l !== to; l += up ? 1 : -1) {
    const here = STAIR.at(l), there = STAIR.at(l + (up ? 1 : -1));
    steps.push(...pathSame(S, l, p, STAIR.lane), ...(up ? here.toFoot : here.toHead).slice(1).map(go), { t: 'stairs', up, to: l + (up ? 1 : -1) },
      ...(up ? there.toHead : there.toFoot).slice(0, -1).reverse().map(go));
    p = STAIR.lane;
  }
  return { steps, end: p };
}
function route(S, A, q, lvl) {
  if (A.lvl === lvl) return pathSame(S, lvl, A, q);
  if (Math.abs(lvl - A.lvl) === 1 && Math.random() < 0.5) { const st = stairSteps(S, A.lvl, lvl, A); return [...st.steps, ...pathSame(S, lvl, st.end, q)]; }
  return [...pathSame(S, A.lvl, A, DOOR), { t: 'lift', to: lvl, phase: 'call' }, ...pathSame(S, lvl, DOOR, q)];
}

// ---------------------------------------------------------------- spots: one person each
// Sofa seats, benches, window spots, coffee machines, plants, newsstand places and the spot next to a
// colleague's desk are claimed when an errand is planned and released when it ends or is dropped.
const claim = (A, spot) => { release(A); spot.by = A.id; A.claim = spot; return spot; };
const release = A => { if (A.claim?.by === A.id) A.claim.by = null; A.claim = null; };
const free = spot => !spot.by;

// ---------------------------------------------------------------- agents
export function initAgent(S, A) {
  Object.assign(A, { plan: [], pose: 'stand', item: '', anim: Math.random() * 9, front: true, right: true, z: 0, idleT: A.data.board ? rand(2, 10) : rand(5, IDLE_SIT[1]), bubble: null, stillT: 0, rescuedAt: -1e9 }); // an idle person's first errand spread over IDLE_SIT
  const s = A.seat;
  A.x ??= s.x; A.y ??= s.y; A.lvl ??= s.level;
  decide(S, A);
}
function seatSteps(S, A) {
  const s = A.seat;
  return s.via ? [...route(S, A, s.via, s.level), go(s), { t: 'sit' }] : [...route(S, A, s, s.level), { t: 'sit' }];
}
// in the lift (beyond waiting for it) or on the stairs: plans wait until they're out
const inTransit = A => { const s = A.plan[0]; return !!s && ((s.t === 'lift' && s.phase !== 'call') || (s.t === 'stairs' && s.y != null)); };

// Plan what to do next from the agent's state.
export function decide(S, A) {
  if (inTransit(A)) { A.later = () => decide(S, A); return; }
  const had = A.claim;
  release(A);
  A.plan = []; A.item = A.item === 'paper' || A.item === 'cup' ? A.item : '';
  if (A.data.board) { A.plan = seatSteps(S, A); return; }
  // a meeting: its people go to its room while it runs, the first to the chairs round the table, everyone after them to
  // a place to stand past its far end (as many as come: anchors.stand); someone already in their place stays in it
  const room = meetingRoomOf(S, S.world.meetingOf(A.id));
  if (room) {
    const an = room.art.anchors, spot = an.meet.includes(had) && free(had) ? had : an.meet.find(free) ?? an.stand();
    const there = spot === had && A.lvl === spot.level && Math.hypot(A.x - spot.x, A.y - spot.y) < 0.05;
    claim(A, spot);
    const steps = there ? [] : spot.via.length ? [...route(S, A, spot.via[0], spot.level), ...spot.via.slice(1).map(go), go(spot)] : route(S, A, spot, spot.level);
    A.plan = [...steps, { t: 'do', pose: spot.pose, dur: Infinity, front: spot.front, right: spot.right, h: spot.h }];
    return;
  }
  // On Air: whoever is making an episode, and a free co-host of it, sits at a mic in the booth while it's made
  const W = S.world.agents.get(A.id);
  if (S.world.recording(W) || S.world.joining(W)) {
    const mic = S.L.rooms.flatMap(r => r.art?.anchors.mics ?? []).find(free);
    if (mic) { claim(A, mic); A.plan = [...route(S, A, mic, mic.level), { t: 'do', pose: 'sit', dur: Infinity, front: mic.front, right: mic.right, h: mic.h }]; return; }
  }
  if (A.state === 'waiting') {
    const r = A.room, q = [...S.people.values()].filter(B => B.room === r && B.state === 'waiting').indexOf(A);
    const X = r.wing !== 'y', lv = S.L.level(r.level), near = (X ? r.x0 : r.y0) + 0.5 + q * 0.5;
    const spot = X ? { x: near, y: lv.lane + 0.15 } : { x: lv.lane + 0.15, y: near };
    A.plan = [...route(S, A, spot, r.level), { t: 'do', pose: 'queue', dur: Infinity, front: false, right: !X }];
    return;
  }
  A.plan = seatSteps(S, A);
}
// The meeting room that holds a live meeting (null: none, or no room for it)
export const meetingRoomOf = (S, m) => (m && S.L.rooms.find(r => r.art?.anchors.meet && S.world.meetingsIn(r.src).includes(m))) || null;
export function errand(S, A, kind) {
  if (inTransit(A) || A.claim?.meet) return false; // (nobody leaves a meeting on an errand)
  const L = S.L, island = S.island, anchors = L.rooms.flatMap(r => r.art ? [r] : []);
  const near = list => list.filter(free).sort((a, b) => Math.abs(a.level - A.lvl) - Math.abs(b.level - A.lvl) || Math.random() - 0.5)[0];
  const go2 = (p, lvl) => route(S, A, p, lvl);
  const outdoorOk = darkness(S.hour) < 0.5;
  let plan = null, spot = null;
  if (kind === 'coffee') {
    spot = near(anchors.flatMap(r => r.art.anchors.coffee));
    if (spot) plan = [...go2(spot, spot.level), { t: 'do', pose: 'stand', dur: 3, front: false, right: spot.right, steam: spot.steam }, { t: 'hold', item: 'cup' }];
  } else if (kind === 'plant') {
    spot = near(anchors.flatMap(r => r.art.anchors.plants.filter(p => p.level >= 0 || A.lvl < 0)));
    if (spot) plan = [{ t: 'hold', item: 'can' }, ...go2(spot, spot.level), { t: 'do', pose: 'water', dur: 3.5, faceTo: { x: spot.px, y: spot.py }, water: spot }, { t: 'hold', item: '' }];
  } else if (kind === 'news') {
    const stand = L.rooms.find(r => r.art?.anchors.news)?.art.anchors.news;
    spot = stand && near(stand.spots);
    if (spot) plan = [...go2(spot, spot.level), { t: 'do', pose: 'stand', dur: 2.5, front: false, right: spot.right }, { t: 'hold', item: 'paper' }];
  } else if (kind === 'sofa') {
    spot = near(anchors.filter(r => r.level >= 0 && r !== A.room && !r.pent).flatMap(r => r.art.anchors.sofas || []));
    if (spot) plan = [...go2(spot.via, spot.level), go(spot), { t: 'do', pose: 'sit', dur: rand(6, 12), front: spot.front, right: spot.right, h: spot.h }];
  } else if (kind === 'bar') { // a drink on a stool at the cocktail bar, the stool's glass in hand
    spot = near(anchors.flatMap(r => r.art.anchors.stools || []));
    if (spot) plan = [...go2(spot, spot.level), { t: 'hold', item: spot.drink }, { t: 'do', pose: 'sit', dur: rand(10, 18), front: spot.front, right: spot.right, h: spot.h }, { t: 'hold', item: '' }];
  } else if (kind === 'stroll' && outdoorOk) {
    spot = near([...island.benches, ...island.walk]);
    if (spot) plan = [...go2(spot, 0), { t: 'do', pose: spot.front ? 'sit' : 'stand', dur: rand(5, 10), front: spot.front ?? true, right: spot.right ?? Math.random() < 0.5, h: spot.h }];
  } else if (kind === 'window') {
    spot = near(A.room.art.anchors.gaze);
    if (spot) plan = [...go2(spot, spot.level), { t: 'do', pose: 'stand', dur: rand(4, 7), front: false, right: A.room.wing !== 'y' }];
  } else if (kind === 'desk') { // A colleague at their desk: one in the same room if there is one, else on this floor
    const B = [...S.people.values()].filter(B => B !== A && !B.data.board && B.plan[0]?.t === 'sit' && B.lvl === A.lvl && free(visitSpot(B)))
      .sort((a, b) => (a.room === A.room ? 0 : 1) - (b.room === A.room ? 0 : 1) || Math.random() - 0.5)[0];
    spot = B && visitSpot(B);
    if (spot) plan = [...go2(spot, spot.level), { t: 'do', pose: 'stand', dur: rand(6, 10), faceTo: B, visit: true }];
  } else if (kind === 'mail' && outdoorOk && island.mailbox) {
    spot = near([island.mailbox]);
    if (spot) plan = [{ t: 'hold', item: 'paper' }, ...go2(spot, 0), { t: 'do', pose: 'stand', dur: 1.5, front: false, right: true }, { t: 'hold', item: '' }];
  }
  if (!plan) return false; // nothing free: carry on as before, keeping any spot already held
  claim(A, spot); // (and let go of the old one)
  A.plan = [...plan, { t: 'home' }];
  return true;
}

export function onChat(S, A, B) {
  if (!A || inTransit(A) || A.state === 'sleeping' || A.data.board || !B || A.plan.some(s => s.visit) || A.claim?.meet) return;
  if (A.room === B.room && Math.abs(A.x - B.x) + Math.abs(A.y - B.y) < 2.2) { A.faceTo = B; return; }
  if (A.state !== 'idle' || Math.random() < 0.25) return; // (someone at work or in the queue stays put: they only turn)
  const v = visitSpot(B); // visitSpot() shared with the 'desk' errand
  if (!free(v)) return;
  claim(A, v);
  A.plan = [...route(S, A, v, v.level), { t: 'do', pose: 'stand', dur: rand(7, 10), faceTo: B, visit: true }, { t: 'home' }];
  A.item = '';
}
// Where a visitor stands at B's desk (one at a time).
const visitSpot = B => { const s = B.seat; return s.visit ??= { ...(B.room.pent ? { x: s.x + 0.2, y: s.y + 1.55 } : { x: s.x + 0.55, y: s.y + 0.55 }), level: s.level }; };
// later: the shell's timer (its work is dropped with the scene)
export function onPost(S, later) {
  const pool = [...S.people.values()].filter(A => !A.data.board && A.state === 'idle').sort(() => Math.random() - 0.5);
  pool.slice(0, 3).forEach((A, k) => later(() => errand(S, A, 'news'), k * 1500));
}

function step(S, A, dt) {
  A.anim += dt;
  const s = A.plan[0];
  A.water = null;
  if (!s) { A.pose = A.pose === 'walk' ? 'stand' : A.pose; return; }
  if (s.t === 'go') {
    const dx = s.x - A.x, dy = s.y - A.y, d = Math.hypot(dx, dy), v = SPEED * dt * (outdoors(S, A) ? 1.1 : 1);
    if (d <= v) { A.x = s.x; A.y = s.y; A.plan.shift(); }
    else { A.x += dx / d * v; A.y += dy / d * v; A.front = dx + dy > 0; A.right = dx - dy > 0; }
    A.pose = 'walk';
  } else if (s.t === 'sit') {
    const seat = A.seat;
    A.x = seat.x; A.y = seat.y; A.front = seat.front; A.right = seat.right; A.sitH = seat.h;
    A.pose = A.state === 'working' ? 'type' : A.state === 'sleeping' ? 'sleep' : 'sit';
    if (A.data.board) {
      if ((A.idleT -= dt) <= 0) { A.idleT = rand(18, 35); boardStroll(S, A); }
    } else if (A.state === 'idle') { // (only the idle get up: someone at work stays at their screen)
      if ((A.idleT -= dt) <= 0) { A.idleT = rand(...IDLE_SIT); errand(S, A, pickR(S.errands)); } // (S.errands)
    }
  } else if (s.t === 'do') {
    s.left ??= s.dur;
    A.pose = s.pose; A.sitH = s.h;
    if (s.faceTo) { const dx = s.faceTo.x - A.x, dy = s.faceTo.y - A.y; A.front = dx + dy > -0.05; A.right = dx - dy > 0; } // level with us on screen: face the viewer
    else if (s.front != null) { A.front = s.front; A.right = s.right; }
    if (s.steam && Math.random() < dt * 6) S.parts.push({ k: 'steam', x: s.steam.x, y: s.steam.y, z: s.steam.z, lvl: A.lvl, life: 1.6, vz: 8 });
    if (s.water) A.water = s.water; // the renderer pours from the can into the pot
    if ((s.left -= dt) <= 0) {
      A.plan.shift();
      if (s.water) for (let i = 0; i < 5; i++) S.parts.push({ k: 'twinkle', x: s.water.px + rand(-0.12, 0.12), y: s.water.py + rand(-0.12, 0.12), z: rand(14, 22), lvl: A.lvl, life: rand(0.6, 1.1), vz: 6 });
    }
  } else if (s.t === 'hold') { A.item = s.item; A.plan.shift(); }
  else if (s.t === 'home') { release(A); A.plan.shift(); A.plan = seatSteps(S, A); } // the walk back is planned once the errand is over
  else if (s.t === 'stairs') climb(S, A, s, dt);
  else if (s.t === 'lift') liftStep(S, A, s, dt);
}

// Up: from the foot, round the pole on the walking line, to the head on the floor above. Down: the reverse.
// The first and last tread blend in from the rim, so nobody jumps on or off. z follows the steps (one riser at a
// time); the level changes at the top, so the agent is always on the floor they stand on. (s.y holds how far
// round, in treads; the name marks the step as under way.)
function climb(S, A, s, dt) {
  const { n, cx, cy, r, R, da, a0, foot, head } = STAIR;
  if (s.y == null) { s.y = s.up ? 0 : n; if (!s.up) A.lvl = s.to; }
  s.y = clamp(s.y + (s.up ? 1 : -1) * CLIMB * dt, 0, n);
  const a = a0 + s.y * da, m = (r + R) / 2 + 0.06, e0 = clamp(1 - s.y, 0, 1), e1 = clamp(1 - (n - s.y), 0, 1);
  let x = cx + m * Math.cos(a), y = cy + m * Math.sin(a);
  if (e0 > 0) { x += (foot.x - x) * e0; y += (foot.y - y) * e0; }
  if (e1 > 0) { x += (head.x - x) * e1; y += (head.y - y) * e1; }
  const sdx = (x - A.x) - (y - A.y), sdy = (x - A.x) + (y - A.y);  // which way that looks on screen
  if (Math.abs(sdx) + Math.abs(sdy) > 1e-4) { A.right = sdx > 0; A.front = sdy > 0; }
  A.x = x; A.y = y; A.z = FH * clamp(Math.ceil(s.y - 1e-6), 0, n) / n; A.pose = 'walk'; A.tread = clamp(Math.ceil(s.y - 1e-6), 1, n) - 1;
  if (s.up ? s.y >= n : s.y <= 0) { if (s.up) A.lvl = s.to; A.z = 0; A.tread = null; A.plan.shift(); runLater(A); }
}

// a board member's stroll: now and then to the mascot the board visits (its rules), else out on a terrace
function boardStroll(S, A) {
  const L = S.L, t = L.rooms.filter(r => r.kind === 'terrace' && r.art);
  const pet = S.mascots.find(c => c.data.rules.visitedBy === 'board');
  if (pet && Math.random() < pet.data.rules.visitChance) { A.plan = [...route(S, A, standBeside(L, L.nUp, pet), L.nUp), { t: 'do', pose: 'stand', dur: 4, faceTo: pet }, { t: 'home' }]; S.world.visit(pet.data.id); return; }
  const r = pickR(t);
  if (!r) return;
  const X = r.wing !== 'y', lv = L.level(r.level), u = (X ? r.x0 : r.y0) + rand(0.5, (X ? r.x1 - r.x0 : r.y1 - r.y0) - 0.5);
  A.plan = [...route(S, A, X ? { x: u, y: lv.lane + 0.3 } : { x: lv.lane + 0.3, y: u }, r.level), { t: 'do', pose: 'stand', dur: rand(5, 9), front: true, right: !X }, { t: 'home' }];
}

// ---------------------------------------------------------------- keeping everyone moving
const runLater = A => { const f = A.later; A.later = null; f?.(); };
// Anyone mid-journey who makes no progress for STUCK seconds is taken off the stairs or out of the lift
// and re-planned from where they are. If that happens twice in a row, they're put back at their desk.
function watchdog(S, A, dt) {
  const s = A.plan[0], lift = S.lift;
  const journey = s && (s.t === 'go' || s.t === 'stairs' || s.t === 'lift');
  // progress: the agent moved, or (waiting for or riding the lift) the cab moved or its doors changed
  const here = A.x * 7 + A.y * 131 + A.z * 0.37 + A.lvl * 1009 + (s?.t === 'lift' ? lift.z * 0.53 + (lift.doorT > 0) * 3 : 0);
  // (the negated test also counts as progress while lastSpot isn't set yet, after a rebuild)
  if (!journey || !(Math.abs(here - A.lastSpot) <= 1e-3)) { A.lastSpot = here; A.stillT = 0; return; }
  if ((A.stillT += dt) < STUCK) return;
  S.rescues++;
  const i = lift.riders.indexOf(A);
  if (i >= 0) lift.riders.splice(i, 1);
  const again = S.t - A.rescuedAt < RESCUE;
  if (S.world.dev) console.warn(`[hq] ${A.id} was stuck (${s.t}${s.phase ? ' ' + s.phase : ''})${again ? ', again: back to their desk' : ': re-planning'}`);
  A.rescuedAt = S.t; A.stillT = 0; A.later = null; A.ride = null;
  if (i >= 0 || s.t === 'stairs' || again) {
    // off the stairs or out of the cab: onto the nearest floor, by the elevator door or at the desk
    const lvl = i >= 0 ? clamp(Math.round(lift.z / FH), -S.L.nDown, S.L.nUp) : A.lvl;
    Object.assign(A, again ? { lvl: A.seat.level, x: A.seat.x, y: A.seat.y } : s.t === 'stairs' ? { ...STAIR.at(A.lvl).foot } : { lvl, ...DOOR }, { z: 0 });
  }
  A.plan = [];
  decide(S, A);
}

// ---------------------------------------------------------------- elevator
const liftOpenAt = (lift, lvl) => lift.target == null && lift.lvl === lvl && lift.doorT > 0;
function liftStep(S, A, s, dt) {
  const lift = S.lift;
  A.pose = 'stand';
  if (s.phase === 'call') {
    if ((s.wait = (s.wait || 0) + dt) > LIFT.giveUp) { // the lift is busy: walk it
      const st = stairSteps(S, A.lvl, s.to, A);
      A.plan.splice(0, 1, ...st.steps);
      return;
    }
    lift.calls.add(A.lvl);
    A.front = false; A.right = true;
    if (liftOpenAt(lift, A.lvl) && lift.riders.length < LIFT.cap) {
      const taken = new Set(lift.riders.map(B => B.ride.slot));
      s.slot = SLOTS.findIndex((_, k) => !taken.has(k));
      s.phase = 'in'; lift.riders.push(A); A.ride = s;
    }
  } else if (s.phase === 'in' || s.phase === 'out') {
    const [tx, ty] = s.phase === 'in' ? SLOTS[s.slot] : [DOOR.x, DOOR.y];
    const dx = tx - A.x, dy = ty - A.y, d = Math.hypot(dx, dy), v = SPEED * dt;
    if (d <= v) {
      A.x = tx; A.y = ty;
      if (s.phase === 'in') { s.phase = 'ride'; A.front = true; A.right = false; }
      else { A.ride = null; A.plan.shift(); runLater(A); }
    } else { A.x += dx / d * v; A.y += dy / d * v; A.front = dx + dy > 0; A.right = dx - dy > 0; A.pose = 'walk'; }
  } else if (s.phase === 'ride') {
    A.front = true; A.right = false; A.z = lift.z - A.lvl * FH;
    if (liftOpenAt(lift, s.to)) { s.phase = 'out'; A.lvl = s.to; A.z = 0; lift.riders.splice(lift.riders.indexOf(A), 1); lift.outs.add(A); }
  }
}
// A collective elevator: it keeps going the way it's going while anyone needs a floor that way, stops
// for riders' floors and for waiting people while there's room, and holds the doors while people are in
// the doorway (up to LIFT.hold). Riders always get where they're going, so the cab never fills up for good.
function updateLift(S, dt) {
  const lift = S.lift, L = S.L;
  lift.door += ((lift.doorT > 0 ? 1 : 0) - lift.door) * Math.min(1, dt * 8);
  for (const A of lift.outs) if (A.ride?.phase !== 'out') lift.outs.delete(A);
  if (lift.target != null) {
    const tz = lift.target * FH, d = tz - lift.z, v = LIFT.speed * dt;
    if (Math.abs(d) <= v) { lift.z = tz; lift.lvl = lift.target; lift.target = null; lift.doorT = LIFT.dwell; lift.openT = 0; lift.reopened = false; }
    else lift.z += Math.sign(d) * v;
    return;
  }
  const doorway = lift.outs.size > 0 || lift.riders.some(A => A.ride.phase === 'in');
  if (lift.doorT > 0 || doorway) {
    lift.openT += dt;
    if (doorway && lift.openT < LIFT.hold) lift.doorT = Math.max(lift.doorT, 0.3);
    if ((lift.doorT -= dt) > 0) return;
    for (const A of lift.riders) if (A.ride.phase === 'in') { [A.x, A.y] = SLOTS[A.ride.slot]; A.ride.phase = 'ride'; } // held too long: step in
  }
  lift.doorT = 0;
  const room = lift.riders.length < LIFT.cap, wanted = new Set(lift.riders.map(A => A.ride.to));
  wanted.delete(lift.lvl);
  // someone arrived here after the doors closed: open again, but only once if riders are waiting to move
  if (room && lift.calls.has(lift.lvl) && (!wanted.size || !lift.reopened)) { lift.reopened = true; lift.doorT = LIFT.dwell; lift.openT = 0; return; }
  const stops = [...wanted, ...(room ? [...lift.calls].filter(l => l !== lift.lvl) : [])];
  if (stops.length) {
    const ahead = stops.filter(l => Math.sign(l - lift.lvl) === lift.dir), pool = ahead.length ? ahead : stops;
    lift.target = pool.reduce((b, l) => Math.abs(l - lift.lvl) < Math.abs(b - lift.lvl) ? l : b);
    lift.dir = Math.sign(lift.target - lift.lvl);
    return;
  }
  lift.dir = 0;
  if ((lift.idle -= dt) <= 0) { lift.idle = rand(6, 14); lift.target = -L.nDown + (Math.random() * (L.nUp + L.nDown + 1) | 0); if (lift.target === lift.lvl) lift.target = null; }
}
export function callLift(S, lvl) { const lift = S.lift; if (lift.target == null && !lift.riders.length && lift.lvl !== lvl) lift.target = lvl; lift.idle = 10; }

// ---------------------------------------------------------------- the robot vacuums
// Straight until it meets the edge of the open floor, a little bump and a turn, and on; after a while home to its
// dock to charge. (Agents walk through it: it's a vacuum.)
function updateVacs(S, dt) {
  for (const v of S.vacs) {
    const { zone: z, X } = v, a = X ? v.x : v.y, d = X ? v.y : v.x;
    v.t -= dt;
    if (v.pause > 0) { v.pause -= dt; continue; }
    if (v.mode === 'charge') { if (v.t <= 0) { v.mode = 'clean'; v.t = rand(50, 110); v.h = rand(0, Math.PI * 2); } continue; }
    if (v.mode === 'clean' && v.t <= 0) v.mode = 'home';
    const speed = 0.32 * dt;
    if (v.mode === 'home') {
      const dx = v.dock.x - v.x, dy = v.dock.y - v.y, dist = Math.hypot(dx, dy);
      if (dist <= speed) { Object.assign(v, v.dock); v.mode = 'charge'; v.t = rand(25, 60); continue; }
      v.h = Math.atan2(dy, dx); v.x += dx / dist * speed; v.y += dy / dist * speed; continue;
    }
    const inside = (p, q) => p >= z.a0 && p <= z.a1 && q >= z.d0 && q <= z.d1;
    if (!inside(a, d)) { v.h = Math.atan2(X ? 1 : 0, X ? 0 : 1); v.x += (X ? 0 : 1) * speed; v.y += (X ? 1 : 0) * speed; continue; } // off its dock, onto the floor
    const nx = v.x + Math.cos(v.h) * speed, ny = v.y + Math.sin(v.h) * speed, na = X ? nx : ny, nd = X ? ny : nx;
    if (!inside(na, nd)) { // bump: back off a hair, pause, and head off inwards
      v.pause = 0.35;
      for (let k = 0; k < 12; k++) {
        const h = rand(0, Math.PI * 2), ta = a + (X ? Math.cos(h) : Math.sin(h)) * 0.3, td = d + (X ? Math.sin(h) : Math.cos(h)) * 0.3;
        if (ta > z.a0 && ta < z.a1 && td > z.d0 && td < z.d1) { v.h = h; break; }
      }
    } else { v.x = nx; v.y = ny; }
  }
}

// ---------------------------------------------------------------- van, pigeons, weather
function updateVan(S, dt) {
  const v = S.van, busy = [...S.people.values()].some(A => A.room.kind === 'dock' && A.state === 'working');
  const len = S.island.streetLen + 2.5;
  v.t -= dt;
  if (v.state === 'away' && v.t <= 0) { if (busy) { v.state = 'in'; v.u = len; S.onVan?.('arrive'); } else v.t = 8; }
  else if (v.state === 'in') { v.u = Math.max(0, v.u - dt * 2.2 * Math.min(1, v.u / 1.5 + 0.25)); if (v.u === 0) { v.state = 'parked'; v.t = 18; } }
  else if (v.state === 'parked') { if (Math.random() < dt * 1.2) S.parts.push({ k: 'parcel', t: 0, life: 1.1 }); if (v.t <= 0) { v.state = 'out'; S.onVan?.('leave'); } }
  else if (v.state === 'out') { v.u += dt * 2.4 * Math.min(1, v.u / 1.5 + 0.25); if (v.u > len) { v.state = 'away'; v.t = busy ? rand(25, 45) : 10; } }
}
function updatePigeons(S, dt) {
  for (const p of S.pigeons) {
    const near = [...S.people.values()].some(A => A.lvl === 0 && Math.hypot(A.x - p.x, A.y - p.y) < 1.1);
    if (near && !p.fly) { p.fly = 1; p.vx = rand(-1, 1); p.vy = rand(-1, 1); S.onFlap?.(); }
    if (p.fly) { p.z += dt * 40; p.x += p.vx * dt * 2; p.y += p.vy * dt * 2; if (p.z > 160) { p.fly = 0; p.z = 0; p.x = p.home.x + rand(-0.6, 0.6); p.y = p.home.y + rand(-0.4, 0.4); p.gone = rand(6, 16); } }
    else if (p.gone > 0) p.gone -= dt;
    else if ((p.t -= dt) <= 0) { p.t = rand(0.4, 2); if (Math.random() < 0.5) { p.x = clamp(p.x + rand(-0.25, 0.25), p.home.x - 0.9, p.home.x + 0.9); p.y = clamp(p.y + rand(-0.2, 0.2), p.home.y - 0.6, p.home.y + 0.6); p.dir = Math.random() < 0.5 ? 1 : -1; } p.peck = Math.random() < 0.5; }
  }
  // flocks crossing the sky by day
  if (darkness(S.hour) < 0.4 && Math.random() < dt / 14 && S.flocks.length < 2) {
    const n = 3 + (Math.random() * 5 | 0), dir = Math.random() < 0.5 ? 1 : -1;
    S.flocks.push({ x: dir > 0 ? S.L.bounds.x0 - 60 : S.L.bounds.x1 + 60, y: S.L.bounds.y0 + rand(20, 160), dir, n, t: 0 });
  }
  S.flocks = S.flocks.filter(f => { f.t += dt; f.x += f.dir * dt * 38; return f.x > S.L.bounds.x0 - 100 && f.x < S.L.bounds.x1 + 100; });
}
function updateWeather(S, dt) {
  const w = S.weather, kind = weatherAt(today()); // (?date= previews that day's weather too)
  w.kind = kind;
  const picked = S.t - (S.pickedAt ?? -99) < 12, k = Math.min(1, dt / (picked ? 1.5 : 8)); // a weather picked at the water tower arrives within seconds
  w.rain += ((kind === 'rain' ? 1 : kind === 'showers' ? 0.4 : 0) - w.rain) * k; w.snow += ((kind === 'snow') - w.snow) * k;
  w.fog = (w.fog ?? 0) + ((kind === 'fog') - (w.fog ?? 0)) * k;
  w.wet = clamp(w.wet + (w.rain > 0.3 ? dt / 40 : -dt / (picked ? 8 : 120)), 0, 1);
  w.cover = clamp(w.cover + (w.snow > 0.3 ? dt / 60 : -dt / 300), 0, 1);
  w.wind = 0.3 + w.rain * 0.7 + Math.sin(S.t * 0.2) * 0.2;
  w.cloud = kind === 'clear' ? 0 : kind === 'cloudy' ? 0.6 : kind === 'showers' ? 0.35 : kind === 'fog' ? 0.5 : 1;
  w.overcast = (w.overcast ?? w.cloud) + (w.cloud - (w.overcast ?? w.cloud)) * k;
  if (S.forceStart == null) { S.forceStart = 1; if (kind === 'rain') { w.rain = 1; w.wet = 0.7; } if (kind === 'snow') { w.snow = 1; w.cover = 0.8; } }
}

// ---------------------------------------------------------------- one tick
export function update(S, dt, hour) {
  S.t += dt; S.hour = hour;
  S.lift.calls.clear();
  for (const A of S.people.values()) { step(S, A, dt); watchdog(S, A, dt); }
  updateLift(S, dt); updateMascots(S, dt); updateVacs(S, dt); updateVan(S, dt); updatePigeons(S, dt); updateWeather(S, dt); updateTown(S.town, S, dt);
  // ambient particles: coffee steam, steaming mugs, sparks from busy server racks, notes from the synth and the record player, autumn leaves
  for (const r of S.L.rooms) {
    const a = r.art?.anchors; if (!a) continue;
    for (const c of a.coffee) if (Math.random() < dt * 1.5) S.parts.push({ k: 'steam', ...c.steam, lvl: r.level, life: 1.4, vz: 7 });
    if (a.sparks.length && Math.random() < dt * 0.6 * S.busy) { const s = pickR(a.sparks); for (let i = 0; i < 5; i++) S.parts.push({ k: 'spark', x: s.x, y: s.y, z: s.z, lvl: r.level, vx: rand(-18, 18), vy: rand(-5, 5), vz: rand(10, 30), g: 80, life: 0.5 }); }
    for (const m of a.mugs || []) if (Math.random() < dt * 0.6) S.parts.push({ k: 'steam', x: m.x, y: m.y, z: m.z, lvl: r.level, life: 1.1, vz: 6 });
    for (const n of a.records || []) if (Math.random() < dt * 0.4) S.parts.push({ k: 'note', ...n, lvl: r.level, life: 2.2, vz: 9, vx: rand(-4, 4) });
    if (a.notes.length && S.people.get(r.agents[0]?.id)?.state === 'working' && Math.random() < dt * 0.8) { const n = a.notes[0]; S.parts.push({ k: 'note', ...n, lvl: r.level, life: 2.2, vz: 9, vx: rand(-4, 4) }); }
  }
  // autumn leaves drift down from the crowns and settle on the grass under each tree
  if (season() === 'autumn' && Math.random() < dt * 0.5) {
    const tr = pickR(S.island.props.filter(p => p.canopy));
    if (tr) { const a = Math.random() * 6.28, r = rand(0.1, 0.6); S.parts.push({ k: 'leaf', x: tr.at.x + Math.cos(a) * r, y: tr.at.y + Math.sin(a) * r, z: rand(18, 30), lvl: 0, vz: -7, life: 6, c: pickR(tr.leaves) }); }
  }
  S.parts = S.parts.filter(p => {
    p.life -= dt;
    if (p.k === 'confetti' || p.k === 'heart' || p.k === 'text') { p.sx += (p.vx || 0) * dt; p.sy += (p.vy || 0) * dt; p.vy += (p.g || 0) * dt; return p.life > 0; }
    if (p.k === 'parcel') { p.t += dt; return p.life > 0; }
    if (p.k === 'leaf') { p.z = Math.max(0, p.z + p.vz * dt); p.x += Math.sin(S.t * 2 + p.life * 3) * dt * 0.12; return p.life > 0; }
    p.x += (p.vx || 0) * dt / 32; p.y += (p.vy || 0) * dt / 32; p.z += (p.vz || 0) * dt; p.vz -= (p.g || 0) * dt;
    return p.life > 0;
  });
  if (S.parts.length > 600) S.parts.splice(0, S.parts.length - 600);
}

// ---------------------------------------------------------------- walkway check (dev mode and tests)
// No prop may stand on a walk lane, a doorway, a path in the core, the way to a seat or any other spot
// people go to, or the space a seated person takes. Returns a list of problems, empty when there are none.
export function walkCheck(L, island) {
  const bad = [], CLEAR = 0.12;
  const near = (a, b, f, pad) => { // does segment a-b come within pad of rect f?
    for (let k = 0; k <= 20; k++) {
      const x = a.x + (b.x - a.x) * k / 20, y = a.y + (b.y - a.y) * k / 20;
      if (x > f.x0 - pad && x < f.x1 + pad && y > f.y0 - pad && y < f.y1 + pad) return true;
    }
    return false;
  };
  const check = (props, paths, seats, where) => {
    for (const p of props) {
      if (!p.foot) continue;
      for (const [a, b, what] of paths) if (near(a, b, p.foot, CLEAR)) bad.push(`${p.name} in ${where} blocks ${what}`);
      for (const [s, id] of seats) if (near(s, s, p.foot, 0.3)) bad.push(`${p.name} in ${where} sits in a seat in ${id}`);
    }
  };
  for (const lv of L.levels) {
    const H = lv.hall;
    const paths = [[H, DOOR, 'core: elevator'], [H, STAIR.lane, 'core: to the stairs'], [H, STAIR.via[0], 'core: behind the stairs'], [STAIR.via[0], STAIR.via[1], 'core: behind the stairs'], [STAIR.via[1], { x: lv.Cx - 0.6, y: lv.lane }, 'core: behind the stairs']], seats = [];
    for (const w of [STAIR.at(lv.i).toFoot, STAIR.at(lv.i).toHead]) w.slice(1).forEach((b, k) => paths.push([w[k], b, 'core: onto the stairs']));
    if (lv.i === 0) paths.push([H, DOOR_IN, 'core: to the front door'], [DOOR_IN, DOOR_OUT, 'the front door']);
    for (const r of lv.rooms) {
      if (r.wing === 'core') continue;
      const X = r.wing !== 'y', lane = p => X ? { x: p.x, y: lv.lane } : { x: lv.lane, y: p.y }, a = r.art.anchors;
      paths.push([X ? { x: Math.max(r.x0, lv.Cx) - 0.6, y: lv.lane } : { x: lv.lane, y: Math.max(r.y0, lv.Cy) - 0.6 }, X ? { x: r.x1, y: lv.lane } : { x: lv.lane, y: r.y1 }, `${r.id}: lane and doorway`]);
      for (const s of [...a.seats, ...(a.sofas || [])]) {
        paths.push(s.via ? [lane(s.via), s.via, `${r.id}: way to a seat`] : [lane(s), s, `${r.id}: way to a seat`]);
        if (s.via) paths.push([s.via, s, `${r.id}: way to a seat`]);
        seats.push([s, r.id]);
      }
      const spots = [...(a.gaze || []), ...a.coffee, ...a.plants, ...(a.news?.spots || [])];
      for (const g of spots) paths.push([lane(g), g, `${r.id}: a spot people walk to`]);
    }
    for (const r of lv.rooms) check(r.art.props, paths, seats, r.id);
  }
  if (island) { // outdoors: the sidewalks, the plaza and the spots people stroll to
    const P = PLAZA, paths = [[P, { x: L.Xe, y: P.y }, 'the sidewalk'], [P, { x: P.x, y: L.Ye }, 'the sidewalk']];
    for (const s of [...island.benches, ...island.walk, island.mailbox].filter(Boolean)) paths.push([s.x > s.y ? { x: s.x, y: P.y } : { x: P.x, y: s.y }, s, 'a spot people stroll to']);
    check(island.props, paths, island.benches.map(b => [b, 'the park']), 'outdoors');
  }
  return bad;
}
