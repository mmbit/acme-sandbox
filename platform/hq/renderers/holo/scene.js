// The holo deck: the company as a volumetric hologram over a radar table, in raw WebGL2. What the shell drives (a
// step, a frame, taps, the camera, a resize), how the deck answers the world's signals, and the showcase tour.
import { canvas, clamp, rand, pick } from '../../util.js';
import { darkness, holidays, today } from '../../world/clock.js';
import { weatherAt } from '../../world/weather.js';
import { TAU, add, sub, scl, polar, context } from './gl.js';
import { createRenderer, size, render } from './render.js';
import { layout, printIn, update as move, addMascots, updateMascots, introLength, built, agentAt, mascotAt, agentColour, TABLE_Y, TABLE_R, CORE, AMBER, WHITE, GOLD, CORAL, MAG, TEAL, VIOLET, MASCOT } from './deck.js';
import { hologram, flightEnds, PARCEL_S, ART } from './draw.js';
import { drawLabels, loadFont, portrait as picture } from './labels.js';
import { makeLook, spriteFrame } from '../brownstone/sprites.js';
import { cam, view, reset, setScreen, step as camStep, matrices, project, ray, focus as frame, camera } from './camera.js';

export const info = { id: 'holo', name: 'Holo deck', context: 'webgl2', label: 'The company as a hologram over a radar table' };

const HOLD = 4.2;          // seconds the tour stays at each stop
const SPARKS = [MAG, GOLD, TEAL, CORAL, VIOLET, WHITE];
// One scene at a time: its state lives here, set up afresh by createScene
let gl, R, S, world, shell, name, screen, labels, lit, camDt, lost, fit;

// A scene, or a throw where the device has no WebGL2 (the shell then keeps the view it has).
// brand: the company's name for the rim; settings.intro: the rooms print themselves in, one after another.
export function createScene({ canvas: cv, world: w, brand, settings, shell: s }) {
  gl = context(cv);
  if (!gl) throw new Error('holo: this device has no WebGL2');
  R = createRenderer(gl); world = w; shell = s; name = brand.name; screen = cv; lit = null; camDt = 0; lost = false;
  labels = canvas(1, 1);
  view.chrome = s.chrome; reset();
  S = { t: 0, rooms: null, people: new Map(), mascots: null, flights: [], parcels: [], parts: [], pulses: [], tags: [], sweep: 1.2, half: 0.27, glitch: 0, docked: 0, rimTaps: [], hour: 12, day: 1, party: 0, requests: 0, holidays: new Set(), weather: { rain: 0, snow: 0, fog: 0, cloud: 0 } };
  build(settings.intro);
  weather(1);
  loadFont();
  document.body.style.background = '#010306'; // (the page round the canvas: iOS' overscroll)
  const bg = document.body.style.background;
  cv.addEventListener('webglcontextlost', onLost); cv.addEventListener('webglcontextrestored', onRestored);
  const offs = listen(), own = gl; // (its own: a swap to a new deck has made the new one's by the time this one goes)
  return {
    update, draw, hit, focus, resize, camera, anchor, highlight: t => { lit = t; }, act, portrait, near, where, showcase, controls: [],
    // its signals stop, its GPU memory goes back now (not whenever the collector gets to it), and its colour leaves the
    // page, unless the next scene (made before this one goes) has put its own there
    dispose() {
      for (const off of offs) off();
      cv.removeEventListener('webglcontextlost', onLost); cv.removeEventListener('webglcontextrestored', onRestored);
      own.getExtension('WEBGL_lose_context')?.loseContext();
      if (document.body.style.background === bg) document.body.style.background = '';
    },
    dev: { S: () => S, cam, hit, scale: rs => { fit.held = rs; if (rs) scaleTo(rs); }, // (a render scale held: the same pixels whatever the GPU)
      tick: (dt, n) => { for (let i = 0; i < n; i++) update(dt); }, rebuild: () => { focus({ kind: 'home' }); return []; } },
  };
}
// a phone backgrounded for long can take the GPU away; the deck comes back when it's returned (context() again: a
// restored context has lost its extensions, and without float targets the deck draws black)
function onLost(e) { e.preventDefault(); lost = true; }
function onRestored() { R = createRenderer(context(screen)); size(R, labels.width, labels.height, samples(fit.rs)); lost = false; fit.fence = null; }

function build(intro) {
  layout(S, world, intro); addMascots(S, world);
  S.holidays = holidays(today(), world.hour());
  if (world.dev) for (const m of world.mascots) if (!ART[m.kind]) console.warn(`[hq] the holo deck has no wireframe for a ${m.kind}, so ${m.name} is a crystal`);
}

// w, h: the screen in CSS px. The shell hands at most dpr 2 (the 2D looks' cap), but the deck sizes its own cost
// (below), so it starts at the screen's own: a phone's 3, where 1.5 upscaled 2× read as blurry.
function resize(w, h, dpr) {
  const top = Math.min(Math.max(dpr, devicePixelRatio || 1), RS_MAX);
  fit = { w, h, top, rs: 0, slow: Infinity, n: 0, busy: 0, quiet: 0, fence: null, at: 0, held: fit?.held };
  scaleTo(fit.held || top);
  Object.assign(screen.style, { width: `${w}px`, height: `${h}px`, imageRendering: 'auto' });
  focus({ kind: 'home' }, { instant: true });
}

// ---------------------------------------------------------------- resolution
// Render px per CSS px: as high as the device keeps up with. A frame is late when the GPU hadn't finished the last one
// by the time it starts (its fence: sync objects work in Safari, timer queries don't), or when it comes more than
// SLOW_MS after the last (a GPU that stalls the CPU instead, or the CPU itself). Mostly late over a window: a step
// down, and that scale is remembered as too slow until the next resize; late no more than a hitch or two over a few
// windows: a step back up (a heavy moment passed, the phone cooled).
const RS_MAX = 3, RS_MIN = 1, RS_STEP = 0.25, WINDOW = 40, LATE = WINDOW / 4, HITCH = 2, QUIET = 3, SLOW_MS = 40;
// MSAA samples: at 2 px per CSS px and up, 2 smooth the lines as well as 4 did at 1.5, and halve the multisampled
// targets (at a phone's 3, 4× float colour and depth came to ~140 MB)
const samples = rs => rs >= 2 ? 2 : 4;
function scaleTo(rs) {
  const { w, h } = fit, W = Math.round(w * rs), H = Math.round(h * rs);
  fit.rs = rs; fit.n = fit.busy = 0;
  Object.assign(screen, { width: W, height: H }); Object.assign(labels, { width: W, height: H });
  setScreen(w, h, rs); size(R, W, H, samples(rs));
}
// before a frame: how the last one went (dev frames, dt 0, aren't judged: tests get the same pixels every time; nor
// is the first after a pause or a hidden page)
function judge() {
  const now = performance.now(), gap = now - fit.at;
  fit.at = now;
  if (fit.fence) {
    if (camDt > 0 && gap < 1000) { fit.n++; fit.busy += gl.getSyncParameter(fit.fence, gl.SYNC_STATUS) !== gl.SIGNALED || gap > SLOW_MS; }
    gl.deleteSync(fit.fence); fit.fence = null;
  }
  if (fit.held || fit.n < WINDOW) return;
  const { rs, busy, top, slow } = fit;
  fit.quiet = busy > HITCH ? 0 : fit.quiet + 1;
  if (busy > LATE && rs > RS_MIN) { fit.slow = rs; scaleTo(Math.max(RS_MIN, rs - RS_STEP * Math.ceil(busy / LATE))); }
  else if (fit.quiet >= QUIET && rs < top && rs + RS_STEP < slow) { fit.quiet = 0; scaleTo(Math.min(top, rs + RS_STEP)); }
  else fit.n = fit.busy = 0;
}

// ---------------------------------------------------------------- the step
function update(dt) {
  S.t += dt; camDt = dt;
  const h = world.hour(), dark = darkness(h), load = world.load(), { play, ready } = shell.sound;
  Object.assign(S, { hour: h, day: 1 - dark, requests: world.requests, party: clamp(world.party, 0, 1), glitch: Math.max(0, S.glitch - dt * 3), machine: world.machine });
  S.sweep += dt * (0.8 + 0.5 * load.busy + 2 * S.party);
  move(S, dt, world); updateMascots(S, dt); weather(dt);
  for (const f of S.flights) if (!f.landed && S.t - f.t0 >= f.dur) {
    f.landed = true;
    const to = S.people.get(f.b)?.room ?? (f.b === 'board' ? S.core : f.room);
    if (to) to.flash = 1;
    S.pulses.push({ c: flightEnds(S, f)[2], r: 0.08, t0: S.t, col: f.col });
    play('pop');
  }
  S.flights = S.flights.filter(f => S.t - f.t0 < f.dur * 1.25);
  // a busy loading dock sends parcels out over the table's edge
  if (load.deliveries && (S.docked += dt) > 1.3) { S.docked = 0; for (const r of S.rooms) if (r.w.kind === 'dock' && built(S, r) === 1) S.parcels.push({ room: r, t0: S.t }); }
  S.parcels = S.parcels.filter(p => S.t - p.t0 < PARCEL_S);
  // confetti from the crown at a party; fireworks over the deck on New Year's Eve and the company's birthday, at night
  if (S.party > 0 && Math.random() < dt * 30) S.parts.push({ k: 'spark', p: polar(rand(0, 2.4), rand(0, TAU), 4), v: [rand(-0.2, 0.2), -rand(0.2, 0.6), rand(-0.2, 0.2)], g: 0.4, life: 5, c: pick(Math.random, SPARKS) });
  if ((S.holidays.has('newYear') || S.holidays.has('birthday')) && dark > 0.5 && Math.random() < dt * 0.5) {
    const at = polar(rand(0, 2), rand(0, TAU), rand(4.4, 5.4)), c = pick(Math.random, SPARKS);
    for (let i = 0; i < 40; i++) { const a = rand(0, TAU), z = rand(-1, 1), s = Math.sqrt(1 - z * z); S.parts.push({ k: 'spark', p: at, v: scl([Math.cos(a) * s, z, Math.sin(a) * s], rand(0.8, 1.2)), g: 0.5, life: 1.6, c }); }
    if (ready()) play('boom');
  }
  S.parts = S.parts.filter(p => (p.life -= dt) > 0);
  for (const p of S.parts) { if (p.v) { p.v[1] -= p.g * dt; p.p = add(p.p, scl(p.v, dt)); } else p.p = add(p.p, [0, p.vy * dt, 0]); }
  S.pulses = S.pulses.filter(u => S.t - u.t0 < 0.9);
  shell.sound.weather(S.weather.rain, dark, S.weather.snow);
}
// the world's weather, eased in (k: how much of the way, 1 at once)
function weather(k) {
  const kind = weatherAt(today()), w = S.weather, ease = (key, v) => { w[key] += (v - w[key]) * Math.min(1, k); };
  ease('rain', kind === 'rain' ? 1 : kind === 'showers' ? 0.4 : 0); ease('snow', +(kind === 'snow')); ease('fog', +(kind === 'fog'));
  ease('cloud', { clear: 0, cloudy: 0.6, showers: 0.35, fog: 0.5 }[kind] ?? 1);
}

// ---------------------------------------------------------------- the frame
function draw(t) {
  if (lost) return;
  judge();
  camStep(camDt); matrices();
  for (const P of S.people.values()) P.hit = P.room === S.core || built(S, P.room) === 1 ? project(agentAt(S, P)) : null;
  for (const c of S.mascots) c.hit = project(add(mascotAt(c), [0, 0.08, 0]));
  hologram(S, t, view.eye, view.w * view.h < 600_000 ? 0.5 : 1);
  drawLabels(labels.getContext('2d'), S, { project, view, name, lit, t });
  const flick = (0.94 + 0.06 * Math.sin(t * 47) * Math.sin(t * 13)) * (1 - 0.35 * S.glitch);
  render(R, S, { VP: view.VP, eye: view.eye, t, flick, fog: 0.15 + 0.3 * S.weather.fog, day: S.day, glitch: S.glitch, power: 0.7 + 0.6 * world.load().busy, scale: view.scale }, labels);
  fit.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
}

// ---------------------------------------------------------------- taps
// What's under a point (CSS px): a name tag (words win over the lights behind them), a person's light, a mascot, the
// core (the board's room), a room's platform (the nearest), the lens or the rim. No side effects.
function hit(x, y) {
  if (!view.VP) return null;
  const room = id => ({ kind: 'room', id, room: id });
  for (const g of S.tags) if (x >= g.x0 && x <= g.x1 && y >= g.y0 && y <= g.y1) return room(g.id);
  let best = null, bd = 18;
  for (const P of S.people.values()) { const d = P.hit ? Math.hypot(P.hit.x - x, P.hit.y - y) : 99; if (d < bd) { bd = d; best = P; } }
  if (best) return { kind: 'agent', id: best.id, room: best.room.id };
  for (const c of S.mascots) if (c.hit && Math.hypot(c.hit.x - x, c.hit.y - y) < 24) return { kind: 'mascot', id: c.data.id, room: c.data.home };
  const core = project(CORE);
  if (S.core && core && Math.hypot(core.x - x, core.y - y) < 0.45 * view.scale / view.rs / core.w) return room(S.core.id);
  const { o, d } = ray(x, y), on = py => d[1] ? add(o, scl(d, (py - o[1]) / d[1])) : null;
  const plates = S.rooms.filter(r => built(S, r) > 0.6).sort((a, b) => Math.hypot(...sub(a.pos, o)) - Math.hypot(...sub(b.pos, o)));
  for (const r of plates) { const p = on(r.pos[1]); if (p && Math.hypot(p[0] - r.pos[0], p[2] - r.pos[2]) < r.rp * 1.35) return room(r.id); }
  const p = on(TABLE_Y), rr = p ? Math.hypot(p[0], p[2]) : 99;
  return rr < 0.45 ? { kind: 'object', id: 'lens' } : rr > 2.28 && rr < TABLE_R + 0.05 ? { kind: 'object', id: 'rim' } : null;
}
// the deck's own things: a pat for a mascot; the lens runs a time-lapse; the rim, tapped five times quickly, a party
function act({ kind, id }) {
  const { play } = shell.sound;
  if (kind === 'mascot') world.pet(id);
  else if (id === 'lens') { world.lapse(20); play('rewind'); shell.toast('<b>Time-lapse!</b> A whole day in twenty seconds.'); }
  else if (id === 'rim') { S.rimTaps = S.rimTaps.filter(t => S.t - t < 3).concat(S.t); play('blip'); if (S.rimTaps.length >= 5) { S.rimTaps = []; world.startParty(); } }
}
function focus(target, opts) { return frame(S, target, opts); }
// where a bubble or a card hangs (CSS px): over a person's light, or over a mascot; null off screen
function anchor({ kind, id }) {
  const P = kind === 'agent' && S.people.get(id), c = kind === 'mascot' && S.mascots.find(m => m.data.id === id);
  const at = P?.hit ? project(add(agentAt(S, P), [0, 0.06, 0])) : c?.hit ? project(add(mascotAt(c), [0, 0.25, 0])) : null;
  return at && { x: at.x, y: at.y };
}
// two people on the same platform (one speaks over the other)
const near = (a, b) => !!S.people.get(a.id) && S.people.get(a.id).room === S.people.get(b.id)?.room;
const where = ({ kind, id }) => kind === 'mascot' && S.mascots.some(c => c.data.id === id) ? 'deck' : null;
const hex = c => '#' + c.map(v => Math.round(Math.min(1, v) * 255).toString(16).padStart(2, '0')).join('');
function portrait({ kind, id }) {
  if (kind === 'mascot') { const img = picture(MASCOT, world.mascots.find(m => m.id === id)?.kind); return img && { img, accent: hex(MASCOT) }; }
  const P = S.people.get(id), col = agentColour(P);
  const look = makeLook(world.agents.get(id)?.data ?? { id });
  return { img: picture(col, 'agent', spriteFrame(id, look, 'stand', true, false)), accent: hex(col) };
}

// ---------------------------------------------------------------- the world's signals (after the shell's bubbles)
function listen() {
  const { play, ready } = shell.sound;
  return [
    world.on('status', ({ agent, was }) => { const P = S.people.get(agent); if (P && was !== P.state) S.pulses.push({ c: agentAt(S, P), r: 0.05, t0: S.t, col: P.state === 'waiting' ? AMBER : WHITE }); }),
    world.on('say', ({ agent, to }) => {
      if (!S.people.has(agent) || !(S.people.has(to) || to === 'board')) { play('blip'); return; }
      const [p0, , p2] = flightEnds(S, { a: agent, b: to });
      S.flights.push({ a: agent, b: to, t0: S.t, dur: clamp(Math.hypot(...sub(p2, p0)) * 0.5, 0.8, 2.2), col: to === 'board' || S.people.get(to).room === S.core ? WHITE : AMBER });
      play('whoosh');
    }),
    // a post flies to the newsstand (or up to the crown, where there's none)
    world.on('post', ({ agent }) => { play('jingle'); S.flights.push({ a: agent, b: null, room: S.rooms.find(r => r.w.features.includes('gazette-newsstand')), t0: S.t, dur: 1.6, col: GOLD }); }),
    world.on('log', ({ agent }) => { const P = S.people.get(agent); if (P) S.parts.push({ k: 'text', s: '...', p: add(agentAt(S, P), [0, 0.1, 0]), vy: 0.1, life: 1.2, c: '#dff8ff' }); }),
    world.on('feel', ({ mascot, emote }) => { if (mascot && emote === 'love') pet(mascot); }), // (an agent's: labels.js)
    world.on('party', () => { play('fanfare'); shell.toast('<b>Party on the deck!</b> 🎉'); S.glitch = 1; }),
    world.on('org', () => { const n = S.rooms.length; build(false); if (S.rooms.length > n) { S.glitch = 1; if (ready()) play('twinkle'); } }),
    world.on('day', () => build(false)),
  ];
}
// A mascot, petted (world.pet): hearts, its sound, and its name card
function pet(id) {
  const c = S.mascots.find(x => x.data.id === id);
  if (!c) return;
  shell.sound.play(ART[c.data.kind]?.sound ?? 'twinkle');
  for (let i = 0; i < 3; i++) S.parts.push({ k: 'heart', s: '♥', p: add(mascotAt(c), [rand(-0.06, 0.06), 0.2 + i * 0.06, 0]), vy: 0.12, life: 1.5, c: '#ff8fc8' });
  shell.card({ kind: 'mascot', id }, c.data.name, c.data.role, 3.5);
}

// The showcase tour: the rooms print themselves in again, then the core, every room round the ring and the mascots
function showcase(on) {
  if (!on) return null;
  const stops = [], sub = r => {
    const people = r.w.agentIds.map(id => world.agents.get(id)).filter(Boolean), working = people.filter(A => A.state === 'working').length;
    return people.length ? `${people.length} ${people.length === 1 ? 'agent' : 'agents'} · ${working} working` : r.w.features.includes('gazette-newsstand') ? 'Where the news comes in' : r.w.features.includes('knowledge-search') ? 'Everything the company knows' : '';
  };
  if (S.core) stops.push({ target: { kind: 'room', id: S.core.id }, hold: HOLD, title: S.core.w.name, sub: 'The core: the board, over everything' });
  for (const r of S.rooms) {
    stops.push({ target: { kind: 'room', id: r.id }, hold: HOLD, title: r.w.name, sub: sub(r) });
    for (const m of world.mascots.filter(x => x.home === r.id)) stops.push({ target: { kind: 'mascot', id: m.id }, hold: HOLD, title: m.name, sub: m.role });
  }
  for (const m of world.mascots.filter(x => x.home === S.core?.id)) stops.push({ target: { kind: 'mascot', id: m.id }, hold: HOLD, title: m.name, sub: m.role });
  printIn(S);
  focus({ kind: 'home' });
  return { lead: introLength(S.rooms.length), stops };
}
