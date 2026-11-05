// A call held across a lost connection (call.js): the board's words kept until the line has them, and a page that left
// mid-call calling back into it.
import { store } from '../util.js';
import { transcribe, turnEnded } from './callscreen.js';

// A call that ended without a hang-up (the page left or reloaded, or the line dropped) waits HOLD_MS on the line's end
// (platform/voice, HOLD): calling the same agent again in that time, from any of HQ's pages on this browser, rejoins it.
// (The line rejoins a dial to an agent whose call is still on by itself too, as from a page that froze and never said it
// lost the call: this only says Rejoining.)
// Kept from pickup to hang-up as { id, agent, request, lost }, lost: when this page lost it (0 while it still has it).
const HOLD_MS = 600000,
  HELD = 'heldCall';

const keep = (c, lost) => store.set(HELD, { id: c.id, agent: c.agent, request: c.request, lost });
// The call on this page is up: it's this page's until it's lost
export const holdCall = c => keep(c, 0);
// The page lost the call (it left, or the line dropped): its HOLD_MS count from now
export const lostCall = c => keep(c, Date.now());
// Hung up: nothing to rejoin
export const letCallGo = () => store.set(HELD, null);
// The call with this agent that was lost under HOLD_MS ago, or null: a call about a card rejoins only one about the
// same card; one from the agent's panel or the intercom (request 0) rejoins whatever it was about
export function heldCall(agent, request) {
  const held = store.get(HELD, null),
    sameCard = !request || held?.request === request;
  return held?.agent === agent && sameCard && held.lost && Date.now() - held.lost < HOLD_MS ? held : null;
}
// The line picked up the call this page called back into: it has the board's samples up to here (heard), and the
// transcript so far shows again
export function rejoined(c, ev) {
  c.keptFrom = ev.heard;
  for (const line of ev.said) {
    transcribe(c, line.who, line.text);
    turnEnded(c);
  }
}

// The board's words outlast a dropped connection. From pickup on, each microphone frame (FRAME samples) is kept until
// the line says it has it (`heard`: its samples so far, all call, with each pong): what was still queued in a socket
// that dropped, and what the microphone made while reconnecting. None is dropped unheard: the pongs clear it twice a
// second while connected, it grows only as the socket's own queue does on a weak uplink, and a reconnect ends within
// the line's hold (HOLD_MS). The line's `call` on the new connection says what it has; the rest goes first, with a ping
// from when it was made every pingMs (call.js PING_MS), so the line reads it as late and waits for all of it before it
// answers (platform/voice, LATE). (An older line says nothing: none is kept.).
const FRAME = 320;
export function sendFrame(c, frame) {
  if (!c.id) return; // (not picked up yet: nobody hears it)
  c.kept.push({ frame, at: performance.now() });
  if (c.ws?.readyState === 1 && c.live) c.ws.send(frame);
}
export function forgetHeard(c, heard) {
  const n = Number.isFinite(heard) ? Math.min(c.kept.length, Math.floor((heard - c.keptFrom) / FRAME)) : c.kept.length;
  if (n > 0) {
    c.kept.splice(0, n);
    c.keptFrom += n * FRAME;
  }
}
export function resend(c, heard, pingMs) {
  forgetHeard(c, heard);
  let pinged = -Infinity;
  for (const { frame, at } of c.kept) {
    if (at - pinged >= pingMs) {
      pinged = at;
      c.ws.send(JSON.stringify({ type: 'ping', t: Math.round(at) }));
    }
    c.ws.send(frame);
  }
}
