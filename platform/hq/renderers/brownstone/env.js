// The world around the building: the floating diorama island (soil strata, basement windows,
// sidewalk, a street with a loading bay, a park with a duck pond), trees, lamps, the delivery van,
// and the sky backdrop with sun, moon, stars, clouds and a distant city.
import { rng, pick, mix, clamp, lerp, canvas, trim } from '../../util.js';
import { FH, SLAB, CORE, PLAZA, ENTRANCE, INK, F, disc, sprite, SX, SY, top, wallY, wallX, box, onWallY, onWallX, wallYCol, wallXCol, ellipse, text, textW, upright } from './iso.js';
import { today, season, holidays, darkness } from '../../world/clock.js';
// the calendar and the weather are the world's; the rest of the brownstone still imports them from here
export { today, season, holidays, darkness };
export { pickWeather, weatherAt } from '../../world/weather.js';

// ---- time of day ----
const SKY = [[0, '#141032', '#2a2352'], [4.5, '#1b1540', '#3d2f63'], [6, '#3b3a7a', '#f08a7e'], [7.5, '#6fb7ff', '#ffd3a5'],
  [10, '#5aa9f5', '#bfe6ff'], [16.5, '#5aa9f5', '#c6ebff'], [18.5, '#6d7fd6', '#ffb07a'], [19.8, '#4a3f8f', '#f07a8a'],
  [21, '#221c4a', '#3b2f66'], [24, '#141032', '#2a2352']];
export function skyAt(h, wet = 0) {
  let i = SKY.findIndex(k => k[0] > h);
  if (i < 1) i = i < 0 ? SKY.length - 1 : 1;
  const a = SKY[i - 1], b = SKY[i], t = (h - a[0]) / (b[0] - a[0]);
  const c = [mix(a[1], b[1], t), mix(a[2], b[2], t)];
  return wet ? c.map(x => mix(x, '#6b7290', Math.min(0.85, wet * 0.85) * (1 - darkness(h) * 0.6))) : c;
}

// ---- the island ----
const LEAVES = { winter: ['#8b7a6a', '#6e5a4a', '#a8927a'], spring: ['#7bd389', '#ff8fab', '#5cc26a'], summer: ['#5cc26a', '#3f9b5c', '#7bd389'] };
const AUTUMN_LEAVES = [['#e8a33d', '#d9772b', '#f2c14e'], ['#c8553d', '#e07a5f', '#f2a65a'], ['#8cbf5a', '#d9a441', '#6fa84a']];
const BACK = 0.25; // how thick the building's back walls are (see the brick ends in rooms.js)
export function buildIsland(L, sea = season()) {
  const { Xe, Ye, X1, Y1, nDown } = L, zb = -nDown * FH - 26;
  const b = L.bounds, W = b.x1 - b.x0, H = b.y1 - b.y0;
  const faces = canvas(W, H), gf = faces.getContext('2d'), ground = canvas(W, H), gg = ground.getContext('2d'), tops = canvas(W, H), gt = tops.getContext('2d');
  for (const g of [gf, gg, gt]) g.translate(-b.x0, -b.y0);
  const r = rng('island'), out = { props: [], lamps: [], pond: null, bays: [], hot: [], mailbox: null, benches: [], walk: [], ducks: [], pumpkins: [] };
  const street = L.street, E = (u, v) => street === 'x' ? { x: X1 + u, y: v } : { x: v, y: Y1 + u };
  const park = (u, v) => street === 'x' ? { x: v, y: Y1 + u } : { x: X1 + u, y: v };
  const basement = L.rooms.filter(rm => rm.level < 0 && rm.wing !== 'core');

  // soil faces: strata, pebbles, roots and a jagged underside, with the basement rooms showing through openings
  const strata = [[0, '#8b8fa3'], [-3, '#6d6a80'], [-SLAB, '#9a6a48'], [-24, '#8a5a3c'], [-60, '#6e4a36'], [-120, '#5a3e36'], [-190, '#4a3a4a']];
  const face = (plane, a0, a1) => {
    for (let k = 0; k < strata.length; k++) {
      const z1 = strata[k][1] && strata[k][0], z0 = k + 1 < strata.length ? strata[k + 1][0] : zb;
      if (z1 <= zb) break;
      plane(a0, a1, Math.max(z0, zb), z1, strata[k][1]);
    }
    for (let u = a0; u < a1; u += 0.5) { const drop = 4 + (r() * 16 | 0); plane(u, u + 0.5, zb - drop, zb, r() < 0.5 ? '#4a3a4a' : '#3e3040'); if (r() < 0.4) plane(u + 0.15, u + 0.35, zb - drop - 6, zb - drop, '#3e3040'); }
    for (let i = 0; i < (a1 - a0) * 6; i++) { const u = a0 + r() * (a1 - a0), z = zb + 6 + r() * (-zb - 16); plane(u, u + 0.06, z, z + 1, r() < 0.5 ? '#a47352' : '#4e3630'); }
  };
  const pY = (Y) => (a0, a1, z0, z1, c) => wallY(gf, a0, a1, Y, z0, z1, c);
  const pX = (X) => (a0, a1, z0, z1, c) => wallX(gf, a0, a1, X, z0, z1, c);
  // the island's ends run on under the back walls' thickness (BACK), so the ground floor's brick ends stand on it
  face(pY(4), 4, Xe); face(pX(4), 4, Ye); face(pX(Xe), -BACK, 4); face(pY(Ye), -BACK, 4);
  // grass lip along the park edge
  street === 'x' ? wallX(gf, Y1, Ye, 4, -3, 0, '#5cc26a') : wallY(gf, X1, Xe, 4, -3, 0, '#5cc26a');
  // fossils and a buried chest, because dioramas deserve secrets
  const fs = [SX(4 + (Xe - 4) * 0.7, 4), SY(4 + (Xe - 4) * 0.7, 4, zb + 22)];
  F(gf, fs[0], fs[1], 7, 1, '#e8dcc8'); for (let i = 0; i < 3; i++) F(gf, fs[0] + 1 + i * 2, fs[1] - 1, 1, 3, '#e8dcc8'); F(gf, fs[0] + 7, fs[1] - 1, 2, 3, '#e8dcc8');
  const ch = [SX(4, 4 + (Ye - 4) * 0.6), SY(4, 4 + (Ye - 4) * 0.6, zb + 20)];
  F(gf, ch[0] - 4, ch[1] - 4, 9, 5, '#8e5a2b'); F(gf, ch[0] - 4, ch[1] - 5, 9, 1, '#6e4029'); F(gf, ch[0], ch[1] - 3, 1, 2, '#ffd966');
  out.chest = { sx: ch[0], sy: ch[1] - 3 };
  // cut the basement rooms out of the faces (a wing that reaches the island's end is open there too,
  // like the floors above), then label them on the slab below
  const cut = (plane, a0, a1, z0, z1) => { gf.save(); gf.globalCompositeOperation = 'destination-out'; plane(a0, a1, z0, z1, '#000'); gf.restore(); };
  // (each opening is only its own floor's height, so a deeper floor doesn't open up the soil in front of the one above)
  for (const rm of basement) {
    const X = rm.wing === 'x', D = rm.lv.D, zt = rm.z + FH - SLAB;
    cut(X ? pY(D) : pX(D), X ? rm.x0 : rm.y0, X ? rm.x1 : rm.y1, rm.z, zt);
    (X ? pY(D) : pX(D))(X ? rm.x0 : rm.y0, X ? rm.x1 : rm.y1, rm.z - SLAB, rm.z, '#3b3355');
    if ((X ? rm.x1 : rm.y1) >= (X ? Xe : Ye)) { const end = X ? pX(Xe) : pY(Ye); cut(end, 0, D, rm.z, zt); end(0, D, rm.z - SLAB, rm.z, '#3b3355'); }
  }
  for (const rm of basement) label(gf, rm, rm.wing === 'x', rm.lv.D, rm.z - SLAB + 1);
  // fibre from the server room: down into the ground, then along the soil face and round the corner to the
  // park end (render.js sends little pulses of data along it). out.fiber: one path per cable, points in world
  // coordinates on the faces.
  out.fiber = [];
  // (round the corner it runs up in the soil, or under the lowest floor when the park side has basement rooms of its own
  // to stay out of their openings: then it goes down in front of the core, which has none, and turns the corner at the
  // bottom.)
  const toPark = street === 'x' ? 'y' : 'x';
  const parkRooms = basement.some(rm => rm.wing === toPark);
  for (const rm of basement) if (rm.kind === 'server' && !(rm.part > 1)) { // (one cable run, from a split server room's first part)
    const X = rm.wing === 'x', D = rm.lv.D, a = (X ? rm.x0 + rm.x1 : rm.y0 + rm.y1) / 2, top1 = rm.z - SLAB;
    [['#f2c14e', 0, 6, 34, 0.04], ['#5b8def', 0.3, 9, 37, 0.22]].forEach(([c, da, dz, up, off]) => { // under the basement, then up into the deeper soil round the corner
      const u = a + da + 0.05, z = top1 - dz, foot = X ? { x: u, y: D } : { x: D, y: u }, end = toPark === 'y' ? { x: D, y: Ye } : { x: Xe, y: D };
      const turn = (X ? 'x' : 'y') !== toPark, zp = turn ? (parkRooms ? -nDown * FH - SLAB - dz : -up) : z;
      // where it climbs the corner, one riser per cable. low: it goes down in front of the core instead, then round the corner
      const low = toPark === 'y' && parkRooms, cn = toPark === 'y' && !low ? { x: D, y: D + off } : { x: D + off, y: D };
      const corner = turn ? [...(low ? [] : [{ x: D, y: D, z }]), { ...cn, z }, { ...cn, z: zp }, ...(low ? [{ x: D, y: D, z: zp }] : [])] : [];
      const pts = [{ ...foot, z: top1 }, { ...foot, z }, ...corner, { ...end, z: zp }];
      for (let k = 1; k < pts.length; k++) { // lay the cable, 2 px thick, on whichever face each stretch runs along
        const p = pts[k - 1], q = pts[k], lo = Math.min(p.z, q.z) - (p.z === q.z ? 1 : 0), hi = Math.max(p.z, q.z) + 1;
        if (p.y === q.y && p.y === D && p.x !== q.x) pY(D)(Math.min(p.x, q.x), Math.max(p.x, q.x), lo, hi, c);
        else if (p.x === q.x && p.x === D && p.y !== q.y) pX(D)(Math.min(p.y, q.y), Math.max(p.y, q.y), lo, hi, c);
        else if (p.x === q.x && p.y === q.y && p.z !== q.z && (p.x === D && p.y !== D || p.y === D && p.x !== D) && !(X ? p.y === D && p.x === u : p.x === D && p.y === u)) (p.x === D ? pX(D) : pY(D))(p.x === D ? p.y : p.x, (p.x === D ? p.y : p.x) + 0.1, lo, hi, c); // up the corner
        else (X ? pY(D) : pX(D))(u - 0.05, u + 0.07, lo, hi, c);
      }
      out.fiber.push({ pts, c });
    });
  }

  // ground: sidewalk in front of the building, a street on one side, a park on the other
  const pave = '#d4cfe0', seam = '#b9b3c9', C = CORE;
  top(gg, C, C, X1, C + 1, 0, pave); top(gg, C, C, C + 1, Y1, 0, pave);
  for (let x = C; x < X1; x += 0.5) top(gg, x, C, x + 1 / 32, C + 1, 0, seam);
  for (let y = C; y < Y1; y += 0.5) top(gg, C, y, C + 1, y + 1 / 32, 0, seam);
  top(gg, C, C + 0.94, X1, C + 1, 0, '#fdf3e1'); top(gg, C + 0.94, C, C + 1, Y1, 0, '#fdf3e1');
  // level-0 room labels along the curb, on their own layer: the closed façade hides them (see render.js)
  const labels = canvas(W, H), gl = labels.getContext('2d'); gl.setTransform(gf.getTransform());
  for (const rm of L.rooms) if (rm.level === 0 && rm.wing !== 'core') label(gl, { ...rm, x0: rm.wing === 'x' ? rm.x0 + 1 : rm.x0, y0: rm.wing === 'y' ? rm.y0 + 1 : rm.y0, y1: rm.wing === 'y' ? rm.y1 + 1 : rm.y1 }, rm.wing === 'x', 4, -SLAB + 1, true);
  // street extension: asphalt, a loading bay by the dock, dashed centre line, sidewalk
  const len = street === 'x' ? Xe - X1 : Ye - Y1;
  const rect = (u0, v0, u1, v1, c, g = gg) => { const a = E(u0, v0), bb = E(u1, v1); top(g, Math.min(a.x, bb.x), Math.min(a.y, bb.y), Math.max(a.x, bb.x), Math.max(a.y, bb.y), 0, c); };
  rect(0, -BACK, len, 4, '#565a70');
  rect(0, 3, len, 4, pave); rect(0, 3.94, len, 4, '#fdf3e1'); for (let u = 0; u < len; u += 0.5) rect(u, 3, u + 1 / 32, 4, seam);
  rect(0, -BACK, len, 0.35, pave);
  for (let u = 2.4; u < len; u += 0.8) rect(u, 1.64, u + 0.4, 1.7, '#f6e7c1');
  for (let k = 0; k < 6; k++) rect(0.15 + k * 0.32, 0.5, 0.3 + k * 0.32, 2.8, '#f2c14e'); rect(0, 0.45, 2.2, 0.5, '#f2c14e'); rect(0, 2.8, 2.2, 2.85, '#f2c14e');
  for (let i = 0; i < 18; i++) { const u = r() * len, v = 0.4 + r() * 2.5; rect(u, v, u + 0.06, v + 0.06, '#6d6a80'); }
  out.bay = E(1.1, 1.6); out.streetEnd = E(len + 0.5, 1.6); out.streetAxis = street; out.streetLen = len;
  // park extension: grass, a path loop round the duck pond, flower beds, a picnic blanket
  const plen = street === 'x' ? Ye - Y1 : Xe - X1;
  const prect = (u0, v0, u1, v1, c, g = gg, z = 0) => { const a = park(u0, v0), bb = park(u1, v1); top(g, Math.min(a.x, bb.x), Math.min(a.y, bb.y), Math.max(a.x, bb.x), Math.max(a.y, bb.y), z, c); };
  const grass = sea === 'autumn' ? '#8cbf5a' : sea === 'winter' ? '#9fbf8a' : '#6fcf6a';
  prect(0, -BACK, plen, 4, grass);
  for (let i = 0; i < 26 * plen; i++) { const u = r() * plen, v = r() * 4; prect(u, v, u + 0.05, v + 0.05, r() < 0.5 ? mix(grass, '#ffffff', 0.18) : mix(grass, INK, 0.15)); }
  prect(0, 3, plen, 4, pave); prect(0, 3.94, plen, 4, '#fdf3e1');
  const loop = { u: plen * 0.52, v: 1.5, ru: Math.min(2.5, plen * 0.3), rv: 1.1 }; // the path loop (and the pond inside it)
  const onLoop = a => park(loop.u + Math.cos(a) * loop.ru, loop.v + Math.sin(a) * loop.rv);
  for (let a = 0; a < Math.PI * 2; a += 0.05) { const p = { u: loop.u + Math.cos(a) * loop.ru, v: loop.v + Math.sin(a) * loop.rv }; prect(p.u - 0.16, p.v - 0.16, p.u + 0.16, p.v + 0.16, '#e8dcc8'); }
  prect(loop.u - 0.16, loop.v + loop.rv, loop.u + 0.16, 3, '#e8dcc8'); // the way in from the sidewalk
  const pc = park(loop.u, loop.v - 0.1);
  ellipse(gg, SX(pc.x, pc.y), SY(pc.x, pc.y), 26, 11, '#8a6e4e'); ellipse(gg, SX(pc.x, pc.y), SY(pc.x, pc.y), 24, 10, '#4fa3d5'); ellipse(gg, SX(pc.x, pc.y) - 5, SY(pc.x, pc.y) - 3, 10, 3, '#6fc0e8');
  out.pond = { ...pc, sx: SX(pc.x, pc.y), sy: SY(pc.x, pc.y), rx: 22, ry: 9 };
  const bed = (u0, v0, u1, v1) => { prect(u0, v0, u1, v1, '#8a5a3c'); prect(u0 + 0.05, v0 + 0.05, u1 - 0.05, v1 - 0.05, '#6e4a36'); for (let i = 0; i < (u1 - u0) * (v1 - v0) * 40; i++) { const p = park(u0 + 0.1 + r() * (u1 - u0 - 0.2), v0 + 0.1 + r() * (v1 - v0 - 0.2)); F(gg, SX(p.x, p.y), SY(p.x, p.y) - 1, 1, 1, pick(r, sea === 'winter' ? ['#e8e0d0'] : ['#ff8fab', '#ffd966', '#fffaf0', '#9b72cf', '#e8505b'])); F(gg, SX(p.x, p.y), SY(p.x, p.y), 1, 1, '#3f9b5c'); } };
  bed(0.5, 0.25, 1.7, 0.85); bed(plen - 2.0, 2.55, plen - 0.6, 2.9);
  for (let i = 0; i < 12 * plen / 5; i++) { const u = r() * plen, v = 0.2 + r() * 2.6, p = park(u, v); if (Math.hypot(u - loop.u, (v - loop.v) * 2) < 3.6) continue; F(gg, SX(p.x, p.y), SY(p.x, p.y) - 1, 1, 1, pick(r, ['#ff8fab', '#ffd966', '#fffaf0', '#9b72cf', '#e8505b'])); }
  // a picnic blanket with a basket, by the flower bed
  prect(0.45, 1.3, 1.35, 2.1, '#e8505b'); for (let k = 0; k < 4; k++) prect(0.45 + k * 0.225, 1.3, 0.56 + k * 0.225, 2.1, '#fffaf0'); for (let k = 0; k < 4; k++) prect(0.45, 1.3 + k * 0.2, 1.35, 1.38 + k * 0.2, '#fffaf0');
  const pb = park(1.1, 1.5); F(gg, SX(pb.x, pb.y) - 3, SY(pb.x, pb.y) - 4, 6, 4, '#a8693f'); F(gg, SX(pb.x, pb.y) - 3, SY(pb.x, pb.y) - 4, 6, 1, '#cf9460'); F(gg, SX(pb.x, pb.y) - 1, SY(pb.x, pb.y) - 6, 2, 2, '#6e4029');
  // outdoor tops mask (snow and wet sheen go here)
  gt.drawImage(ground, b.x0, b.y0);
  gf.drawImage(ground, b.x0, b.y0);
  const tl = trim(faces); out.land = { c: tl.c, x: b.x0 + tl.dx, y: b.y0 + tl.dy };
  const ll = trim(labels); out.labels = { c: ll.c, x: b.x0 + ll.dx, y: b.y0 + ll.dy };

  // ---- props you can walk behind ----
  // r: the footprint people can't walk through, half-size in tiles
  const add = (s, x, y, extra = {}, r = 0.15) => out.props.push({ ...s, depth: x + y, foot: r ? { x0: x - r, y0: y - r, x1: x + r, y1: y + r } : null, ...extra });
  const tree = (x, y, k) => {
    const rr = rng('tree' + k), big = rr() < 0.5;
    const trunk = sprite(x - 0.2, y - 0.2, x + 0.2, y + 0.2, 0, 26, g => { const sx = SX(x, y), sy = SY(x, y); ellipse(g, sx, sy, 10, 4, 'rgba(29,26,47,.18)'); F(g, sx - 1, sy - 22, 3, 22, '#6e4029'); F(g, sx + 1, sy - 22, 1, 22, '#5a3825'); F(g, sx - 4, sy - 16, 3, 1, '#6e4029'); F(g, sx + 2, sy - 19, 3, 1, '#6e4029'); });
    const pal = sea === 'autumn' ? pick(rr, AUTUMN_LEAVES) : LEAVES[sea] || LEAVES.summer;
    const cw = big ? 30 : 24, chh = big ? 28 : 22, canopy = canvas(cw, chh), gc = canopy.getContext('2d');
    if (sea === 'winter') { for (let i = 0; i < 9; i++) { const a = -Math.PI / 2 + (rr() - 0.5) * 2.2, l = 6 + rr() * 8; for (let s = 0; s < l; s++) F(gc, Math.round(cw / 2 + Math.cos(a) * s), Math.round(chh - 4 + Math.sin(a) * s), 1, 1, pal[i % 2]); } }
    else for (let i = 0; i < (big ? 16 : 11); i++) { const a = rr() * 6.28, d = rr() * (cw / 2 - 6); disc(gc, Math.round(cw / 2 + Math.cos(a) * d), Math.round(chh / 2 + 2 + Math.sin(a) * d * 0.7), big ? 5 : 4, pal[i % 3]); }
    if (sea !== 'winter') for (let i = 0; i < 6; i++) disc(gc, Math.round(cw / 2 - 3 + rr() * 4), Math.round(chh / 2 - 2 + rr() * 3), 2, mix(pal[0], '#ffffff', 0.25));
    add(trunk, x, y, { canopy, cx: SX(x, y) - cw / 2, cy: SY(x, y) - 18 - chh, phase: rr() * 6, name: 'tree', at: { x, y }, leaves: sea === 'autumn' ? pal : null });
  };
  const lamp = (x, y) => { add(sprite(x - 0.1, y - 0.1, x + 0.1, y + 0.1, 0, 34, g => { const sx = SX(x, y), sy = SY(x, y); F(g, sx, sy - 30, 1, 30, '#3b3355'); F(g, sx - 1, sy - 2, 3, 2, '#3b3355'); F(g, sx - 2, sy - 33, 5, 3, '#3b3355'); F(g, sx - 1, sy - 31, 3, 1, '#fff3b0'); }), x, y, { name: 'lamp' }, 0.06); out.lamps.push({ x, y, z: 30 }); };
  // a park bench, along x or along y: u runs along it, v across it
  const bench = (x, y, alongX) => {
    add(sprite(x - 0.5, y - 0.5, x + 0.5, y + 0.5, 0, 14, g => {
      const part = (u0, v0, z0, u1, v1, z1, c) => alongX ? box(g, x + u0, y + v0, z0, x + u1, y + v1, z1, c) : box(g, x + v0, y + u0, z0, x + v1, y + u1, z1, c);
      part(-0.45, -0.12, 5, 0.45, 0.12, 7, '#a8693f'); part(-0.45, -0.14, 7, 0.45, -0.1, 13, '#a8693f'); // seat and back
      part(-0.4, -0.1, 0, -0.34, 0.1, 5, '#3b3355'); part(0.34, -0.1, 0, 0.4, 0.1, 5, '#3b3355'); // legs
    }), x, y, { name: 'bench' }, 0);
    out.benches.push({ x: alongX ? x : x + 0.1, y: alongX ? y + 0.1 : y, front: true, right: !alongX, level: 0, h: 7 });
  };
  // a carved pumpkin, candle-lit inside after dark (see render.js's lighting pass for the flicker)
  const pumpkin = (x, y, big) => {
    const w = big ? 11 : 8, h = big ? 9 : 7;
    add(sprite(x - 0.25, y - 0.25, x + 0.25, y + 0.25, 0, h + 4, g => {
      const sx = SX(x, y), sy = SY(x, y);
      ellipse(g, sx, sy, w / 2 + 1, 2, 'rgba(29,26,47,.22)');
      ellipse(g, sx, sy - h / 2, w / 2, h / 2, '#d9772b');
      ellipse(g, sx - w / 4, sy - h / 2 - 1, w / 4, h / 2 - 1, '#e8a33d');
      for (let i = -1; i <= 1; i++) F(g, sx + i * (w / 3 | 0), sy - h, 1, h, '#c8631f');
      F(g, sx - 1, sy - h - 3, 2, 3, '#3f9b5c'); F(g, sx, sy - h - 1, 2, 1, '#6fa84a');
      F(g, sx - 2, sy - h / 2 - 1, 1, 2, INK); F(g, sx + 1, sy - h / 2 - 1, 1, 2, INK); // eyes (lit at night)
      F(g, sx - 1, sy - h / 2 + 2, 3, 1, INK); // mouth
    }), x, y, { name: 'pumpkin' }, 0.18);
    out.pumpkins.push({ x, y, z: h - 1 });
  };
  // along the sidewalk: lamps, a mailbox, a bike
  for (let x = 5; x < X1 - 0.5; x += 5) lamp(x, C + 0.88);
  for (let y = 5.5; y < Y1 - 0.5; y += 5) lamp(C + 0.88, y);
  const mb = { x: X1 - 1.3, y: C + 0.8 };
  add(sprite(mb.x - 0.2, mb.y - 0.2, mb.x + 0.2, mb.y + 0.2, 0, 16, g => { box(g, mb.x - 0.13, mb.y - 0.1, 0, mb.x + 0.13, mb.y + 0.1, 3, '#3b3355'); box(g, mb.x - 0.15, mb.y - 0.12, 3, mb.x + 0.15, mb.y + 0.12, 14, ['#ff7a82', '#e8505b', '#b8404f']); F(g, SX(mb.x, mb.y) - 2, SY(mb.x, mb.y, 11), 3, 1, INK); }), mb.x, mb.y, { name: 'mailbox' });
  out.mailbox = { x: mb.x - 0.4, y: PLAZA.y, level: 0 };
  // a bike on its stand by the curb, with a basket of flowers
  const bx = 11.6; // (clear of the front door)
  add(sprite(bx - 0.2, 3.6, bx + 1.8, 4, 0, 18, g => { ellipse(g, SX(bx + 0.75, 3.8), SY(bx + 0.75, 3.8), 12, 3, 'rgba(29,26,47,.14)'); g.drawImage(bikeFlat('#e8505b', true), Math.round(SX(bx + 0.75, 3.8)) - 12, Math.round(SY(bx + 0.75, 3.8)) - 15); }), bx + 0.8, 3.8, { name: 'bike', foot: { x0: bx, y0: 3.7, x1: bx + 1.5, y1: 3.9 } }, 0);
  // either side of the front door: a carved pumpkin through Halloween week, a tub of flowers the rest of the year
  const tub = (x, y, k) => add(sprite(x - 0.25, y - 0.25, x + 0.25, y + 0.25, 0, 16, g => {
    const rr = rng('tub' + k), sx = SX(x, y), sy = SY(x, y); ellipse(g, sx, sy, 6, 2, 'rgba(29,26,47,.2)');
    box(g, x - 0.16, y - 0.16, 0, x + 0.16, y + 0.16, 7, ['#e07a5f', '#c8553d', '#8e3b2c']); top(g, x - 0.12, y - 0.12, x + 0.12, y + 0.12, 7, '#5a3825');
    for (let i = 0; i < 9; i++) disc(g, sx - 4 + (rr() * 8 | 0), sy - 9 - (rr() * 4 | 0), 1, i % 2 ? '#5cc26a' : '#3f9b5c');
    for (let i = 0; i < 7; i++) F(g, sx - 4 + (rr() * 9 | 0), sy - 13 + (rr() * 5 | 0), 2, 1 + (i % 2), pick(rr, sea === 'winter' ? ['#e8505b', '#fffaf0'] : ['#ff8fab', '#ffd966', '#fffaf0', '#9b72cf', '#e8505b']));
  }), x, y, { name: 'flowers' }, 0.18);
  if (L.holidays.has('halloween')) { pumpkin(C + 1.3, C + 0.85, true); pumpkin(C + 0.85, C + 1.3, false); }
  else { tub(C + 1.3, C + 0.85, 'a'); tub(C + 0.85, C + 1.3, 'b'); }
  // Sinterklaas: a painted wooden clog on the doorstep, and on his last evening a carrot in it for his horse
  if (L.holidays.has('sinterklaas')) {
    const x = ENTRANCE - 0.2, y = C + 0.36, carrot = L.holidays.has('pakjesavond');
    add(sprite(x - 0.2, y - 0.2, x + 0.2, y + 0.2, 0, carrot ? 14 : 8, g => {
      const sx = Math.round(SX(x, y)), sy = Math.round(SY(x, y));
      ellipse(g, sx, sy, 5, 1, 'rgba(29,26,47,.25)');
      // side on, heel to the left: a tall heel with the opening on top, sloping down to a toe that turns up
      [-6, -6, -6, -6, -6, -5, -4, -4, -4, -5].forEach((t, k) => { F(g, sx - 5 + k, sy + t, 1, -1 - t, '#f2c14e'); F(g, sx - 5 + k, sy + t, 1, 1, k > 4 ? '#ffd966' : '#d9a441'); });
      F(g, sx - 4, sy - 6, 4, 2, '#5a3825'); F(g, sx - 4, sy - 1, 9, 1, '#c98a2e'); // the opening, the sole
      F(g, sx + 1, sy - 3, 1, 1, '#e8505b'); F(g, sx, sy - 3, 1, 1, '#3f9b5c'); F(g, sx + 2, sy - 3, 1, 1, '#3f9b5c'); // a painted flower
      if (carrot) { for (let k = 0; k < 6; k++) F(g, sx - 3 + (k >> 1), sy - 6 - k, 2, 1, k < 2 ? '#e07a2e' : '#f2a65a'); F(g, sx, sy - 14, 1, 3, '#5cc26a'); F(g, sx + 1, sy - 13, 1, 2, '#3f9b5c'); }
    }), x, y, { name: 'clog' }, 0);
  }
  // street side
  lamp(E(len - 1.2, 3.85).x, E(len - 1.2, 3.85).y);
  // festoon lights along the street's sidewalk, on two posts, sagging between them (lit after dark)
  { const u0 = 0.5, u1 = len - 1.8, v = 3.9, P = 28, a = E(u0, v), b = E(u1, v), sag = u => Math.sin((u - u0) / (u1 - u0) * Math.PI) * 6;
    const pt = u => E(u, v), l = Math.min(SX(a.x, a.y), SX(b.x, b.y)) - 3, t0 = Math.min(SY(a.x, a.y, P), SY(b.x, b.y, P)) - 3, c = canvas(Math.abs(SX(b.x, b.y) - SX(a.x, a.y)) + 6, Math.abs(SY(b.x, b.y) - SY(a.x, a.y)) + P + 6), g = c.getContext('2d');
    g.translate(-l, -t0); out.bulbs = [];
    for (const u of [u0, u1]) { const p = pt(u); F(g, SX(p.x, p.y), SY(p.x, p.y, P + 1), 1, P + 1, '#3b3355'); F(g, SX(p.x, p.y) - 1, SY(p.x, p.y), 3, 1, '#3b3355'); }
    for (let u = u0; u < u1; u += 1 / 16) { const p = pt(u); F(g, Math.round(SX(p.x, p.y)), Math.round(SY(p.x, p.y, P - sag(u))), 1, 1, '#3b3355'); }
    for (let u = u0 + 0.25, k = 0; u < u1 - 0.1; u += 0.4, k++) { const p = pt(u), z = P - sag(u) - 2; F(g, Math.round(SX(p.x, p.y)), Math.round(SY(p.x, p.y, z)), 1, 2, ['#ffd966', '#ff8fab', '#8fd3ff', '#b8f0c8'][k % 4]); out.bulbs.push({ ...p, z: z - 1 }); }
    out.props.push({ img: c, x: l, y: t0, depth: b.x + b.y + 1, name: 'festoon', foot: null }); } // in front of everything on the street
  const hy = E(3.2, 3.8); add(sprite(hy.x - 0.2, hy.y - 0.2, hy.x + 0.2, hy.y + 0.2, 0, 10, g => { box(g, hy.x - 0.1, hy.y - 0.1, 0, hy.x + 0.1, hy.y + 0.1, 8, '#e8505b'); box(g, hy.x - 0.14, hy.y - 0.04, 4, hy.x + 0.14, hy.y + 0.04, 6, '#b8404f'); }), hy.x, hy.y, { name: 'hydrant' });
  tree(E(len - 0.6, 0.2).x, E(len - 0.6, 0.2).y, 's1');
  // park side: trees stand well clear of the building, so their crowns never cover it
  for (const [u, v, k] of [[plen - 0.6, 1.3, 'p2'], [plen - 1.5, 0.35, 'p3'], [loop.u - loop.ru - 0.2, 0.3, 'p4'], [loop.u + 0.4, 0.2, 'p5']]) { const p = park(u, v); tree(p.x, p.y, k); }
  for (const u of [loop.u - 1.3, loop.u + 1.3]) { const bp = park(u, 2.95); bench(bp.x, bp.y, street !== 'x'); }
  lamp(park(plen * 0.75, 3.85).x, park(plen * 0.75, 3.85).y); lamp(park(loop.u - 0.35, 2.95).x, park(loop.u - 0.35, 2.95).y);
  // a small playground at the far end: a swing and a slide
  const sw = park(plen - 1.1, 2.1), sl = park(plen - 0.6, 0.55);
  add(sprite(sw.x - 0.5, sw.y - 0.5, sw.x + 0.5, sw.y + 0.5, 0, 26, g => { const along = street !== 'x', A = (a, b) => along ? [sw.x + b, sw.y + a] : [sw.x + a, sw.y + b];
    for (const a of [-0.4, 0.4]) { const [x, y] = A(a, 0); F(g, SX(x, y), SY(x, y) - 22, 1, 22, '#5b8def'); }
    for (let k = -0.4; k <= 0.4; k += 0.05) { const [x, y] = A(k, 0); F(g, SX(x, y), SY(x, y) - 23, 1, 2, '#34508f'); }
    for (const a of [-0.15, 0.15]) { const [x, y] = A(a, 0); F(g, SX(x, y), SY(x, y) - 21, 1, 14, '#8b8fa3'); F(g, SX(x, y) - 1, SY(x, y) - 7, 3, 1, '#e8505b'); } }), sw.x, sw.y, { name: 'swing' }, 0.45);
  add(sprite(sl.x - 0.5, sl.y - 0.5, sl.x + 0.5, sl.y + 0.5, 0, 20, g => { const sx = SX(sl.x, sl.y), sy = SY(sl.x, sl.y); F(g, sx - 6, sy - 16, 1, 16, '#8b8fa3'); F(g, sx - 3, sy - 16, 1, 16, '#8b8fa3'); for (let k = 0; k < 5; k++) F(g, sx - 6, sy - 3 - k * 3, 4, 1, '#8b8fa3'); for (let k = 0; k < 10; k++) F(g, sx - 3 + k, sy - 16 + Math.round(k * 1.4), 2, 2, '#f2c14e'); }), sl.x, sl.y, { name: 'slide' }, 0.35);
  out.walk = [onLoop(Math.PI / 2 - 0.5), onLoop(Math.PI / 2 + 0.5), park(1.9, 1.7), E(len * 0.6, 3.5)].map(p => ({ ...p, level: 0 }));
  out.park = park; out.E = E; out.plen = plen;
  // where the townsfolk walk: the outer edge of the sidewalks round the building's front, and the park loop
  const TS = C + 0.58;
  out.routes = { sidewalk: [{ x: Xe + 1.2, y: TS }, { x: TS, y: TS }, { x: TS, y: Ye + 1.2 }], loopIn: park(loop.u, TS), loop: Array.from({ length: 24 }, (_, k) => onLoop(Math.PI / 2 + k / 24 * Math.PI * 2)), street: { E, len } };
  // a little duck house on a post at the back of the pond, with a ramp down to the water
  { const hx = out.pond.sx - 11, hy = out.pond.sy - 5, c = canvas(14, 18), g = c.getContext('2d');
    F(g, 6, 11, 2, 6, '#6e4029'); F(g, 2, 6, 10, 6, '#f6e7c1'); F(g, 8, 6, 4, 6, '#e0cfa4'); F(g, 4, 8, 3, 3, '#5a3825'); F(g, 5, 11, 1, 1, '#a8693f');
    for (let k = 0; k < 4; k++) F(g, 1 + k, 5 - k, 12 - 2 * k, 1, k ? '#e8505b' : '#b8404f'); F(g, 6, 1, 2, 1, '#e8505b');
    for (let k = 0; k < 4; k++) F(g, 8 + k, 12 + k, 2, 1, '#a8693f');
    out.props.push({ img: c, x: hx - 7, y: hy - 16, depth: out.pond.x + out.pond.y - 0.6, name: 'duckhouse', foot: null }); }
  for (let i = 0; i < 3; i++) out.ducks.push({ a: i * 2.1, r: 0.55 + i * 0.12, s: 0.25 + i * 0.07 });
  return { faces, ground, tops, ...out };
}

// a bicycle side-on (parked across the view, so it needs no shearing): wheels, a diamond frame, saddle, bars
function bikeFlat(col, basket) {
  const c = canvas(25, 16), g = c.getContext('2d'), ln = (x1, y1, x2, y2, k) => { const n = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)); for (let i = 0; i <= n; i++) F(g, Math.round(x1 + (x2 - x1) * i / n), Math.round(y1 + (y2 - y1) * i / n), 1, 1, k); };
  for (const cx of [5, 19]) { for (let y = -5; y <= 5; y++) for (let x = -5; x <= 5; x++) { const d = Math.hypot(x, y); if (d > 3.5 && d < 4.9) F(g, cx + x, 10 + y, 1, 1, INK); } F(g, cx, 10, 1, 1, '#8b8fa3'); }
  ln(5, 10, 11, 11, col); ln(11, 11, 9, 5, col); ln(9, 5, 5, 10, col); ln(9, 5, 16, 5, col); ln(16, 5, 11, 11, col); ln(16, 4, 19, 10, mix(col, INK, 0.2));
  F(g, 7, 3, 4, 1, INK); F(g, 9, 4, 1, 1, INK); F(g, 15, 2, 1, 3, INK); F(g, 14, 2, 4, 1, INK); ln(11, 12, 12, 15, '#565a70');
  if (basket) { F(g, 18, 4, 6, 4, '#c98a52'); F(g, 18, 5, 6, 1, '#a8693f'); F(g, 18, 7, 6, 1, '#a8693f'); for (const [x, y, k] of [[18, 2, '#ff8fab'], [20, 1, '#ffd966'], [22, 2, '#ff8fab'], [21, 3, '#5cc26a'], [19, 3, '#5cc26a'], [23, 3, '#fffaf0']]) F(g, x, y, k === '#5cc26a' ? 1 : 2, k === '#5cc26a' ? 1 : 2, k); }
  return c;
}

// the room's name on a plate on the wall at depth d (the basement's soil face, or the island's curb when curb), its
// letters upright on the wall's slant
function label(g, rm, X, d, zb, curb) {
  const len = X ? rm.x1 - rm.x0 : rm.y1 - rm.y0;
  const s = rm.name.toUpperCase().slice(0, Math.floor((len * 16 - 12) / 4)), w = textW(s) + 4;
  const f = canvas(w, 7), fg = f.getContext('2d'), a = X ? rm.x0 + 0.25 : rm.y0 + 0.25 + w / 16;
  const rows = Array.from({ length: w }, (_, u) => (X ? wallYCol : wallXCol)(a, d, zb, 7, u)[1]);
  F(fg, 0, 0, w, 7, curb ? '#3b3355' : '#fdf3e1'); upright(fg, s, 2, 1, curb ? '#fdf3e1' : INK, rows);
  (X ? onWallY : onWallX)(g, f, a, d, zb);
}

// ---- the delivery van (drawn per frame from two cached poses) ----
const vanCache = {};
export function vanSprite(axis, open, lights) {
  const k = `${axis}${open}${lights}`;
  if (vanCache[k]) return vanCache[k];
  const X = axis === 'x', L = 1.9, Wd = 0.9;
  const [x0, y0, x1, y1] = X ? [0, 0, L, Wd] : [0, 0, Wd, L];
  const s = sprite(x0, y0, x1, y1, 0, 28, g => {
    ellipse(g, SX((x0 + x1) / 2, (y0 + y1) / 2), SY((x0 + x1) / 2, (y0 + y1) / 2) + 2, 26, 9, 'rgba(29,26,47,.25)');
    const B = (a0, b0, a1, b1, z0, z1, c) => X ? box(g, a0, b0, z0, a1, b1, z1, c) : box(g, b0, a0, z0, b1, a1, z1, c);
    const wheel = (a, b) => { const p = X ? [a, b] : [b, a]; ellipse(g, SX(p[0], p[1]), SY(p[0], p[1]) - 3, 3, 3, INK); ellipse(g, SX(p[0], p[1]), SY(p[0], p[1]) - 3, 1, 1, '#c9ccd8'); };
    // backed up to the dock: the cargo box at the building end, the cab facing the street. Teal, like HQ's roof
    const body = ['#4fb5a5', '#45a293', '#357f73'], cab = ['#5cc2b2', '#4fb5a5', '#3d8f82'];
    B(0.1, 0.05, 1.85, 0.85, 3, 7, '#3b3355');
    B(0.05, 0.05, 1.3, 0.85, 7, 25, body);
    B(1.3, 0.08, 1.85, 0.82, 7, 17, cab);
    const side = X ? wallY : wallX, front = X ? wallX : wallY; // along its near side: a cream band, a parcel with its tape, the cab window
    front(g, 0.15, 0.75, 1.85, 11, 16, '#8fd3ff');
    side(g, 0.1, 1.25, 0.85, 9, 11, '#fffaf0');
    side(g, 0.6, 1.05, 0.85, 13, 21, '#cf9460'); side(g, 0.79, 0.86, 0.85, 13, 21, '#f6e7c1');
    side(g, 1.4, 1.75, 0.82, 11, 16, '#8fd3ff');
    wheel(0.35, 0.86); wheel(1.5, 0.86);
    if (open) B(0.05, 0.85, 0.45, 0.9, 8, 24, cab); // a rear door swung open, flat against its side
    if (lights) { const p = X ? [1.85, 0.7] : [0.7, 1.85]; F(g, SX(p[0], p[1]) - 1, SY(p[0], p[1], 12), 3, 2, '#fff3b0'); }
  });
  return (vanCache[k] = s);
}

// ---- sky backdrop, drawn in buffer space with parallax ----
let skyline = null, skyKey = '';
// The share of the city's windows that are lit: a few by day, filling up after sunset, going out
// again after midnight. Each window has its own threshold, so they switch on and off one by one.
const cityLights = h => { h %= 24; return h < 5 ? 0.2 - h * 0.03 : h < 7 ? 0.08 : h < 17 ? 0.03 : h < 21 ? 0.03 + (h - 17) * 0.1 : 0.43 - (h - 21) * 0.08; };
function buildSkyline(bot, dark, lit) {
  const w = 900, h = 120, c = canvas(w, h), g = c.getContext('2d'), r = rng('city');
  for (const [layer, fade] of [[0, 0.62], [1, 0.4]]) {
    const body = mix(mix(bot, '#3b3355', fade), '#141032', dark * 0.5);
    for (let x = -4; x < w;) {
      const bw = 14 + (r() * 24 | 0), bh = 20 + (r() * (layer ? 70 : 50) | 0) + layer * 20;
      F(g, x, h - bh, bw - 2, bh, body);
      if (r() < 0.25) F(g, x + (bw >> 1) - 1, h - bh - 7, 1, 7, body);
      if (layer) for (let wy = h - bh + 4; wy < h - 4; wy += 6) for (let wx = x + 3; wx < x + bw - 5; wx += 4) if (r() < lit) F(g, wx, wy, 2, 2, '#ffd27a');
      x += bw;
    }
  }
  return c;
}
const CLOUDS = [0, 1, 2].map(k => { const r = rng('cloud' + k), w = 34 + k * 14, c = canvas(w, 16), g = c.getContext('2d'); for (let i = 0; i < 5 + k * 2; i++) disc(g, 8 + (r() * (w - 16) | 0), 9 + (r() * 3 | 0), 4 + (r() * 3 | 0), '#fff'); F(g, 4, 11, w - 8, 3, '#fff'); return c; });
const tinted = new Map();
// the rainbow's bands, one cached picture per screen size: a pixel arc low over the far horizon
let bowKey = '', bowImg = null;
function rainbowImg(bw, bh) {
  if (bowKey === `${bw}x${bh}`) return bowImg;
  bowKey = `${bw}x${bh}`; bowImg = canvas(bw, bh);
  const g = bowImg.getContext('2d'), cx = bw * 0.72, cy = bh * 0.5, R = Math.min(bw * 0.4, bh * 0.36), cols = ['#e8505b', '#f2a65a', '#ffd966', '#7bd389', '#5b8def', '#9b72cf'];
  // the ends fade out towards the horizon, in a few steps so it stays pixel-crisp
  cols.forEach((c, i) => { g.fillStyle = c; const r = R - i * 3; for (let a = Math.PI; a <= 2 * Math.PI; a += 0.5 / r) { const up = -Math.sin(a); g.globalAlpha = Math.round(Math.min(1, up / 0.6) * 4) / 4; if (g.globalAlpha > 0) g.fillRect(Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a)), 2, 3); } });
  g.globalAlpha = 1;
  return bowImg;
}
// A cloud slot in the overcast deck keeps its looks as it drifts: whether it's there, which cloud, and its
// offset. Kept in a small cache, as the slots scroll past a few per second.
const deckSlots = new Map();
function deckSlot(row, slot) {
  const key = `${row}:${slot}`;
  let s = deckSlots.get(key);
  if (!s) {
    const rd = rng(`deck${key}`);
    s = { keep: rd(), k: rd() * 3 | 0, dy: rd() * 10 | 0, dx: rd() * 20 | 0 };
    if (deckSlots.size > 500) deckSlots.clear();
    deckSlots.set(key, s);
  }
  return s;
}
// (the shade band is drawn source-atop: source-in would wipe everything outside it)
function cloudImg(k, col) {
  const key = k + col;
  if (!tinted.has(key)) { const src = CLOUDS[k], c = canvas(src.width, src.height), g = c.getContext('2d'); g.drawImage(src, 0, 0); g.globalCompositeOperation = 'source-in'; F(g, 0, 0, c.width, c.height, col); g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(29,26,47,.18)'; g.fillRect(0, c.height - 4, c.width, 4); if (tinted.size > 60) tinted.clear(); tinted.set(key, c); }
  return tinted.get(key);
}

// Drawn with 'destination-over' behind the finished scene, so layers go front to back:
// clouds, the distant city, the sun or moon, stars. The gradient itself is the page background.
const moons = new Map();
function moonImg(topC) {
  if (!moons.has(topC)) { const c = canvas(20, 20), g = c.getContext('2d'); disc(g, 10, 10, 9, 'rgba(246,231,193,.12)'); disc(g, 10, 10, 6, '#f6e7c1'); g.globalCompositeOperation = 'destination-out'; disc(g, 13, 8, 5, '#000'); if (moons.size > 40) moons.clear(); moons.set(topC, c); }
  return moons.get(topC);
}
// cam: {x, y}, bw/bh: the buffer size. Returns the sun or moon (buffer coords) for tapping
export function drawSky(g, bw, bh, cam, L, h, wx, t, R) {
  const wet = wx.wet, dark = darkness(h), [topC, bot] = skyAt(h, wet);
  const css = `linear-gradient(${topC}, ${bot})`;
  if (R.skyCss !== css) { R.skyCss = css; document.body.style.background = css; }
  // a plane crossing high up every so often: a small silhouette by day, blinking lights by night
  const pp = (t % 80) / 80;
  if (pp < 0.5) {
    const px = Math.round(-30 + pp * 2 * (bw + 60)), py = Math.round(bh * 0.14 + Math.sin(pp * 6) * 4);
    if (dark > 0.5) { const on = (t * 1.5 | 0) % 2; F(g, px, py, 1, 1, on ? '#ff4d5e' : '#fffaf0'); F(g, px - 6, py + 1, 1, 1, on ? '#fffaf0' : '#7bff9a'); }
    else { const c = mix('#8b8fa3', topC, 0.3); F(g, px - 6, py, 8, 1, c); F(g, px - 3, py - 2, 2, 5, c); F(g, px - 6, py - 1, 1, 1, c); }
  }
  const oc = wx.overcast ?? 0;
  // clouds in two layers: the more overcast, the more of them, and a grey veil over the sky behind
  const col = mix(dark > 0.5 ? '#6a6390' : '#ffffff', wet ? '#8d90a8' : '#ffd3c4', wet ? 0.7 : Math.max(0, 1 - Math.abs(h - 19) / 1.2) * 0.6 + Math.max(0, 1 - Math.abs(h - 6.8) / 1.2) * 0.5);
  const n = 5 + Math.round(oc * 19), r = rng('clouds');
  // how far the wind has carried the clouds: added up frame by frame, so a change of wind changes their speed
  // (not t × wind, which jumps further the longer HQ has been open)
  R.drift = (R.drift ?? 0) + clamp(t - (R.skyT ?? t), 0, 0.25) * (1 + wx.wind); R.skyT = t;
  for (let i = 0; i < n; i++) {
    const k = i % 3, p = 0.3 + (i % 4) * 0.12, span = bw + 400;
    const x = ((r() * span + R.drift * (2 + r() * 3) - (cam.x - L.bounds.x0) * p) % span + span) % span - 200;
    const y = (L.bounds.y0 + r() * (L.bounds.y1 - L.bounds.y0) * 0.75 - cam.y) * p + bh / 2 - 40;
    g.globalAlpha = dark > 0.5 ? 0.55 + oc * 0.35 : 0.92; g.drawImage(cloudImg(k, col), Math.round(x), Math.round(y)); g.globalAlpha = 1;
  }
  // an overcast deck across the upper sky: a few rows of cloud, drifting, fuller the more overcast
  if (oc > 0.05) {
    const deck = mix(col, dark > 0.5 ? '#2a2550' : '#8d90a8', 0.35 + oc * 0.25), STEP = 45;
    for (let row = 0; row < 4; row++) {
      // each cloud belongs to a slot that scrolls with the deck, so it keeps its looks as it drifts
      const y = Math.round(bh * (0.04 + row * 0.085)), shift = t * (3 + row) * 0.6 - (cam.x - L.bounds.x0) * (0.2 + row * 0.05), first = Math.floor((-120 - shift) / STEP);
      for (let slot = first; slot * STEP + shift < bw + 60; slot++) {
        const s = deckSlot(row, slot); if (s.keep > oc * (1.1 - row * 0.15)) continue;
        g.globalAlpha = (dark > 0.5 ? 0.7 : 0.85) * Math.min(1, oc * 1.4); g.drawImage(cloudImg(s.k, row % 2 ? mix(deck, '#ffffff', 0.08) : deck), Math.round(slot * STEP + shift + s.dx), y + s.dy);
      }
    }
    g.globalAlpha = 1;
  }
  // a rainbow opposite the sun when it rains in sunshine (sunshowers, and the edges of a daytime rain)
  const bow = dark < 0.3 ? Math.max(0, Math.min(1, wx.rain / 0.25, (1 - wx.rain) / 0.35)) * Math.max(0, 1 - Math.max(0, oc - 0.5) * 2) * (1 - dark / 0.3) : 0;
  if (bow > 0.05) { g.globalAlpha = 0.7 * bow; g.drawImage(rainbowImg(bw, bh), 0, 0); g.globalAlpha = 1; }
  // distant city, a little parallax, and the land under it
  const lit = Math.round(cityLights(h) * 60) / 60, key = `${bot}${dark.toFixed(1)}${lit}`;
  if (key !== skyKey) { skyKey = key; skyline = buildSkyline(bot, dark, lit); }
  const hy = (L.bounds.y1 - 70 - cam.y) * 0.45 + bh / 2, sxo = ((-(cam.x - L.bounds.x0) * 0.25) % 900 + 900) % 900;
  // a bank of low cloud the island floats above, in front of the city
  const bank = mix(col, '#ffffff', dark > 0.5 ? 0 : 0.25), bo = ((t * 3 - (cam.x - L.bounds.x0) * 0.35) % 120 + 120) % 120;
  for (let row = 0; row < 2; row++) for (let x = -120 - bo - row * 50; x < bw + 60; x += 58) {
    const k = ((x + bo) / 58 | 0) & 1 ? 2 : 1; g.globalAlpha = row ? 0.55 : 0.9; g.drawImage(cloudImg(k, row ? mix(bank, bot, 0.25) : bank), Math.round(x), Math.round(hy - 6 + row * 10 + (k === 2 ? -3 : 0)));
  }
  g.globalAlpha = 1;
  // a train along the foot of the city now and then, windows lit after dark
  const tp = (t % 55) / 55;
  if (tp < 0.55) {
    const tx = Math.round(bw + 60 - tp / 0.55 * (bw + 180)), ty = Math.round(hy - 3), body = mix(mix(bot, '#3b3355', 0.7), '#141032', dark * 0.5);
    for (let k = 0; k < 5; k++) { F(g, tx + k * 13, ty - 4, 12, 4, body); for (let w = 0; w < 3; w++) F(g, tx + k * 13 + 2 + w * 3, ty - 3, 2, 1, dark > 0.4 ? '#ffd27a' : mix(body, '#ffffff', 0.25)); }
    F(g, tx - 1, ty - 3, 1, 3, body);
  }
  for (let x = sxo - 900; x < bw; x += 900) g.drawImage(skyline, Math.round(x), Math.round(hy - 120));
  if (hy + 8 < bh) F(g, 0, Math.round(hy + 8), bw, bh - Math.round(hy + 8), mix(mix(col, bot, 0.6), '#3b3355', 0.12 + dark * 0.3));
  if (L.holidays.has('newYear')) drawFireworks(g, bw, hy, sxo, h, t, dark); // (behind the city, so the rockets rise from between its towers)
  // sun and moon on an arc across the top of the screen
  const sunT = (h - 5.5) / 15, moonT = ((h + 24 - 19.5) % 24) / 11, arc = s => ({ x: Math.round(lerp(bw * 0.08, bw * 0.92, s)), y: Math.round(bh * 0.1 + (1 - Math.sin(Math.PI * s)) * bh * 0.35) });
  let orb = null;
  if (sunT > 0 && sunT < 1) { orb = { ...arc(sunT), kind: 'sun' }; g.globalAlpha = 1 - Math.max(wet, oc) * 0.75; disc(g, orb.x, orb.y, 6, '#ffd966'); disc(g, orb.x, orb.y, 8, '#ffe89a'); disc(g, orb.x, orb.y, 11, 'rgba(255,232,154,.35)'); g.globalAlpha = 1; }
  else if (moonT > 0 && moonT < 1) { orb = { ...arc(moonT), kind: 'moon' }; g.globalAlpha = 1 - Math.max(wet, oc) * 0.7; g.drawImage(moonImg(topC), orb.x - 10, orb.y - 10); g.globalAlpha = 1; }
  // a bat crossing the moon, Halloween week only
  if (orb?.kind === 'moon' && wet < 0.5 && L.holidays.has('halloween')) {
    const bp = (t % 26) / 26;
    if (bp < 0.35) {
      const bx = Math.round(orb.x - 16 + bp / 0.35 * 32), by = Math.round(orb.y - 5 + Math.sin(bp * 14) * 4), up = (t * 11 | 0) % 2;
      F(g, bx, by, 1, 1, INK); F(g, bx - 4, by - up, 3, 1, INK); F(g, bx + 1, by - up, 3, 1, INK); F(g, bx - 6, by - up + 1, 2, 1, INK); F(g, bx + 4, by - up + 1, 2, 1, INK);
    }
  }
  // stars
  if (dark > 0.05) {
    const rs = rng('stars');
    for (let i = 0; i < 140; i++) {
      const x = ((rs() * 1400 - (cam.x - L.bounds.x0) * 0.1) % 1400 + 1400) % 1400 - 200, y = rs() * bh * 0.8, tw = Math.sin(t * (1 + rs() * 2) + i) > 0.6;
      g.globalAlpha = dark * (1 - wet) * (1 - oc) * (tw ? 1 : 0.55); F(g, x | 0, y | 0, 1, 1, rs() < 0.2 ? '#ffd966' : '#f6e7c1');
    }
    g.globalAlpha = 1;
  }
  return orb;
}

// ---- New Year's Eve: fireworks over the city ----
// Nothing is kept between frames. Time is cut into slots, SLOTS a second, and each slot's rocket (if it fires) is
// decided by the slot's number alone. So every frame redraws the same show, and there are never more rockets in
// the air than slots in a rocket's lifetime (a few hundred sparks at the height of the finale).
const SLOTS = 4, RISE = 1.1, FADE = 2.4, SPARKS = 30;
const FIRE = ['#ff5c8a', '#ffd966', '#7bd389', '#8fd3ff', '#ff7a4d', '#b98bff', '#fffaf0'];
// rockets a second: now and then in the evening, more and more towards midnight, the finale from 23:59 to 00:03,
// then fewer and fewer until morning
export function fireworksRate(h) {
  const m = ((h + 12) % 24 - 12) * 60; // minutes from midnight
  if (m >= -1 && m < 3) return SLOTS;
  return m < 0 ? 0.4 + 0.8 * clamp(1 + m / 180, 0, 1) ** 2 : 0.4 + 1.6 * Math.exp(-(m - 3) / 60);
}
// hy: the foot of the city. sxo: the city's parallax offset, so the rockets stay over the same towers
function drawFireworks(g, bw, hy, sxo, h, t, dark) {
  const show = clamp((dark - 0.2) / 0.5, 0, 1), now = Math.floor(t * SLOTS);
  if (!show) return;
  for (let slot = now - Math.ceil((RISE + FADE) * SLOTS); slot <= now; slot++) {
    const r = rng(`firework${slot}`), rate = fireworksRate(h - (t - slot / SLOTS) / 3600), finale = rate === SLOTS; // (the rate when it went up, so no rocket vanishes mid-air as the rate drops)
    if (r() > rate / SLOTS) continue;
    const age = t - (slot + r()) / SLOTS, cx = r() * 900, top = hy - 105 - r() * 80, R = 18 + r() * 22 + (finale ? 10 : 0);
    const kind = r() < 0.5 ? 'peony' : r() < 0.5 ? 'ring' : 'willow', c = FIRE[r() * FIRE.length | 0];
    if (age < 0 || age > RISE + FADE) continue;
    for (let x = sxo - 900 + cx; x < bw + 40; x += 900) if (x > -40) rocket(g, Math.round(x), hy, top, R, kind, c, age, t, show);
  }
  if (fireworksRate(h) === SLOTS && ((h + 12) % 24 - 12) >= 0) newYearNumber(g, Math.round(bw * 0.8), Math.round(hy - 150), t, show); // (off to the side: HQ stands in the middle)
  g.globalAlpha = 1;
}
function rocket(g, x, hy, top, R, kind, c, age, t, show) {
  if (age < RISE) { // the climb: a spark with a short tail, slowing as it reaches the top
    const k = age / RISE, y = Math.round(hy - (hy - top) * (1 - (1 - k) ** 2)), wob = Math.round(Math.sin(age * 9) * 0.6);
    for (let i = 0; i < 4; i++) { g.globalAlpha = show * (1 - i / 4); F(g, x + wob, y + i * 2, 1, 2, i ? '#ffb35a' : '#fff3b0'); }
    return;
  }
  const a = age - RISE, spread = 1 - Math.exp(-a * 3.2), fall = a * a * (kind === 'willow' ? 7 : 4), fade = 1 - a / FADE;
  if (a < 0.35) { g.globalAlpha = show * 0.16 * (1 - a / 0.35); disc(g, x, Math.round(top), Math.round(R * 0.8 * spread) + 2, c); } // the flash lights up the sky round it
  for (let i = 0; i < SPARKS; i++) {
    // a peony or willow fills its sphere evenly (a sunflower pattern: the golden angle, sqrt spacing), a ring is its rim
    const ang = kind === 'ring' ? i / SPARKS * Math.PI * 2 : i * 2.39996, v = kind === 'ring' ? 1 : Math.sqrt((i + 0.5) / SPARKS);
    if (fade < 0.35 && ((t * 18 + i * 5) | 0) % 3 === 0) continue; // the crackle as it dies away
    const px = Math.round(x + Math.cos(ang) * R * v * spread), py = Math.round(top + Math.sin(ang) * R * v * spread * 0.9 + fall);
    const col = a < 0.2 ? '#fffaf0' : kind === 'willow' ? (fade > 0.5 ? '#ffe89a' : '#e8a33d') : c, size = a < 0.8 && v > 0.5 ? 2 : 1;
    g.globalAlpha = show * Math.min(1, fade * 1.6); F(g, px, py, size, size, col);
    if (spread < 0.9) for (const k of [0.84, 0.7, 0.56]) { g.globalAlpha *= 0.6; F(g, Math.round(x + (px - x) * k), Math.round(top + (py - fall - top) * k + fall), 1, 1, col); } // its streak
  }
}
// Just after midnight a rocket every six seconds bursts into the new year's number, in gold, which hangs and
// twinkles, then droops and fades
const yearDots = new Map();
function newYearNumber(g, x, y, t, show) {
  const d = today(), year = String(d.getMonth() === 0 ? d.getFullYear() : d.getFullYear() + 1);
  if (!yearDots.has(year)) {
    const w = textW(year, 3) + 2, H = 18, c = canvas(w, H), cg = c.getContext('2d'), dots = [];
    text(cg, year, 1, 1, '#fff', 3);
    const px = cg.getImageData(0, 0, w, H).data; // every other lit pixel of the number, spaced out twice as wide
    for (let i = 0; i < w * H; i++) if (px[i * 4 + 3] > 128 && (i % w + (i / w | 0)) % 2 === 0) dots.push({ dx: (i % w - w / 2) * 2, dy: ((i / w | 0) - H / 2) * 2 });
    yearDots.set(year, dots);
  }
  const a = t % 6;
  if (a < 0.9) { rocket(g, x, y + 120, y, 0, 'peony', '#ffd966', a / 0.9 * RISE, t, show); return; }
  const spread = 1 - Math.exp(-(a - 0.9) * 5), fall = Math.max(0, a - 4.4) ** 2 * 6, fade = a < 4.4 ? 1 : 1 - (a - 4.4) / 1.6;
  yearDots.get(year).forEach((p, i) => {
    const on = ((t * 10 + i * 7) | 0) % 5 !== 0;
    g.globalAlpha = show * fade * (on ? 1 : 0.4);
    F(g, Math.round(x + p.dx * spread), Math.round(y + p.dy * spread + fall * (1 + (i % 4) / 3)), 1, 1, on ? '#ffe89a' : '#ffb35a');
  });
}
