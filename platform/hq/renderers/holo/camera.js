// The camera: an orbit round the deck (turn, tilt, distance, the point it looks at) that eases to what it's asked to
// frame, drifts slowly round when left alone, keeps the deck in the part of the screen the shell's chrome leaves free,
// and answers the shell's gestures.
import { clamp, lerp } from '../../util.js';
import { TAU, persp, lookAt, mmul, add, sub, scl, nrm, cross } from './gl.js';
import { TABLE_Y, CROWN_Y, CORE, agentAt, mascotAt } from './deck.js';

const EASE = 3.2, DRIFT = 0.035, IDLE_S = 4; // how briskly moves settle; the drift (rad/s) after this long untouched
const HOME = [0, 2.05, 0];
export const cam = {}; // yaw, pitch, dist, at; goal: where it's easing to; spin: a fling's; idle: s untouched; shift: see free()
// w, h: the screen (CSS px); rs: render px per CSS px; VP, eye, scale: this frame's (scale: px per world unit at 1)
export const view = { w: 1, h: 1, rs: 1, chrome: null, VP: null, eye: [0, 0, 0], scale: 1, fov: 0.62 };

export function reset() { Object.assign(cam, { yaw: 0.42, pitch: 0.16, dist: 9, at: HOME, goal: null, spin: 0, idle: 0, held: false, shift: [0, 0] }); }

// The part of the screen the chrome leaves free (CSS px): below the toolbar, above the bottom bar and a phone's sheet,
// beside a wide panel, 8 px in from each
export function area() {
  const c = view.chrome(), { w, h } = view, side = c.panel.open && c.panel.wide ? c.panel.right : 0, sheet = c.panel.open && !c.panel.wide ? h * c.panel.share : 0;
  return { x0: 8, x1: w - side - 8, y0: c.top + 8, y1: h - sheet - c.bottom - 8 };
}
// That area's size, and where its middle sits in NDC
function free() {
  const a = area();
  return { fw: a.x1 - a.x0, fh: a.y1 - a.y0, cx: (a.x0 + a.x1) / view.w - 1, cy: 1 - (a.y0 + a.y1) / view.h };
}
// A wide lens on a tall screen so the whole table fits across it, then as close as the free area allows. Tall
// screens look down on the deck a little more, and at a lower point: the hologram stands on the table, so looking at
// its middle left the deck in the bottom half of a phone with the top half empty (the board's screenshot).
function home() {
  const { fw, fh } = free(), tan = Math.tan(view.fov / 2), aspect = view.w / view.h;
  const tall = view.h > view.w, dist = Math.max((tall ? 2.5 : 3.05) * view.w / (fw * tan * aspect), 2.05 * view.h / (fh * tan)) + 1.2;
  return { yaw: cam.yaw, pitch: tall ? 0.2 : 0.16, dist, at: tall ? [0, 1.1, 0] : HOME };
}
export function setScreen(w, h, rs) {
  Object.assign(view, { w, h, rs });
  view.fov = 2 * Math.atan(clamp(0.36 / (w / h), Math.tan(0.31), 0.6));
}

export function step(dt) {
  const g = cam.goal, k = 1 - Math.exp(-dt * EASE);
  if (g) {
    cam.yaw += ((((g.yaw - cam.yaw) % TAU) + TAU * 1.5) % TAU - Math.PI) * k;
    cam.pitch = lerp(cam.pitch, g.pitch, k); cam.dist = Math.exp(lerp(Math.log(cam.dist), Math.log(g.dist), k)); cam.at = cam.at.map((v, i) => lerp(v, g.at[i], k));
  } else if (!cam.held) { cam.yaw += cam.spin * dt; cam.spin *= Math.exp(-dt * 2.5); } // the glide after a fling
  cam.idle += dt;
  const c = view.chrome();
  if (!cam.held && cam.idle > IDLE_S && !c.panel.open) { cam.yaw += DRIFT * dt; if (g) g.yaw += DRIFT * dt; }
  const f = free();
  cam.shift = [lerp(cam.shift[0], f.cx, k), lerp(cam.shift[1], f.cy, k)];
}
// this frame's matrices
export function matrices() {
  const { w, h, rs, fov } = view, cp = Math.cos(cam.pitch);
  const eye = add(cam.at, [Math.sin(cam.yaw) * cp * cam.dist, Math.sin(cam.pitch) * cam.dist, Math.cos(cam.yaw) * cp * cam.dist]);
  view.VP = mmul(persp(fov, w / h, 0.05, 80, ...cam.shift), lookAt(eye, cam.at));
  view.eye = eye; view.scale = h * rs / (2 * Math.tan(fov / 2));
}
// p on screen (CSS px) and its depth, or null behind the camera
export function project(p) {
  const m = view.VP;
  if (!m) return null;
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return w < 0.05 ? null : { x: (x / w * 0.5 + 0.5) * view.w, y: (0.5 - y / w * 0.5) * view.h, w };
}
// the ray from the eye through a point on screen (CSS px), as this frame's matrices see it
export function ray(x, y) {
  const { w, h, fov, eye } = view, t = Math.tan(fov / 2), z = nrm(sub(eye, cam.at)), xa = nrm(cross([0, 1, 0], z)), ya = cross(z, xa);
  const nx = (x / w * 2 - 1 - cam.shift[0]) * t * w / h, ny = (1 - y / h * 2 - cam.shift[1]) * t;
  return { o: eye, d: nrm(add(add(scl(xa, nx), scl(ya, ny)), scl(z, -1))) };
}

function to(goal, instant) {
  goal.pitch = clamp(goal.pitch, 0.02, 1.25);
  if (instant) { const f = free(); Object.assign(cam, goal, { goal: null, shift: [f.cx, f.cy] }); return; }
  cam.goal = goal; cam.idle = 0;
}
// Frames a target ({ kind: 'home' | 'agent' | 'mascot' | 'room' | 'object', id }) from outside its room, looking in
// towards the core; false when the deck has nothing to frame. close: in on an agent or a mascot (a panel opens beside it).
export function focus(S, { kind, id }, { instant, close } = {}) {
  const room = id => (S.core?.id === id ? S.core : S.rooms.find(r => r.id === id));
  if (kind === 'home') to(home(), instant);
  else if (kind === 'room') { const r = room(id); if (!r) return false; frameRoom(S, r, instant); }
  else if (kind === 'agent') {
    const P = S.people.get(id); if (!P) return false;
    if (close) to({ yaw: P.room === S.core ? cam.yaw : P.room.a, pitch: 0.28, dist: 2.6, at: agentAt(S, P) }, instant); else frameRoom(S, P.room, instant);
  } else if (kind === 'mascot') {
    const c = S.mascots.find(x => x.data.id === id); if (!c) return false;
    to({ yaw: c.a, pitch: 0.5, dist: close ? 1.4 : 2.2, at: add(mascotAt(c), [0, 0.08, 0]) }, instant);
  } else if (kind === 'object' && id === 'lens') to({ yaw: cam.yaw, pitch: 0.7, dist: 3.4, at: [0, TABLE_Y, 0] }, instant);
  else return false;
  return true;
}
function frameRoom(S, r, instant) {
  to(r === S.core ? { yaw: cam.yaw, pitch: 0.25, dist: 3.4, at: CORE } : { yaw: r.a, pitch: 0.32, dist: 1.8 + r.rp * 6, at: add(r.pos, [0, 0.12, 0]) }, instant);
}

// ---- the shell's gestures, in CSS px (and px/s)
// One finger: across turns the deck, up and down pans it (the board's ask: like the other looks); two fingers: a pinch
// zooms, moving up or down together tilts; the arrow keys turn and tilt.
let pinched = null; // { dist, y }: the distance a pinch started from, and where its fingers' middle was last
const touch = () => { cam.goal = null; cam.idle = 0; };
const tilt = dy => { cam.pitch = clamp(cam.pitch + dy * 0.004, 0.02, 1.25); };
// The deck follows the finger: the point looked at moves up or down by what dy px spans there, between a little
// under the table top and the crown, so the deck can't be lost off screen (a framed room or mascot outside that
// range may only be panned back towards it)
function pan(dy) {
  const span = 2 * cam.dist * Math.tan(view.fov / 2) / view.h / Math.cos(cam.pitch), y = cam.at[1];
  cam.at = [cam.at[0], clamp(y + dy * span, Math.min(TABLE_Y - 0.4, y), Math.max(CROWN_Y, y)), cam.at[2]];
}
export const camera = {
  grab() { cam.held = true; cam.spin = 0; touch(); },
  drag(dx, dy, vx) { cam.yaw -= dx * 0.006; pan(dy); cam.spin = -vx * 0.006; touch(); },
  pinch(x, y, scale, phase) {
    if (phase === 'start') pinched = { dist: cam.dist, y };
    else if (phase === 'move' && pinched) { cam.dist = clamp(pinched.dist / scale, 1.2, 24); tilt(y - pinched.y); pinched.y = y; }
    touch();
  },
  release(fling) { cam.held = false; if (!fling) cam.spin = 0; },
  // from where the camera is heading, so quick wheel notches add up
  zoom(step) { const g = cam.goal ?? { ...cam }; to({ yaw: g.yaw, pitch: g.pitch, at: g.at, dist: clamp(g.dist * 0.8 ** step, 1.2, 24) }); },
  nudge(dx, dy) { cam.yaw -= dx * 0.004; tilt(-dy * 0.75); touch(); },
};
