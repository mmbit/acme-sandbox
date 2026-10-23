// Builds the brownstone from the world: the layout, each room's art, the island, the simulation and its people.
import { trim } from '../../util.js';
import { buildLayout } from './layout.js';
import { makeLook } from './sprites.js';
import { buildRoom } from './rooms.js';
import { buildIsland, season, today, holidays } from './env.js';
import { createSim, carryLift, initAgent, walkCheck } from './sim.js';
import { buildRoofBits } from './sign.js';
import { buildFacade } from './facade.js';
import { cam, view } from './camera.js';
import { R, world, brand, shell, SW, SH, dpr } from './scene.js';
import * as audio from '../../shell/audio.js';

export let L, S; // the layout and the simulation: rebuilt when the org, the screen's shape or the day changes
// a new scene's building carries nothing over from the last one's (the lift, a party)
export const forget = () => { L = S = null; };

export function build() {
  L = view.L = buildLayout(world, SW, SH);
  L.day = today().toDateString(); L.holidays = holidays(today(), world.hour());
  audio.setHolidays(L.holidays);
  const looks = new Map();
  for (const room of L.rooms) for (const a of room.agents) looks.set(a.id, makeLook(a));
  for (const room of L.rooms) {
    const art = room.art = buildRoom(room, L, looks), t = trim(art.c);
    art.c = t.c; art.cx = art.bx + t.dx; art.cy = art.by + t.dy;
    if (art.m) { const tm = trim(art.m); art.m = tm.c; art.mx = art.bx + tm.dx; art.my = art.by + tm.dy; }
  }
  const island = buildIsland(L, season());
  const oldS = S;
  S = createSim(L, island, world);
  if (oldS) carryLift(S, oldS);
  S.onVan = e => shell.sound.play('whirr', e === 'leave');
  S.onFlap = () => { if (cam.z / dpr >= 3) shell.sound.play('flap'); };
  let i = 0;
  for (const room of L.rooms) room.agents.forEach((a, k) => {
    // the world's agent (their state, task and log stay the world's), here in this building
    const A = Object.assign(Object.create(world.agents.get(a.id)), { room, i: i++, look: looks.get(a.id), seat: room.art.anchors.seats[k] });
    S.people.set(a.id, A);
    initAgent(S, A);
    // straight into the chair, arriving or already here: a rebuild (the team changed) isn't a reason to stand up
    if (A.plan.some(p => p.t === 'sit') && A.seat) { A.x = A.seat.x; A.y = A.seat.y; A.plan = [{ t: 'sit' }]; }
  });
  buildRoofBits(R, L, brand, L.holidays.has('birthday'));
  R.facade = buildFacade(L, season(), brand);
  if (world.dev) for (const w of walkCheck(L, island)) console.warn('[hq] layout:', w);
  lightState();
}
// rooms where everyone is asleep switch their lights off (src: the world's room a layout room shows; a room of the
// building's own with people in it, like the darkroom, by its own people.)
export function lightState() {
  for (const r of L.rooms) {
    const w = world.rooms.find(x => x.id === r.src);
    r.dark = w ? !!w.asleep : r.agents.length > 0 && r.agents.every(a => world.agents.get(a.id)?.state === 'sleeping');
  }
}
