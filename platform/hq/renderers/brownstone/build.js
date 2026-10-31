// Builds the brownstone from the world: the layout, each room's art, the island, the simulation and its people
import { trim } from '../../util.js';
import { buildLayout } from './layout.js';
import { makeLook } from './sprites.js';
import { buildRoom } from './rooms.js';
import { buildIsland, season, today, holidays } from './env.js';
import { createSim, carryLift, leave, initAgent, walkCheck } from './sim.js';
import { roofBits } from './sign.js';
import { buildFacade } from './facade.js';
import { cam, view } from './camera.js';
import { R, world, brand, shell, SW, SH, dpr } from './scene.js';
import * as audio from '../../shell/audio.js';

// the building on show and its simulation: a kept building when the screen's shape changes back, built anew when the
// org or the day changes
export let L, S;
// The two buildings kept, each with its screen's shape (scene.js's layout key): the one on show, and the other one,
// laid out ahead or shown last. A screen that changes back (the book opening beside HQ's page and shutting again) takes
// its building up again rather than building it anew.
let shown = null,
  other = null;
// the world changed (the org, the day): every building is built anew as it's next needed
export const forgetKept = () => {
  shown = other = null;
};
// a new scene's building carries nothing over from the last one's (the lift, a party)
export const forget = () => {
  L = S = null;
  forgetKept();
};

// The building for the screen's shape (key) and a new simulation in it
export function build(key) {
  const b = [shown, other].find(k => k?.key === key) ?? { key, ...building(SW, SH) };
  if (b !== shown) [shown, other] = [b, shown];
  enter(b);
}
// The building for a screen of sw × sh (device px) laid out ahead, for when the screen takes its shape (key)
export function prepare(key, sw, sh) {
  if (shown?.key !== key && other?.key !== key) other = { key, ...building(sw, sh) };
}

// The building alone: its layout, each room's art, the island, the roof's sign and bunting, and the façade
function building(sw, sh) {
  const layout = buildLayout(world, sw, sh);
  layout.day = today().toDateString();
  layout.holidays = holidays(today(), world.hour());
  const looks = new Map();
  for (const room of layout.rooms) for (const a of room.agents) looks.set(a.id, makeLook(a));
  for (const room of layout.rooms) {
    const art = (room.art = buildRoom(room, layout, looks));
    [art.c, art.cx, art.cy] = trimmed(art, art.c);
    if (art.m) [art.m, art.mx, art.my] = trimmed(art, art.m);
  }
  const island = buildIsland(layout, season());
  if (world.dev) for (const w of walkCheck(layout, island)) console.warn('[hq] layout:', w);
  return {
    L: layout,
    looks,
    island,
    roof: roofBits(layout, brand, layout.holidays.has('birthday')),
    facade: buildFacade(layout, season(), brand),
  };
}

// The simulation in this building, the lift where it was
function enter(b) {
  const oldS = S;
  if (oldS) leave(oldS);
  L = view.L = b.L;
  audio.setHolidays(L.holidays);
  S = createSim(L, b.island, world);
  if (oldS) carryLift(S, oldS);
  S.onVan = e => shell.sound.play('whirr', e === 'leave');
  S.onFlap = () => {
    if (cam.z / dpr >= 3) shell.sound.play('flap');
  };
  let i = 0;
  for (const room of L.rooms)
    room.agents.forEach((a, k) => {
      // the world's agent (their state, task and log stay the world's), here in this building
      const A = Object.assign(Object.create(world.agents.get(a.id)), {
        room,
        i: i++,
        look: b.looks.get(a.id),
        seat: room.art.anchors.seats[k],
      });
      S.people.set(a.id, A);
      initAgent(S, A);
      // straight into the chair, arriving or already here: a rebuild (the team changed) isn't a reason to stand up
      if (A.plan.some(p => p.t === 'sit') && A.seat) {
        A.x = A.seat.x;
        A.y = A.seat.y;
        A.plan = [{ t: 'sit' }];
      }
      A.look.party = S.party > 0; // setParty reached only the building on screen, so a kept one's looks catch up here
    });
  R.sign = b.roof.sign;
  R.bunting = b.roof.bunting;
  R.facade = b.facade;
  lightState();
}
// A room's canvas cut to what's drawn on it, and where that sits
const trimmed = (art, c) => {
  const t = trim(c);
  return [t.c, art.bx + t.dx, art.by + t.dy];
};
// rooms where everyone is asleep switch their lights off (src: the world's room a layout room shows; a room of the
// building's own with people in it, like the darkroom, by its own people.)
export function lightState() {
  for (const r of L.rooms) {
    const w = world.rooms.find(x => x.id === r.src);
    r.dark = w ? !!w.asleep : r.agents.length > 0 && r.agents.every(a => world.agents.get(a.id)?.state === 'sleeping');
  }
}
