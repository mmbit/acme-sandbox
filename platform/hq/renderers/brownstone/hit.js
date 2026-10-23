// Taps on the brownstone: what's under a point, where someone is on screen, and the building's own answers (the
// bell, the sign, the water tower…).
import { SX, SY, toTile } from './iso.js';
import { darkness, pickWeather } from './env.js';
import { callLift } from './sim.js';
import { ART } from './mascots.js';
import { ROUND } from './rooms.js';
import { DRINKS } from './sprites.js';
import { onLid } from './facade.js';
import { cam, toWorld } from './camera.js';
import { L, S } from './build.js';
import { R, world, shell, dpr, now, fx, setWalls } from './scene.js';

// What's under a point (device px), as the building knows it: an agent, a mascot, a room or one of rooms.js' hot
// spots (with its room), the sign, the orb and the island's things
export function find(sx, sy) {
  const p = toWorld(sx, sy), pad = 6 * dpr / cam.z;
  const inR = h => h && p.x >= h.x0 - pad && p.x <= h.x1 + pad && p.y >= h.y0 - pad && p.y <= h.y1 + pad;
  for (let i = R.hits.length - 1; i >= 0; i--) if (inR(R.hits[i].hit)) return { type: 'agent', A: R.hits[i] };
  for (const c of S.mascots) if (inR(c.hit)) return { type: 'cat', c }; // (type cat: what pixel-check.mjs taps on both sides)
  if (R.sign && inR(R.sign.hot)) return { type: 'sign' };
  for (const d of S.island.ducks) if (d.hit && Math.abs(p.x - d.hit.sx) < 6 + pad && Math.abs(p.y - d.hit.sy) < 5 + pad) return { type: 'duck' };
  if (S.van.state !== 'away' && R.van && Math.abs(p.x - R.van.sx - 20) < 34 && Math.abs(p.y - R.van.sy - 4) < 18) return { type: 'van' };
  const ch = S.island.chest; if (Math.abs(p.x - ch.sx) < 7 && Math.abs(p.y - ch.sy) < 6) return { type: 'chest' };
  const shut = lv => R.shut?.(lv.i);
  if (R.lidded && onLid(R.facade, p.x, p.y)) return { type: 'walls', room: L.pent };
  for (let li = L.levels.length - 1; li >= 0; li--) {
    const lv = L.levels[li];
    if (shut(lv)) continue;
    for (let k = lv.rooms.length - 1; k >= 0; k--) for (const h of lv.rooms[k].pent && R.lidded ? [] : lv.rooms[k].art.hot) {
      const hx = SX(h.x, h.y), hy = SY(h.x, h.y, h.z);
      if (Math.abs(p.x - hx) <= h.w * 12 + pad && p.y <= hy + 6 + pad && p.y >= hy - h.h - pad) return h;
    }
  }
  if (R.orb && Math.hypot(p.x - R.orb.wx, p.y - R.orb.wy) < 12 + pad) return { type: 'orb' };
  for (let li = L.levels.length - 1; li >= 0; li--) {
    const lv = L.levels[li], rooms = lv.rooms.slice().reverse();
    for (const hgt of [0, 12, 24, 36]) for (const r of rooms) {
      const t = toTile(p.x, p.y, lv.z + hgt);
      if (t.x >= r.x0 && t.x < r.x1 && t.y >= r.y0 && t.y < r.y1) return { type: shut(lv) || (r.pent && R.lidded) ? 'walls' : 'room', room: r };
    }
  }
  return null;
}
// The same for the shell (x, y: CSS px): { kind: 'agent' | 'mascot' | 'room' | 'object', id, room }. The hot spots
// the shell opens go by its names for them.
const OBJECT = { gazette: 'news', search: 'library' };
export function hit(x, y) {
  const h = find(x * dpr, y * dpr);
  if (!h) return null;
  if (h.A) return { kind: 'agent', id: h.A.id };
  if (h.c) return { kind: 'mascot', id: h.c.data.id };
  // id: the world's room (a department), room: the part of it tapped
  // (a room of the building's own with an app, like the photo studio's darkroom, opens that app.)
  if (h.type === 'room' && h.room.app) return { kind: 'object', id: h.room.app, room: h.room.id };
  if (h.type === 'room') return { kind: 'room', id: h.room.src ?? h.room.id, room: h.room.id };
  // a machine opens the machines' settings, the lent one (the rig) at its own page; hint: what the mouse says over it
  if (h.type === 'machine') {
    const m = h.rig ? world.machine : null;
    return { kind: 'object', id: 'machine', room: h.room.id, machine: m?.id ?? null, hint: m ? `${m.name}: status and settings` : 'Machines: status and settings' };
  }
  return { kind: 'object', id: OBJECT[h.type] || h.type, room: h.room?.id };
}

// Where a bubble or a card hangs, in CSS px: over an agent's head, or beside a mascot (so the heart from a pat
// floats up clear). null while they aren't drawn.
export function anchor({ kind, id }) {
  const X = kind === 'agent' ? S.people.get(id) : kind === 'mascot' ? S.mascots.find(c => c.data.id === id) : null;
  if (!X?.hit || !R.toScreen) return null;
  const p = kind === 'agent' ? R.toScreen(X.hit.sx, X.hit.y0 - 2) : R.toScreen(X.hit.sx + 40, X.hit.sy + 4);
  return { x: p.x / dpr, y: p.y / dpr };
}
// two agents standing right by each other (one speaks over the other)
export function near(a, b) {
  const A = S.people.get(a.id), B = S.people.get(b.id);
  return !!A && !!B && A.room === B.room && Math.abs(A.x - B.x) + Math.abs(A.y - B.y) < 1.5;
}

// The taps the building answers itself (the shell answers people, rooms and the desk's things)
const WEATHER_PICKED = { rain: 'Let it rain', showers: 'Sun and showers', snow: 'Let it snow', fog: 'Pea soup', cloudy: 'Clouds, please', clear: 'Blue skies' };
export function act({ kind, id, room: roomId }) {
  const { play } = shell.sound, room = L.rooms.find(r => r.id === roomId);
  if (kind === 'mascot') world.pet(id);
  else if (id === 'bell') ringBell(room);
  else if (id === 'sign') { fx.signTaps = fx.signTaps.filter(t => now - t < 3).concat(now); play('blip'); if (fx.signTaps.length >= 5) { fx.signTaps = []; world.startParty(); } }
  else if (id === 'elevator') { callLift(S, room.level); play('blip'); }
  else if (id === 'jacuzzi') { play('blub'); const j = room.art.anchors.jacuzzi; for (let i = 0; i < 16; i++) S.parts.push({ k: 'confetti', sx: SX(j.x, j.y) + (Math.random() - 0.5) * 30, sy: SY(j.x, j.y, j.z), vx: (Math.random() - 0.5) * 8, vy: -20 - Math.random() * 20, g: 30, life: 1.2, c: '#bfe6ff' }); }
  else if (id === 'weather') { const k = pickWeather(); S.pickedAt = S.t; play('blip'); shell.toast(k ? `<b>${WEATHER_PICKED[k]}!</b> The water tower obliges.` : '<b>Back to the real weather.</b> The water tower rests.'); }
  else if (id === 'telescope') { play('twinkle'); shell.toast(darkness(world.hour()) > 0.5 ? '<b>A shooting star!</b> Make a wish for the next launch.' : '<b>Land ho!</b> You can see all the way to the next venture from up here.'); }
  else if (id === 'orb') { world.lapse(20); play('rewind'); shell.toast('<b>Time-lapse!</b> A whole day in twenty seconds.'); }
  else if (id === 'duck') play('quack');
  else if (id === 'van') play('honk');
  else if (id === 'chest') { play('jingle'); shell.toast('<b>You found the time capsule!</b> Buried on day one. Open it at the first million.'); }
  else if (id === 'walls') setWalls(false); // tapping the closed building opens it up
  else if (id === 'bar') pour();
}
// A mascot, petted (world.pet): it stops where it is to enjoy it (at night it carries on to bed after), and its name
// card shows
export function pet(id) {
  const c = S.mascots.find(x => x.data.id === id);
  if (!c) return;
  shell.sound.play(ART[c.data.kind].sound);
  if (c.goal) { c.goal = null; c.to = null; }
  if (c.hit) S.parts.push({ k: 'heart', sx: c.hit.sx - 2, sy: c.hit.y0 - 6, vy: -6, life: 1.5 });
  shell.card({ kind: 'mascot', id }, c.data.name, c.data.role, 3.5);
}
function ringBell(room) {
  shell.sound.play('ding');
  fx.bells = fx.bells.filter(t => now - t < 2.5).concat(now);
  if (fx.bells.length >= 3) { fx.bells = []; callLift(S, room.level); shell.later(() => shell.toast('The elevator is here. Going up?'), 1400); }
}
// The cocktail bar, tapped: a round (rooms.js ROUND, drawn by render.js drawBar). A tap while the shaker is still
// going orders the next drink after it; three on the counter at once and the bar has its hands full.
const KINDS = Object.keys(DRINKS);
function pour() {
  const end = ROUND.shake + ROUND.pour + ROUND.slide + ROUND.stay;
  fx.rounds = fx.rounds.filter(r => now < r.t0 + end);
  const free = [0, 1, 2].find(k => !fx.rounds.some(r => r.stop === k));
  if (free == null) return shell.sound.play('blip');
  const last = fx.rounds.at(-1), t0 = Math.max(now, last ? last.t0 + ROUND.shake + ROUND.pour : 0);
  fx.rounds.push({ t0, stop: free, kind: KINDS[fx.poured++ % KINDS.length] });
  shell.sound.play('shake', t0 - now, ROUND.shake);
  shell.sound.play('serve', t0 - now + ROUND.shake, ROUND.pour, ROUND.slide);
}
