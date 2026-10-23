// The building's outside: warm brick over a sandstone ground floor, stone trim and cornices, tall shuttered
// windows with window boxes (sky in the glass by day, lamplight and the odd silhouette by night), the front
// door under a striped awning, ivy on the park end and a mural facing the street. It closes the dollhouse's
// open sides. Each face is drawn flat, all floors tall, then sliced per level and sheared into place, so
// every level's front can swing open on its own. The glass is repainted only when the sky changes.
import { rng, pick, mix, canvas, trim, clamp } from '../../util.js';
import { FH, SLAB, PENT_H, CORE, ENTRANCE, INK, F, SX, SY, top, wallY, wallX, box, disc, text, wordmark, sprite, onWallY, onWallX, silhouette } from './iso.js';
import { BILLBOARD, drawBillboard } from './billboard.js';
import { roomAt } from './layout.js';

const LIP = 4; // the roof cornice's lip above the roof
const BRICK = '#c0593f', BRICK_HI = mix(BRICK, '#ffffff', 0.09), BRICK_LO = mix(BRICK, INK, 0.1), MORTAR = mix(BRICK, INK, 0.2), BRICK_SH = mix(BRICK, INK, 0.38);
const STONE = '#fdf3e1', STONE_HI = '#fffaf0', STONE_SH = '#e6d2ac', STONE_DK = '#c9ab7e';
const SAND = '#ebd3a8', SAND_LN = '#d2b384', PLINTH = '#8b8fa3', PLINTH_LN = '#6d6a80';
const SHUT = '#5fa89a', SHUT_DK = '#46877c', DOOR = '#2f8f83', DOOR_DK = '#236b62', GOLD = '#ffd966', PIPE = '#565a70', PIPE_HI = '#8b8fa3';
const BOXES = ['#b8693f', '#6e4029', '#4f8f84', '#fdf3e1'];
const BLOOMS = { spring: ['#ff8fab', '#fffaf0', '#ffd966', '#9b72cf'], summer: ['#e8505b', '#ff8fab', '#ffd966', '#ff9b4a'], autumn: ['#e8a33d', '#d9772b', '#c8553d', '#f2c14e'], winter: ['#e8505b', '#fffaf0'] };
const LEAVES = { spring: ['#3f9b5c', '#5cc26a', '#7bd389', '#2f7a47'], summer: ['#2f7a47', '#3f9b5c', '#5cc26a', '#7bd389'], autumn: ['#c8553d', '#e07a5f', '#e8a33d', '#8e3b2c', '#3f9b5c'], winter: ['#3f6a47', '#2f5a3c'] };
const CURTAINS = ['#e07a5f', '#9b72cf', '#4fb5a5', '#ffd966', '#ff8fab'];
// the soil the basement is cut out of (as in env.js), put back when the walls are on
const STRATA = [[0, '#8b8fa3'], [-3, '#6d6a80'], [-SLAB, '#9a6a48'], [-24, '#8a5a3c'], [-60, '#6e4a36'], [-120, '#5a3e36'], [-190, '#4a3a4a']];

// The four faces. Y: in a plane y = d (else x = d), running a0..a1 along the other axis. A and B are the
// wings' fronts. C and D are the wings' ends, including the back wall's edge.
function faces(L) {
  const list = [
    { id: 'A', Y: true, d: CORE, a0: CORE, a1: L.X1 },
    { id: 'B', Y: false, d: CORE, a0: CORE, a1: L.Y1 },
    { id: 'C', Y: false, d: L.X1, a0: -0.25, a1: CORE, end: 'x' },
    { id: 'D', Y: true, d: L.Y1, a0: -0.25, a1: CORE, end: 'y' },
  ];
  return list.map(f => ({ ...f, w: Math.round((f.a1 - f.a0) * 16) }));
}
const colOf = (f, a) => Math.round(f.Y ? (a - f.a0) * 16 : (f.a1 - a) * 16);
const alongOf = (f, c) => f.Y ? f.a0 + c / 16 : f.a1 - c / 16;
const world = (f, a) => f.Y ? { x: a, y: f.d } : { x: f.d, y: a };
// A window's light on the ground in front of it: three bands, from the wall outwards, each a little wider and further
// out than the last, so it fades as it spreads (screen points, drawn by pool)
const spillOf = (f, a0, a1) => [0.35, 0.6, 0.85].map((d, k) => [[a0 - 0.06 * k, 0.03], [a1 + 0.06 * k, 0.03], [a1 + 0.06 * k, d], [a0 - 0.06 * k, d]]
  .map(([a, dd]) => { const w = f.Y ? [a, f.d + dd] : [f.d + dd, a]; return [Math.round(SX(...w)), Math.round(SY(...w, 0))]; }));
function pool(g, bands, c, a) {
  g.fillStyle = c; g.globalAlpha = a;
  for (const q of bands) { g.beginPath(); q.forEach(([x, y], k) => k ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.fill(); }
  g.globalAlpha = 1;
}
const plane = (g, f, a0, a1, z0, z1, c) => f.Y ? wallY(g, a0, a1, f.d, z0, z1, c) : wallX(g, a0, a1, f.d, z0, z1, c);
// onWallY / onWallX, from rows sy..sy+H of a taller flat
function shear(g, f, src, sy, H, zb) {
  const c0 = f.Y ? Math.round(16 * (f.a0 - f.d)) : Math.round(16 * (f.d - f.a1));
  for (let u = 0; u < f.w; u++) {
    const c = c0 + u, y = (f.Y ? Math.floor(c / 2 - 0.25 + 16 * f.d - zb) : Math.floor(16 * f.d - c / 2 - 0.75 - zb)) - H + 1;
    g.drawImage(src, u, sy, 1, H, c, y, 1, H);
  }
}

// ---------------------------------------------------------------- one face, flat, all floors tall
function drawFace(L, f, fi, HT, out) {
  const { w } = f, c = canvas(w, HT), g = c.getContext('2d'), r = rng('facade' + f.id), sea = out.sea, on = L.holidays;
  const band = (x, z0, z1, bw, col) => { if (z1 > z0 && bw > 0) F(g, x, HT - z1, bw, z1 - z0, col); };
  const hole = (x, z0, z1, bw) => g.clearRect(x, HT - z1, bw, z1 - z0);
  const px = (x, z, col) => F(g, x, HT - z - 1, 1, 1, col);
  const at = a => colOf(f, a);
  const ledge = (x, z, lw) => out.ledges.push({ fi, x, z, w: lw });
  const lamp = (x, z, kind = 'lamp') => out.lamps.push({ ...world(f, alongOf(f, x + 0.5)), z, kind });
  const pane = (i, x, z0, z1, pw, kind = 'win') => {
    const a0 = alongOf(f, x), a1 = alongOf(f, x + pw), am = (a0 + a1) / 2, inside = f.end === 'x' ? { x: L.X1 - 0.1, y: am } : f.end === 'y' ? { x: am, y: L.Y1 - 0.1 } : f.Y ? { x: am, y: CORE - 0.1 } : { x: CORE - 0.1, y: am };
    out.panes.push({ fi, i, x, w: pw, z0, z1, a0: Math.min(a0, a1), a1: Math.max(a0, a1), kind, room: roomAt(L, i, inside.x, inside.y), curtain: kind === 'win' && r() < 0.4 ? pick(r, CURTAINS) : null });
  };
  const street = f.end && f.end === L.street, park = f.end && !street, nUp = L.nUp, roofZ = L.roofZ;
  // brick everywhere, coursed from the ground up so the floors line up
  band(0, 0, HT, w, BRICK);
  for (let z = 0; z < HT; z += 4) {
    band(0, z, z + 1, w, MORTAR);
    for (let x = (z / 4) % 2 ? 0 : 4; x < w; x += 8) { band(x, z + 1, z + 4, 1, MORTAR); if (r() < 0.16) band(x + 1, z + 1, z + 4, 7, r() < 0.5 ? BRICK_HI : BRICK_LO); }
  }
  // the ground floor: rusticated sandstone on a plinth
  const G = FH - SLAB;
  band(0, 0, G, w, SAND);
  for (let z = 6; z < G; z += 8) { band(0, z, z + 1, w, SAND_LN); for (let x = (z / 8 | 0) % 2 ? 6 : 18; x < w; x += 24) band(x, z + 1, Math.min(G, z + 8), 1, mix(SAND, SAND_LN, 0.5)); }
  band(0, 0, 6, w, PLINTH); band(0, 5, 6, w, '#b9b3c9'); for (let x = 3; x < w; x += 12) band(x, 0, 5, 1, PLINTH_LN);
  // quoins up the corners
  const quoin = (x0, flip) => { for (let z = G + 1, k = 0; z + 9 < roofZ - SLAB - 6; z += 10, k++) { const long = (k + flip) % 2 === 0, qw = long ? 9 : 6, x = x0 < 0 ? w - qw : x0; band(x, z + 1, z + 10, qw, '#f3e4c6'); band(x, z + 1, z + 2, qw, STONE_SH); band(x, z + 9, z + 10, qw, STONE_HI); } };
  if (f.id === 'A') quoin(-1, 0); if (f.id === 'C') { quoin(0, 1); quoin(-1, 0); } if (f.id === 'B') quoin(0, 0); if (f.id === 'D') { quoin(-1, 1); quoin(0, 0); }
  // a downpipe near the x wing's corner
  if (f.id === 'A') { const x = w - 12; band(x, 2, roofZ - 6, 2, PIPE); band(x, 2, roofZ - 6, 1, PIPE_HI); for (let z = 20; z < roofZ - 10; z += 24) band(x - 1, z, z + 1, 4, INK); band(x - 2, roofZ - 12, roofZ - 6, 6, PIPE); band(x - 2, roofZ - 7, roofZ - 6, 6, PIPE_HI); band(x, 0, 3, 4, PIPE); }
  // a stone belt at every floor slab, and the big cornice at the roof
  for (let i = 1; i < nUp; i++) {
    const z = i * FH;
    band(0, z - SLAB - 2, z - SLAB, w, BRICK_SH);
    band(0, z - SLAB, z, w, STONE); band(0, z - 1, z, w, STONE_HI); band(0, z - SLAB, z - SLAB + 1, w, STONE_DK); band(0, z - SLAB + 1, z - SLAB + 2, w, STONE_SH);
    for (let x = 1; x < w; x += 4) band(x, z - 6, z - 3, 2, STONE_SH);
    ledge(0, z, w);
  }
  const cz = roofZ;
  band(0, cz - SLAB - 8, cz - SLAB - 6, w, BRICK_SH);
  band(0, cz - SLAB - 6, cz + LIP, w, STONE);
  band(0, cz - SLAB - 6, cz - SLAB - 5, w, STONE_DK); band(0, cz - SLAB - 2, cz - SLAB - 1, w, '#d9a441');
  for (let x = 1; x < w; x += 4) { band(x, cz - SLAB + 1, cz - 1, 2, STONE_HI); band(x + 2, cz - SLAB + 1, cz - 1, 1, STONE_SH); }
  band(0, cz - 1, cz, w, STONE_SH); band(0, cz + LIP - 1, cz + LIP, w, STONE_HI);
  ledge(0, cz + LIP, w);

  // ---- windows ----
  const sash = (i, cx, box) => {
    const zf = i * FH, z0 = zf + 14, z1 = zf + 54, gx = cx - 7, gw = 14;
    for (const sx of [gx - 5, gx + gw + 1]) { band(sx, z0, z1, 4, SHUT); for (let z = z0 + 2; z < z1 - 1; z += 2) band(sx + 1, z, z + 1, 2, SHUT_DK); band(sx, z0, z1, 1, SHUT_DK); }
    band(gx - 1, z0 - 1, z1 + 1, gw + 2, STONE); band(gx, z0, z1, gw, BRICK_SH); hole(gx + 1, z0, z1 - 1, gw - 1);
    band(cx, z0, z1 - 1, 1, STONE); band(gx + 1, z1 - 14, z1 - 13, gw - 1, STONE);
    band(gx - 3, z1 + 1, z1 + 4, gw + 6, STONE); band(gx - 3, z1 + 1, z1 + 2, gw + 6, STONE_SH); band(cx - 2, z1 - 1, z1 + 6, 4, STONE_HI); band(cx + 1, z1 - 1, z1 + 6, 1, STONE_SH);
    band(gx - 3, z0 - 3, z0 - 1, gw + 6, STONE); band(gx - 3, z0 - 3, z0 - 2, gw + 6, STONE_SH); band(gx - 2, z0 - 5, z0 - 3, gw + 4, BRICK_SH);
    ledge(gx - 3, z0 - 1, gw + 6); ledge(gx - 3, z1 + 4, gw + 6);
    pane(i, gx + 1, z0, z1 - 1, gw - 1);
    if (box) windowBox(cx, z0);
  };
  const windowBox = (cx, z0) => {
    const bx = cx - 9, bw = 18, col = pick(r, BOXES), leaves = LEAVES[sea], blooms = BLOOMS[sea];
    for (let x = bx; x < bx + bw; x++) { const hgt = 2 + (r() * 3 | 0); band(x, z0 + 3, z0 + 3 + hgt, 1, pick(r, leaves)); }
    for (let k = 0; k < 7; k++) { const x = bx + 1 + (r() * (bw - 3) | 0), z = z0 + 5 + (r() * 3 | 0); if (sea === 'winter') px(x, z, k % 3 ? '#e8505b' : '#fffaf0'); else { const b = pick(r, blooms); px(x, z, b); px(x + 1, z, b); px(x, z + 1, b); px(x + 1, z + 1, mix(b, '#ffffff', 0.4)); } }
    if (on.has('halloween') && r() < 0.35) { const x = bx + 4 + (r() * 8 | 0); band(x, z0 + 3, z0 + 7, 4, '#d9772b'); band(x + 1, z0 + 3, z0 + 7, 1, '#c8631f'); px(x + 2, z0 + 7, '#3f9b5c'); }
    band(bx, z0 - 2, z0 + 3, bw, col); band(bx, z0 + 2, z0 + 3, bw, mix(col, '#ffffff', 0.3)); band(bx, z0 - 2, z0 - 1, bw, mix(col, INK, 0.3));
    band(bx + 2, z0 - 4, z0 - 2, 1, INK); band(bx + bw - 3, z0 - 4, z0 - 2, 1, INK);
    if (sea !== 'winter') for (let k = 0; k < 4; k++) { const x = bx + (r() * bw | 0), l = 2 + (r() * 4 | 0); band(x, z0 - 2 - l, z0 - 1, 1, pick(r, leaves)); }
    ledge(bx, z0 + 3, bw);
  };
  const arch = (cx, gw, z0, z1, i) => { // an arched ground-floor window (or fanlight)
    const hw = gw >> 1;
    band(cx - hw - 2, z0 - 1, z1 + 2, gw + 4, STONE); band(cx - hw - 2, z0 - 1, z1 + 2, 1, STONE_SH);
    for (const [k, ins] of [[0, 4], [1, 2], [2, 1]]) { band(cx - hw - 2, z1 + 1 - k, z1 + 2 - k, ins, SAND); band(cx + hw + 2 - ins, z1 + 1 - k, z1 + 2 - k, ins, SAND); }
    hole(cx - hw, z0, z1 - 3, gw);
    for (const [k, ins] of [[0, 4], [1, 2], [2, 1]]) hole(cx - hw + ins, z1 - 1 - k, z1 - k, gw - 2 * ins);
    band(cx - 2, z1 - 1, z1 + 5, 4, STONE_HI); band(cx + 1, z1 - 1, z1 + 5, 1, STONE_SH);
    if (i != null) pane(i, cx - hw, z0, z1, gw);
  };
  const shopWindow = (cx) => {
    arch(cx, 18, 12, 54, 0);
    band(cx, 12, 51, 1, STONE); band(cx - 9, 40, 41, 18, STONE);
    band(cx - 11, 8, 11, 22, STONE); band(cx - 11, 8, 9, 22, STONE_SH); band(cx - 10, 6, 8, 20, mix(SAND, INK, 0.25));
    ledge(cx - 11, 11, 22);
  };
  // the rooms behind this face on level i, as spans along it
  const spans = i => {
    if (f.end) return [[0.3, CORE - 0.3]];
    const behind = L.level(i).rooms.filter(rm => f.id === 'A' ? rm.wing !== 'y' : rm.wing === 'y');
    const span = rm => f.id === 'A' ? [Math.max(rm.x0, CORE + 0.4), Math.min(rm.x1, L.X1 - 1)] : [Math.max(rm.y0, CORE + 0.45), Math.min(rm.y1, L.Y1 - 0.6)];
    const aroundDoor = ([a, b]) => f.id === 'A' && !i ? [[a, Math.min(b, ENTRANCE - 0.85)], [Math.max(a, ENTRANCE + 0.85), b]] : [[a, b]];
    return behind.map(span).flatMap(aroundDoor).filter(([a, b]) => b - a >= 1.2);
  };
  // the street end's screen: where it goes, and the floors whose windows it replaces
  const BW = BILLBOARD.w, BH = BILLBOARD.h, sx = (w - BW) >> 1, sz = FH + 12, screen = street && sx >= 5 && sz + BH + 3 <= nUp * FH - SLAB - 8; // (under the roof cornice)
  for (let i = 0; i < nUp; i++) {
    if (street && i === 0) { dockDoor(); continue; }
    if (screen && i * FH + 8 < sz + BH + 8 && i * FH + 60 > sz - 10) continue;
    for (const [s0, s1] of spans(i)) {
      const n = Math.max(1, Math.floor((s1 - s0) / 2)), p = (s1 - s0) / n;
      for (let k = 0; k < n; k++) { const cx = at(s0 + p * (k + 0.5)); i ? sash(i, cx, park || r() < 0.6) : shopWindow(cx); }
    }
  }
  if (screen) mount(sx, sz, BW, BH);
  function dockDoor() { // the loading dock's roller shutter, where the parcels go out to the van
    const cx = at(1.6), x = cx - 16;
    band(x - 2, 0, 44, 36, INK); for (let z = 0; z < 44; z++) { band(x - 2, z, z + 1, 2, (z >> 2) % 2 ? GOLD : INK); band(x + 32, z, z + 1, 2, (z >> 2) % 2 ? GOLD : INK); }
    band(x, 0, 42, 32, '#8b8fa3'); for (let z = 1; z < 42; z += 3) band(x, z, z + 1, 32, '#6d6a80');
    band(x + 13, 3, 5, 6, '#565a70'); band(x - 2, 42, 44, 36, GOLD);
    band(cx - 9, 50, 57, 18, GOLD); text(g, 'DOCK', cx - 7, HT - 56, INK);
    band(cx, 60, 64, 1, INK); band(cx - 3, 58, 60, 7, INK); band(cx - 2, 57, 58, 5, '#fff3b0');
    lamp(cx, 55);
  }
  function mount(x, z0, mw, mh) { // the promo screen facing the street: bezel, brackets, a speaker, a cable to the dock
    const cx = x + (mw >> 1);
    for (const bx of [x - 5, x + mw + 2]) for (const bz of [z0 + 6, z0 + mh - 8]) { band(bx, bz, bz + 2, 4, IRON); band(bx + (bx < x ? 0 : 3), bz - 2, bz + 4, 1, IRON); }
    band(x - 3, z0 - 3, z0 + mh + 3, mw + 6, '#2b2230'); band(x - 3, z0 + mh + 2, z0 + mh + 3, mw + 6, '#565a70'); band(x - 1, z0 - 1, z0 + mh + 1, mw + 2, '#141a2e');
    band(x, z0, z0 + mh, mw, '#141a2e'); px(x + mw, z0 - 2, '#7bd389');
    band(cx - 7, z0 - 9, z0 - 4, 14, '#2b2230'); for (let u = 1; u < 13; u += 2) for (let v = 1; v < 5; v += 2) px(cx - 7 + u, z0 - 9 + v, '#565a70');
    for (let z = z0 - 3, k = 0; z > 64; z--, k++) { px(x + mw - 3 + Math.round(Math.sin(k / 9) * 1.2), z, '#2b2230'); if (k % 12 === 6) px(x + mw - 2, z, '#8b8fa3'); }
    out.screen = { fi, x, z0, w: mw, h: mh };
    out.lamps.push({ ...world(f, alongOf(f, cx)), z: z0 + (mh >> 1), kind: 'screen' });
  }
  // the front door, beside the stairwell, with lanterns and the name above
  if (f.id === 'A') {
    const cx = at(ENTRANCE);
    band(cx - 11, 0, 53, 22, STONE); band(cx - 11, 0, 53, 1, STONE_SH); band(cx + 10, 0, 53, 1, STONE_SH); band(cx - 9, 0, 3, 18, STONE_DK);
    band(cx - 8, 3, 41, 16, DOOR_DK);
    for (const lx of [cx - 8, cx]) { band(lx, 3, 40, 8, DOOR); band(lx + 1, 5, 18, 6, DOOR_DK); band(lx + 2, 6, 17, 4, DOOR); band(lx, 3, 40, 1, DOOR_DK); band(lx + 1, 21, 37, 6, DOOR_DK); hole(lx + 2, 22, 36, 4); pane(0, lx + 2, 22, 36, 4, 'door'); }
    px(cx - 2, 20, GOLD); px(cx + 1, 20, GOLD); px(cx - 2, 21, GOLD); px(cx + 1, 21, GOLD);
    arch(cx, 16, 42, 50, null); pane(0, cx - 8, 42, 50, 16, 'door'); for (const dx of [-4, 0, 4]) band(cx + (dx > 0 ? 3 : dx < 0 ? -4 : 0), 42, 45, 1, STONE);
    if (on.has('christmas')) { for (let a = 0; a < 16; a++) px(cx + Math.round(Math.cos(a / 16 * 6.28) * 4), 30 + Math.round(Math.sin(a / 16 * 6.28) * 4), a % 4 ? '#3f9b5c' : '#e8505b'); band(cx - 1, 25, 27, 3, '#e8505b'); }
    const lan = x => { band(x - 1, 36, 37, 3, INK); band(x - 2, 26, 34, 5, INK); band(x - 1, 27, 33, 3, '#fff3b0'); band(x - 2, 34, 36, 5, INK); px(x, 36, INK); px(x, 25, INK); lamp(x, 30); };
    lan(cx + 16);
    // the name: the logo on a small plum plaque in a stone rim, its accent in gold, centred on the plaque's 15 rows
    const { sign: { pixels, plaque }, logo: { colours: o } } = out.brand, sw = pixels[0].length + 6, sx = Math.max(3, cx - (sw >> 1) + 2); // (between the arches' tops and the belt above)
    band(sx - 1, 57, 78, sw + 2, STONE); band(sx, 58, 77, sw, plaque); wordmark(g, sx + 3, HT - 75 + ((15 - pixels.length) >> 1), o.ink, o.accent, o.shadow, pixels); band(sx - 1, 57, 58, sw + 2, STONE_SH);
    out.sign = { fi, x: sx - 1, z0: 57, z1: 78, w: sw + 2 };
  }
  if (f.id === 'B') { const x = at(CORE + 0.4); band(x - 1, 36, 37, 3, INK); band(x - 2, 26, 34, 5, INK); band(x - 1, 27, 33, 3, '#fff3b0'); band(x - 2, 34, 36, 5, INK); px(x, 36, INK); px(x, 25, INK); lamp(x, 30); }
  // ivy climbing the park end and round the corner (red in autumn, bare in winter)
  const ivy = (x0, x1, zMax, seed) => {
    const r2 = rng(seed), lv = LEAVES[sea], dense = sea === 'winter' ? 0.12 : 0.85;
    for (let v = 0; v < 6; v++) {
      let x = x0 + r2() * (x1 - x0); const hgt = zMax * (0.5 + r2() * 0.5);
      for (let z = 0; z < hgt; z++) {
        if (r2() < 0.3) x = clamp(x + (r2() < 0.5 ? -1 : 1), 0, w - 1);
        px(x | 0, z, '#5a3825');
        if (r2() < dense * (1 - z / hgt * 0.6)) { const lx = (x | 0) + (r2() * 7 | 0) - 3, col = pick(r2, lv); band(lx, z, z + 2, 3, col); px(lx + 1, z + 2, col); if (r2() < 0.35) px(lx + 1, z + 1, mix(col, '#ffffff', 0.3)); else px(lx + 2, z, mix(col, INK, 0.2)); }
      }
    }
  };
  if (park) ivy(f.Y ? w - 7 : 0, f.Y ? w : 7, FH * 1.3, 'ivy-end');
  if ((f.id === 'B' && L.street === 'x') || (f.id === 'A' && L.street !== 'x')) ivy(f.id === 'B' ? 0 : w - 16, f.id === 'B' ? 14 : w, FH * 1.2, 'ivy-front');
  return c;
}

// ---------------------------------------------------------------- the door's awning, step and topiaries
function frontExtras(g) {
  const x0 = ENTRANCE - 0.66, x1 = ENTRANCE + 0.66, OUT = 0.5, Z = 57, DROP = 8;
  box(g, x0 + 0.08, CORE, 0, x1 - 0.08, CORE + 0.3, 3, ['#e6e8f0', '#c9ccd8', '#a8a4b8']);
  for (const [px0, py0] of [[x0 - 0.3, CORE + 0.12], [x1 + 0.05, CORE + 0.12]]) {
    box(g, px0, py0, 0, px0 + 0.22, py0 + 0.22, 8, ['#cf9460', '#b8693f', '#8e5a2b']);
    const sx = SX(px0 + 0.11, py0 + 0.11), sy = SY(px0 + 0.11, py0 + 0.11, 14);
    disc(g, sx, sy, 5, '#2f7a47'); disc(g, sx - 1, sy - 1, 4, '#3f9b5c'); F(g, sx - 2, sy - 3, 2, 1, '#7bd389'); F(g, sx, sy + 5, 1, 2, '#6e4029');
  }
  // the canopy, sloping out from the wall, in red and cream stripes, then its scalloped valance and side
  const stripe = u => ((u - x0) / 0.1875 | 0) % 2 ? '#fffaf0' : '#e8505b';
  for (let u = x0; u < x1; u += 1 / 64) for (let v = 0; v < OUT; v += 1 / 64) F(g, Math.round(SX(u, CORE + v)), Math.round(SY(u, CORE + v, Z - v / OUT * DROP)), 1, 1, stripe(u));
  for (let u = x0; u < x1 - 1e-6; u += 0.1875) { const k = Math.round((u - x0) / 0.1875); wallY(g, u, Math.min(x1, u + 0.1875), CORE + OUT, Z - DROP - (k % 2 ? 4 : 5), Z - DROP, stripe(u + 0.01)); }
  for (let v = 0; v < OUT; v += 1 / 32) wallX(g, CORE + v, CORE + v + 1 / 32, x1, Z - DROP - 4, Z - v / OUT * DROP, '#c8404b');
  wallY(g, x0, x1, CORE + OUT, Z - DROP, Z - DROP + 1, '#b8404f');
}
// the penthouse's glass front
function pentGlass(g, L) {
  const P = L.pent, z = L.roofZ, x1 = P.x1, Y = CORE;
  g.globalAlpha = 0.2; wallY(g, 0, x1, Y, z + LIP, z + PENT_H, '#bfe6ff');
  g.globalAlpha = 0.4; for (let x = 0.4; x < x1 - 0.5; x += 2.3) { wallY(g, x, x + 0.14, Y, z + 12, z + PENT_H - 4, '#ffffff'); wallY(g, x + 0.2, x + 0.26, Y, z + 12, z + PENT_H - 4, '#ffffff'); }
  g.globalAlpha = 1;
  for (let x = 0; x <= x1; x += 1) wallY(g, Math.min(x, x1 - 0.06), Math.min(x, x1 - 0.06) + 0.06, Y, z, z + PENT_H, '#fdf3e1');
  wallY(g, 0, x1, Y, z + PENT_H - 2, z + PENT_H, '#fdf3e1'); wallY(g, 0, x1, Y, z + 30, z + 31, '#fdf3e1');
}

// ---------------------------------------------------------------- the fire escape on the park end
// Iron landings at every floor with railings, steep flights switching back between them, a drop ladder that
// stops well above the pavement and a gooseneck ladder over the cornice. One sprite per level (the landing
// and the flight coming down to it), so it arrives with its floor and still makes sense with the walls off.
const IRON = '#2b2230', IRON_HI = '#6d6a80', GRATE = '#4a4560';
function fireEscape(L, i) {
  const top1 = L.nUp - 1, X = L.street !== 'x', E = X ? L.X1 : L.Y1, z = i * FH, N = 0.6, A0 = 0.3, A1 = 2.7;
  const pt = (a, n) => X ? [E + n, a] : [a, E + n], s = (a, n, zz) => { const [x, y] = pt(a, n); return [Math.round(SX(x, y)), Math.round(SY(x, y, zz))]; };
  const flat = (g, a0, a1, n0, n1, zz, c) => { const [x0, y0] = pt(Math.min(a0, a1), n0), [x1, y1] = pt(Math.max(a0, a1), n1); top(g, Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1), zz, c); };
  const front = (g, a0, a1, n, z0, z1, c) => X ? wallX(g, a0, a1, E + n, z0, z1, c) : wallY(g, a0, a1, E + n, z0, z1, c);
  const side = (g, a, n0, n1, z0, z1, c) => X ? wallY(g, E + n0, E + n1, a, z0, z1, c) : wallX(g, E + n0, E + n1, a, z0, z1, c);
  const line = (g, [x1, y1], [x2, y2], c) => { const n = Math.max(1, Math.abs(x2 - x1), Math.abs(y2 - y1)); g.fillStyle = c; for (let k = 0; k <= n; k++) g.fillRect(Math.round(x1 + (x2 - x1) * k / n), Math.round(y1 + (y2 - y1) * k / n), 1, 1); };
  const ladder = (g, a, n, zb, zt) => { for (const u of [a, a + 0.22]) line(g, s(u, n, zb), s(u, n, zt), IRON); for (let zz = zb + 3; zz < zt; zz += 5) line(g, s(a, n, zz), s(a + 0.22, n, zz), IRON_HI); };
  const from = k => k % 2 ? 0.5 : 2.5, to = k => k % 2 ? 2.2 : 0.8; // the flight down to landing k starts over here and lands there
  const up = i === top1 ? (i > 1 ? (from(i - 1) < 1.5 ? 2.25 : 0.45) : 2.25) : null;
  const [bx0, by0] = pt(A0 - 0.1, 0), [bx1, by1] = pt(A1 + 0.1, N + 0.1);
  return sprite(Math.min(bx0, bx1), Math.min(by0, by1), Math.max(bx0, bx1), Math.max(by0, by1), i === 1 ? 24 : z - 16, i === top1 ? L.roofZ + 16 : z + FH + 14, g => {
    for (const a of [A0 + 0.2, A1 - 0.2]) line(g, s(a, 0, z - 13), s(a, N - 0.05, z - 1), IRON); // brackets
    if (i === 1) ladder(g, 0.42, 0.42, 28, z);
    flat(g, A0, A1, 0, N, z, GRATE);
    for (let a = A0 + 0.1; a < A1; a += 3 / 16) flat(g, a, a + 1 / 16, 0.04, N - 0.04, z, IRON_HI);
    front(g, A0, A1, N, z - 2, z, IRON); front(g, A0, A1, N, z - 1, z, IRON_HI);
    if (i < top1) { // the flight coming down from the landing above
      const a0 = from(i), a1 = to(i), n0 = 0.1, n1 = 0.36, zt = z + FH;
      for (let k = 1; k < 16; k++) { const a = a0 + (a1 - a0) * k / 16, zz = zt + (z - zt) * k / 16; flat(g, a - 0.05, a + 0.05, n0, n1, zz, IRON_HI); }
      line(g, s(a0, n0, zt), s(a1, n0, z), IRON); line(g, s(a0, n1, zt), s(a1, n1, z), IRON);
      line(g, s(a0, n1, zt + 11), s(a1, n1, z + 11), IRON_HI); line(g, s(a1, n1, z), s(a1, n1, z + 11), IRON);
    }
    if (up != null) { // a gooseneck ladder over the cornice onto the roof
      ladder(g, up, 0.42, z, L.roofZ + 6);
      for (const u of [up, up + 0.22]) { line(g, s(u, 0.42, L.roofZ + 6), s(u, 0.22, L.roofZ + 11), IRON); line(g, s(u, 0.22, L.roofZ + 11), s(u, 0.02, L.roofZ + 6), IRON); }
    }
    if (i === top1) { // someone keeps a plant out here
      const a = up < 1.5 ? 2.05 : 0.95, [sx, sy] = s(a, 0.24, z);
      flat(g, a - 0.1, a + 0.1, 0.14, 0.34, z + 6, '#cf9460'); front(g, a - 0.1, a + 0.1, 0.34, z, z + 6, '#b8693f');
      disc(g, sx, sy - 11, 4, '#3f9b5c'); disc(g, sx - 1, sy - 12, 3, '#5cc26a'); F(g, sx - 2, sy - 14, 1, 1, '#ff8fab'); F(g, sx + 2, sy - 12, 1, 1, '#ff8fab'); F(g, sx, sy - 15, 1, 1, '#ffd966');
    }
    // the railing: balusters, a mid rail and a top rail round the outside
    for (let a = A0; a <= A1 + 1e-6; a += 0.4) front(g, Math.min(a, A1 - 1 / 16), Math.min(a, A1 - 1 / 16) + 1 / 16, N, z, z + 12, IRON);
    for (const a of [A0, A1 - 1 / 32]) { side(g, a, 0, N, z + 11, z + 12, IRON_HI); side(g, a, 0, N, z + 6, z + 7, IRON); }
    front(g, A0, A1, N, z + 11, z + 12, IRON_HI); front(g, A0, A1, N, z + 6, z + 7, IRON);
  }, 4);
}

// ---------------------------------------------------------------- the penthouse's roof
// A verdigris copper mansard over the glass box: stone eaves, short steep slopes to a flat top with two
// skylights, a brick chimney and a cat on the weather vane. The top stops short of the back wall, just where
// the sign's feet are, so the sign still stands clear above it. The chimney (with the vane on it) is at the far
// left, clear of the sign. snow: the same slopes in white, for winter.
function penthouseRoof(L, snow) {
  const P = L.pent, x0 = -0.12, x1 = P.x1 + 0.12, yF = CORE + 0.12, yB = -0.12, R = 0.8, yT = yF - R, yK = 0.6, z0 = L.roofZ + PENT_H + 2, zT = z0 + 8;
  const xR = x1 - R, sky = [[2.4, 3.3], [4.6, 5.5]], chim = x0 + 0.2; // the chimney at the left end, clear of the sign
  return sprite(x0, yB, x1, yF, z0 - 5, zT + 26, g => {
    const put = (x, y, z, c) => F(g, Math.round(SX(x, y)), Math.round(SY(x, y, z)), 1, 1, c);
    const cu = (seam, k) => snow ? (seam ? '#dfe6f5' : '#f4f6ff') : seam ? '#4f8f84' : ['#6fb5a0', '#5a9c8b', '#7fc4ae'][k];
    for (let v = 0; v <= 1.001; v += 1 / 32) { // the slope at the far end, facing the street side
      const x = x1 - R * v, z = z0 + 8 * v, ya = yB + (yK - yB) * v, yb = yF - R * v;
      for (let y = ya; y <= yb; y += 1 / 40) put(x, y, z, cu(((y * 4) % 1) < 0.14, 1));
    }
    for (let v = 0; v <= 1.001; v += 1 / 32) { // the front slope
      const y = yF - R * v, z = z0 + 8 * v, xb = x1 - R * v;
      for (let x = x0; x <= xb; x += 1 / 40) put(x, y, z, cu(((x * 4) % 1) < 0.12, 0));
    }
    top(g, x0, yK, xR, yT, zT, cu(false, 2)); // the flat top
    for (let x = x0 + 0.2; x < xR; x += 0.5) top(g, x, yK, x + 1 / 32, yT, zT, snow ? '#e8eefb' : '#6fb5a0');
    if (!snow) {
      for (let x = x0; x <= xR; x += 1 / 32) put(x, yT, zT, '#9fdcc8'); for (let v = 0; v <= 1; v += 1 / 24) put(x1 - R * v, yF - R * v, z0 + 8 * v, '#9fdcc8');
      for (const [a, b] of sky) { box(g, a, yK + 0.35, zT, b, yT - 0.2, zT + 2, ['#fdf3e1', '#e6d2ac', '#c9ab7e']); top(g, a + 0.08, yK + 0.43, b - 0.08, yT - 0.28, zT + 2, '#bfe6ff'); top(g, a + 0.2, yK + 0.5, a + 0.3, yT - 0.35, zT + 2, '#ffffff'); }
    }
    // stone eaves with dentils
    if (!snow) {
      wallY(g, x0, x1, yF, z0 - 5, z0, STONE); wallY(g, x0, x1, yF, z0 - 5, z0 - 4, STONE_DK); wallY(g, x0, x1, yF, z0 - 1, z0, STONE_HI);
      for (let x = x0 + 0.05; x < x1 - 0.1; x += 0.25) wallY(g, x, x + 0.12, yF, z0 - 4, z0 - 2, STONE_SH);
      wallX(g, yB, yF, x1, z0 - 5, z0, STONE_SH); wallX(g, yB, yF, x1, z0 - 5, z0 - 4, STONE_DK);
    }
    // a brick chimney with a stone cap and a pot
    const cy = yK + 0.15;
    box(g, chim, cy, zT, chim + 0.42, cy + 0.4, zT + 17, snow ? '#f4f6ff' : [BRICK_HI, BRICK, BRICK_SH]);
    if (snow) return;
    for (let z = zT + 3; z < zT + 16; z += 4) { wallY(g, chim, chim + 0.42, cy + 0.4, z, z + 1, MORTAR); wallX(g, cy, cy + 0.4, chim + 0.42, z, z + 1, mix(BRICK_SH, INK, 0.2)); }
    box(g, chim - 0.05, cy - 0.05, zT + 17, chim + 0.47, cy + 0.45, zT + 19, [STONE_HI, STONE, STONE_SH]);
    box(g, chim + 0.13, cy + 0.12, zT + 19, chim + 0.29, cy + 0.28, zT + 23, ['#cf9460', '#b8693f', '#8e5a2b']);
    // the weather vane, on the chimney pot: an arrow and a cat
    const vx = Math.round(SX(chim + 0.21, cy + 0.2)), vy = Math.round(SY(chim + 0.21, cy + 0.2, zT + 23)), V = '#b8862e';
    F(g, vx, vy - 13, 1, 13, IRON); F(g, vx - 4, vy - 9, 9, 1, V); F(g, vx + 4, vy - 10, 1, 3, V); F(g, vx - 5, vy - 11, 1, 5, V); F(g, vx - 6, vy - 10, 1, 3, V);
    F(g, vx - 2, vy - 16, 5, 3, V); F(g, vx - 2, vy - 18, 1, 2, V); F(g, vx, vy - 18, 1, 2, V); F(g, vx + 3, vy - 18, 1, 4, V); F(g, vx - 1, vy - 17, 1, 1, INK);
  }, 4);
}

// ---------------------------------------------------------------- the soil over the basement
// a floor's concrete ceiling slab over the building's L-shaped footprint, with a lighter rim along the front
function ceiling(g, L, z) {
  top(g, -0.25, -0.25, L.X1, CORE, z, CONCRETE[0]); top(g, -0.25, CORE, CORE, L.Y1, z, CONCRETE[0]);
  top(g, CORE, CORE - 0.12, L.X1, CORE, z, CONCRETE[1]); top(g, CORE - 0.12, CORE, CORE, L.Y1, z, CONCRETE[1]);
  top(g, L.X1 - 0.12, -0.25, L.X1, CORE, z, CONCRETE[1]); top(g, -0.25, L.Y1 - 0.12, CORE, L.Y1, z, CONCRETE[1]);
}
// the lot the building stands on, shown while its ground floor is closed (the intro lands the floors on it)
export function drawLot(g, L) {
  top(g, -0.25, -0.25, L.X1, CORE, 0, CONCRETE[2]); top(g, -0.25, CORE, CORE, L.Y1, 0, CONCRETE[2]);
}
const CONCRETE = ['#a9a5b8', '#cdc9da', '#8f8aa0'];

function buildPlug(L) {
  const rooms = L.rooms.filter(rm => rm.level < 0 && rm.wing !== 'core');
  if (!rooms.length) return null;
  const b = L.bounds, c = canvas(b.x1 - b.x0, b.y1 - b.y0), g = c.getContext('2d'), r = rng('plug');
  g.translate(-b.x0, -b.y0);
  const fill = (pl, a0, a1, z0, z1) => {
    for (let k = 0; k < STRATA.length; k++) { const top1 = STRATA[k][0], bot = k + 1 < STRATA.length ? STRATA[k + 1][0] : -999; const lo = Math.max(z0, bot), hi = Math.min(z1, top1); if (hi > lo) pl(a0, a1, lo, hi, STRATA[k][1]); }
    for (let i = 0; i < (a1 - a0) * (z1 - z0) / 5; i++) { const u = a0 + r() * (a1 - a0), z = z0 + r() * (z1 - z0 - 1); pl(u, u + 0.06, z, z + 1, r() < 0.5 ? '#a47352' : '#4e3630'); }
  };
  for (const rm of rooms) {
    const X = rm.wing === 'x', D = rm.lv.D, z0 = rm.z - SLAB, z1 = -SLAB;
    fill(X ? (a0, a1, lo, hi, col) => wallY(g, a0, a1, D, lo, hi, col) : (a0, a1, lo, hi, col) => wallX(g, a0, a1, D, lo, hi, col), X ? rm.x0 : rm.y0, X ? rm.x1 : rm.y1, z0, z1);
    if (X && rm.x1 >= L.Xe) fill((a0, a1, lo, hi, col) => wallX(g, a0, a1, L.Xe, lo, hi, col), 0, D, z0, z1);
    if (!X && rm.y1 >= L.Ye) fill((a0, a1, lo, hi, col) => wallY(g, a0, a1, L.Ye, lo, hi, col), 0, D, z0, z1);
  }
  const t = trim(c), p = { c: t.c, x: b.x0 + t.dx, y: b.y0 + t.dy };
  p.shade = silhouette(p.c, '#0d0b28');
  return p;
}

// ---------------------------------------------------------------- build: flats, then one sheared layer per level
// brand: as scene.js dresses it
export function buildFacade(L, sea, brand) {
  if (!L.nUp) return null;
  const HT = L.roofZ + LIP, fs = faces(L), out = { panes: [], lamps: [], ledges: [], sea, brand };
  const flats = fs.map((f, fi) => drawFace(L, f, fi, HT, out));
  const FC = { L, HT, faces: fs, flats, levels: [], key: '', snowFlats: null, plug: buildPlug(L) };
  let glassFlats = null;
  for (let i = 0; i <= L.nUp; i++) {
    const roof = i === L.nUp, z0 = roof ? L.roofZ - SLAB : i ? i * FH - SLAB : 0, z1 = roof ? L.roofZ + LIP : (i + 1) * FH - SLAB;
    const pts = [[L.X1, -0.25, z1], [-0.25, L.Y1, z1], [CORE, CORE, z1], [L.X1, CORE, z0], [CORE, L.Y1, z0], ...(i ? [] : [[ENTRANCE + 0.9, CORE + 0.9, 0]])];
    const x = Math.floor(SX(-0.25, L.Y1)) - 2, y = Math.floor(Math.min(...pts.map(p => SY(...p)))) - 4;
    const c = canvas(Math.ceil(SX(L.X1, -0.25)) + 2 - x, Math.ceil(Math.max(...pts.map(p => SY(...p)))) + 4 - y), g = c.getContext('2d');
    g.translate(-x, -y);
    fs.forEach((f, fi) => shear(g, f, flats[fi], HT - z1, z1 - z0, z0));
    const V = { i, z0, z1, extra: null, glass: null };
    // a closed floor's ceiling, so each floor drops in as a solid block (hidden under the next floor once it
    // lands, and left out while the walls lift)
    if (!roof) { V.ceil = sprite(-0.25, -0.25, L.X1, L.Y1, z1, z1, gg => ceiling(gg, L, z1)); V.ceil.shade = silhouette(V.ceil.img, '#0d0b28'); }
    if (i === 0) { V.extra = sprite(ENTRANCE - 1, CORE, ENTRANCE + 1, CORE + 0.7, 0, 60, frontExtras); g.drawImage(V.extra.img, V.extra.x, V.extra.y); }
    if (i > 0 && !roof) V.escape = fireEscape(L, i);
    if (roof && L.pent) { V.lid = penthouseRoof(L, false); V.lid.shade = silhouette(V.lid.img, '#0d0b28'); }
    if (roof && L.pent) V.glass = sprite(0, CORE - 0.1, L.pent.x1, CORE + 0.05, L.roofZ, L.roofZ + PENT_H, gg => pentGlass(gg, L));
    const t = trim(c);
    Object.assign(V, { img: t.c, x: x + t.dx, y: y + t.dy });
    V.shade = silhouette(V.img, '#0d0b28');
    V.panes = canvas(V.img.width, V.img.height);
    V.glassMask = canvas(V.img.width, V.img.height); // where the glass shows through the wall
    const gm = V.glassMask.getContext('2d'); gm.translate(-V.x, -V.y);
    glassFlats ??= fs.map((f, fi) => { const gc = canvas(f.w, HT), gg = gc.getContext('2d'); for (const p of out.panes) if (p.fi === fi) F(gg, p.x, HT - p.z1, p.w, p.z1 - p.z0, '#fff'); return gc; });
    fs.forEach((f, fi) => shear(gm, f, glassFlats[fi], HT - z1, z1 - z0, z0));
    gm.setTransform(1, 0, 0, 1, 0, 0); gm.globalCompositeOperation = 'destination-out'; gm.drawImage(V.img, 0, 0);
    // (spill: where a ground-floor window's light falls, on the sidewalk in front of it: spillOf)
    V.wins = out.panes.filter(p => p.i === i && z0 <= p.z0 && p.z1 <= z1).map(p => {
      const f = fs[p.fi], wp = world(f, (p.a0 + p.a1) / 2);
      return { ...p, f, sx: SX(wp.x, wp.y), sy: SY(wp.x, wp.y, p.z0), spill: i === 0 && p.kind !== 'door' && p.z0 < 20 ? spillOf(f, p.a0, p.a1) : null };
    });
    const sn = out.sign;
    if (sn && sn.z0 >= z0 && sn.z1 <= z1) { // the entrance sign's halo, drawn flat round it and sheared onto its wall like the sign
      const f = fs[sn.fi], P = 6, hf = canvas(f.w, HT), hg = hf.getContext('2d');
      // signLit keeps the sign itself out of the night shade, and nothing round it: the awning under it is lit only by the
      // halo, signGlow, a soft one that leaves its letters alone
      hg.fillStyle = '#7a5a14'; hg.fillRect(sn.x, HT - sn.z1, sn.w, sn.z1 - sn.z0);
      V.signLit = canvas(V.img.width, V.img.height); const sl = V.signLit.getContext('2d'); sl.translate(-V.x, -V.y);
      shear(sl, f, hf, HT - z1, z1 - z0, z0);
      hg.clearRect(0, 0, f.w, HT); hg.globalAlpha = 0.13;
      for (let b = 0; b < 4; b++) { const e = Math.round(P * (b + 1) / 4), x = sn.x - e, y = HT - sn.z1 - e, w = sn.w + 2 * e, h = sn.z1 - sn.z0 + 2 * e; hg.fillRect(x + 1, y, w - 2, h); hg.fillRect(x, y + 1, w, h - 2); }
      hg.globalAlpha = 1; hg.clearRect(sn.x, HT - sn.z1, sn.w, sn.z1 - sn.z0);
      V.signGlow = canvas(V.img.width, V.img.height); const sg = V.signGlow.getContext('2d'); sg.translate(-V.x, -V.y);
      shear(sg, f, hf, HT - z1, z1 - z0, z0);
    }
    V.lamps = out.lamps.filter(l => l.z >= z0 && l.z < z1).map(l => ({ ...l, sx: SX(l.x, l.y), sy: SY(l.x, l.y, l.z) }));
    FC.levels.push(V);
  }
  FC.panes = out.panes; FC.ledges = out.ledges; FC.sea = sea; FC.brand = brand;
  if (out.screen) { // the promo, redrawn a dozen times a second and sheared onto the wall
    const S = FC.screen = { ...out.screen, f: fs[out.screen.fi], i: Math.floor(out.screen.z0 / FH), c: canvas(out.screen.w, out.screen.h), frame: -1 }, a = alongOf(S.f, S.x), fl = canvas(S.w, S.h);
    S.at = a; F(fl.getContext('2d'), 0, 0, S.w, S.h, '#fff');
    const b0 = S.f.Y ? [a, S.f.d - 0.01, a + S.w / 16, S.f.d + 0.01] : [S.f.d - 0.01, a - S.w / 16, S.f.d + 0.01, a];
    S.mask = sprite(...b0, S.z0, S.z0 + S.h, g => S.f.Y ? onWallY(g, fl, a, S.f.d, S.z0) : onWallX(g, fl, a, S.f.d, S.z0));
  }
  return FC;
}

// ---------------------------------------------------------------- glass: the sky by day, lamplight by night
export function tintFacade(FC, sky, dark) {
  const key = `${sky}${Math.round(dark * 20)}${FC.L.rooms.map(r => r.dark ? 1 : 0).join('')}`;
  if (key === FC.key) return;
  FC.key = key;
  const { HT, faces: fs } = FC, [t, b] = sky, day = [mix(t, '#ffffff', 0.45), mix(t, b, 0.55), mix(b, '#ffffff', 0.2)];
  FC.paneFlats ??= fs.map(f => canvas(f.w, HT));
  FC.paneFlats.forEach(c => c.getContext('2d').clearRect(0, 0, c.width, c.height));
  for (const p of FC.panes) {
    const g = FC.paneFlats[p.fi].getContext('2d'), lit = !p.room?.dark, h = p.z1 - p.z0, y0 = HT - p.z1, h3 = Math.max(1, Math.round(h / 3));
    const night = lit ? ['#fff0b8', '#ffd27a', '#f2ac5c'] : ['#3a3266', '#2a2352', '#221c46'], cols = day.map((c, k) => mix(c, night[k], dark));
    F(g, p.x, y0, p.w, h3, cols[0]); F(g, p.x, y0 + h3, p.w, h3, cols[1]); F(g, p.x, y0 + 2 * h3, p.w, h - 2 * h3, cols[2]);
    if (p.curtain) {
      const cc = mix(mix(p.curtain, '#fdf3e1', 0.2), lit ? '#ffd27a' : INK, dark * 0.35), fold = mix(cc, INK, 0.22);
      for (let k = 0; k < h; k++) { const t2 = k / h, cw = t2 < 0.55 ? Math.round(3 - t2 * 3.6) + 1 : t2 < 0.62 ? 1 : 2; F(g, p.x, y0 + k, cw, 1, cc); F(g, p.x + p.w - cw, y0 + k, cw, 1, cc); if (cw > 2) { F(g, p.x + 1, y0 + k, 1, 1, fold); F(g, p.x + p.w - 2, y0 + k, 1, 1, fold); } }
      F(g, p.x, y0, p.w, 2, cc); for (let x = p.x; x < p.x + p.w; x += 2) F(g, x, y0 + 2, 1, 1, cc); F(g, p.x, y0 + 1, p.w, 1, fold);
    }
    if (dark < 0.75) { // the sky's reflection: two bright diagonal streaks
      g.globalAlpha = 0.55 * (1 - dark);
      for (const [o, sw] of [[0.3, 2], [0.62, 1]]) for (let k = 0; k < h; k++) { const x = p.x + Math.round(p.w * o) + k - Math.round(h * 0.25), y = y0 + h - 1 - k; if (x >= p.x && x + sw <= p.x + p.w && k > h * 0.15) F(g, x, y, sw, 1, '#ffffff'); }
      g.globalAlpha = 1;
    }
    if (lit && dark > 0.4) { g.globalAlpha = dark; F(g, p.x, y0, p.w, 1, '#fff8dc'); g.globalAlpha = 1; }
  }
  for (const V of FC.levels) {
    const g = V.panes.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, V.panes.width, V.panes.height); g.translate(-V.x, -V.y);
    if (V.wins.length) fs.forEach((f, fi) => shear(g, f, FC.paneFlats[fi], HT - V.z1, V.z1 - V.z0, V.z0));
  }
}
// snow on every ledge, cornice and window box (built the first time it snows)
function snowLayer(FC, V) {
  if (V.snow) return V.snow;
  FC.snowFlats ??= FC.faces.map((f, fi) => { const c = canvas(f.w, FC.HT), g = c.getContext('2d'), r = rng('snowfacade' + fi); for (const l of FC.ledges) if (l.fi === fi) for (let x = l.x; x < l.x + l.w; x++) { F(g, x, FC.HT - l.z - 1, 1, 1, '#f4f6ff'); if (r() < 0.45) F(g, x, FC.HT - l.z - 2, 1, 1, '#ffffff'); } return c; });
  V.snow = canvas(V.img.width, V.img.height);
  const g = V.snow.getContext('2d'); g.translate(-V.x, -V.y);
  FC.faces.forEach((f, fi) => shear(g, f, FC.snowFlats[fi], FC.HT - V.z1, V.z1 - V.z0, V.z0));
  return V.snow;
}

// ---------------------------------------------------------------- drawing
const SEATED = new Set(['sit', 'type', 'sleep']);
// Someone inside, seen against the glass: head and shoulders at a desk, more of them walking past.
function silhouettes(g, V, agents, dark) {
  if (!agents.length) return;
  for (const p of V.wins) {
    if (p.kind !== 'win' || p.f.end || p.room?.dark) continue;
    const A = agents.find(A2 => { const a = p.f.Y ? A2.x : A2.y; return a > p.a0 - 0.1 && a < p.a1 + 0.1; });
    if (!A) continue;
    const a = p.f.Y ? A.x : A.y, seated = SEATED.has(A.pose), z = p.z0 + (seated ? 5 : 2), top1 = z + (seated ? 6 : 14) - (A.pose === 'sleep' ? 3 : 0);
    g.globalAlpha = dark > 0.35 ? 0.85 : 0.22;
    const col = dark > 0.35 ? '#6e4029' : '#3b3355';
    plane(g, p.f, a - 0.28, a + 0.28, z, top1, col); plane(g, p.f, a - 0.2, a + 0.2, top1, top1 + 1, col); plane(g, p.f, a - 0.12, a + 0.12, top1 + 1, top1 + 7, col);
    g.globalAlpha = 1;
  }
}
// a closed level: its glass, the people behind it, the wall, snow, the penthouse glass
export function drawClosed(g, FC, i, blit, agents, dark, cover) {
  const V = FC.levels[i]; if (!V) return;
  if (V.wins.length) { blit(V.panes, V.x, V.y); silhouettes(g, V, agents, dark); }
  if (V.glass) g.drawImage(V.glass.img, V.glass.x, V.glass.y);
  if (V.ceil) g.drawImage(V.ceil.img, V.ceil.x, V.ceil.y);
  blit(V.img, V.x, V.y);
  if (V.lid) g.drawImage(V.lid.img, V.lid.x, V.lid.y);
  if (cover > 0.02) {
    g.globalAlpha = cover; blit(snowLayer(FC, V), V.x, V.y);
    if (V.lid) { V.lid.snow ??= penthouseRoof(FC.L, true); g.drawImage(V.lid.snow.img, V.lid.snow.x, V.lid.snow.y); }
    g.globalAlpha = 1;
  }
}
// The walls lifting off (k: 0 closed .. 1 open): the whole façade rises and fades as one, every level by the
// same amount, so the building's outside moves off like a lid.
const LIFT = 70, lift = k => { const e = k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) ** 2; return [Math.round(e * LIFT), 1 - e]; };
export const revealed = k => 1 - lift(k)[1];
export function drawLift(g, FC, i, k, blit) {
  const V = FC.levels[i]; if (!V) return;
  const [dy, a] = lift(k);
  g.globalAlpha = a; g.translate(0, -dy);
  if (V.wins.length) blit(V.panes, V.x, V.y);
  if (V.glass) g.drawImage(V.glass.img, V.glass.x, V.glass.y);
  blit(V.img, V.x, V.y);
  if (V.lid) g.drawImage(V.lid.img, V.lid.x, V.lid.y);
  g.translate(0, dy); g.globalAlpha = 1;
}
export function drawPlug(g, FC, a, blit) { if (!FC.plug || a <= 0) return; const [dy, al] = lift(1 - a); g.globalAlpha = al; blit(FC.plug.c, FC.plug.x, FC.plug.y - dy); g.globalAlpha = 1; }
// the lightmap: the façade is outdoors (night gloom), its lit windows and lanterns aren't. While it lifts off
// (k) the same light goes with it, weighted by how much of it is still there
export function lightClosed(lg, FC, i, gloom, glowAt, k = 0) {
  const V = FC.levels[i]; if (!V) return;
  const [dy, a] = lift(k), S = FC.screen;
  lg.translate(0, -dy);
  const shade = (img, x, y) => { lg.globalCompositeOperation = 'destination-out'; lg.globalAlpha = a; lg.drawImage(img, x, y); lg.globalCompositeOperation = 'source-over'; lg.globalAlpha = gloom * a; lg.drawImage(img, x, y); };
  shade(V.shade, V.x, V.y);
  if (V.ceil && !k) shade(V.ceil.shade, V.ceil.x, V.ceil.y);
  if (V.lid) shade(V.lid.shade, V.lid.x, V.lid.y);
  lg.globalCompositeOperation = 'destination-out';
  if (V.wins.length) { lg.globalAlpha = 0.95 * a; lg.drawImage(V.glassMask, V.x, V.y); }
  for (const l of V.lamps) if (l.kind === 'lamp') glowAt(l.sx, l.sy, 6, 5, 0.7 * a); // lanterns: a small, local light
  for (const p of V.wins) if (p.spill && !p.room?.dark) pool(lg, p.spill, '#000', 0.1 * a); // (and the sidewalk in front of a lit window)
  if (V.signLit) { lg.globalAlpha = 0.9 * a; lg.drawImage(V.signLit, V.x, V.y); }
  if (S?.i === i) { lg.globalAlpha = a; lg.drawImage(S.mask.img, S.mask.x, S.mask.y); }
  lg.globalAlpha = 1; lg.translate(0, dy);
}
export function lightPlug(lg, FC, a, gloom) {
  const p = FC.plug; if (!p || a <= 0) return;
  const [dy, al] = lift(1 - a);
  lg.globalCompositeOperation = 'destination-out'; lg.globalAlpha = al; lg.drawImage(p.c, p.x, p.y - dy);
  lg.globalCompositeOperation = 'source-over'; lg.globalAlpha = al * gloom; lg.drawImage(p.shade, p.x, p.y - dy);
  lg.globalCompositeOperation = 'destination-out'; lg.globalAlpha = 1;
}
export function drawEscape(g, FC, i) { const e = FC.levels[i]?.escape; if (e) g.drawImage(e.img, e.x, e.y); }
// is world pixel (x, y) on the penthouse's roof?
export function onLid(FC, x, y) { const l = FC?.levels[FC.L.nUp]?.lid, u = Math.floor(x - l?.x), v = Math.floor(y - l?.y); return !!l && u >= 0 && v >= 0 && u < l.img.width && v < l.img.height && l.img.getContext('2d').getImageData(u, v, 1, 1).data[3] > 0; }
// The street end's screen, while its wall is up (k: how open the walls are). It lifts off with them.
export function drawScreen(g, FC, k, off, t, dark, hour) {
  const S = FC?.screen; if (!S || k >= 1) return;
  const frame = Math.floor(t * 12);
  if (frame !== S.frame) { S.frame = frame; paintScreen(FC, S, t, dark, hour); }
  const [dy, a] = lift(k);
  g.globalAlpha = a; g.translate(0, -off - dy);
  if (a < 1) shearScreen(g, S); // (see-through while it lifts off: a cached copy would round its colours differently)
  else g.drawImage(S.wall, S.mask.x, S.mask.y);
  g.translate(0, off + dy); g.globalAlpha = 1;
}
// a new frame of the promo, sheared onto its wall once
function paintScreen(FC, S, t, dark, hour) {
  const sg = S.c.getContext('2d');
  sg.clearRect(0, 0, S.w, S.h); drawBillboard(sg, t, FC.brand, { night: dark > 0.5, season: FC.sea, hour });
  S.wall ??= canvas(S.mask.img.width, S.mask.img.height);
  const wg = S.wall.getContext('2d');
  wg.setTransform(1, 0, 0, 1, 0, 0); wg.clearRect(0, 0, S.wall.width, S.wall.height); wg.translate(-S.mask.x, -S.mask.y);
  shearScreen(wg, S);
}
const shearScreen = (g, S) => S.f.Y ? onWallY(g, S.c, S.at, S.f.d, S.z0) : onWallX(g, S.c, S.at, S.f.d, S.z0);
// additive light from a closed level at night: small pools under lit windows, the lanterns, the entrance sign's
// halo and the screen's glow. glow(colour, x, y, rx, ry, alpha) draws a quantised glow.
export function facadeGlows(g, FC, i, night, glow, k = 0) {
  const V = FC?.levels[i]; if (!V) return;
  const [dy, a] = lift(k), n = night * a;
  g.translate(0, -dy);
  for (const p of V.wins) if (!p.room?.dark) glow('#5a3a14', p.sx, p.sy + 1, p.kind === 'door' ? 6 : 9, 4, n * 0.35); // party mode: the rooms' lights through the glass
  for (const p of V.wins) if (p.spill && !p.room?.dark) pool(g, p.spill, '#4a3010', n * 0.1);
  if (FC.screen?.i === i && FC.screen.wall) { g.globalAlpha = n * 0.45; g.drawImage(FC.screen.wall, FC.screen.mask.x, FC.screen.mask.y); g.globalAlpha = 1; } // (a display: brighter after dark)
  for (const l of V.lamps) l.kind === 'lamp' ? glow('#806020', l.sx, l.sy, 5, 4, n * 0.8) : glow('#1c2c52', l.sx, l.sy, 26, 22, n * 0.4);
  if (V.signGlow) { g.globalAlpha = n * 0.7; g.drawImage(V.signGlow, V.x, V.y); g.globalAlpha = 1; }
  g.translate(0, dy);
}

// Party mode with the walls on: the disco lights tint every window's glass (colour: a window's number => css colour).
export function partyGlass(g, FC, i, colour, k = 0) {
  const V = FC?.levels[i]; if (!V?.wins.length) return;
  const [dy, a] = lift(k), m = V.glassMask, c = V.party ??= canvas(m.width, m.height), t = c.getContext('2d');
  t.globalCompositeOperation = 'source-over'; t.clearRect(0, 0, c.width, c.height);
  V.wins.forEach((p, j) => { if (p.room?.dark) return; const h = p.z1 - p.z0; t.fillStyle = colour(i + j); t.fillRect(p.sx - V.x - 12, p.sy - V.y - h - 4, 24, h + 8); });
  t.globalCompositeOperation = 'destination-in'; t.drawImage(m, 0, 0);
  g.save(); g.globalCompositeOperation = 'source-over'; g.globalAlpha = a * 0.7; g.drawImage(c, V.x, V.y - dy); g.restore();
}
