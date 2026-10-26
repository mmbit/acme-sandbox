// Turns the world's rooms into an isometric building. Nothing here knows about specific departments:
// placement is driven only by room kind, size, agent count and features.
//
// The building is an L seen from its open side, like a dollhouse: a core (elevator + stairs) in the
// back corner, an x-wing running down-right and a y-wing running down-left. Each level packs rooms
// into the two wings, which are at most MAX_WING tiles long: a department too big for a wing takes
// several, stacked up the building, so a big company grows taller instead of wider. The basement sits
// under a one-tile sidewalk, so it shows in the island's cut face. The board's penthouse sits on the roof
// with a terrace. The whole thing floats on a diorama island.
import { FH, SX, SY, CORE, CORE_X, inWell } from './iso.js';
import { ART } from './mascots.js';

const SIZE = { s: 3, m: 4, l: 6 };
const BASEMENT = new Set(['server', 'vault']);
const GROUND = new Set(['lobby', 'dock']);
const EXTRA = { lobby: 1, library: 2, dock: 2, vault: 2, boardroom: 2, lounge: 0, booth: 2, darkroom: 5, engine: 2, arcade: 4, meeting: 7 }; // (darkroom, engine, arcade; meeting)
// the island beyond each wing's end: a street on one side, a (bigger) park on the other
const EXT = { street: 5, park: 8 };
// the longest a wing gets, in tiles: about a dozen desks plus the room's own things. A floor wider than this is a
// long walk past one straight line of desks, and the building outgrows the screen sideways
export const MAX_WING = 18;
// the rooms that fill a wing's leftover floor, in turn, and about how long each is
const FILLERS = ['nook', 'gym', 'canteen', 'lounge'], FILLER = 5;
const FILLER_NAMES = { nook: 'Green Corner', gym: 'Gym', canteen: 'Canteen', lounge: 'Lounge', storage: 'Storage' };
// the cocktail bar: one in the whole building, small or medium (up to a filler's usual length: past it it's a hall), in
// place of the first green corner of that length, or with none, the first filler of it above ground. Its name fits the
// floor's edge: under 3 tiles five letters show (on a y wing's slab B and P lose their right side: "Bar" read as "Ear")
const BAR = 5, BAR_NAMES = ['Clink', 'Cocktails'];

// agents: the org's records of the people in the room. pets: the mascots the brownstone draws
function collectRooms(world) {
  // src: the world's room it shows (a department split over several wings has one per part)
  const rooms = world.rooms.map(r => ({ id: r.id, src: r.id, name: r.name, kind: r.kind, size: r.size, features: r.features, agents: r.agentIds.map(id => world.agents.get(id).data), isBoard: r.board, dept: r.deptId }));
  // On Air's recording booth, once the company has a show: the hosts sit at its mics while an episode is made (sim.js)
  if (world.shows?.length) rooms.push({ id: 'onair', src: 'onair', name: 'On Air', kind: 'booth', size: 's', features: [], agents: [], isBoard: false, dept: null, commons: true });
  // The photo studio's darkroom, once the company runs one (world.studio): its keeper works at a desk here instead of in
  // their department's room (nobody, if the keeper isn't on a department's desk). app: what a tap on it opens (hit.js).
  // Named Photo Lab, as a company's own department may well be called Studio
  if (world.studio) {
    const id = world.studio.keeper, home = rooms.find(r => !r.isBoard && r.agents.some(a => a.id === id));
    const agents = home ? home.agents.splice(home.agents.findIndex(a => a.id === id), 1) : [];
    rooms.push({ id: 'darkroom', src: 'darkroom', name: 'Photo Lab', kind: 'darkroom', size: 's', features: [], agents, isBoard: false, dept: null, commons: true, app: 'studio', keeper: id });
  }
  // Subscription seats (not pay-per-use keys) show up as racks in the server room.
  const engines = [...new Set(rooms.flatMap(r => r.agents.map(a => a.engine)))].filter(e => e && e !== 'api' && e !== 'human');
  // The rig (a lent machine, world.machine) stands beside them, in the first server room.
  const rig = world.machine ? rooms.find(r => r.kind === 'server')?.id ?? null : null;
  for (const r of rooms) {
    // extra: tiles every part of the room has besides its desks. min: its size, or room for its name on the floor's edge
    r.extra = (EXTRA[r.kind] ?? 1) + (r.kind === 'server' ? engines.length : 0) + (r.id === rig ? 1 : 0);
    r.min = Math.max(SIZE[r.size] || 4, Math.ceil((r.name.length * 4 + 10) / 16));
    r.len = roomLen(r, r.agents.length, r.features);
  }
  return { rooms: rooms.flatMap(r => r.isBoard ? [r] : split(r, MAX_WING)), pets: world.mascots.filter(m => ART[m.kind]), engines, rig, rigLook: rigLook(world) };
}
// How the rig is built: its size, its GPUs and the colours the board gave it (world.js); null without one. A change
// rebuilds the building (react.js).
export const rigLook = world => world.machine && { size: world.machine.size, gpuCount: world.machine.gpuCount, body: world.machine.body, glow: world.machine.glow };
const roomLen = (r, desks, features) => Math.max(r.min, desks + Math.ceil(features.length * 1.5) + r.extra);

// A room longer than cap tiles becomes parts that each fit: as few as will do, the people shared out evenly in org
// order, the features in the first. Every part has the room's name and kind. (A room without people to share out,
// or whose name alone is longer, stays whole: the wings grow to fit it.)
function split(r, cap) {
  if (r.len <= cap || r.agents.length < 2) return [r];
  // desks the first part has room for, and each part after it
  const first = cap - Math.ceil(r.features.length * 1.5) - r.extra, next = cap - r.extra;
  const n = r.agents.length, parts = 1 + Math.ceil((n - first) / next), out = [];
  for (let k = 0, from = 0; k < parts; k++) {
    // shares as even as the first part's room allows, the bigger ones first
    const left = n - from, share = Math.ceil(left / (parts - k)), take = k ? share : Math.min(first, share);
    const agents = r.agents.slice(from, from + take), features = k ? [] : r.features;
    out.push({ ...r, id: `${r.id}/${k + 1}`, part: k + 1, parts, agents, features, len: roomLen(r, agents.length, features) });
    from += take;
  }
  return out;
}

// First-fit packing into levels with two wings of fixed capacity, keeping org order where possible. A split room's
// next part goes beside its last part (the other wing of that floor) or above it, in the same wing: the department
// reads as one block going up the building. endsNot(i, wing, r): r mustn't fill that wing of floor i up to its end
function pack(list, cx, cy, levels = [], endsNot = () => false) {
  const cap = { x: cx, y: cy }, last = new Map(); // a split room's src → where its last part went: { i, wing }
  for (const r of list) {
    const prev = r.part > 1 ? last.get(r.src) : null, wings = prev?.wing === 'y' ? ['y', 'x'] : ['x', 'y'];
    let i = prev?.i ?? 0, wing = null;
    for (; i < levels.length && !wing; i++) wing = wings.find(w => (!prev || i === prev.i || w === prev.wing) && levels[i][w].used + r.len <= cap[w] && !(levels[i][w].used + r.len === cap[w] && endsNot(i, w, r)));
    if (!wing) {
      levels.push({ x: { rooms: [], used: 0 }, y: { rooms: [], used: 0 } }); i = levels.length;
      wing = wings.find(w => r.len <= cap[w]);
    }
    const slot = levels[i - 1][wing];
    slot.rooms.push(r); slot.used += r.len;
    last.set(r.src, { i: i - 1, wing });
  }
  return levels;
}

// the basement's y wing starts a tile further out (its wings are a tile deeper) and both end with the wings above
const BASE_CAP = (Lx, Ly) => [Lx, Ly - 1];
function plan(info, Lx, Ly) {
  const { rooms } = info;
  const top = rooms.find(r => r.isBoard);
  const base = rooms.filter(r => r !== top && BASEMENT.has(r.kind));
  const ground = rooms.filter(r => r !== top && GROUND.has(r.kind));
  const rest = rooms.filter(r => r !== top && !base.includes(r) && !ground.includes(r));
  const lounge = { id: 'lounge', name: 'Lounge', kind: 'lounge', size: 's', agents: [], features: [], len: 3, commons: true, auto: true };
  const up = pack(ground, Lx, Ly);
  // the lobby goes in the x wing on the ground floor, and the street runs past the end of the dock's wing (the rest
  // brings neither: the ground floor's wings swap once it's packed)
  const g0 = up[0], swap = g0 && g0.y.rooms.some(r => r.kind === 'lobby') && !g0.x.rooms.some(r => r.kind === 'lobby');
  const street = g0?.[swap ? 'x' : 'y'].rooms.some(r => r.kind === 'dock') ? 'y' : 'x';
  // An empty department's room three tiles long doesn't end the park side's wing on an even floor above the ground: the
  // fire escape's flight comes down there across the middle of its back wall, with no room either side for its notice
  // (ESCAPE; the top floor, where the ladder goes up instead, unknown till the packing's done, is kept to as well). The
  // wing ends with another room, or the filler its leftover floor becomes
  pack([...rest, lounge], Lx, Ly, up, (i, w, r) => i > 0 && i % 2 === 0 && w !== street && r.len === 3 && r.dept && !r.agents.length);
  if (swap) [g0.x, g0.y] = [g0.y, g0.x];
  // the basement fills the street side's wing first, on under the street to the island's end, and the park side's only
  // when that's full: under the park is soil.
  const [bx, by] = BASE_CAP(Lx, Ly);
  // pack tries x first for each department, so the street capacity goes there before the wings are swapped back
  const streetFirst = street === 'x' ? [bx + EXT.street, by] : [by + EXT.street, bx];
  const down = base.length ? pack(base, ...streetFirst) : [];
  if (street === 'y') for (const L of down) [L.x, L.y] = [L.y, L.x];
  const waste = up.reduce((s, L) => s + (Lx - L.x.used) + (Ly - L.y.used), 0) + down.reduce((s, L) => s + Math.max(0, Lx - 1 - L.x.used) * 0.3, 0);
  return { up, down, top, waste, street };
}

// World-pixel bounding box of the whole diorama.
function bounds(nUp, nDown, Lx, Ly, street) {
  const Xe = CORE_X + Lx + EXT[street === 'x' ? 'street' : 'park'], Ye = CORE + Ly + EXT[street === 'x' ? 'park' : 'street'], zb = -nDown * FH - 34;
  const b = { Xe, Ye, x0: SX(0, Ye) - 40, x1: SX(Xe, 0) + 40, y0: SY(0, 0, nUp * FH + 130), y1: Math.max(SY(Xe, 4, zb), SY(4, Ye, zb)) + 24 };
  // the home view frames the building and the start of the street and park. The rest is a pan away
  const fx = CORE_X + Lx + 1.5, fy = CORE + Ly + 1.5;
  b.fit = { x0: SX(0, fy) - 6, x1: SX(fx, 0) + 6, y0: b.y0 + 20, y1: Math.max(SY(fx, 4, zb), SY(4, fy, zb)) };
  return b;
}

const MIN_FLOORS = 3;
// sw/sh: screen size in device pixels. Pick the wing lengths whose diorama fills it best at an integer zoom.
export function buildLayout(world, sw = 1280, sh = 800) {
  const info = collectRooms(world);
  const maxLen = Math.max(4, ...info.rooms.filter(r => !r.isBoard).map(r => r.len));
  let best = null;
  for (let Lx = maxLen; Lx <= Math.max(maxLen, MAX_WING); Lx++) for (let Ly = maxLen; Ly <= Math.max(maxLen, MAX_WING); Ly++) {
    const p = plan(info, Lx, Ly), b = bounds(p.up.length, p.down.length, Lx, Ly, p.street);
    const w = b.fit.x1 - b.fit.x0, h = b.fit.y1 - b.fit.y0 + 70, z = Math.max(1, Math.floor(Math.min(sw / w, sh / h)));
    const fill = Math.min(1, w * z / sw) * Math.min(1, h * z / sh) - Math.max(0, h * z / sh - 1) - Math.max(0, w * z / sw - 1);
    // a building, not a bungalow: at least MIN_FLOORS above ground (the ground floor included), whatever the screen
    const score = fill - p.waste * 0.02 - Math.abs(Lx - Ly) * 0.015 - (p.up.length < MIN_FLOORS ? 1 : 0);
    if (!best || score > best.score) best = { score, p, b, Lx, Ly, z };
  }
  return assemble(info, best);
}

function assemble(info, { p, b, Lx, Ly, z }) {
  // X1, Y1: where the wings end (the island goes on to Xe, Ye)
  const L = { levels: [], rooms: [], pets: info.pets, engines: info.engines, rig: info.rig, rigLook: info.rigLook, Lx, Ly, X1: CORE_X + Lx, Y1: CORE + Ly, Xe: b.Xe, Ye: b.Ye, bounds: b, zFit: z };
  const nUp = p.up.length, nDown = p.down.length;
  L.nUp = nUp; L.nDown = nDown; L.roofZ = nUp * FH;
  const mkLevel = i => {
    // D: how deep the wings are. Cx, Cy: where they start (the core's extent)
    const under = i < 0, D = under ? CORE + 1 : CORE, Cx = CORE_X, Cy = D;
    // lane: the walkway along each wing, just inside the open front. hall: where the lanes meet in front of the core
    const LANE_IN = 0.6, lv = { i, z: i * FH, D, Cx, Cy, lane: D - LANE_IN, hall: { x: D - LANE_IN, y: D - LANE_IN }, rooms: [], roof: i === nUp };
    L.levels.push(lv);
    return lv;
  };
  const place = (lv, room, wing, p0, len) => {
    const D = lv.D;
    Object.assign(room, wing === 'x' ? { x0: lv.Cx + p0, x1: lv.Cx + p0 + len, y0: 0, y1: D } : { x0: 0, x1: D, y0: lv.Cy + p0, y1: lv.Cy + p0 + len },
      { wing, level: lv.i, z: lv.z, len, lv });
    lv.rooms.push(room); L.rooms.push(room);
  };
  const fill = (lv, wing, rooms, cap) => {
    let p0 = 0, left = cap - rooms.reduce((s, r) => s + r.len, 0);
    // leftover floor becomes a lounge if there's space for one, otherwise it widens the last room
    const list = rooms.slice();
    // the street side's basement wing with rooms runs on under the street to the island's end (that stretch is
    // storage). Past the park side's rooms, and in a basement wing without any, is just soil.
    if (lv.i < 0) left = rooms.length && wing === p.street ? left + (wing === 'x' ? L.Xe - L.X1 : L.Ye - L.Y1) : 0;
    if (left >= 2) {
      // a long stretch becomes a few rooms of FILLER tiles or so (one long empty room reads as a gap), each a different
      // kind from the one beside it and a lounge at most once a wing; the basement's is storage
      const n = lv.i < 0 ? 1 : Math.max(1, Math.round(left / FILLER)), fillers = [];
      let k = lv.i * 2 + (wing === 'y'), lounge = list.some(r => r.kind === 'lounge');
      for (let j = 0; j < n; j++) {
        const len = Math.floor(left / n) + (j < left % n);
        let kind = lv.i < 0 ? 'storage' : 'nook'; // (one under three tiles is a green corner: a gym or a canteen needs the room)
        if (lv.i >= 0 && len >= 3) do kind = FILLERS[((k++ % FILLERS.length) + FILLERS.length) % FILLERS.length]; while (kind === 'lounge' && lounge || kind === fillers.at(-1)?.kind);
        lounge ||= kind === 'lounge';
        fillers.push({ id: `nook-${lv.i}-${wing}${j ? `-${j}` : ''}`, name: FILLER_NAMES[kind], kind, size: 's', agents: [], features: [], len, commons: true, auto: true, filler: true });
      }
      const d = list.findIndex(r => r.kind === 'dock');
      list.splice(d < 0 ? list.length : d, 0, ...fillers); left = 0;
    }
    list.forEach((r, k) => { const len = r.len + (k === list.length - 1 ? left : 0); place(lv, r, wing, p0, len); p0 += len; });
  };
  const levelRooms = (lvl, i) => {
    const lv = mkLevel(i), cap = i < 0 ? BASE_CAP(Lx, Ly) : [Lx, Ly];
    lv.rooms.push(Object.assign({ id: `core-${i}`, name: 'Core', kind: 'core', agents: [], features: [], x0: 0, y0: 0, x1: lv.Cx, y1: lv.Cy, wing: 'core', level: i, z: lv.z, lv }));
    L.rooms.push(lv.rooms[0]);
    // ground floor: the lobby sits by the core, the loading dock at a wing end next to the street
    if (i === 0) {
      for (const w of [lvl.x, lvl.y]) w.rooms.sort((a, b) => (a.kind === 'lobby' ? -1 : b.kind === 'lobby' ? 1 : 0) || (a.kind === 'dock') - (b.kind === 'dock'));
    }
    fill(lv, 'x', lvl.x.rooms, cap[0]); fill(lv, 'y', lvl.y.rooms, cap[1]);
  };
  p.down.forEach((lvl, k) => levelRooms(lvl, -1 - k));
  p.up.forEach((lvl, i) => levelRooms(lvl, i));
  // (L.rooms: in the order the wings filled, floor by floor from the bottom, the x wing first, near end first. Not the
  // building's own lounge, plan()'s: it'd have none)
  const cosy = L.rooms.filter(r => r.filler && r.level >= 0 && r.len <= BAR), bar = cosy.find(r => r.kind === 'nook') ?? cosy[0];
  if (bar) Object.assign(bar, { kind: 'bar', name: BAR_NAMES[+(bar.len >= 3)] });
  // roof: penthouse over the core, terrace on the rest
  const roof = mkLevel(nUp), pent = p.top;
  if (pent) {
    const len = Math.min(pent.len, Lx);
    place(roof, pent, 'x', -CORE_X, len + CORE_X);
    pent.pent = true;
    if (len < Lx) place(roof, { id: 'terrace-x', name: 'Terrace', kind: 'terrace', agents: [], features: [], commons: true, auto: true }, 'x', len, Lx - len);
  } else place(roof, { id: 'terrace-c', name: 'Roof', kind: 'terrace', agents: [], features: [], auto: true }, 'x', -CORE_X, Lx + CORE_X);
  place(roof, { id: 'terrace-y', name: 'Roof Garden', kind: 'terrace', agents: [], features: [], commons: true, auto: true, garden: true }, 'y', 0, Ly);
  L.pent = pent || null;
  L.levels.sort((a, b) => a.i - b.i);
  for (const lv of L.levels) lv.rooms.sort((a, b) => (a.wing === 'core' ? -1 : b.wing === 'core' ? 1 : a.x0 + a.y0 - b.x0 - b.y0));
  // the street runs past whichever wing end has the dock
  const dock = L.rooms.find(r => r.kind === 'dock' && r.level === 0);
  L.street = p.street;
  L.dock = dock || null;
  L.level = i => L.levels.find(l => l.i === i);
  // seats: one desk per agent along the back wall, packed away from the core
  for (const r of L.rooms) {
    const n = r.agents.length, far = r.wing === 'y' ? r.y1 : r.x1;
    r.seats = r.agents.map((a, k) => far - n + k + 0.5); // position along the wing
  }
  return L;
}

export const levelName = lv => lv.i < 0 ? `B${-lv.i}` : lv.i === 0 ? 'G' : lv.roof ? 'R' : String(lv.i);

// Which room contains a point on a level (null outside the building).
export function roomAt(L, level, x, y) {
  const lv = L.level(level);
  if (!lv) return null;
  for (let k = lv.rooms.length - 1; k >= 0; k--) {
    const r = lv.rooms[k];
    if (x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) return r;
  }
  return null;
}

// Where someone stands to be with whatever's at p on a level: half a tile in front of it, else on its other sides, wherever
// there's floor all round their feet, clear of the stairwell, so nobody beside something at the well's rim or a floor's
// edge stands on air. Else at p itself.
const BESIDE = [[0.45, 0.45], [0.45, -0.45], [-0.45, 0.45], [-0.45, -0.45]], FEET = 0.2;
const FEET_CORNERS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
export function standBeside(L, level, p) {
  const floor = (x, y) => !inWell(x, y, FEET) && FEET_CORNERS.every(([a, b]) => roomAt(L, level, x + a * FEET, y + b * FEET));
  const [dx, dy] = BESIDE.find(([bx, by]) => floor(p.x + bx, p.y + by)) ?? [0, 0];
  return { x: p.x + dx, y: p.y + dy };
}

// the park end's fire escape (facade.js fireEscape): its landings run from a0 to a1 tiles out from the back walls and n
// past the wing's end. The flight down to landing k runs from from(k) over landing k + 1 to to(k) at landing k, its
// stringers n0 and n1 past the end and its handrail rail px over the n1 one; the top landing's gooseneck ladder goes up
// at up(top) on to up(top) + rung, ladder past the end (rooms.js keeps an empty
// room's notice clear of it)
const from = k => k % 2 ? 0.5 : 2.5;
export const ESCAPE = { a0: 0.3, a1: 2.7, n: 0.6, from, to: k => k % 2 ? 2.2 : 0.8, n0: 0.1, n1: 0.36, rail: 11, ladder: 0.42, rung: 0.22, up: top => top > 1 ? (from(top - 1) < 1.5 ? 2.25 : 0.45) : 2.25 };
// Where the fire escape crosses rows z0 to z1 px over level's floor of the back wall that ends at its wing's end, as
// [s0, s1] in tiles from that end (negative: along the wall), seen as what stands a out shows a nearer the wall's start
// and 16a px lower (iso.js SY). Below level's floor and above its ceiling it crosses nothing there: the landing's
// railing and the flight's foot stay under 12 px less 16a, the landing above starts FH up
function escapeCrossing(level, top, z0, z1) {
  const { n0, n1, rail, ladder, rung, up } = ESCAPE, a0 = from(level), a1 = ESCAPE.to(level);
  if (level === top) return [ladder - up(top) - rung, ladder - up(top)]; // (the gooseneck's rails stand the floor's full height)
  // each of the flight's straight runs, n past the end, from h px at a0 down FH to a1: where its z' = h - FH t - 16 a(t) is in z0..z1
  const along = [[n0, FH], [n1, FH], [n1, FH + rail]].flatMap(([n, h]) => {
    const at = z => (h - 16 * a0 - z) / (FH + 16 * (a1 - a0)), t0 = Math.max(0, at(z1)), t1 = Math.min(1, at(z0));
    return t0 > t1 ? [] : [t0, t1].map(t => n - a0 - (a1 - a0) * t);
  });
  return [Math.min(...along), Math.max(...along)];
}

// how far out from the back wall a room's glass partition runs: a tile short of the room's front (rooms.js partition)
export const partitionDepth = room => (room.wing !== 'y' ? room.y1 : room.x1) - 1;

// The stretches of a room's back wall, [a0, a1] in tiles from its start, that what stands in front of it past its back
// row hides, as what stands d out shows d nearer the start: the next room's glass partition at its far end, and at the
// park end the fire escape's iron where it crosses the notice's rows (NOTICE_Z). In turn: with the partition's whole
// pane, then (for a wall too short to clear it) with only its front post, the pane's tint over the rest. Every wall at
// the escape's end clears its iron (plan) (out of rooms.js, where backWall hangs the notice, for its test)
export function wallHidden(room, L) {
  const X = room.wing !== 'y', len = X ? room.x1 - room.x0 : room.y1 - room.y0, end = X ? room.x1 : room.y1;
  const next = room.lv.rooms.find(r => r.wing === room.wing && (X ? r.x0 : r.y0) === end), post = next && len - partitionDepth(next);
  const escape = room.level > 0 && room.level < L.nUp && (L.street !== 'x') === X && end === (X ? L.X1 : L.Y1) && escapeCrossing(room.level, L.nUp - 1, ...NOTICE_Z).map((s, k) => len + s + (k ? 1 : -1) / 16);
  const postOnly = next && [post - 1 / 16, post + 0.07 + 1 / 16];
  return [[next && [post - 1 / 16, len], escape], [postOnly, escape]].map(h => h.filter(Boolean));
}
const NOTICE_Z = [19, 28]; // the rows of an empty room's notice, px over its floor (rooms.js backWall's band, WALL.vacant's card)
// the flat x nearest x where iw px of a back wall (F_: rooms.js frame), from x0 to x1, cross none of its hidden stretches (wallHidden), or null
export function clearOf(hidden, F_, x, iw, x0, x1) {
  const spans = hidden.map(([a0, a1]) => F_.X ? [a0 * 16, a1 * 16] : [(F_.len - a1) * 16, (F_.len - a0) * 16]);
  const clear = u => u >= x0 && u + iw <= x1 && !spans.some(([h0, h1]) => u < h1 && u + iw > h0);
  const at = [x, ...spans.flatMap(([h0, h1]) => [Math.ceil(h1), Math.floor(h0) - iw])].filter(clear);
  return at.length ? at.reduce((b, u) => Math.abs(u - x) < Math.abs(b - x) ? u : b) : null;
}

// the middle of the arcade's neon, in tiles from the room's start: just past its back row (cabinets, TV and timeboard,
// 3.5 tiles, all taller than the sign, the timeboard's top seen 0.3 nearer the start), so the whole of PLAY shows, and
// clear of the park end's fire escape where the arcade ends its wing
const ARCADE_NEON = 4;
// The arcade's wall art: its things ([name, width in px], the neon among them, and
// an empty one's EMPTY sign) in a row from the neon on to the room's far end, 2 px apart so a shelf fits beside the neon
// in the smallest room that has people (6 tiles: 36 px of wall past the back row, 4 of them kept clear at the end as on
// every wall). An empty one has 4 tiles, all behind its back row: nothing fits, so nothing peeks out cut off. Each as
// [name, its middle in tiles from the room's start].
export function arcadeWall(roomLen, things) {
  const order = [things.find(([name]) => name === 'neon'), ...things.filter(([name]) => name !== 'neon')], row = [];
  for (let u = ARCADE_NEON - order[0][1] / 32, i = 0; ; i++) {
    const [name, px] = order[i % order.length], len = px / 16;
    if (u + len > roomLen - 0.25) return row;
    row.push([name, u + len / 2]);
    u += len + 2 / 16;
  }
}
