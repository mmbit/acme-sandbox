// Draws a frame, back to front: the basement, the island, the floors (each room: its cached shell, animated
// decals, then props and people sorted by depth), the façade, outdoors, particles, light, the sky behind it
// all, and weather. Everything is drawn at 1 world pixel per buffer pixel. CSS scales it up by the zoom.
import { canvas, mix, rng, clamp, lerp } from '../../util.js';
import { drawEmotes } from './emotes.js';
import { FH, SLAB, CORE, SHAFT, INK, F, SX, SY, top, wallY, wallX, box, ellipse, text, textW, onWallY, sprite, silhouette } from './iso.js';
import { spriteFrame, CW, FOOT, DRINKS } from './sprites.js';
import { drawSky, darkness, skyAt, vanSprite } from './env.js';
import { roomAt, levelName } from './layout.js';
import { SEAT_H, treadDepth, SHAKER, ROUND } from './rooms.js'; // (SHAKER, ROUND)
import { outdoors } from './sim.js';
import { drawMascot } from './mascots.js';
import { drawDarkroom, darkroomTint, safelightGlow } from './darkroom.js';
import { drawMeeting } from './meeting.js';
import { townItems, drawTownsfolk, drawCar } from './town.js';
import { drawLot, tintFacade, drawClosed, drawLift, drawPlug, drawEscape, drawScreen, lightClosed, lightPlug, facadeGlows, partyGlass, revealed } from './facade.js';

const SIT_ABOVE = 1;  // a seated frame's lowest row is drawn this far above its feet row: on the cushion, not in it
const CAB_H = 33;     // the elevator cab, px tall
const HEAD_ROOM = 32; // on the stairs, someone this close below the floor above has their head through its opening
const ENGINE_BG = { claude: '#ffd9b3', codex: '#b9f5c4', api: '#bcd4ff', human: '#fff3b0' };
// intro(ISLAND): how far the island is from its place during the intro (it rises from below, the floors drop in)
export const ISLAND = -99;

// The visible canvas is the low-resolution frame buffer, and CSS scales it up (pixelated) on the GPU.
// Speech bubbles and name cards are DOM elements over it (see shell/overlay.js).
export function createRenderer(screen) {
  const R = { fb: screen, lm: canvas(1, 1), glows: new Map(), hits: [] };
  R.fg = R.fb.getContext('2d'); R.lg = R.lm.getContext('2d');
  return R;
}

// ---------------------------------------------------------------- the frame
export function render(R, S, L, cam, o) {
  const { SW, SH, t, hour: h } = o, z = cam.z;
  const bw = Math.ceil(SW / z) + 2, bh = Math.ceil(SH / z) + 2;
  fitBuffer(R, bw, bh, !cam.t && !cam.pinching && Number.isInteger(z));
  const bx0 = Math.floor(cam.x - SW / 2 / z), by0 = Math.floor(cam.y - SH / 2 / z);
  const dark = darkness(h), wx = S.weather, g = R.fg;
  R.hits = []; R.bx0 = bx0; R.by0 = by0;
  tintWindows(L, h, Math.max(wx.rain, wx.snow) * 0.6, dark);
  // the scene only ever covers the island's box: limit full-buffer passes to it
  const A = lightArea(L, o.intro), rx = clamp(A.x - bx0, 0, bw), ry = clamp(A.y - by0, 0, bh);
  R.rect = [rx, ry, clamp(A.x + A.w - bx0, 0, bw) - rx, clamp(A.y + A.h - by0, 0, bh) - ry];
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, bw, bh);
  g.setTransform(1, 0, 0, 1, -bx0, -by0); g.imageSmoothingEnabled = false;
  const blit = (img, x, y) => {
    const sx = Math.max(0, bx0 - x), sy = Math.max(0, by0 - y), w = Math.min(img.width - sx, bx0 + bw - x - sx), hh = Math.min(img.height - sy, by0 + bh - y - sy);
    if (w > 0 && hh > 0) g.drawImage(img, sx, sy, w, hh, x + sx, y + sy, w, hh);
  };
  const visible = (x, y, w, hh) => x < bx0 + bw && x + w > bx0 && y < by0 + bh && y + hh > by0;
  const facade = R.facade, walls = facade && o.walls ? o.walls : null, intro = o.intro;
  // with the outside walls on, a closed level's rooms aren't drawn at all (nor can anyone in them be tapped)
  R.shut = i => !!walls && i < L.nUp && walls(i) === 0;
  R.lidded = !!walls && !!L.pent && walls(L.nUp) === 0; // the penthouse under its roof
  if (facade) tintFacade(facade, skyAt(Math.round(h * 4) / 4, Math.max(wx.rain, wx.snow) * 0.6), dark);
  const f = { R, S, L, g, t, h, dark, wx, bx0, by0, blit, visible, facade, walls, intro, rounds: o.rounds ?? [], ...whoIsWhere(S, L) }; // (rounds)
  for (const lv of L.levels) if (lv.i < 0) drawLevel(f, lv);
  drawIsland(f);
  for (const lv of L.levels) if (lv.i >= 0) drawLevel(f, lv);
  if (walls) drawFacadeLift(f);
  drawOutdoors(f);
  drawParticles(f);
  drawFlocks(g, S);
  lighting(R, g, S, L, t, dark, bx0, by0, intro, walls);
  for (const p of o.planes || []) paperPlane(g, p);
  if (o.selected?.hit) drawSelection(g, o.selected, t);
  drawEmotes(g, R.hits, t, o.selected);
  // the sky goes in behind the finished scene (its gradient is the page background)
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'destination-over';
  R.orb = drawSky(g, bw, bh, cam, L, h, { ...wx, wet: Math.max(wx.rain, wx.snow, (wx.fog ?? 0) * 0.9) * 0.8 + wx.cloud * 0.15 }, t, R);
  g.restore();
  if (R.orb) { R.orb.wx = R.orb.x + bx0; R.orb.wy = R.orb.y + by0; }
  weather(R, g, S, L, t, bw, bh, bx0, by0, dark);
  placeCanvas(R, cam, o, bx0, by0);
}
// The frame buffer fits the view exactly once the zoom has settled. While it changes, the buffer only grows,
// so a zoom doesn't reallocate it every frame.
function fitBuffer(R, w, h, settled) {
  const fb = R.fb;
  if (settled ? fb.width === w && fb.height === h : fb.width >= w && fb.height >= h) return;
  fb.width = settled ? w : Math.max(w, fb.width);
  fb.height = settled ? h : Math.max(h, fb.height);
}
// the sky seen through the back walls' windows, tinted again when the sky changes (its key on the building's layout, so a
// kept building keeps its own)
function tintWindows(L, h, wet, dark) {
  const [a, b] = skyAt(h, wet), key = `${a}${b}`;
  if (key === L.winKey) return;
  L.winKey = key;
  const r = rng('winstars');
  for (const room of L.rooms) {
    const art = room.art; if (!art?.m) continue;
    art.win ??= canvas(art.m.width, art.m.height);
    const g = art.win.getContext('2d');
    g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, art.win.width, art.win.height);
    g.drawImage(art.m, 0, 0); g.globalCompositeOperation = 'source-in';
    const gr = g.createLinearGradient(0, 0, 0, art.win.height); gr.addColorStop(0, a); gr.addColorStop(1, b);
    g.fillStyle = gr; g.fillRect(0, 0, art.win.width, art.win.height);
    g.globalCompositeOperation = 'source-atop';
    if (dark > 0.4) for (let i = 0; i < art.win.width / 3; i++) F(g, r() * art.win.width | 0, r() * art.win.height | 0, 1, 1, '#f6e7c1');
    else for (let i = 0; i < art.win.width / 4; i++) { const x = r() * art.win.width | 0, y = r() * art.win.height | 0; F(g, x, y, 4, 1, 'rgba(255,255,255,.5)'); }
    g.globalCompositeOperation = 'source-over';
  }
}
// Who is drawn where: indoors, the room each agent is in, and everyone outdoors. Riders in the cab are drawn
// with the cab. Someone on the stairs with their head through the floor above is drawn with this floor (behind
// the stair's near railing), and the part above the floor line again with the floor above, over its floor.
function whoIsWhere(S, L) {
  const inRoom = new Map(), outside = [];
  for (const A of S.people.values()) {
    A.dz = A.z; A.dlvl = A.lvl;
    if (A.ride?.phase === 'ride') continue;
    if (outdoors(S, A)) { outside.push(A); continue; }
    const stairs = A.plan[0]?.t === 'stairs' && A.plan[0].y != null;
    if (stairs && A.z > FH - HEAD_ROOM && L.level(A.lvl + 1)) {
      const up = L.level(A.lvl + 1).rooms[0], head = Object.create(A);
      head.dz = A.z - FH; head.dlvl = A.lvl + 1; head.clipAbove = true;
      if (!inRoom.has(up)) inRoom.set(up, []);
      inRoom.get(up).push(head);
    }
    const lv = L.level(A.dlvl);
    const room = (stairs ? lv.rooms[0] : roomAt(L, A.lvl, A.x, A.y)) || nearestRoom(lv, A);
    if (!inRoom.has(room)) inRoom.set(room, []);
    inRoom.get(room).push(A);
  }
  const cabLvl = clamp(Math.floor((S.lift.z + 1) / FH), -L.nDown, L.nUp), cabTop = S.lift.z + CAB_H > (cabLvl + 1) * FH;
  return { inRoom, outside, cabLvl, cabTop };
}
function nearestRoom(lv, A) {
  const near = (best, r) => { const d = Math.hypot(clamp(A.x, r.x0, r.x1) - A.x, clamp(A.y, r.y0, r.y1) - A.y); return !best || d < best.d ? { r, d } : best; };
  return lv.rooms.reduce(near, null).r;
}
// One level: each room's shell, decals and depth-sorted props and people, then (walls on) the closed façade.
function drawLevel(f, lv) {
  const { R, g, facade, walls, intro } = f, off = intro ? intro(lv.i) : 0;
  if (off > 400) return;
  if (off) g.translate(0, -off);
  if (R.shut(lv.i)) for (const room of lv.rooms) for (const A of f.inRoom.get(room) || []) A.hit = null;
  else for (const room of lv.rooms) drawRoom(f, lv, room);
  if (walls && lv.i >= 0 && walls(lv.i) === 0) drawClosed(g, facade, lv.i, f.blit, lv.rooms.flatMap(r => f.inRoom.get(r) || []), f.dark, f.wx.cover);
  if (facade && lv.i > 0) drawEscape(g, facade, lv.i);
  if (off) g.translate(0, off);
}
function drawRoom(f, lv, room) {
  const { R, S, L, g, t, blit } = f, art = room.art;
  if (art.win) blit(art.win, art.mx, art.my);
  if (art.plug && R.shut(lv.i - 1)) g.drawImage(art.plug.img, art.plug.x, art.plug.y); // the stairwell, over a shut floor
  blit(art.c, art.cx, art.cy);
  if (room.dark) { art.shade ??= silhouette(art.c, '#0d0b24'); g.globalAlpha = 0.35 + f.dark * 0.2; blit(art.shade, art.cx, art.cy); g.globalAlpha = 1; }
  if (room.pent && R.sign) g.drawImage(R.sign.imgs[(t * 6 | 0) % 3], R.sign.x, R.sign.y); // the bulbs chase round
  if (room.kind === 'terrace' && S.weather.cover > 0.02) { g.globalAlpha = S.weather.cover * 0.85; top(g, room.x0 + 0.05, room.y0 + 0.05, room.x1, room.y1, room.z, '#f4f6ff'); g.globalAlpha = 1; }
  drawDecals(g, room, S, t, f.rounds); // (rounds)
  drawDepthSorted(g, art, roomMovers(f, lv, room), it => {
    if (it.A?.clipAbove) drawHead(R, g, it.A, S, t, lv.z);
    else if (it.A) drawAgent(R, g, it.A, S, t, lv.z, false, it.A.dz);
    else if (it.cab) drawCab(g, S, it.clip);
    else if (it.front) drawLiftFront(g, room, S, L);
    else if (it.pet) drawMascot(g, it.pet, t, lv.z);
    else if (it.fan) drawFan(g, it.fan, t);
    else if (it.dock) drawVacDock(g, it.dock, t, lv.z);
    else if (it.vac) drawVac(g, it.vac, t, lv.z);
  });
  if (art.anchors.studio && S.studio?.editing) { g.save(); roomClip(g, room, 0); darkroomTint(g, art, blit); g.restore(); } // the safelight's red over everything in it
  if (lv.roof && room.kind === 'terrace' && R.bunting && !room.garden) g.drawImage(R.bunting.img, R.bunting.x, R.bunting.y);
}

// the part of a climber above the floor they're coming up through
function drawHead(R, g, A, S, t, floorZ) {
  g.save(); g.beginPath(); g.rect(-1e5, -1e5, 2e5, 1e5 + SY(A.x, A.y, floorZ)); g.clip();
  drawAgent(R, g, A, S, t, floorZ, false, A.dz);
  g.restore();
}
function drawFan(g, fan, t) {
  const k = (t * 12 | 0) % 2;
  F(g, fan.x - 4 + k * 2, fan.y, 4, 1, '#2b2230'); F(g, fan.x - 1, fan.y - 1 + k, 2, 1, '#2b2230');
}

// ---------------------------------------------------------------- per-frame decals
// the animated bits of a room: screens, LEDs and the ringing phone, parcels on the conveyor, bubbles in the
// jacuzzi and glints on glass
function drawDecals(g, room, S, t, rounds) { // (rounds: the bar's)
  const anchors = room.art.anchors;
  if (anchors.screens.length) drawScreens(g, room, S, t);
  for (const l of anchors.leds) {
    const sx = SX(l.x, l.y), sy = SY(l.x, l.y, l.z);
    let on;
    if (l.antenna) on = (t % 1.6) < 0.5;
    else if (l.caret) { F(g, Math.round(sx), Math.round(sy), 1, 1, (t % 1.1) < 0.55 ? l.c : l.off); continue; } // the Overseer's prompt
    else if (l.phone) {
      const ring = S.requests > 0 && (t % 2.2) < 0.9;
      on = S.requests > 0 ? (t * 8 | 0) % 2 === 0 : (t % 2.4) < 0.3;
      if (ring) { const k = (t * 10 | 0) % 2; F(g, sx - 5 - k, sy - 4, 1, 3, '#ffd966'); F(g, sx + 5 + k, sy - 4, 1, 3, '#ffd966'); F(g, sx - 3, sy - 7 - k, 1, 2, '#ffd966'); F(g, sx + 3, sy - 7 - k, 1, 2, '#ffd966'); }
    }
    else if (l.eng) { // a seat's rack: a slow few lights idle, half of them quicker at work; n is capped at 3 so the rate stays at or under ~1.6 Hz
      const n = Math.min(S.engineBusy[l.eng] || 0, 3);
      on = Math.sin(t * (n ? 4 + n * 2 : 1.2) + l.k * 1.7) > (n ? 0 : 0.6);
    }
    else if (l.onair != null) on = S.onAir ? Math.sin(t * 9 + l.onair * 1.9) > -0.2 : false; // the booth: the mixer's lights dance while anyone records
    else if (l.vu != null) on = S.onAir && l.vu < 2.5 + 2.2 * Math.sin(t * 6.1) * Math.sin(t * 2.3 + 1); // and its recorder's level
    else if (l.rig) { // the rig's RGB along its side, while it's there (drawRig has its front)
      if (S.machine?.present && Math.sin(t * 0.9 + l.k * 2.1) > -0.4) F(g, sx, sy, 1, 1, l.c ?? `hsl(${(t * 24 + l.k * 120) % 360} 85% 65%)`);
      continue;
    }
    else on = Math.sin(t * 2 + sx) > 0;
    F(g, sx, sy, l.eng ? 2 : 1, 1, on ? l.c : '#2b3148');
  }
  if (anchors.rig) drawRig(g, anchors.rig, S.machine, t);
  for (const b of anchors.belts) { // parcels move along the conveyor while the dock is busy
    for (let k = 0; k < 3; k++) {
      const u = b.a0 + ((t * (S.dockBusy ? 0.35 : 0) + k / 3) % 1) * (b.a1 - b.a0 - 0.3);
      b.F.box(g, u, b.d - 0.12, u + 0.28, b.d + 0.12, b.z - b.F.z, b.z - b.F.z + 6, k % 2 ? '#cf9460' : '#b07a4f');
    }
  }
  if (anchors.jacuzzi) {
    const j = anchors.jacuzzi;
    for (let i = 0; i < 7; i++) {
      const u = j.a0 + 0.15 + ((i * 0.37 + t * 0.2) % 1) * (j.a1 - j.a0 - 0.3), d = j.d0 + 0.15 + ((i * 0.61 + Math.sin(t + i) * 0.1) % 1) * (j.d1 - j.d0 - 0.3);
      const [sx, sy] = j.F.s(u, d, 8);
      F(g, sx, sy - ((t * 3 + i) % 2 | 0), 2, 1, '#bfe6ff');
    }
  }
  if (anchors.onair && S.onAir) g.drawImage(anchors.onair.img, anchors.onair.x, anchors.onair.y); // the booth's ON AIR sign, lit
  if (anchors.studio) drawDarkroom(g, anchors.studio, S.studio, t);
  if (anchors.board) drawMeeting(g, room, S, t);
  if (anchors.bar) drawBar(g, anchors.bar, rounds, t); // (under the shaker's glint)
  for (const gl of anchors.glints) if (Math.sin(t * 1.7 + gl.x) > 0.97) { const sx = SX(gl.x, gl.y), sy = SY(gl.x, gl.y, gl.z); F(g, sx, sy - 1, 1, 3, '#fffaf0'); F(g, sx - 1, sy, 3, 1, '#fffaf0'); }
}
// The cocktail bar's rounds (hit.js, rooms.js ROUND): the shaker on the counter, or up and shaken, then held over the
// glass pouring; each glass slid from it along the counter's front to its place, a sparkle where it stops, and gone
// after its stay.
const POURING = SHAKER.map(([x, y, w, h, c]) => [x, -9 - y - h, w, h, c]); // the shaker upside down (its rows -9 to -1 turned over)
const TWINKLES = [[-4, -9, 0], [4, -6, 0.12], [0, -13, 0.24]]; // where round a stopped glass, and when (s)
function drawBar(g, bar, rounds, t) {
  const { shake, pour, slide, stay, fade } = ROUND, at = (u, d) => bar.F.s(u, d, bar.top).map(Math.round);
  const pixels = (list, x, y) => { for (const [dx, dy, w, h, c] of list) F(g, x + dx, y + dy, w, h, c); };
  const [x, y] = at(bar.shaker, bar.d), [gx, gy] = at(bar.shaker, bar.front), busy = rounds.find(r => t >= r.t0 && t < r.t0 + shake + pour);
  const k = busy ? t - busy.t0 : 0, beat = (k * 14 | 0) % 2;
  if (!busy) pixels(SHAKER, x, y);
  else if (k < shake) pixels(SHAKER, x + (beat ? 1 : -1), y - 4 - beat * 2); // up and shaken, seven times a second
  else { // upside down over the glass, pouring: a thin stream of the drink from its cap
    const list = DRINKS[busy.kind], c = list.find(p => p[4] !== list[0][4])[4];
    pixels(POURING, gx, gy - 9);
    F(g, gx, gy - 9, 1, 3 + (t * 20 | 0) % 2, c);
  }
  for (const r of rounds) {
    const tk = t - (r.t0 + shake + pour), left = slide + stay - tk;
    if (t < r.t0 + shake || left <= 0) continue;
    const e = 1 - (1 - clamp(tk / slide, 0, 1)) ** 3, [sx, sy] = at(lerp(bar.shaker, bar.stops[r.stop], e), bar.front);
    g.globalAlpha = clamp(left / fade, 0, 1);
    pixels(DRINKS[r.kind], sx, sy);
    g.globalAlpha = 1;
    const ts = tk - slide;
    if (ts >= 0 && ts < 0.9) for (const [dx, dy, from] of TWINKLES) if (ts >= from && ((ts - from) * 10 | 0) % 3 !== 2) {
      F(g, sx + dx, sy + dy - 1, 1, 3, '#fffaf0'); F(g, sx + dx - 1, sy + dy, 3, 1, '#fffaf0'); F(g, sx + dx, sy + dy, 1, 1, '#fff3b0');
    }
  }
}
// The rig's front (rooms.js): a light sweeps along its bar and lights run up its channels, each with a fading trail.
const RIG_PACE = { // speeds in radians and px per second, the sweep's lag in seconds, the trail's first lights left out
  run: { sweepSpeed: 4, sweepLag: 0.06, channelSpeed: 34, lights: 2, trailSkip: 0 },
  wait: { sweepSpeed: 1.3, sweepLag: 0.15, channelSpeed: 6, lights: 1, trailSkip: 2 },
};
const sweepPixel = (bar, speed, t) => bar[Math.round((bar.length - 1) * (0.5 - 0.5 * Math.cos(t * speed)))];
function drawRigBar(g, rig, pace, head, t) {
  for (const [x, y] of rig.bar) F(g, x, y, 1, 1, rig.dim);
  for (let k = rig.sweep.length; k >= 0; k--) F(g, ...sweepPixel(rig.bar, pace.sweepSpeed, t - k * pace.sweepLag), 1, 1, k ? rig.sweep[k - 1] : head);
}
function drawRigChannels(g, rig, pace, head, t) {
  const trail = rig.trail.slice(pace.trailSkip);
  for (const [i, [x, y0, length]] of rig.channels.entries()) {
    F(g, x, y0, 1, length, rig.dim);
    const speed = pace.channelSpeed * (1 + ((i * 7) % 3 - 1) * 0.15), loop = length + trail.length + 1; // (channels in turn 15 % slower, as is, 15 % faster)
    for (let light = 0; light < pace.lights; light++) {
      const y = y0 + length - 1 - Math.floor((t * speed + ((i * 0.37 + light / 2) % 1) * loop) % loop);
      for (let k = trail.length; k >= 0; k--) if (y + k >= y0 && y + k < y0 + length) F(g, x, y + k, 1, 1, k ? trail[k - 1] : head);
    }
  }
}
function drawRig(g, rig, machine, t) {
  if (!machine?.present) return;
  const running = !!machine.running, pace = RIG_PACE[running ? 'run' : 'wait'], head = running ? rig.hi : rig.c;
  F(g, ...rig.power, 1, 1, '#7bff9a');
  drawRigBar(g, rig, pace, head, t);
  drawRigChannels(g, rig, pace, head, t);
}
// Monitor screens animate through a few frames per state (an idle one is still).
// Each frame is drawn once and cached.
function drawScreens(g, room, S, t) {
  for (const s of room.art.anchors.screens) {
    const A = S.people.get(s.id); if (!A) continue;
    const state = A.state === 'sleeping' || room.dark ? 'off' : A.state;
    const k = state === 'working' ? (t * 4 | 0) % 20 : state === 'off' ? (t % 2 < 1 ? 1 : 0) : state === 'waiting' ? (t * 3 | 0) % 3 : 0; // idle has one frame
    const key = state + k + A.data.engine;
    s.cache ??= new Map();
    let frame = s.cache.get(key);
    if (!frame) s.cache.set(key, frame = screenFrame(s, state, k, A.data.engine, room.kind)); // room.kind picks an idle page
    g.drawImage(frame.c, frame.x, frame.y);
  }
}
// An idle person's screen: the page they left open, dim and still beside a
// working screen's bright scrolling code. Which page, by the room's kind (one of them per person, the same every time).
const IDLE = { bg: '#7984a0', band: '#8790ac', ink: '#5c6582', hi: '#4e5672' };
const IDLE_PAGES = { studio: ['sketch', 'sketch', 'notes'], lab: ['notes', 'sheet', 'chart'], mailroom: ['inbox'], dock: ['inbox', 'sheet'],
  server: ['sheet', 'chart'], archive: ['notes', 'sheet'], vault: ['sheet'], review: ['notes', 'inbox'], library: ['notes'],
  engine: ['chart', 'sheet', 'notes'], arcade: ['chart', 'notes'] }; // (engine, arcade)
const PAGE_ANY = ['notes', 'inbox', 'sheet', 'chart'];
// a page's marks: at(left, right, top, bottom, colour) in px from the screen's top left (10 × 10); r: the person's own numbers
const PAGE = {
  notes: (at, r) => { at(1, 5 + r(3), 1, 2, IDLE.hi); for (const y of [3, 5, 7]) at(1, 5 + r(5), y, y + 1, IDLE.ink); },
  inbox: (at, r) => { for (const y of [1, 4, 7]) { at(1, 2, y, y + 1, IDLE.hi); at(3, 6 + r(4), y, y + 1, IDLE.hi); at(3, 5 + r(4), y + 1, y + 2, IDLE.ink); } },
  sheet: (at, r) => { at(0, 10, 0, 2, IDLE.band); for (const y of [3, 5, 7]) for (const x of [1, 4, 7]) if (r(5)) at(x, x + 2, y, y + 1, IDLE.ink); },
  chart: (at, r) => { at(1, 9, 8, 9, IDLE.ink); for (const x of [2, 4, 6, 8]) at(x, x + 1, 7 - r(5), 8, IDLE.hi); },
  sketch: (at, r) => { at(1, 9, 1, 6, IDLE.band); at(5 + r(3), 6 + r(3), 2, 3, IDLE.hi); at(1, 4 + r(3), 4, 6, IDLE.ink); at(1, 6, 7, 8, IDLE.ink); },
};
// frame k of a screen in a state: off (a blinking standby light), working (lines of code in the engine's
// colour), waiting (a progress dot) or idle (the page left open, by kind: the room's)
function screenFrame(s, st, k, eng, kind) {
  const X = s.X, xs = X ? [16 * (s.a0 - s.d), 16 * (s.a1 - s.d)] : [16 * (s.d - s.a1), 16 * (s.d - s.a0)];
  const ys = X ? [8 * (s.a0 + s.d) - s.z1, 8 * (s.a1 + s.d) - s.z0] : [8 * (s.d + s.a0) - s.z1, 8 * (s.d + s.a1) - s.z0];
  const l = Math.floor(xs[0]) - 1, tp = Math.floor(ys[0]) - 1, c = canvas(Math.ceil(xs[1]) - l + 2, Math.ceil(ys[1]) - tp + 2), g = c.getContext('2d');
  g.translate(-l, -tp);
  const plane = (a0, a1, z0, z1, col) => X ? wallY(g, a0, a1, s.d, z0, z1, col) : wallX(g, a0, a1, s.d, z0, z1, col);
  if (st === 'off') { plane(s.a0, s.a1, s.z0, s.z1, '#141a2e'); plane(s.a1 - 0.06, s.a1 - 0.03, s.z0 + 1, s.z0 + 2, k ? '#e8505b' : '#141a2e'); }
  else if (st === 'working') {
    plane(s.a0, s.a1, s.z0, s.z1, ENGINE_BG[eng] || '#ffd9b3');
    for (let i = 0; i < 4; i++) { const w = ((k + i * 7 + 3) % 5 + 3) / 16; plane(s.a0 + 0.05 + ((i + k) % 3 === 0 ? 0.06 : 0), s.a0 + 0.05 + w, s.z1 - 3 - i * 2, s.z1 - 2 - i * 2, i % 2 ? '#3b3355' : '#6b4c9a'); }
    if (k % 2) plane(s.a0 + 0.3, s.a0 + 0.34, s.z0 + 1, s.z0 + 2, '#3b3355');
  } else if (st === 'waiting') { plane(s.a0, s.a1, s.z0, s.z1, '#fff3b0'); plane(s.a0 + 0.1 + k * 0.12, s.a0 + 0.16 + k * 0.12, s.z0 + 4, s.z0 + 6, '#f2c14e'); }
  else {
    plane(s.a0, s.a1, s.z0, s.z1, IDLE.bg); // a dim page (IDLE_PAGES above) instead of a drifting dot
    const R = rng(s.id), r = n => R() * n | 0, pages = IDLE_PAGES[kind] ?? PAGE_ANY;
    PAGE[pages[r(pages.length)]]((u0, u1, y0, y1, c) => plane(s.a0 + u0 / 16, s.a0 + u1 / 16, s.z1 - y1, s.z1 - y0, c), r);
  }
  return { c, x: l, y: tp };
}

// ---------------------------------------------------------------- depth sorting
// what moves among a room's props, by depth: its people, the cab and the landing doors (in the core), the mascots
function roomMovers(f, lv, room) {
  const { S, L, cabLvl, cabTop } = f;
  const movers = (f.inRoom.get(room) || []).map(A => ({ A, d: A.plan[0]?.t === 'stairs' ? onSpiral(A) : A.x + A.y + (isSeated(A) ? 0 : 0.01) }));
  if (room.wing === 'core' || room.pent) {
    if (cabLvl === lv.i) movers.push({ cab: 1, d: 1.35 });
    else if (cabTop && cabLvl + 1 === lv.i) movers.push({ cab: 1, clip: lv.z, d: 1.35 });
    movers.push({ front: 1, d: SHAFT[1] * 2 - 0.05 });
  }
  if (lv.roof) for (const c of S.mascots) if (roomAt(L, lv.i, c.x, c.y) === room) movers.push({ pet: c, d: c.x + c.y });
  for (const fan of room.art.anchors.fans || []) movers.push({ fan, d: fan.d }); // just in front of its AC unit
  for (const v of S.vacs || []) if (v.room === room) movers.push({ dock: v, d: v.dock.x + v.dock.y - 0.01 }, { vac: v, d: v.x + v.y });
  return movers.sort((a, b) => a.d - b.d);
}
// someone on the spiral is drawn just after the tread they stand on: behind the treads in front of it
const onSpiral = A => treadDepth(A.tread ?? 0) + 0.002;
const CHUNK_PROPS = 12;
const DRAW_COST_PX = 2000; // what one more drawImage call costs, in pixels drawn
// Draws a room's props and movers back to front. A mover goes after every prop at or in front of its
// depth. Runs of props with no mover between them are drawn as one pre-merged picture.
function drawDepthSorted(g, art, movers, drawMover) {
  const props = art.props, chunks = art.chunks ??= chunkProps(props);
  const slots = movers.map(it => propsAtOrBefore(props, it.d));
  let m = 0;
  for (const chunk of chunks) {
    while (m < movers.length && slots[m] <= chunk.i0) drawMover(movers[m++]);
    if (m < movers.length && slots[m] < chunk.i1) {
      for (let i = chunk.i0; i < chunk.i1; i++) {
        while (m < movers.length && slots[m] <= i) drawMover(movers[m++]);
        g.drawImage(props[i].img, props[i].x, props[i].y);
      }
    } else g.drawImage(chunk.img, chunk.x, chunk.y);
  }
  while (m < movers.length) drawMover(movers[m++]);
}
// how many of the depth-ordered props have a depth of d or less
function propsAtOrBefore(props, d) {
  let lo = 0, hi = props.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (props[mid].depth <= d) lo = mid + 1; else hi = mid; }
  return lo;
}
// Consecutive props merged into chunks of up to CHUNK_PROPS. A chunk stops growing when drawing its box
// would cost more than drawing its props one by one.
function chunkProps(props) {
  const chunks = [];
  for (let i0 = 0; i0 < props.length;) {
    let box = propBox(props[i0]), area = box.w * box.h, i1 = i0 + 1;
    while (i1 < props.length && i1 - i0 < CHUNK_PROPS) {
      const grown = unionBox(box, propBox(props[i1])), grownArea = area + props[i1].img.width * props[i1].img.height;
      if (grown.w * grown.h > grownArea + DRAW_COST_PX * (i1 - i0)) break;
      box = grown; area = grownArea; i1++;
    }
    chunks.push({ i0, i1, ...mergeProps(props, i0, i1, box) });
    i0 = i1;
  }
  return chunks;
}
const propBox = p => ({ x: p.x, y: p.y, w: p.img.width, h: p.img.height });
function unionBox(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
function mergeProps(props, i0, i1, box) {
  if (i1 - i0 === 1) return { img: props[i0].img, x: props[i0].x, y: props[i0].y };
  const img = canvas(box.w, box.h), g = img.getContext('2d');
  for (let i = i0; i < i1; i++) g.drawImage(props[i].img, props[i].x - box.x, props[i].y - box.y);
  return { img, x: box.x, y: box.y };
}

// ---------------------------------------------------------------- people, the cab, the landing doors
function drawAgent(R, g, A, S, t, baseZ, outside, z = A.z) {
  const sx = Math.round(SX(A.x, A.y)), sy = Math.round(SY(A.x, A.y, baseZ + z));
  const seated = isSeated(A);
  let item = A.item, dy = 0;
  if (outside && S.weather.rain > 0.3 && !seated) item = 'umbrella';
  if (A.pose === 'water') item = '';
  if (S.party > 0 && A.state !== 'sleeping') dy = -Math.abs(Math.round(Math.sin(t * 8 + A.i) * 3));
  if (A.pose === 'queue') dy = (A.anim * 2 | 0) % 2 ? 0 : -1;
  if (!seated) ellipse(g, sx, sy, 4, 2, 'rgba(29,26,47,.22)');
  const img = spriteFrame(A.id, A.look, agentFrame(A, t, S.party > 0), A.front, A.right, seated && item !== 'paper' && !DRINKS[item] ? '' : item); // (a drink at the bar stays in hand)
  const x = sx - (CW >> 1), y = sy - FOOT + dy - (seated ? (A.sitH ?? SEAT_H) - SIT_ABOVE : 0);
  g.drawImage(img, x, y);
  if (A.water) wateringCan(g, A, sx, sy, baseZ, t);
  A.hit = { x0: x + 2, y0: y + 3, x1: x + CW - 2, y1: sy + 1, sx, sy: y + (seated ? 8 : 4), lvl: A.lvl };
  R.hits.push(A);
}
function agentFrame(A, t, party) {
  const pose = A.pose;
  if (pose === 'walk') return (A.anim * 7 | 0) % 2 ? 'walk1' : 'walk2';
  if (pose === 'type') return (A.anim * (5 + A.i % 3) | 0) % 2 ? 'type1' : 'type2';
  if (pose === 'sleep') return 'sleep';
  if (pose === 'water') return 'water';
  if (pose === 'sit') return A.front && (A.anim + A.i) % 4.1 < 0.14 ? 'blink' : 'sit';
  if (party && A.state !== 'sleeping') return (t * 4 + A.i | 0) % 2 ? 'walk1' : 'walk2';
  return A.front && (A.anim + A.i) % 3.7 < 0.14 ? 'blink' : 'stand';
}
// Watering: the can held out at arm's length towards the plant, tipped, with a stream of drops from
// the spout arcing down into the pot. Everything stays below shoulder height.
function wateringCan(g, A, sx, sy, baseZ, t) {
  const d = A.right ? 1 : -1, X = k => sx + d * k - (d < 0 ? 1 : 0), p = A.water;
  F(g, Math.min(X(5), X(7)), sy - 13, 3, 1, '#b8862e');                                  // handle, in the hand
  F(g, Math.min(X(5), X(8)), sy - 12, 4, 3, '#f2c14e'); F(g, Math.min(X(5), X(8)), sy - 10, 4, 1, '#d9a441'); // body
  F(g, X(9), sy - 11, 1, 1, '#d9a441'); F(g, X(10), sy - 10, 1, 1, '#d9a441'); F(g, X(11), sy - 10, 1, 2, '#fff3b0'); // spout and rose
  const ax = X(12), ay = sy - 9, bx = SX(p.px, p.py), by = SY(p.px, p.py, baseZ + p.pz) - 1;
  for (let i = 0; i < 5; i++) {
    const k = (t * 2.6 + i / 5) % 1, x = Math.round(ax + (bx - ax) * k), y = Math.round(ay + (by - ay) * k * k - Math.sin(k * Math.PI) * 2);
    F(g, x, y, 1, 1, i % 2 ? '#8fd3ff' : '#5b8def');
  }
  if ((t * 6 | 0) % 2) F(g, bx - 1, by, 3, 1, '#bfe6ff'); // the splash on the soil
}
const isSeated = A => A.pose === 'sit' || A.pose === 'type' || A.pose === 'sleep';
// The cab: its floor and lit back walls, the riders, then its steel side, doors and roof. While it stands at
// a floor, the walls and roof come from cached pictures. The doors are always drawn live: they are half
// see-through, and a cached copy would round their colours differently.
function drawCab(g, S, clipZ) {
  const lift = S.lift, z = lift.z, [x0, x1] = SHAFT, door = lift.door;
  const atRest = clipZ == null && Number.isInteger(z);
  if (clipZ != null) { // only what rises above the floor at clipZ: everything above the V of the cab's front edges
    const l = [SX(x0, x1), SY(x0, x1, clipZ)], m = [SX(x1, x1), SY(x1, x1, clipZ)], r = [SX(x1, x0), SY(x1, x0, clipZ)];
    g.save(); g.beginPath(); g.moveTo(l[0] - 2, l[1] - 400); g.lineTo(l[0] - 2, l[1]); g.lineTo(...m); g.lineTo(r[0] + 2, r[1]); g.lineTo(r[0] + 2, r[1] - 400); g.clip();
  }
  if (atRest) drawCabPart(g, 'back', z, g2 => cabBack(g2, 0));
  else cabBack(g, z);
  lift.riders.filter(A => A.ride?.phase === 'ride').sort((a, b) => a.x + a.y - b.x - b.y).forEach(A => {
    const sx = Math.round(SX(A.x, A.y)), sy = Math.round(SY(A.x, A.y, z));
    g.drawImage(spriteFrame(A.id, A.look, 'stand', true, false, A.item), sx - (CW >> 1), sy - FOOT);
    A.hit = { x0: sx - 5, y0: sy - 22, x1: sx + 5, y1: sy, sx, sy: sy - 20, lvl: Math.floor(z / FH) };
  });
  if (atRest) drawCabPart(g, 'side', z, g2 => cabSide(g2, 0));
  else cabSide(g, z);
  cabDoors(g, z, door);
  if (atRest) drawCabPart(g, 'roof', z, g2 => cabRoof(g2, 0));
  else cabRoof(g, z);
  if (clipZ != null) g.restore();
}
const cabParts = {};
function drawCabPart(g, name, z, draw) {
  const [s0, s1] = SHAFT, part = cabParts[name] ??= sprite(s0, s0, s1, s1, 0, CAB_H, draw);
  g.drawImage(part.img, part.x, part.y - z);
}
function cabBack(g, z) {
  const [x0, x1] = SHAFT;
  top(g, x0, x0, x1, x1, z, '#6d6a80');
  wallY(g, x0, x1, x0, z, z + 30, '#fff3b0'); wallX(g, x0, x1, x0, z, z + 30, '#ffe89a'); // lit back walls inside the cab
}
function cabSide(g, z) {
  const [x0, x1] = SHAFT;
  wallX(g, x0, x1, x1, z, z + 30, '#8b8fa3'); wallX(g, x0 + 0.2, x1 - 0.2, x1, z + 12, z + 26, '#ffe89a'); // steel side with a window
}
function cabDoors(g, z, open) {
  const [x0, x1] = SHAFT;
  g.globalAlpha = 0.85; wallY(g, x0, x0 + 0.55 * (1 - open) + 0.02, x1, z, z + 30, '#c9ccd8'); wallY(g, x1 - 0.55 * (1 - open) - 0.02, x1, x1, z, z + 30, '#c9ccd8'); g.globalAlpha = 1;
}
function cabRoof(g, z) {
  const [x0, x1] = SHAFT;
  box(g, x0, x0, z + 30, x1, x1, z + 33, '#565a70');
  wallX(g, x0, x1, x1, z, z + 1, '#ffd966'); wallY(g, x0, x1, x1, z + 32, z + 33, '#ffd966');
}
// The elevator's door frame on each landing, drawn in front of the cab: a steel header with the floor
// indicator (where the cab is, with an arrow while it moves) and the call button, lit while someone waits.
const liftSigns = new Map();
function drawLiftFront(g, room, S, L) {
  const lift = S.lift, [s0, s1] = SHAFT, z = room.z, at = L.level(lift.target == null ? lift.lvl : Math.round(lift.z / FH)) || room.lv;
  const dir = lift.target == null ? '' : lift.target > lift.lvl ? '↑' : '↓', key = levelName(at) + dir;
  let f = liftSigns.get(key); // the indicator, sheared onto the header once (at floor height 0) and cached
  if (!f) {
    const flat = canvas(14, 8), fg = flat.getContext('2d'); F(fg, 0, 0, 14, 8, INK); text(fg, levelName(at), dir ? 1 : 3, 1, '#ffd966'); if (dir) text(fg, dir, 9, 1, '#7bd389');
    const x = Math.floor(SX(0.26, s1 + 0.06)) - 1, y = Math.floor(SY(0.26, s1 + 0.06, CAB_H + 8)) - 1; f = { img: canvas(18, 18), x, y };
    const sg = f.img.getContext('2d'); sg.translate(-x, -y); onWallY(sg, flat, 0.26, s1 + 0.06, CAB_H); liftSigns.set(key, f);
  }
  // the frame is the same on every floor: drawn once per call-light state with its doors shut, and live
  // only while the doors here are open
  const open = lift.target == null && lift.lvl === room.level ? lift.door : 0, waiting = lift.calls.has(room.level);
  if (open > 0.01) liftFrame(g, z, open, waiting);
  else {
    const k = waiting ? 1 : 0;
    liftFrames[k] ??= sprite(s0 - 0.1, s0 - 0.1, s1 + 0.1, s1 + 0.1, 0, CAB_H + 10, g2 => liftFrame(g2, 0, 0, waiting));
    g.drawImage(liftFrames[k].img, liftFrames[k].x, liftFrames[k].y - z);
  }
  g.drawImage(f.img, f.x, f.y - z);
}
const liftFrames = [];
// glass landing doors with a steel frame and a centre seam (they part only when the cab is here), the
// header above them and the call button beside them
function liftFrame(g, z, open, waiting) {
  const [s0, s1] = SHAFT, half = (s1 - s0) / 2, w = half * (1 - open) + 0.03, Y = s1 + 0.04;
  g.globalAlpha = 0.28; wallY(g, s0, s0 + w, Y, z, z + CAB_H, '#bfe6ff'); wallY(g, s1 - w, s1, Y, z, z + CAB_H, '#bfe6ff'); g.globalAlpha = 1;
  for (const [a, b] of [[s0 + w - 0.03, s0 + w], [s1 - w, s1 - w + 0.03]]) wallY(g, a, b, Y, z, z + CAB_H, '#8b8fa3');
  wallY(g, s0 - 0.05, s1 + 0.05, s1 + 0.05, z + CAB_H, z + CAB_H + 9, '#565a70'); wallX(g, s0 - 0.05, s1 + 0.05, s1 + 0.05, z + CAB_H, z + CAB_H + 9, '#4d5270');
  wallY(g, s0 - 0.05, s1 + 0.05, s1 + 0.05, z + CAB_H + 8, z + CAB_H + 9, '#8b8fa3');
  wallY(g, s1 - 0.12, s1 - 0.04, s1 + 0.06, z + 13, z + 19, '#3b3355');
  wallY(g, s1 - 0.11, s1 - 0.05, s1 + 0.06, z + 14, z + 18, waiting ? '#ffd966' : '#6d6a80');
}
// the robot vacuum: a flat dark disc with a lighter lid, a bumper, a light (blue cleaning, green charging, blinking
// when full) and a side brush that spins while it works; and its dock, a little wedge against the pallets
function drawVac(g, v, t, z) {
  const sx = Math.round(SX(v.x, v.y)), sy = Math.round(SY(v.x, v.y, z)), on = v.mode !== 'charge' && v.pause <= 0;
  ellipse(g, sx, sy + 1, 6, 3, 'rgba(29,26,47,.25)');
  ellipse(g, sx, sy, 6, 3, '#2b2740'); ellipse(g, sx, sy - 2, 6, 3, '#565a70'); ellipse(g, sx, sy - 2, 4, 2, '#6d6a80');
  F(g, sx - 1, sy - 3, 2, 1, '#8b8fa3');
  const fx = Math.cos(v.h), fy = Math.sin(v.h), bx = Math.round(16 * (fx - fy) / Math.hypot(16 * (fx - fy), 8 * (fx + fy) || 1) * 5), by = Math.round(8 * (fx + fy) / Math.hypot(16 * (fx - fy), 8 * (fx + fy) || 1) * 2.5);
  F(g, sx + bx - 1, sy - 2 + by, 2, 1, '#1d1a2f'); // the bumper, facing where it's going
  const lit = v.mode === 'charge' ? ((t * 1.5 | 0) % 2 ? '#7bd389' : '#3f9b5c') : '#8fd3ff';
  F(g, sx + 2, sy - 3, 1, 1, lit);
  if (on) { const k = (t * 14 | 0) % 4, br = [[1, 0], [1, 1], [0, 1], [-1, 1]][k]; F(g, sx + bx + br[0] * 2, sy + by + br[1], 1, 1, '#c9ccd8'); F(g, sx + bx - br[0] * 2, sy + by - br[1], 1, 1, '#c9ccd8'); }
}
// (in the room's own axes: a along its length, d out from the pallets, so it sits in perspective either way the room runs)
function drawVacDock(g, v, t, z) {
  const { x, y } = v.dock, at = (a, d) => v.X ? [x + a, y + d] : [x + d, y + a];
  const block = (a0, a1, d0, d1, z0, z1, c) => { const [p0, q0] = at(a0, d0), [p1, q1] = at(a1, d1); box(g, Math.min(p0, p1), Math.min(q0, q1), z + z0, Math.max(p0, p1), Math.max(q0, q1), z + z1, c); };
  block(-0.18, 0.18, -0.06, 0.1, 0, 1, '#2b2740'); // the plate it rolls onto
  block(-0.18, 0.18, -0.13, -0.05, 0, 7, ['#565a70', '#3b3355', '#2b2740']); // the upright with its contacts
  const [lx, ly] = at(0, -0.05);
  F(g, Math.round(SX(lx, ly)), Math.round(SY(lx, ly, z + 5)), 1, 1, v.mode === 'charge' ? '#7bd389' : '#565a70');
}

// ---------------------------------------------------------------- the island and outdoors
// The island's ground and soil, its curbside labels (hidden behind a closed façade), the data on the fibre,
// the soil over the basement while the walls are on, and wet or snowy ground.
function drawIsland(f) {
  const { R, S, L, g, t, blit, facade, walls, wx } = f, island = S.island, off = islandOffset(f.intro);
  g.translate(0, -off);
  blit(island.land.c, island.land.x, island.land.y);
  if (walls && walls(0) === 0) drawLot(g, L);
  const labels = walls ? walls(0) : 1;
  if (labels > 0) { g.globalAlpha = labels; blit(island.labels.c, island.labels.x, island.labels.y); g.globalAlpha = 1; }
  for (const fiber of island.fiber || []) fiberPulses(g, fiber, t);
  if (walls) drawPlug(g, facade, 1 - walls(-1), blit);
  if (wx.cover > 0.02 || wx.wet > 0.02) groundFx(g, S, L, t, blit);
  g.translate(0, off);
}
// data on the fibre in the ground: a few soft pulses sliding from the server room to the park end
function fiberPulses(g, f, t) {
  const seg = f.pts.slice(1).map((q, k) => { const p = f.pts[k]; return { p, q, len: Math.hypot(q.x - p.x, q.y - p.y) + Math.abs(q.z - p.z) / 16 }; }), total = seg.reduce((s, e) => s + e.len, 0);
  const at = d => { for (const e of seg) { if (d <= e.len) { const k = d / e.len; return [e.p.x + (e.q.x - e.p.x) * k, e.p.y + (e.q.y - e.p.y) * k, e.p.z + (e.q.z - e.p.z) * k]; } d -= e.len; } return null; };
  for (let i = 0; i < 3; i++) {
    const d = ((t * 0.9 + i * total / 3 + (f.c === '#5b8def' ? 1.3 : 0)) % total);
    for (let j = 0; j < 3; j++) { const p = at(d - j * 0.06); if (p) { g.globalAlpha = 0.9 - j * 0.3; F(g, Math.round(SX(p[0], p[1])), Math.round(SY(p[0], p[1], p[2])), 1, 1, '#fffaf0'); } }
  }
  g.globalAlpha = 1;
}
// wet sheen, puddles and snow cover on everything outdoors (drawn once onto the building's island)
function groundFx(g, S, L, t, blit) {
  const wx = S.weather, isl = S.island;
  if (!isl.snowTops) { isl.snowTops = silhouette(isl.tops, '#f4f6ff'); isl.wetTops = silhouette(isl.tops, '#3b4a7a'); }
  if (wx.wet > 0.02) { g.globalAlpha = wx.wet * 0.22; blit(isl.wetTops, L.bounds.x0, L.bounds.y0); g.globalAlpha = 1; }
  if (wx.cover > 0.02) { g.globalAlpha = wx.cover * 0.85; blit(isl.snowTops, L.bounds.x0, L.bounds.y0); g.globalAlpha = 1; }
  if (wx.wet > 0.1 && wx.cover < 0.3) {
    isl.puddles ??= (() => { const r = rng('puddles'), out = []; for (let i = 0; i < 16; i++) { const k = r(), p = k < 0.5 ? { x: CORE + 1 + r() * (L.Lx - 1), y: CORE + 0.2 + r() * 0.6 } : k < 0.75 ? isl.E(r() * isl.streetLen, 0.6 + r() * 2.2) : { x: CORE + 0.2 + r() * 0.6, y: CORE + 1 + r() * (L.Ly - 1) }; out.push({ ...p, rx: 3 + (r() * 6 | 0), ry: 1 + (r() * 2 | 0) }); } return out; })();
    const [skyTop] = skyAt(S.hour, 0.6);
    for (const p of isl.puddles) {
      const sx = Math.round(SX(p.x, p.y)), sy = Math.round(SY(p.x, p.y)), k = Math.min(1, wx.wet * 1.4);
      const rx = Math.max(1, Math.round(p.rx * k)), ry = Math.max(1, Math.round(p.ry * k + 0.4));
      g.globalAlpha = 0.75; ellipse(g, sx, sy, rx, ry, mix(skyTop, '#8a94c0', 0.35)); g.globalAlpha = 1;
      F(g, sx - rx + 2, sy - ry + 1, Math.max(1, rx - 2), 1, 'rgba(255,255,255,.45)');
      if (wx.rain > 0.3 && Math.sin(t * 5 + p.x * 17) > 0.8) { g.globalAlpha = 0.6; F(g, sx - 2, sy, 1, 1, '#fff'); F(g, sx + 2, sy, 1, 1, '#fff'); F(g, sx, sy - 1, 1, 1, '#fff'); g.globalAlpha = 1; }
    }
  }
}
// the façade lifting off or coming back down, over everything it covers, and the promo screen on it
function drawFacadeLift(f) {
  const { g, t, facade, walls, intro } = f;
  for (const lv of f.L.levels) {
    const k = lv.i >= 0 ? walls(lv.i) : 1;
    if (k <= 0 || k >= 1) continue;
    const off = intro ? intro(lv.i) : 0;
    g.translate(0, -off); drawLift(g, facade, lv.i, k, f.blit); g.translate(0, off);
  }
  if (facade.screen) drawScreen(g, facade, walls(facade.screen.i), intro ? intro(facade.screen.i) : 0, t, f.dark, f.h);
}
// Outdoors, depth-sorted: trees, lamps and the island's other props, people outside, the van, pigeons,
// falling leaves, the townsfolk and their cars, the ducks, and the parcels hopping into the van.
function drawOutdoors(f) {
  const { R, S, L, g, t, dark, wx } = f, island = S.island, van = S.van, off = islandOffset(f.intro);
  g.translate(0, -off);
  const items = [...island.props.map(p => ({ p, d: p.depth })), ...f.outside.map(A => ({ A, d: A.x + A.y + 0.01 }))];
  if (van.state !== 'away') {
    const at = island.streetAxis === 'x' ? { x: L.X1 + 0.12 + van.u, y: 1.15 } : { x: 1.15, y: L.Y1 + 0.12 + van.u };
    items.push({ van: at, d: at.x + at.y + 1.3 });
  }
  for (const p of S.pigeons) if (!p.gone) items.push({ pig: p, d: p.x + p.y });
  for (const p of S.parts) if (p.k === 'leaf') items.push({ leaf: p, d: p.x + p.y });
  if (van.state === 'parked') for (const p of S.parts) if (p.k === 'parcel') items.push({ parcel: p, d: 0 }), items.at(-1).d = parcelAt(L, island, p).d;
  items.push(...townItems(S.town, island));
  for (const d of island.ducks) items.push(duckOnPond(island.pond, d, t));
  items.sort((a, b) => a.d - b.d);
  const sway = 0.6 + wx.wind * 1.2;
  for (const it of items) {
    if (it.p) drawIslandProp(f, it.p, sway);
    else if (it.A) drawAgent(R, g, it.A, S, t, 0, true);
    else if (it.van) drawVan(R, g, island, van, it.van, t, dark);
    else if (it.town) drawTownsfolk(g, it.town, t, dark);
    else if (it.car) drawCar(g, it, island.streetAxis, dark);
    else if (it.pig) pigeon(g, it.pig, t);
    else if (it.leaf) leaf(g, it.leaf, t);
    else if (it.duck) duck(g, it.duck, t);
    else if (it.parcel) parcel(g, L, island, it.parcel);
  }
  g.translate(0, off);
}
// a duck swims round the pond at its own radius and speed
function duckOnPond(pond, d, t) {
  const a = d.a + t * d.s * 0.4;
  return { duck: { x: pond.sx + Math.cos(a) * pond.rx * d.r, y: pond.sy + Math.sin(a) * pond.ry * d.r, dir: -Math.sin(a) > 0, d }, d: pond.x + pond.y + Math.sin(a) * d.r * 0.5 };
}
function drawIslandProp(f, p, sway) {
  const { g, t, wx } = f;
  if (!f.visible(p.x, p.y - 40, p.img.width, p.img.height + 40)) return;
  g.drawImage(p.img, p.x, p.y);
  if (!p.canopy) return;
  const dx = Math.round(Math.sin(t * 1.3 + p.phase) * sway);
  g.drawImage(p.canopy, p.cx + dx, p.cy);
  if (wx.cover > 0.2) { g.globalAlpha = wx.cover; g.drawImage(p.snow ??= snowCap(p.canopy), p.cx + dx, p.cy); g.globalAlpha = 1; }
}
// snow resting on a tree: a white rim along the top edge of its canopy, a little deeper where it's flatter
function snowCap(canopy) {
  const w = canopy.width, h = canopy.height, px = canopy.getContext('2d').getImageData(0, 0, w, h).data, cap = canvas(w, h), g = cap.getContext('2d'), tops = [];
  for (let x = 0; x < w; x++) { let y = 0; while (y < h && px[(y * w + x) * 4 + 3] < 128) y++; tops.push(y); }
  g.fillStyle = '#ffffff';
  tops.forEach((y, x) => { if (y >= h) return; const flat = Math.abs((tops[x - 1] ?? y) - y) + Math.abs((tops[x + 1] ?? y) - y) < 2; g.fillRect(x, y, 1, flat ? 2 : 1); });
  return cap;
}
// the delivery van: it bounces while it drives, and fades out at the far end of the street
function drawVan(R, g, island, van, at, t, dark) {
  const s = vanSprite(island.streetAxis, van.state === 'parked', dark > 0.4), ox = SX(at.x, at.y), oy = SY(at.x, at.y);
  const beyond = Math.max(0, van.u - island.streetLen + 1.9), bounce = van.state === 'parked' ? 0 : (t * 8 | 0) % 2;
  g.globalAlpha = clamp(1 - beyond / 1.5, 0, 1); g.drawImage(s.img, Math.round(ox + s.x), Math.round(oy + s.y - bounce)); g.globalAlpha = 1;
  R.van = { sx: ox, sy: oy - 12 };
}
function pigeon(g, p, t) {
  const sx = Math.round(SX(p.x, p.y)), sy = Math.round(SY(p.x, p.y, p.z));
  if (p.fly) { const up = (t * 12 | 0) % 2; F(g, sx - 1, sy - 3, 3, 2, '#8b8fa3'); F(g, sx - 4, sy - 4 - up, 3, 1, '#8b8fa3'); F(g, sx + 2, sy - 4 - up, 3, 1, '#8b8fa3'); return; }
  const f = p.dir, peck = p.peck && (t * 3 | 0) % 2;
  F(g, sx - 2, sy - 3, 4, 2, '#8b8fa3'); F(g, sx + (f > 0 ? 1 : -2), sy - (peck ? 2 : 5), 2, 2, '#6d6a80'); F(g, sx + (f > 0 ? 3 : -3), sy - (peck ? 1 : 4), 1, 1, '#f2c14e'); F(g, sx - 1, sy - 1, 1, 1, '#e8505b'); F(g, sx + 1, sy - 1, 1, 1, '#e8505b');
}
// a falling leaf flutters (one pixel or two wide) until it lands
function leaf(g, p, t) {
  g.globalAlpha = Math.min(1, p.life);
  F(g, Math.round(SX(p.x, p.y)), Math.round(SY(p.x, p.y, p.z)), p.z > 0 ? (t * 4 + p.life | 0) % 2 + 1 : 2, 1, p.c);
  g.globalAlpha = 1;
}
function duck(g, d, t) {
  const x = Math.round(d.x), y = Math.round(d.y + Math.sin(t * 2 + d.d.a)), f = d.dir;
  F(g, x - 3, y - 2, 6, 2, '#fffaf0'); F(g, x + (f ? 1 : -3), y - 5, 2, 3, '#fffaf0'); F(g, x + (f ? 3 : -4), y - 4, 1, 1, '#f2a65a'); F(g, x + (f ? 2 : -2), y - 5, 1, 1, INK);
  F(g, x - 4, y, 8, 1, 'rgba(255,255,255,.35)');
  d.d.hit = { sx: x, sy: y - 3 };
}
// a parcel hopping from the dock along the van's near side into its open back (in front of the van, so drawn after it)
function parcelAt(L, island, p) {
  const X = island.streetAxis === 'x', k = clamp(p.t / 1.1, 0, 1), u = lerp(-0.25, 0.14, k), x = X ? L.X1 + u : 2.12, y = X ? 2.12 : L.Y1 + u;
  return { x, y, z: 6 + k * 4 + Math.sin(k * Math.PI) * 8, k, d: x + y + 1 };
}
function parcel(g, L, island, p) {
  const { x, y, z, k } = parcelAt(L, island, p), sx = Math.round(SX(x, y)), sy = Math.round(SY(x, y, z));
  if (k >= 1) return;
  F(g, sx - 2, sy - 3, 5, 4, '#cf9460'); F(g, sx, sy - 3, 1, 4, '#f6e7c1');
}
// Particles: screen-anchored ones (confetti, hearts, labels), and ones in the world (steam, sparks, twinkles,
// notes) on their level. Parcels and leaves are drawn outdoors.
function drawParticles(f) {
  const { L, g, intro } = f;
  for (const p of f.S.parts) {
    if (p.k === 'parcel' || p.k === 'leaf') continue;
    if (p.sx != null) {
      if (p.k === 'confetti') F(g, p.sx | 0, p.sy | 0, 1 + ((p.life * 3 | 0) % 2), 1, p.c);
      else if (p.k === 'heart') heart(g, p.sx | 0, p.sy | 0);
      else if (p.k === 'text') text(g, p.s, p.sx | 0, p.sy | 0, p.c || '#e8505b');
      continue;
    }
    const lvz = (L.level(p.lvl)?.z ?? 0) - (intro ? intro(p.lvl) : 0), sx = Math.round(SX(p.x, p.y)), sy = Math.round(SY(p.x, p.y, lvz + p.z));
    if (p.k === 'steam') { g.globalAlpha = Math.min(1, p.life) * 0.7; F(g, sx + Math.round(Math.sin(p.life * 5 + p.x * 9)), sy, 1, 2, '#fffaf0'); g.globalAlpha = 1; }
    else if (p.k === 'spark') F(g, sx, sy, 1, 1, p.life > 0.25 ? '#fff3b0' : '#ffb35a');
    else if (p.k === 'twinkle') { if ((p.life * 10 | 0) % 3) { F(g, sx, sy - 1, 1, 3, '#fffaf0'); F(g, sx - 1, sy, 3, 1, '#fffaf0'); F(g, sx, sy, 1, 1, '#b8f0c8'); } }
    else if (p.k === 'note') { g.globalAlpha = Math.min(1, p.life); F(g, sx, sy, 2, 2, '#9b72cf'); F(g, sx + 1, sy - 4, 1, 4, '#9b72cf'); F(g, sx + 2, sy - 4, 2, 1, '#9b72cf'); g.globalAlpha = 1; }
  }
}
const heart = (g, x, y) => { F(g, x, y, 2, 1, '#ff5c8a'); F(g, x + 3, y, 2, 1, '#ff5c8a'); F(g, x - 1, y + 1, 7, 2, '#ff5c8a'); F(g, x, y + 3, 5, 1, '#ff5c8a'); F(g, x + 1, y + 4, 3, 1, '#ff5c8a'); F(g, x + 2, y + 5, 1, 1, '#ff5c8a'); };
// birds crossing the sky in a V, flapping
function drawFlocks(g, S) {
  for (const flock of S.flocks) for (let i = 0; i < flock.n; i++) {
    const side = i % 2, row = i >> 1, up = (flock.t * 6 + i | 0) % 2;
    const x = Math.round(flock.x - flock.dir * row * 7 - flock.dir * side * 4), y = Math.round(flock.y + row * 4 * (side ? 1 : -1) + Math.sin(flock.t * 2 + i) * 2);
    F(g, x, y, 1, 1, '#3b3355'); F(g, x - 2, y - up, 2, 1, '#3b3355'); F(g, x + 1, y - up, 2, 1, '#3b3355');
  }
}

// ---------------------------------------------------------------- light
function lighting(R, g, S, L, t, dark, bx0, by0, intro, W) {
  const wx = S.weather, rect = R.rect;
  const gloom = dark * 0.62 + Math.max(wx.rain, wx.snow) * 0.12 * (1 - dark);
  const lamps = S.island.lamps, lampOn = dark > 0.25 || wx.rain > 0.5;
  if (gloom > 0.02 && rect[2] > 0 && rect[3] > 0) {
    const shade = nightShade(R, S, L, dark, gloom, lampOn, intro, W);
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-atop';
    g.drawImage(shade.c, rect[0] + bx0 - shade.x, rect[1] + by0 - shade.y, rect[2], rect[3], ...rect);
    g.restore();
  }
  // additive glows
  g.save(); g.globalCompositeOperation = 'lighter';
  const night = dark, glows = roomGlows(R, S, L, t, night, intro, W);
  if (intro) drawGlows(R, g, L, [...glows.steady, ...glows.bulbs]);
  else {
    const layer = steadyGlowLayer(R, L, glows.steady);
    if (layer) g.drawImage(layer.c, layer.x, layer.y);
    drawGlows(R, g, L, glows.bulbs);
  }
  if (night > 0.1) for (const b of S.island.bulbs || []) { const sx = SX(b.x, b.y), sy = SY(b.x, b.y, b.z) - islandOffset(intro), on = Math.sin(t * 1.5 + b.x * 2 + b.y) > -0.7; putGlow(R, g, '#806020', sx, sy, 5, 4, night * (on ? 1 : 0.45)); F(g, sx, sy, 1, 1, '#fff3b0'); }
  // lamplight spilling out of a closed façade's windows, and its lanterns
  const beat = (t * 4 | 0), partyColour = room => ['#802050', '#205080', '#807020', '#207040'][(beat + room.x0 + room.y0) % 4];
  if (W && (night > 0.1 || S.party > 0)) for (const lv of L.levels) if (lv.i >= 0 && W(lv.i) < 1) {
    const off = intro ? intro(lv.i) : 0; if (off > 400) continue;
    g.translate(0, -off);
    if (night > 0.1) facadeGlows(g, R.facade, lv.i, night, (c, x, y, rx, ry, a) => putGlow(R, g, c, x, y, rx, ry, a), W(lv.i));
    if (S.party > 0) partyGlass(g, R.facade, lv.i, k => ['#ff2d8a', '#3a6bff', '#ffc400', '#1fd760'][(beat + k) % 4], W(lv.i));
    g.translate(0, off);
  }
  if (lampOn) {
    const off = islandOffset(intro), wall = W ? 1 - revealed(W(0)) : 0;
    g.save(); groundClip(g, L, off); for (const l of lamps) { const [gx, gy] = lampPool(l); putGlow(R, g, '#705018', SX(gx, gy), SY(gx, gy) - off, 20, 10, 0.55); } g.restore();
    for (const l of lamps) putGlow(R, g, '#806020', SX(l.x, l.y), SY(l.x, l.y) - off - 31, 6, 5, 1);
    if (wall > 0) for (const l of lamps) { const w = lampWall(L, l); if (w) putGlow(R, g, '#604818', SX(...w), SY(w[0], w[1], 22) - off, 12, 16, 0.4 * wall); } // (on the façade behind it)
  }
  // a candle flickering inside each jack-o'-lantern, after dark
  if (night > 0.15) for (const p of S.island.pumpkins) { const sx = SX(p.x, p.y), sy = SY(p.x, p.y, p.z) - islandOffset(intro), flick = 0.7 + 0.3 * Math.sin(t * 9 + p.x * 13) + (Math.sin(t * 23 + p.y * 7) > 0.85 ? -0.3 : 0); putGlow(R, g, '#ff8a3d', sx, sy, 9, 6, night * Math.max(0.35, flick)); }
  const soff = intro ? intro(L.nUp) : 0;
  if (R.sign && night > 0.2 && soff < 400) { g.globalAlpha = night * (0.85 + Math.sin(t * 9) * 0.05 + (Math.sin(t * 0.7) > 0.98 ? -0.4 : 0)); g.drawImage(R.sign.glow.img, R.sign.glow.x, R.sign.glow.y - soff); g.globalAlpha = 1; }
  if (S.van.state !== 'away' && night > 0.3 && R.van) putGlow(R, g, '#806030', R.van.sx + 40, R.van.sy + 22 - islandOffset(intro), 30, 12, night * 0.7);
  if (S.party > 0) for (const room of L.rooms) { // coloured light in every room you can see into (with the walls on: through the windows, above)
    if (room.kind === 'terrace' || room.dark || (room.level < 0 && room.wing === 'core') || (W && (room.level < 0 ? W(-1) < 1 : W(room.level) === 0))) continue;
    const m = room.art.anchors.lights[0]; if (!m) continue;
    const c = partyColour(room), off = intro ? intro(room.level) : 0;
    g.save(); roomClip(g, room, off); putGlow(R, g, c, SX(m.x, m.y), SY(m.x, m.y, m.z) - off, 60, 30, 0.8); g.restore();
  }
  g.restore();
}
// The night shade: gloom everywhere, but for the light coming out of the rooms, the lamps and the sign.
// Drawn 'source-atop' over the frame. Redrawn only when something it shows changes, and every frame of the intro.
function nightShade(R, S, L, dark, gloom, lampOn, intro, W) {
  const key = `${gloom.toFixed(2)},${lampOn},${W ? L.levels.map(l => W(l.i)).join() : ''},${R.facade?.key || ''},${L.rooms.map(r => r.dark ? 1 : 0).join('')}`;
  if (!intro && key === R.shadeKey && R.shade?.L === L) return R.shade;
  const area = lightArea(L, intro), lm = R.lm, lg = R.lg, lamps = S.island.lamps;
  R.shadeKey = intro ? null : key; R.shade = { c: lm, x: area.x, y: area.y, L };
  if (lm.width !== area.w || lm.height !== area.h) { lm.width = area.w; lm.height = area.h; }
  lg.setTransform(1, 0, 0, 1, 0, 0); lg.globalCompositeOperation = 'source-over'; lg.globalAlpha = 1; lg.clearRect(0, 0, area.w, area.h);
  lg.fillStyle = `rgba(13,11,40,${gloom})`; lg.fillRect(0, 0, area.w, area.h);
  lg.setTransform(1, 0, 0, 1, -area.x, -area.y); lg.globalCompositeOperation = 'destination-out';
  // rooms let their light out where they show. The island is solid, so after the basement rooms its
  // soil (and the ground on top) goes back to the plain night gloom, then the floors above are lit. A dark room is solid
  // too: in the order they're drawn, it puts the gloom back over any light behind it
  const litRooms = under => { for (const lv of L.levels) for (const room of lv.rooms) {
    if (room.kind === 'terrace' || (room.level < 0) !== under || R.shut(room.level)) continue;
    (room.dark ? darkRoom : lightRoom)(room, intro ? intro(room.level) : 0);
  } };
  const lit = []; // (the boxes lit so far)
  // a room's light, and its openings' view down to a shut floor below (indoors too)
  const lightRoom = (room, off) => {
    const a = room.art;
    lg.globalAlpha = room.lit ?? 0.9; lg.drawImage(a.c, a.cx, a.cy - off); lit.push([a.cx, a.cy - off, a.c.width, a.c.height]);
    if (a.plug && R.shut(room.level - 1)) lg.drawImage(a.plug.img, a.plug.x, a.plug.y - off);
  };
  const gloomOver = (img, x, y) => {
    lg.globalCompositeOperation = 'destination-out'; lg.globalAlpha = 1; lg.drawImage(img, x, y);
    lg.globalCompositeOperation = 'source-over'; lg.globalAlpha = gloom; lg.drawImage(img, x, y);
    lg.globalCompositeOperation = 'destination-out';
  };
  const darkRoom = (room, off) => {
    const a = room.art;
    a.night ??= silhouette(a.c, '#0d0b28');
    gloomOver(a.night, a.cx, a.cy - off);
  };
  litRooms(true);
  const land = S.island.land, ioff = islandOffset(intro);
  S.island.landShade ??= silhouette(land.c, '#0d0b28');
  gloomOver(S.island.landShade, land.x, land.y - ioff);
  if (W) { lg.translate(0, -ioff); lightPlug(lg, R.facade, 1 - W(-1), gloom); lg.translate(0, ioff); }
  litRooms(false);
  // the island's props are drawn over any room behind them (drawOutdoors comes
  // after the levels), so where a room's light shows through them they go back to the plain night gloom (the bike's flowers).
  // 'lighter' after the cut blends the two exactly, so a soft shadow's edge keeps its share of the room's light
  for (const p of S.island.props) {
    const y = p.y - ioff;
    if (!lit.some(([x0, y0, w, h]) => p.x < x0 + w && x0 < p.x + p.img.width && y < y0 + h && y0 < y + p.img.height)) continue;
    p.night ??= silhouette(p.img, '#0d0b28');
    lg.globalAlpha = 1; lg.drawImage(p.night, p.x, y);
    lg.globalCompositeOperation = 'lighter'; lg.globalAlpha = gloom; lg.drawImage(p.night, p.x, y);
    lg.globalCompositeOperation = 'destination-out';
  }
  // the roof terraces are outdoors: plain night gloom over them, whatever lit room lies behind, then the string lights.
  // The penthouse's glass end wall, drawn with the terrace beside it, is lit from inside where it shows (art.glass)
  const terraces = () => { for (const room of L.rooms) if (room.kind === 'terrace') {
    const a = room.art, off = intro ? intro(room.level) : 0;
    a.night ??= silhouette(a.c, '#0d0b28');
    gloomOver(a.night, a.cx, a.cy - off);
    if (a.glass && L.pent && !L.pent.dark) { lg.globalAlpha = L.pent.lit ?? 0.9; lg.drawImage(a.glass, a.bx, a.by - off); }
  } };
  terraces();
  // a closed façade is outdoors: gloomy, but for its lit windows and lanterns
  if (W) for (const lv of L.levels) if (lv.i >= 0 && W(lv.i) < 1) { const off = intro ? intro(lv.i) : 0; lg.translate(0, -off); lightClosed(lg, R.facade, lv.i, gloom, (x, y, rx, ry, a) => putGlow(R, lg, '#000', x, y, rx, ry, a), W(lv.i)); lg.translate(0, off); }
  // the penthouse under its roof still shows its light through the glass: its room again, then the roof's gloom over it
  if (R.lidded && L.pent && !L.pent.dark) {
    const off = intro ? intro(L.pent.level) : 0, V = R.facade.levels[L.nUp];
    lg.globalCompositeOperation = 'destination-out'; lightRoom(L.pent, off);
    terraces(); // (the jacuzzi's rim by the glass stays outdoors too)
    for (const s of V ? [V, V.lid].filter(Boolean) : []) { // the parapet in front and the roof above stay outdoors
      gloomOver(s.shade, s.x, s.y - off);
    }
    lg.globalCompositeOperation = 'destination-out'; lg.globalAlpha = 1;
  }
  if (lampOn) {
    lg.save(); groundClip(lg, L, ioff); for (const l of lamps) { const [gx, gy] = lampPool(l); putGlow(R, lg, '#000', SX(gx, gy), SY(gx, gy) - ioff, 24, 11, 0.85); } lg.restore();
    for (const l of lamps) putGlow(R, lg, '#000', SX(l.x, l.y), SY(l.x, l.y) - ioff - 30, 8, 8, 1);
    const wall = W ? 1 - revealed(W(0)) : 0; // (and the façade behind each lamp, while it's there)
    if (wall > 0) for (const l of lamps) { const w = lampWall(L, l); if (w) putGlow(R, lg, '#000', SX(...w), SY(w[0], w[1], 22) - ioff, 14, 18, 0.55 * wall); }
  }
  for (const room of L.rooms) if (room.lv.roof) { const off = intro ? intro(room.level) : 0; for (const b of room.art.anchors.bulbs || []) if (!b.hid) putGlow(R, lg, '#000', SX(b.x, b.y), SY(b.x, b.y, b.z) - off, 10, 6, dark * 0.8); }
  const soff = intro ? intro(L.nUp) : 0; // the rooftop sign arrives with the roof
  if (R.sign && soff < 400) { const L2 = R.sign.glow.lit; lg.globalAlpha = 0.85; lg.drawImage(L2.img, L2.x, L2.y - soff); }
  lg.globalAlpha = 1; lg.globalCompositeOperation = 'source-over';
  return R.shade;
}
// The island's box in world pixels, with room round it. The night shade and the rooms' steady glow are
// drawn here in world space, so a moving camera doesn't redraw them. During the intro it reaches as far as the floors
// drop from and the island rises from (scene.js introOffset): a floor still in the air is night too.
const INTRO_UP = 330, INTRO_DOWN = 250;
function lightArea(L, intro) {
  const B = L.bounds, x = B.x0 - 60, y = B.y0 - 80 - (intro ? INTRO_UP : 0);
  return { x, y, w: B.x1 + 60 - x, h: B.y1 + 40 + (intro ? INTRO_DOWN : 0) - y };
}
// Every lit room's glow as a list of draws { clip, off, c, x, y, rx, ry, a, dot }. clip keeps a glow inside its
// room ({ room }), or inside the basement rooms' openings in the soil ({ under, off }). A terrace has none.
// Bulbs flicker, so they go in a list of their own. The steady list is cached (see steadyGlowLayer).
function roomGlows(R, S, L, t, night, intro, W) {
  const steady = [], bulbs = [], a0 = 0.08 + night * 0.3;
  const add = (room, clip) => {
    const off = intro ? intro(room.level) : 0, an = room.art.anchors;
    // (while its level's façade lifts off or comes down, a room's light shows only as much as the room does: never over the brick)
    const seen = W && room.level >= 0 && room.level < L.nUp ? revealed(W(room.level)) : 1;
    const put = (list, c, x, y, rx, ry, a, dot) => seen > 0 && list.push({ clip, off, c, x, y, rx, ry, a: a * seen, dot });
    // the darkroom's light is red while its safelight is on
    const safe = an.studio && S.studio?.editing;
    for (const l of an.lights) put(steady, room.kind === 'server' ? '#3a6aa0' : safe ? '#6a1420' : '#6a4a1a', SX(l.x, l.y), SY(l.x, l.y, l.z), 34, 17, a0);
    if (night <= 0.1) return;
    for (const s of an.screens) { const A = S.people.get(s.id); if (A && A.state !== 'sleeping') put(steady, A.state === 'working' ? SCREEN_GLOW[A.data.engine] || SCREEN_GLOW.claude : '#1a3a7a', SX(s.x, s.y), SY(s.x, s.y, s.z0 + 8), 16, 12, night * (A.state === 'idle' ? 0.35 : 0.9)); } // an idle screen glows dimly
    for (const gl of an.glows) put(steady, GLOW[gl.c] ?? '#1a4a6a', SX(gl.x, gl.y), SY(gl.x, gl.y, gl.z), gl.r, gl.r * 0.7, night);
    for (const b of an.bulbs || []) { if (b.hid) continue; const on = Math.sin(t * 2 + b.x * 3) > -0.8; put(bulbs, '#806020', SX(b.x, b.y), SY(b.x, b.y, b.z), 5, 4, night * (on ? 1 : 0.4), true); }
    if (an.jacuzzi) { const j = an.jacuzzi; put(steady, '#1a5a7a', SX(j.x, j.y), SY(j.x, j.y, j.z), 16, 8, night * 0.8); } // (on the water only)
    if (safe) put(steady, '#8a1424', ...safelightGlow(an.studio), 18, 9, night * 0.9); // the safelight
    if (an.onair && S.onAir) { const s = an.onair.glow; put(steady, '#7a1f2a', SX(s.x, s.y), SY(s.x, s.y, s.z), 26, 14, night * 0.7); } // the booth's sign, on air
    if (an.rig && S.machine?.running) put(steady, an.rig.glow, SX(an.rig.x, an.rig.y), SY(an.rig.x, an.rig.y, an.rig.z), 11, 8, night * 0.8);   // the rig at work
  };
  // basement light only shows through the rooms' openings in the island's soil (by day it's too faint to matter)
  const under = L.rooms.filter(r => r.level < 0 && !r.dark && r.wing !== 'core'); // (the core has no opening in the soil)
  if (under.length && night > 0.1 && !(W && W(-1) < 1)) { const clip = { under, off: islandOffset(intro) }; for (const room of under) add(room, clip); }
  for (const room of L.rooms) if (!room.dark && room.level >= 0 && !R.shut(room.level)) add(room, room.kind === 'terrace' ? null : { room });
  return { steady, bulbs };
}
// a glow's light by the colour of what gives it (the bar's neon)
const GLOW = { '#ffd966': '#6a5010', '#ff5c8a': '#6a1838' };
const SCREEN_GLOW = { codex: '#2a6a3a', api: '#2a4a8a', claude: '#7a4a1a' };
// Draws a glow list, one clip per run of draws that share it.
function drawGlows(R, g, L, list) {
  for (let i = 0; i < list.length;) {
    const clip = list[i].clip;
    let j = i + 1;
    while (j < list.length && list[j].clip === clip) j++;
    if (clip?.under) { g.save(); underClip(g, L, clip.under, clip.off); }
    for (let k = i; k < j;) {
      const off = list[k].off;
      let m = k + 1;
      while (m < j && list[m].off === off) m++;
      g.translate(0, -off);
      if (clip?.room) { g.save(); roomClip(g, clip.room, 0); }
      for (let n = k; n < m; n++) { const e = list[n]; putGlow(R, g, e.c, e.x, e.y, e.rx, e.ry, e.a); if (e.dot) F(g, e.x, e.y, 1, 1, '#fff3b0'); }
      if (clip?.room) g.restore();
      g.translate(0, off);
      k = m;
    }
    if (clip?.under) g.restore();
    i = j;
  }
}
// the basement rooms' openings in the island's soil, as one clip
function underClip(g, L, rooms, off) {
  const quad = (a, b) => { g.moveTo(SX(...a), SY(...a) - off); for (const p of b) g.lineTo(SX(p[0], p[1]), SY(...p) - off); g.closePath(); };
  g.beginPath();
  for (const r of rooms) {
    const X = r.wing === 'x', D = r.lv.D, z0 = r.z, z1 = -SLAB;
    X ? quad([r.x0, D, z0], [[r.x1, D, z0], [r.x1, D, z1], [r.x0, D, z1]]) : quad([D, r.y0, z0], [[D, r.y1, z0], [D, r.y1, z1], [D, r.y0, z1]]);
    if (X && r.x1 >= L.Xe) quad([L.Xe, 0, z0], [[L.Xe, D, z0], [L.Xe, D, z1], [L.Xe, 0, z1]]);
    if (!X && r.y1 >= L.Ye) quad([0, L.Ye, z0], [[D, L.Ye, z0], [D, L.Ye, z1], [0, L.Ye, z1]]);
  }
  g.clip();
}
// The steady room glows drawn once into a picture of their own, and redrawn only when the list changes
// (a light going out, a screen changing state, the minute changing the dusk).
function steadyGlowLayer(R, L, list) {
  if (!list.length) return null;
  const key = list.map(e => `${e.clip?.room?.id ?? (e.clip ? '_' : '')} ${e.c} ${e.x} ${e.y} ${e.rx} ${e.ry} ${e.a}`).join('|');
  if (key === R.glowKey && R.glowLayer?.L === L) return R.glowLayer;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of list) {
    const w = (e.rx * 2 + 2) | 0, h = (e.ry * 2 + 2) | 0, x = Math.round(e.x - w / 2), y = Math.round(e.y - h / 2);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  const c = canvas(x1 - x0, y1 - y0), g = c.getContext('2d');
  g.translate(-x0, -y0); g.globalCompositeOperation = 'lighter';
  drawGlows(R, g, L, list);
  R.glowKey = key; R.glowLayer = { c, x: x0, y: y0, L };
  return R.glowLayer;
}
// A street lamp's pool of light lies on the ground just off the curb, and only on the ground outside: the
// sidewalks, the street end and the park end (never on the building or over the island's edge).
const lampPool = l => [l.x, l.y];
// the façade behind a lamp on the building's sidewalk, where its light lands on the wall (null for one elsewhere)
const lampWall = (L, l) => l.y > l.x ? (l.x >= CORE && l.x <= CORE + 1.5 && l.y > CORE && l.y < L.Y1 ? [CORE, l.y] : null)
  : (l.y >= CORE && l.y <= CORE + 1.5 && l.x > CORE && l.x < L.X1 ? [l.x, CORE] : null);
function groundClip(g, L, off) {
  const C = CORE, quad = (x0, y0, x1, y1) => { g.moveTo(SX(x0, y0), SY(x0, y0) - off); g.lineTo(SX(x1, y0), SY(x1, y0) - off); g.lineTo(SX(x1, y1), SY(x1, y1) - off); g.lineTo(SX(x0, y1), SY(x0, y1) - off); g.closePath(); };
  g.beginPath(); quad(C, C, L.Xe, C + 1); quad(C, C, C + 1, L.Ye); quad(L.X1, 0, L.Xe, C + 1); quad(0, L.Y1, C + 1, L.Ye); g.clip();
}
// a room's outline on screen: its box from floor to ceiling, or for a basement room only its opening in the soil
function roomClip(g, room, off) {
  const { x0, y0, x1, y1, z } = room, D = room.lv.D, top1 = z + FH - SLAB;
  let pts = [[x0, y0, top1], [x1, y0, top1], [x1, y0, z], [x1, y1, z], [x0, y1, z], [x0, y1, top1]];
  if (room.level < 0 && room.wing !== 'y') pts = [[x0, D, z], [x1, D, z], [x1, D, -SLAB], [x0, D, -SLAB]];
  else if (room.level < 0) pts = [[D, y0, z], [D, y1, z], [D, y1, -SLAB], [D, y0, -SLAB]];
  g.beginPath(); pts.forEach(([x, y, h], i) => i ? g.lineTo(SX(x, y), SY(x, y, h) - off) : g.moveTo(SX(x, y), SY(x, y, h) - off)); g.closePath(); g.clip();
}
const putGlow = (R, g, color, sx, sy, rx, ry, a = 1, bands) => { g.globalAlpha = a; const c = glow(R, color, rx, ry, bands); g.drawImage(c, Math.round(sx - c.width / 2), Math.round(sy - c.height / 2)); };
// quantised radial glow, so lights stay pixel-crisp
function glow(R, color, rx, ry, bands = 4) {
  const k = `${color}${rx}${ry}${bands}`;
  let c = R.glows.get(k);
  if (!c) {
    c = canvas(rx * 2 + 2, ry * 2 + 2); const g = c.getContext('2d');
    for (let b = 0; b < bands; b++) { const f = 1 - b / bands; g.globalAlpha = 1 / bands; ellipse(g, rx + 1, ry + 1, Math.max(1, Math.round(rx * f)), Math.max(1, Math.round(ry * f)), color); }
    R.glows.set(k, c);
  }
  return c;
}
const islandOffset = intro => intro ? intro(ISLAND) : 0;

// ---------------------------------------------------------------- over the scene
function paperPlane(g, p) {
  const a = p.A.hit, b = p.B.hit; if (!a || !b) return;
  const e = p.t, x = Math.round(lerp(a.sx, b.sx, e)), y = Math.round(lerp(a.y0, b.y0, e) - Math.sin(e * Math.PI) * p.arc), d = Math.sign(b.sx - a.sx || 1);
  F(g, x - 2, y, 5, 1, '#fffaf0'); F(g, x - 1, y - 1, 3, 1, '#fffaf0'); F(g, x, y + 1, 2, 1, '#fffaf0'); F(g, x - 3 * d, y, 1, 1, '#8b8fa3');
}
// the selected agent: a bouncing arrow and a name tag, in world pixels
function drawSelection(g, A, t) {
  const y = A.hit.y0 - 5 + Math.round(Math.sin(t * 6)), x = A.hit.sx;
  F(g, x - 2, y, 5, 1, '#ffd966'); F(g, x - 1, y + 1, 3, 1, '#ffd966'); F(g, x, y + 2, 1, 1, '#ffd966');
  const name = (A.data?.name || '').toUpperCase(), w = textW(name) + 4, lx = Math.round(x - w / 2);
  F(g, lx, y - 9, w, 8, INK); text(g, name, lx + 2, y - 8, '#fffaf0');
}
function weather(R, g, S, L, t, bw, bh, bx0, by0, dark) {
  const wx = S.weather;
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
  if (wx.rain > 0.02) {
    const n = Math.round(260 * wx.rain), r = rng('rain');
    g.fillStyle = dark > 0.5 ? 'rgba(170,180,230,.45)' : 'rgba(210,225,255,.6)';
    for (let i = 0; i < n; i++) {
      const sp = 170 + r() * 60, x = ((r() * (bw + 60) - t * sp * 0.25 - bx0 * 0.5) % (bw + 60) + bw + 60) % (bw + 60), y = ((r() * (bh + 40) + t * sp - by0 * 0.2) % (bh + 40));
      g.fillRect(x | 0, y | 0, 1, 3); g.fillRect((x | 0) - 1, (y | 0) + 3, 1, 2);
    }
    // splashes on the ground outside and on the open roof decks (not on railings or glass)
    const sr = rng('splash' + (t * 6 | 0)), spots = L.splashAreas ??= splashAreas(L);
    g.fillStyle = 'rgba(230,240,255,.7)';
    for (let i = 0; i < 60 * wx.rain; i++) {
      let k = sr() * spots.total, q = spots.list[0];
      for (const a of spots.list) { q = a; if ((k -= a.w) < 0) break; }
      const p = { x: q.x0 + sr() * (q.x1 - q.x0), y: q.y0 + sr() * (q.y1 - q.y0), z: q.z };
      const sx = Math.round(SX(p.x, p.y)) - bx0, sy = Math.round(SY(p.x, p.y, p.z)) - by0;
      g.fillRect(sx - 1, sy - 1, 1, 1); g.fillRect(sx + 1, sy - 1, 1, 1); g.fillRect(sx, sy - 2, 1, 1);
    }
    // ripples on the pond
    const pd = S.island.pond, px = pd.sx - bx0, py = pd.sy - by0;
    for (let i = 0; i < 4; i++) { const ph = (t * 0.8 + i * 0.25) % 1, a = i * 2.4 + (t * 0.8 + i * 0.25 | 0); g.globalAlpha = 1 - ph; ellipse(g, px + Math.cos(a) * 14, py + Math.sin(a) * 5, Math.round(1 + ph * 4), Math.max(1, Math.round(ph * 2)), null); }
    g.globalAlpha = 1;
  }
  if ((wx.fog ?? 0) > 0.02) { // fog: a pale veil and slow drifting bands of mist
    g.fillStyle = '#e6e8f0'; g.globalAlpha = 0.3 * wx.fog; g.fillRect(0, 0, bw, bh);
    const r = rng('fog');
    for (let i = 0; i < 10; i++) { const y = (bh * 0.25 + r() * bh * 0.75 + Math.sin(t * 0.05 + i) * 12) | 0, h = 14 + (r() * 26 | 0), x = ((t * (3 + r() * 4) + r() * bw) % (bw * 2)) - bw * 0.5; g.globalAlpha = (0.14 + r() * 0.16) * wx.fog; g.fillRect(x | 0, y, bw * 1.2 | 0, h); g.fillRect((x | 0) + 24, y - 3, bw * 1.1 | 0, 3); g.fillRect((x | 0) - 16, y + h, bw * 1.1 | 0, 2); }
    g.globalAlpha = 1;
  }
  if (wx.snow > 0.02) {
    const n = Math.round(200 * wx.snow), r = rng('snow');
    g.fillStyle = '#fbfcff';
    for (let i = 0; i < n; i++) {
      const sp = 14 + r() * 16, x = ((r() * (bw + 20) + Math.sin(t * 0.8 + i) * 6 - bx0 * 0.4) % (bw + 20) + bw + 20) % (bw + 20), y = ((r() * (bh + 20) + t * sp - by0 * 0.3) % (bh + 20));
      g.fillRect(x | 0, y | 0, r() < 0.3 ? 2 : 1, 1);
    }
  }
  g.restore();
}
// where rain splashes: the outdoor ground (as in groundClip) and each roof terrace's deck, inset from its edges
function splashAreas(L) {
  const C = CORE, list = [[C, C, L.Xe, C + 1], [C, C + 1, C + 1, L.Ye], [L.X1, 0, L.Xe, C], [0, L.Y1, C, L.Ye]].map(([x0, y0, x1, y1]) => ({ x0, y0, x1, y1, z: 0 }));
  for (const r of L.rooms) if (r.kind === 'terrace' && r.lv.roof) list.push({ x0: r.x0 + 0.3, y0: r.y0 + 0.3, x1: r.x1 - 0.3, y1: r.y1 - 0.45, z: r.z });
  for (const a of list) a.w = Math.max(0, (a.x1 - a.x0) * (a.y1 - a.y0));
  return { list, total: list.reduce((s, a) => s + a.w, 0) };
}
// The buffer is drawn at 1 world pixel per buffer pixel: CSS scales it up by the zoom, and places it.
function placeCanvas(R, cam, o, bx0, by0) {
  const { SW, SH, dpr } = o, z = cam.z, st = R.fb.style;
  const dx = (bx0 - cam.x) * z + SW / 2, dy = (by0 - cam.y) * z + SH / 2, k = z / dpr;
  const css = `${R.fb.width * k}px|${R.fb.height * k}px|translate(${Math.round(dx) / dpr}px,${Math.round(dy) / dpr}px)`;
  if (css !== R.css) { R.css = css; const [w, h, transform] = css.split('|'); st.width = w; st.height = h; st.transform = transform; }
  R.toScreen = (wx, wy) => ({ x: (wx - cam.x) * z + SW / 2, y: (wy - cam.y) * z + SH / 2 });
}
