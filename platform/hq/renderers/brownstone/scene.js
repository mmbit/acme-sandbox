// The brownstone scene: what the shell drives (a step, a frame, taps, the camera, a resize), the intro, the outside
// walls and the showcase tour's stops.
import { clamp, canvas, cap } from '../../util.js';
import { SX, SY, LOGO_COLOURS, lettering } from './iso.js';
import { spriteFrame, CW, CH } from './sprites.js';
import { darkness, fireworksRate } from './env.js';
import { update, walkCheck, errand } from './sim.js';
import { createRenderer, render, ISLAND } from './render.js';
import { cam, view, home, clampCam, camStep, focus, camera } from './camera.js';
import { build, forget, L, S } from './build.js';
import { find, hit, act, anchor, near } from './hit.js';
import { listen, burst, setParty, CONFETTI } from './react.js';
import { SIGN } from './sign.js';
import { slides } from './billboard.js';
import { ART } from './mascots.js';

export const info = { id: 'brownstone', name: 'Brownstone', context: '2d', label: 'The company as an isometric pixel-art brownstone in a little town' };
const INTRO_STEP = 0.32;        // seconds between floors dropping into place
const WALL_DUR = 0.9;           // seconds for the outside walls to lift off, or come back down
const HOLD = 4.2;               // seconds the tour stays at each of the building's stops
// One scene at a time, like the camera: its state lives here, set up afresh by createScene (a hot swap to a new
// brownstone starts from nothing; only caches of pictures survive).
export let R, world, brand, shell, dpr = 1, SW = 0, SH = 0, now;
let introT, touring, names, lit, camDt;
export const fx = {}; // planes, bells, signTaps, the bar's rounds and how many it's poured
// The outside walls: on (the building from outside) or off (the open dollhouse), remembered per device.
// shut is what's shown. The intro starts closed and opens up unless the walls are on. The tour always opens.
const walls = {};

// brand: the company's brand.yaml (what it leaves out, the brownstone draws its own way) and its names.
// settings.intro: the floors drop into place first. shell: sound, toasts, cards, what its chrome covers.
export function createScene({ canvas: screen, world: w, brand: b, settings, shell: s }) {
  R = createRenderer(screen); world = w; brand = dress(b, w.mascots); names = b.names; shell = s; view.chrome = s.chrome;
  now = view.now = camDt = 0; introT = settings.intro ? 0 : null; touring = false; lit = null; layout.key = null; forget();
  Object.assign(fx, { planes: [], bells: [], signTaps: [], rounds: [], poured: 0 });
  const on = !!s.store.get('walls', false);
  Object.assign(walls, { on, shut: settings.intro || on, anim: null, freeze: null });
  Object.assign(cam, { t: null, vx: 0, vy: 0, held: false, pinching: false });
  const offs = listen();
  if (w.dev) for (const m of w.mascots) if (!ART[m.kind]) console.warn(`[hq] the brownstone has no art for a ${m.kind}, so ${m.name} isn't in the building`);
  return {
    update: step, draw, hit, focus, resize, camera, anchor, highlight: t => { lit = t; }, act, portrait, near, where, showcase,
    // its signals stop, and its sky leaves the page's background
    dispose() { for (const off of offs) off(); document.body.style.background = ''; },
    controls: [{ id: 'walls', title: 'Outside walls', pressed: () => walls.on, toggle: () => setWalls(!walls.on) }],
    dev: {
      R, cam, fx,
      S: () => S,
      L: () => L,
      // what's under a point, in the shape pixel-check.mjs also reads from main
      hit: (x, y) => { const h = find(x * dpr, y * dpr); return h && { type: h.type, room: h.room?.id, agent: h.A?.id }; },
      walkCheck: () => walkCheck(L, S.island),
      errand: (id, kind) => errand(S, S.people.get(id), kind),
      tick: (dt, n) => { for (let i = 0; i < n; i++) update(S, dt, world.hour()); },
      rebuild: () => { layout(); return walkCheck(L, S.island); }, // (world.setOrg's signal rebuilt it: the camera home)
      walls: k => { walls.freeze = k; },
    },
  };
}

// The brand as the brownstone draws it. Without logo pixels the logo is the company's name in the pixel font (a
// word a line on the billboard); sign.text puts other words on the sign and the plaque. mascots: the world's.
function dress({ name, logo = {}, sign = {}, billboard }, mascots) {
  const art = logo.pixels ? { pixels: logo.pixels, lines: logo.lines ?? [[0, logo.pixels[0].length]] } : lettering(name);
  const l = { ...art, colours: { ...LOGO_COLOURS, ...logo.colours } };
  return { logo: l, sign: { ...SIGN, ...sign, pixels: sign.text ? lettering(sign.text).pixels : l.pixels }, billboard: slides(billboard, mascots) };
}

// w, h: the screen in CSS px
function resize(w, h, d) {
  dpr = d; SW = Math.round(w * d); SH = Math.round(h * d);
  Object.assign(view, { SW, SH, dpr });
  layout();
}
// a new layout when the screen changes shape (or when asked), then the camera home
function layout(force) {
  const key = `${SW > SH}|${Math.round(SW / 200)}|${Math.round(SH / 200)}`;
  if (force || key !== layout.key) { layout.key = key; build(); }
  cam.min = L.zFit; cam.max = Math.max(cam.min + 4, Math.round(9 * dpr));
  home(true);
}
// the org or the day changed (the world's signals: react.js)
export function rebuild() { build(); clampCam(); }

// ---------------------------------------------------------------- the frame
function step(dt) {
  now += dt; view.now = now; camDt = dt;
  if (introT != null) stepIntro(dt);
  if (walls.anim && now - walls.anim.t0 > WALL_DUR) walls.anim = null;
  const h = world.hour(), load = world.load(), { play, ready } = shell.sound;
  S.busy = load.busy; S.engineBusy = load.engines; S.dockBusy = load.deliveries; S.requests = world.requests; S.machine = world.machine; S.onAir = world.onAir();
  S.studio = world.studio;
  update(S, dt, h);
  if (S.party > 0) { // (through the frame the world ends it in: its last confetti)
    S.party = world.party;
    const b = L.bounds;
    if (Math.random() < dt * 40) S.parts.push({ k: 'confetti', sx: b.x0 + Math.random() * (b.x1 - b.x0), sy: b.y0 + 20, vx: (Math.random() - 0.5) * 20, vy: 12, g: 16, life: 5, c: CONFETTI[Math.random() * 5 | 0] });
    if (S.party <= 0) setParty(false);
  }
  fx.planes = fx.planes.filter(p => { p.t += dt / p.dur; if (p.t >= 1) { burst(p.B, '!'); play('pop'); return false; } return true; });
  // typing ticks from working agents on screen, only when zoomed in
  if (ready() && cam.z / dpr >= 3 && Math.random() < dt * 5 && [...S.people.values()].some(A => A.pose === 'type' && onScreen(A.x, A.y, A.lvl))) play('tick');
  shell.sound.weather(S.weather.rain * (cam.z / dpr < 6 ? 1 : 0.6), darkness(h), S.weather.snow);
  if (ready() && darkness(h) < 0.3 && S.weather.rain < 0.3 && Math.random() < dt / 9) play('chirp');
  // New Year's Eve: the fireworks over the city, heard now and then (out of step with the sky: they're far away)
  if (ready() && L.holidays.has('newYear') && Math.random() < dt * fireworksRate(h) * darkness(h) / 3) play('boom');
}
// the floors drop into place one by one, each with a thump, then the building opens up
function stepIntro(dt) {
  const n = introStops(), landed = n * INTRO_STEP + 0.35, before = introT;
  introT += dt;
  const floor = Math.floor(introT / INTRO_STEP);
  if (floor !== Math.floor(before / INTRO_STEP) && floor <= n && floor > 0) shell.sound.play('thump', floor);
  if (before < landed && introT >= landed) setShut(walls.on && !touring);
  if (introT > n * INTRO_STEP + 1) introT = null;
}
function onScreen(x, y, lvl) {
  const sx = (SX(x, y) - cam.x) * cam.z + SW / 2, sy = (SY(x, y, L.level(lvl)?.z ?? 0) - cam.y) * cam.z + SH / 2;
  return sx > 0 && sx < SW && sy > 0 && sy < SH;
}
function introStops() { return L.nDown + L.nUp + 2; }
// how open the outside walls are: 0 closed .. 1 open. The whole façade (every floor, the roof, the soil over
// the basement) lifts off together, so i (the level) doesn't matter.
function wallOpen() {
  const a = walls.anim;
  if (walls.freeze != null) return walls.freeze; // (dev: a still of the lift)
  if (!a) return walls.shut ? 0 : 1;
  const p = clamp((now - a.t0) / WALL_DUR, 0, 1);
  return a.open ? p : 1 - p;
}
// a reversal mid-way carries on from where the façade is
function setShut(shut) {
  if (shut === walls.shut) return;
  const open = wallOpen();
  walls.shut = shut;
  walls.anim = { t0: now - (shut ? 1 - open : open) * WALL_DUR, open: !shut };
  if (shell.sound.ready()) shell.sound.play('whoosh');
}
export function setWalls(on) {
  walls.on = on; shell.store.set('walls', on);
  if (introT == null || walls.anim) setShut(on && !touring);
}
// The showcase tour starts with the intro, walls down: how long that takes (s) and the building's stops, top floor
// first. When the tour ends, the walls go back to how they were.
function showcase(on) {
  touring = on;
  if (!on) { if (introT == null || walls.anim) setShut(walls.on); return; }
  // a department split over several wings is one stop, at its first part, framing them all
  // (and the photo studio's darkroom, keeper or not)
  const stops = [], rooms = L.rooms.filter(r => (r.agents.length || r.features.length || r.pent || r.kind === 'darkroom') && !(r.part > 1)).sort((a, b) => b.level - a.level || (a.x0 + a.y0) - (b.x0 + b.y0));
  for (const r of rooms) {
    const people = L.rooms.filter(p => p.src === r.src).flatMap(p => p.agents).map(a => world.agents.get(a.id)).filter(Boolean), working = people.filter(A => A.state === 'working').length;
    const pets = world.mascots.filter(m => m.home === r.src), met = pets.filter(m => ART[m.kind]).map(m => m.name).join(' and ');
    const drying = world.studio?.waiting ?? 0; // (the photos in the board's batch.)
    stops.push({ target: { kind: 'room', id: r.src }, hold: HOLD, title: r.pent ? 'The Penthouse' : r.name, sub: r.pent ? `The board${met ? `, and ${met} on the terrace` : ''}`
      : r.kind === 'darkroom' ? (drying ? `${drying} ${drying === 1 ? 'photo' : 'photos'} drying` : 'Where the product photos develop') : people.length ? `${people.length} ${people.length === 1 ? 'agent' : 'agents'} · ${working} working` : r.features.includes('gazette-newsstand') ? `${cap(names.newsletter)} hits the newsstand here` : r.features.includes('knowledge-search') ? 'Everything the company knows' : '' });
    for (const m of pets) stops.push({ target: { kind: 'mascot', id: m.id }, hold: HOLD, title: m.name, sub: m.role });
  }
  stops.push({ target: { kind: 'object', id: 'van' }, hold: HOLD, title: 'Loading dock', sub: `The van comes when ${world.rooms.find(r => r.kind === 'dock')?.name ?? 'the dock'} is busy` });
  introT = 0; walls.shut = true; walls.anim = null; home(false);
  return { lead: introStops() * INTRO_STEP + 0.8, stops };
}
// How far level i is above its place during the intro, in world px: the island rises from below, then the
// floors drop in from above, bottom first, each with a small bounce.
function introOffset(i) {
  if (introT == null) return 0;
  const order = i === ISLAND ? 0 : i + L.nDown + 1, t = introT - order * INTRO_STEP;
  if (i === ISLAND) {
    if (t < 0) return -240;
    const k = Math.min(1, t / 0.55);
    return -240 * (1 - k) ** 3;
  }
  if (t < 0) return 1000;
  const k = Math.min(1, t / 0.42);
  if (k < 1) return 320 * (1 - (1 - (1 - k) ** 2));
  return Math.max(0, Math.sin((t - 0.42) * 18) * 5 * Math.exp(-(t - 0.42) * 8));
}
// t: the shell's time (s). The camera eases here, after the shell's step, so a move asked for during it starts this
// frame: the tour picks its next stop after update (its whoosh draws on Math.random after the simulation's).
function draw(t) {
  camStep(camDt);
  now = view.now = t;
  render(R, S, L, cam, { SW, SH, dpr, t: now, hour: world.hour(), selected: lit && S.people.get(lit.id), planes: fx.planes, rounds: fx.rounds, intro: introT != null ? introOffset : null, walls: wallOpen }); // (rounds: the bar's)
}

// A picture for the panels and the colour to frame it in: an agent standing, in their shirt's colour, or a mascot
// sitting ({ kind: 'agent' | 'mascot', id }); null for a mascot of a kind the brownstone doesn't draw
function portrait({ kind, id }) {
  const c = canvas(CW, CH), g = c.getContext('2d');
  if (kind === 'mascot') {
    const frame = ART[world.mascots.find(m => m.id === id)?.kind]?.frame;
    if (!frame) return null;
    g.drawImage(frame('sit', false), 0, CH - 14); return { img: c, accent: '#ffd966' };
  }
  const A = S.people.get(id);
  g.drawImage(spriteFrame(A.id, A.look, 'stand', true, false), 0, 0);
  return { img: c, accent: A.look.shirt };
}
// where a mascot lives, as the panels name it (null: it isn't in the building)
const where = ({ kind, id }) => kind === 'mascot' && S.mascots.some(c => c.data.id === id) ? 'roof terrace' : null;
