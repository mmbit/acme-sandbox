// Input on the canvas: tap, double tap, hover, drag, pinch, fling, wheel and keys, and what a tap opens.
import * as world from '../world/world.js';
import * as audio from './audio.js';
import { cv, scene, pointed, resize } from './stage.js';
import { dropCard } from './overlay.js';
import { stopTour } from './tour.js';
import { syncHud } from './hud.js';
import { openAgent, openRoom, closePanel, panelOpen } from './panel.js';
import { openGazette, openLibrary } from './news.js';
import { openPhone, openIntercom, openComputer } from './desk.js';

const TAP_SLOP = 14, TAP_MS = 600, DOUBLE_TAP_MS = 380; // a tap moves less than this (CSS px) and is this quick
// the scene's objects the shell opens itself (the rest, and mascots, are the scene's to answer), each given what was hit
const TOOLS = { news: () => openGazette(), library: () => openLibrary(), phone: () => openPhone(), intercom: () => openIntercom(),
  computer: () => openComputer(), studio: () => openComputer('studio'), // (studio, the photo studio's room)
  machine: h => openComputer('settings', { section: 'sys:machines', page: h.machine ?? null }) }; // (a lent machine, or a look's render farm: the list)
const PAN = { ArrowLeft: [-120, 0], ArrowRight: [120, 0], ArrowUp: [0, -120], ArrowDown: [0, 120] }; // CSS px

function tap(x, y, double) {
  const h = scene.hit(x, y), before = panelOpen();
  if (h?.kind !== 'mascot') dropCard();
  act(h, double);
  // a tap outside the panel closes it, unless the tap opened something else in it
  if (before && panelOpen() === before && !double) closePanel();
}
function act(h, double) {
  if (!h) { if (double) scene.focus({ kind: 'home' }); return; }
  if (double && h.kind !== 'agent' && h.room) { scene.focus({ kind: 'room', id: h.room }); audio.sfx.whoosh(); return; }
  if (h.kind === 'agent') { pointed.selected = h.id; openAgent(world.agents.get(h.id)); scene.focus(h, { close: !double }); }
  else if (h.kind === 'room') {
    const r = world.rooms.find(x => x.id === h.id); // (the scene's own rooms, its corridors and nooks, open nothing)
    if (!r) return;
    if (r.features.includes('knowledge-search')) openLibrary();
    else if (r.features.includes('gazette-newsstand')) openGazette();
    else openRoom(r.id);
  } else if (h.kind === 'object' && TOOLS[h.id]) TOOLS[h.id](h);
  else {
    scene.act(h, { double });
    if (h.id === 'walls') syncHud(); // the closed building, tapped, opens up: its button too
  }
}

// a tap a look takes on its own page (wire: drawn in the DOM, which scrolls itself), answered as one on the canvas
export function press(x, y) { audio.unlock(); stopTour(); tap(x, y, false); }

export function bindInput() {
  bindCanvas(cv);
  let resizeT;
  addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => resize(), 150); });
  const code = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
  let seq = [];
  addEventListener('keydown', e => {
    if (e.target.closest('input, textarea')) return;
    seq = seq.concat(e.key).slice(-code.length);
    if (seq.join() === code.join()) { audio.unlock(); world.startParty(); }
    if (PAN[e.key]) { scene.camera.nudge(...PAN[e.key]); dropCard(); }
    if (e.key === '+' || e.key === '=') scene.camera.zoom(1);
    if (e.key === '-') scene.camera.zoom(-1);
  });
}
// the gestures on the scene's canvas (the stage binds each new one)
export function bindCanvas(cv) {
  const ptrs = new Map();
  let pinch = null, tapInfo = null, lastMove = 0, lastTap = null;
  const pt = e => ({ x: e.clientX, y: e.clientY });
  const mid = () => { const [a, b] = [...ptrs.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; };
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, pt(e)); scene.camera.grab();
    audio.unlock(); stopTour();
    document.querySelector('#hint').classList.add('gone');
    if (ptrs.size === 1) tapInfo = { ...pt(e), t: performance.now(), moved: 0 };
    else { tapInfo = null; const m = mid(); pinch = { d: m.d, m }; scene.camera.pinch(m.x, m.y, 1, 'start'); dropCard(); }
    cv.classList.add('drag');
  });
  cv.addEventListener('pointermove', e => {
    const p = ptrs.get(e.pointerId), n = pt(e);
    if (!p) {
      const h = e.pointerType === 'mouse' ? scene.hit(n.x, n.y) : null;
      pointed.hover = h?.kind === 'agent' ? h.id : null;
      cv.style.cursor = h && h.kind !== 'room' ? 'pointer' : '';
      cv.title = h?.hint ?? ''; // (what a tap there opens, where the scene says: a machine's settings)
      return;
    }
    ptrs.set(e.pointerId, n);
    if (ptrs.size === 1 && !pinch) {
      const dx = n.x - p.x, dy = n.y - p.y, t = performance.now(), dtm = Math.max(8, t - lastMove);
      scene.camera.drag(dx, dy, dx / dtm * 1000, dy / dtm * 1000); lastMove = t;
      if (tapInfo) { tapInfo.moved += Math.abs(dx) + Math.abs(dy); if (tapInfo.moved >= TAP_SLOP) dropCard(); }
    } else if (pinch && ptrs.size === 2) {
      const m = mid(); pinch.m = m;
      scene.camera.pinch(m.x, m.y, m.d / pinch.d, 'move');
    }
  });
  const up = e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    const tapped = tapInfo && e.type === 'pointerup' && tapInfo.moved < TAP_SLOP && performance.now() - tapInfo.t < TAP_MS;
    if (tapped) {
      const dbl = lastTap && performance.now() - lastTap.t < DOUBLE_TAP_MS && Math.hypot(lastTap.x - tapInfo.x, lastTap.y - tapInfo.y) < 40;
      tap(tapInfo.x, tapInfo.y, dbl);
      lastTap = dbl ? null : { ...tapInfo, t: performance.now() };
    }
    if (ptrs.size < 2 && pinch) { const m = pinch.m; scene.camera.pinch(m.x, m.y, m.d / pinch.d, 'end'); pinch = null; }
    // a fling glides on when the last finger lifts straight after moving
    if (!ptrs.size) { scene.camera.release(!tapped && performance.now() - lastMove <= 80); tapInfo = null; cv.classList.remove('drag'); }
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  let wheel = 0;
  cv.addEventListener('wheel', e => {
    e.preventDefault(); dropCard();
    // a look that rolls with the wheel itself (wire) gets every turn of it, its size included
    if (scene.camera.wheel) return scene.camera.wheel((e.deltaY + e.deltaX) * (e.deltaMode ? 30 : 1));
    wheel += e.deltaY * (e.deltaMode ? 30 : 1);
    if (Math.abs(wheel) > 50) { scene.camera.zoom(-Math.sign(wheel), e.clientX, e.clientY); audio.sfx.blip(); wheel = 0; }
  }, { passive: false });
}
