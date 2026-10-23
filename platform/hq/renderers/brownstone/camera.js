// The camera: eased moves and zooms that settle on an integer zoom (crisp pixels), framing that leaves room for
// the shell's chrome (the HUD, the side panel or the bottom sheet on phones), soft bounds, and the gestures.
import { clamp, lerp } from '../../util.js';
import { SX, SY } from './iso.js';
import { S } from './build.js';

const MARGIN = 60, EASE = 5.5; // world px of slack around the island; how briskly moves settle
export const cam = { x: 0, y: 0, z: 2, t: null, vx: 0, vy: 0, min: 1, max: 12 };
export const view = { SW: 0, SH: 0, dpr: 1, L: null, now: 0, chrome: null }; // kept up to date by scene.js

function frameBox(x0, y0, x1, y1, instant, maxZ = 99) {
  const c = view.chrome(), hud = c.top * view.dpr, wide = c.panel.wide, panel = c.panel.open && wide ? c.panel.right * view.dpr : 0, sheet = c.panel.open && !wide ? view.SH * c.panel.share : 0;
  const aw = view.SW - panel - 16 * view.dpr, ah = view.SH - hud - sheet - (16 + c.bottom) * view.dpr;
  const z = clamp(Math.floor(Math.min(aw / (x1 - x0), ah / (y1 - y0), maxZ)), cam.min, cam.max);
  const fits = (y1 - y0) * z <= ah, cx = (x0 + x1) / 2 + panel / 2 / z, cy = (y0 + y1) / 2 - (fits ? hud / 2 / z : 0) + sheet / 2 / z;
  target(cx, cy, z, instant);
}
export function home(instant) { const b = view.L.bounds.fit; frameBox(b.x0, b.y0, b.x1, b.y1, instant); }
function target(x, y, z, instant, anchor) {
  if (instant) { Object.assign(cam, { x, y, z, t: null }); return; }
  cam.t = { x, y, z, anchor, until: view.now + 3 };
}
// rooms: a room, or every part of a department split over several wings
function focusRoom(rooms, instant) {
  const pts = rooms.flatMap(r => [[r.x0, r.y0, r.z + 50], [r.x1, r.y0, r.z], [r.x0, r.y1, r.z], [r.x1, r.y1, r.z - 10]]);
  const xs = pts.map(p => SX(p[0], p[1])), ys = pts.map(p => SY(p[0], p[1], p[2]));
  frameBox(Math.min(...xs) - 20, Math.min(...ys) - 10, Math.max(...xs) + 20, Math.max(...ys) + 10, instant, Math.round(7 * view.dpr));
}
// in close on a point, in the part of the screen a panel opening beside it leaves free
function focusPoint(wx, wy) {
  const c = view.chrome(), z = clamp(Math.max(Math.round(cam.z), Math.round(4 * view.dpr)), cam.min, cam.max), wide = c.panel.wide;
  const vx = wide ? (view.SW - c.panel.right * view.dpr) / 2 : view.SW / 2, vy = wide ? view.SH / 2 : (60 * view.dpr + view.SH * (1 - c.panel.share)) / 2;
  target(wx - (vx - view.SW / 2) / z, wy - (vy - view.SH / 2) / z, z);
}
// Frames a target ({ kind: 'home' | 'agent' | 'mascot' | 'room' | 'object', id }); false when there's nothing to
// frame. close: in on it, beside the panel a tap opens (an agent out of sight gets their room); else it's framed.
export function focus({ kind, id }, { instant, close } = {}) {
  const { L } = view;
  if (kind === 'home') home(instant);
  else if (kind === 'room') { const rs = L.rooms.filter(x => x.id === id || x.src === id); if (!rs.length) return false; focusRoom(rs, instant); }
  else if (kind === 'agent') {
    const A = S.people.get(id); if (!A) return false;
    if (close && A.hit) focusPoint(A.hit.sx, A.hit.y0 + 10); else focusRoom([A.room], instant);
  } else if (kind === 'mascot') {
    const c = S.mascots.find(x => x.data.id === id); if (!c) return false;
    const x = SX(c.x, c.y), y = SY(c.x, c.y, L.roofZ);
    if (close) focusPoint(x, y); else frameBox(x - 70, y - 50, x + 70, y + 20, instant, Math.round(6 * view.dpr));
  } else if (kind === 'object' && id === 'van') { // the street by the loading dock, where the van pulls in
    const b = S.island.bay, x = SX(b.x, b.y), y = SY(b.x, b.y);
    frameBox(x - 110, y - 90, x + 110, y + 30, instant, Math.round(5 * view.dpr));
  } else return false;
  return true;
}
export function clampCam() {
  const c = view.chrome(), b = view.L.bounds, hw = view.SW / 2 / cam.z, hh = view.SH / 2 / cam.z, open = c.panel.open, wide = c.panel.wide;
  // while a panel is open, let the scene slide out from under it
  const ex = open && wide ? c.panel.right * view.dpr / cam.z : 0, ey = open && !wide ? view.SH * c.panel.share / cam.z : 0, mx = MARGIN, my = MARGIN;
  cam.x = b.x1 - b.x0 + 2 * mx <= hw * 2 ? (b.x0 + b.x1) / 2 + ex / 2 : clamp(cam.x, b.x0 - mx + hw, b.x1 + mx - hw + ex);
  cam.y = b.y1 - b.y0 + 2 * my <= hh * 2 ? (b.y0 + b.y1) / 2 + ey / 2 : clamp(cam.y, b.y0 - my + hh, b.y1 + my - hh + ey);
}
export const toWorld = (sx, sy) => ({ x: cam.x + (sx - view.SW / 2) / cam.z, y: cam.y + (sy - view.SH / 2) / cam.z });
function zoomAt(sx, sy, z, animate = true) {
  z = clamp(z, cam.min, cam.max);
  const w = toWorld(sx, sy);
  if (animate) { target(0, 0, Math.round(z), false, { wx: w.x, wy: w.y, sx, sy }); return; }
  cam.z = z; cam.x = w.x - (sx - view.SW / 2) / z; cam.y = w.y - (sy - view.SH / 2) / z; cam.t = null;
}
export function camStep(dt) {
  const t = cam.t;
  if (t) {
    const k = 1 - Math.exp(-dt * EASE);
    cam.z = Math.exp(lerp(Math.log(cam.z), Math.log(t.z), k));
    if (t.anchor) { cam.x = t.anchor.wx - (t.anchor.sx - view.SW / 2) / cam.z; cam.y = t.anchor.wy - (t.anchor.sy - view.SH / 2) / cam.z; }
    else { cam.x = lerp(cam.x, t.x, k); cam.y = lerp(cam.y, t.y, k); }
    if ((Math.abs(cam.z - t.z) < 0.01 && (t.anchor || Math.hypot(cam.x - t.x, cam.y - t.y) < 0.3)) || view.now > t.until) {
      cam.z = t.z; if (!t.anchor) { cam.x = t.x; cam.y = t.y; } cam.t = null;
    }
  } else if (!cam.held && Math.abs(cam.vx) + Math.abs(cam.vy) > 1) { // the glide after a fling, not while the finger is down
    cam.x -= cam.vx * dt / cam.z; cam.y -= cam.vy * dt / cam.z; cam.vx *= 0.9; cam.vy *= 0.9;
  }
  if (!cam.pinching && !cam.t) cam.z = Math.round(cam.z);
  clampCam();
}

// The shell's gestures, in CSS px (and px/s): a finger down, a drag, a pinch, letting go, zoom steps, key nudges
let pinched = null; // the pinch's middle when last seen and the zoom it started at (device px)
export const camera = {
  grab() { cam.held = true; cam.vx = cam.vy = 0; cam.t = null; },
  drag(dx, dy, vx, vy) {
    const d = view.dpr;
    cam.x -= dx * d / cam.z; cam.y -= dy * d / cam.z; cam.vx = vx * d; cam.vy = vy * d;
    clampCam();
  },
  // phase: 'start', 'move' or 'end'; x, y: the fingers' middle; scale: their spread against the start's
  pinch(x, y, scale, phase) {
    x *= view.dpr; y *= view.dpr;
    if (phase === 'start') { pinched = { x, y, z: cam.z }; cam.pinching = true; return; }
    if (phase === 'end') { cam.pinching = false; zoomAt(x, y, Math.round(cam.z)); return; }
    cam.x -= (x - pinched.x) / cam.z; cam.y -= (y - pinched.y) / cam.z; pinched.x = x; pinched.y = y;
    zoomAt(x, y, pinched.z * scale, false);
    clampCam();
  },
  // fling: the view glides on
  release(fling) { if (!fling) cam.vx = cam.vy = 0; cam.held = false; },
  // About a point (the wheel) from where the camera is heading, so quick notches add up; else about the middle of
  // the screen from where it is (the buttons and keys).
  zoom(step, x, y) {
    if (x == null) zoomAt(view.SW / 2, view.SH / 2, Math.round(cam.z) + step);
    else zoomAt(x * view.dpr, y * view.dpr, Math.round(cam.t?.z ?? cam.z) + step);
  },
  nudge(dx, dy) { cam.x += dx * view.dpr / cam.z; cam.y += dy * view.dpr / cam.z; cam.t = null; clampCam(); },
};
