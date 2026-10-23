// How the building answers the world's signals: people decide what to do next, paper planes, confetti, a party, and
// a new building for a new org or day.
import { clamp } from '../../util.js';
import { SX, SY } from './iso.js';
import { clearSpriteCache } from './sprites.js';
import { decide, onChat, onPost, meetingRoomOf } from './sim.js';
import { L, S, lightState } from './build.js';
import { rigLook } from './layout.js';
import { world, shell, fx, rebuild } from './scene.js';
import { pet } from './hit.js';

export const CONFETTI = ['#e8505b', '#ffd966', '#5b8def', '#7bd389', '#ff8fab'];

// Signals come after the world has changed (A's state, the logs) and after the shell's bubbles. A, B: our people.
// Returns what stops them all.
let recorded = '';   // the shows being recorded, as last seen (the status signal)
export function listen() {
  return [
    world.on('status', ({ agent, was }) => {
      const A = S.people.get(agent);
      // a recording starting or ending (a working host's next job can be a show): its hosts go to the booth or back
      const on = world.shows.filter(s => [...world.agents.values()].some(B => world.recording(B) === s)).map(s => s.id).join(), air = on !== recorded;
      recorded = on;
      if (was !== A.state || A.state === 'waiting' || air) decide(S, A);
      if (air) for (const s of world.shows) for (const id of s.hosts) { const H = S.people.get(id); if (H && H !== A) decide(S, H); }
      for (const X of S.people.values()) if (X !== A && X.room === A.room && X.state === 'waiting') decide(S, X);
      lightState();
    }),
    world.on('say', ({ agent, to }) => {
      const A = S.people.get(agent), B = S.people.get(to);
      if (B && A.hit && B.hit) { fx.planes.push({ A, B, t: 0, dur: clamp(Math.hypot(B.hit.sx - A.hit.sx, B.hit.y0 - A.hit.y0) / 70, 0.8, 3), arc: 12 + Math.abs(B.hit.sx - A.hit.sx) * 0.15 }); shell.sound.play('whoosh'); } else shell.sound.play('blip');
      onChat(S, A, B);
    }),
    world.on('post', () => { shell.sound.play('jingle'); newsBurst(); onPost(S, shell.later); }),
    world.on('log', ({ agent }) => { const A = S.people.get(agent); if (A.hit) S.parts.push({ k: 'text', s: '...', sx: A.hit.sx - 5, sy: A.hit.y0 - 8, vy: -4, life: 1.2, c: '#fffaf0' }); }),
    world.on('feel', ({ mascot, emote }) => { if (mascot && emote === 'love') pet(mascot); }), // (an agent's: drawEmotes)
    world.on('party', () => setParty(true)), // (the step ends it, after its last confetti)
    world.on('org', rebuild),
    // a meeting starting, ending, or its people changing: whoever is now in another place than the one they hold (a
    // chair at a meeting room's table, or none) goes there
    world.on('meetings', () => {
      for (const A of S.people.values()) if ((A.claim?.meet ? A.claim.room : null) !== meetingRoomOf(S, world.meetingOf(A.id))) decide(S, A);
    }),
    // the photo studio opening or closing, or a new keeper (its counts the darkroom reads every frame).
    world.on('studio', () => { const d = L.rooms.find(r => r.kind === 'darkroom'); if (!!world.studio !== !!d || (d && d.keeper !== world.studio.keeper)) rebuild(); }),
    world.on('machines', () => { if (JSON.stringify(rigLook(world)) !== JSON.stringify(L.rigLook)) rebuild(); }),
    world.on('day', rebuild),
  ];
}
function newsBurst() {
  const lobby = L.rooms.find(r => r.art.anchors.news); if (!lobby) return;
  const s = lobby.art.anchors.news.spark, sx = SX(s.x, s.y), sy = SY(s.x, s.y, s.z);
  for (let i = 0; i < 40; i++) S.parts.push({ k: 'confetti', sx, sy, vx: (Math.random() - 0.5) * 60, vy: -30 - Math.random() * 30, g: 60, life: 2.2, c: CONFETTI[i % 5] });
}
// a word popping up over someone's head
export function burst(A, s, c = '#e8505b') { if (A?.hit) S.parts.push({ k: 'text', s, sx: A.hit.sx - 1, sy: A.hit.y0 - 10, vy: -8, life: 1.2, c }); }
export function setParty(on) {
  S.party = world.party;
  for (const A of S.people.values()) A.look.party = on;
  clearSpriteCache();
  if (on) { shell.sound.play('fanfare'); shell.toast('<b>Party on every floor!</b> 🎉'); }
}
