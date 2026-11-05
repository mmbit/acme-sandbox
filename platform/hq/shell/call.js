// A live call with anyone on the team, streamed both ways over one WebSocket to the voice line (platform/voice):
// the microphone goes out as 20 ms frames of 16 kHz PCM, the agent's voice comes back the same way and plays as
// it arrives. The voice line hears when the board stops talking, and stops the agent when the board talks over it.
// The call's audio is callaudio.js's, shared with the join link's page: the voice through an <audio> element for the
// echo canceller, the screen kept on, the microphone brought back after the screen went off.
// The call is a layer of its own over whatever HQ shows, and minimises into a bubble while it goes on (callscreen.js).
// The Pencil writes on HQ during a call, and the agent asks to see and draws in its own ink (calldraw.js), and opens
// a piece of work on the board's screen and drives it (calldrive.js).
import { esc } from '../util.js';
import { loadLanguage } from './data.js';
import { hush, cue, cueRepeating, cueInto } from './audio.js';
import { CallAudio } from './callaudio.js';
import { shareCallMicrophone } from './callmic.js';
import { gotStream } from '/__review/micallowed.js';
import * as world from '../world/world.js';
import { toast } from './hud.js';
import { names } from './brand.js';
import {
  openLayer,
  closeLayer,
  minimise,
  expand,
  shareKey,
  screenToLine,
  transcribe,
  turnEnded,
  turnTakenBack,
} from './callscreen.js';
import { startPictures, picturesLive, pictureState, showPictures, stopPictures } from './callpictures.js';
import { startDrop, stopDrop } from './calldrop.js';
import { forgetHeard, heldCall, holdCall, letCallGo, lostCall, rejoined, resend, sendFrame } from './callheld.js';
import { FROM_LINE as DRAWING, reconnected, startDrawing, stopDrawing } from './ink/calldraw.js'; // (Ink's folder)
import { FROM_LINE as DRIVING, stopDriving, wiped } from './calldrive.js';
import { askHangUp, guestKey, guestsToLine, listed } from './callguest.js'; // (guestsToLine; askHangUp)
import { handFromLine } from './callhand.js';
import { lagging, PING_MS } from './calllag.js';
import { ceoName, closeTool, openIntercom, openComputer, intercomOpen, notesComing, watchCall } from './desk.js';
import { tell } from './alert.js';

const $ = s => document.querySelector(s);
let call = null;
export const inCall = () => !!call;
// (once the call's microphone has started; none if it didn't, the call ending.)
shareCallMicrophone(() =>
  call?.started.then(
    () => call?.audio.stream,
    () => null,
  ),
);
// The call open over HQ, its screen in front: Escape makes it small (desk.js)
export const callInFront = () => !!call && !call.small;
export const minimiseCall = () => call && minimise(call);
// Whom the call on is with (its name), or null with none
export const callName = () => call?.name ?? null;

// Call someone: the call opens over whatever is on screen (their panel, a card, Reviews), which is there again when it
// ends. The intercom closes instead, at the call's start and its end: the call's screen takes its place, so minimising
// leaves only the bubble, and a call over leaves no chat behind. request:
// the card it's about.
// walk: from a card's Walk me through it (calldraw.js). pictures: Files (or promises of them, or a promise of their
// list: callpictures.js showPictures) the agent is shown once the line picks up,
// a page of the Notebook shared by its corner (bookshare.js); with a call already on, they go into that one. page: that page's id, brought to the call's notes page as its first scrap (calldraw.js). (request and the rest named; pictures)
export async function callAgent(
  agent = world.company.ceo,
  name = ceoName(),
  { request = 0, walk = false, pictures = [], page = 0 } = {},
) {
  if (intercomOpen()) closeTool();
  if (call) {
    expand(call);
    return showPictures(call, pictures);
  }
  // (never a design session from the start: the agent makes the call one when asked, calldraw.js designed.
  const c = (call = { agent, name, request, walk, brought: page, voiced: [], kept: [], keptFrom: 0 });
  c.hangUp = () => hangUp(c);
  c.audio = audioOf(c);
  openLayer(c);
  hush(true, 'call');
  // (the board interrupts by speaking: the line clears the voice, FROM_LINE.clear.)
  $('#call-end').onclick = () => hangUp(c);
  startPictures(c);
  showPictures(c, pictures);
  startDrop(c);
  callSay('Starting the microphone…');
  c.audio.awake.keep(); // (first, still in the tap: Safari grants the first lock only seconds after one)
  // (it rings in the call's sound, opened in the tap, while the microphone starts.)
  c.audio.open();
  ring(c);
  // (callmic.js's share reads it from here on, so it's set before anything waits)
  c.started = c.audio.start();
  try {
    await c.started;
    gotStream();
  } catch {
    return endCall(`The microphone didn’t start. Check ${names.hq}’s microphone permission.`);
  }
  const l = await loadLanguage(world.dev).catch(() => null); // the board's language, which the line speaks and hears
  if (call !== c) return;
  if (!l) return endCall('The language can’t be read right now. Try again in a moment.');
  // (until the line picks up and says it listens: FROM_LINE.state.)
  const held = heldCall(agent, request);
  if (held) c.request = held.request;
  callSay(held ? 'Rejoining…' : 'Dialling…');
  // never stuck: if nobody picks up, say so
  c.ring = setTimeout(() => {
    if (call === c && !c.live) endCall(`${name} didn’t pick up. Try again in a moment.`);
  }, 30000);
  // (walk)
  c.dial = { agent, lang: l.lang, request: c.request, ...(walk && c.request ? { walk } : {}) };
  connect(c, held ? { resume: held.id, back: true } : c.dial);
}

// (a page that leaves mid-call can call back into it: callheld.js)
addEventListener('pagehide', () => call?.id && lostCall(call));

// A call's microphone and voice: its frames sent on the line, a microphone lost ends it, and each tick keeps its screen
function audioOf(c) {
  return new CallAudio({
    worklet: 'shell/mic-worklet.js',
    lead: 0.05,
    send: frame => sendFrame(c, frame),
    lost: err => endCall(`The microphone stopped. ${microphoneFix(err)}`),
    warn: why => showSoundNote(soundNote(why)),
    tick: () => (onAir(c), switchOffOnTone(c), lagging(c)),
  });
}

// It rings until the line picks up, as a phone does, and the handset clacks then (FROM_LINE.call): in the call's own
// sound, where its voice is heard
function ring(c) {
  cueInto(c.audio.voice);
  c.stopRinging = cueRepeating('ringing', 5);
}
const microphoneFix = err =>
  err.name === 'NotAllowedError'
    ? `Check ${names.hq}’s microphone permission, then call again.`
    : err.name === 'NotReadableError'
      ? 'Close any other app using it, then call again.'
      : 'Call again.';
// One connection to the voice line. When it drops (the phone switched networks), reconnect to the same call.
function connect(c, hello) {
  const ws = (c.ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/voice/ws`));
  ws.binaryType = 'arraybuffer';
  c.late = 0;
  c.heardAt = undefined; // (lagging: this connection's)
  ws.onopen = () => ws.send(JSON.stringify(hello));
  ws.onmessage = m => {
    if (call !== c || c.ws !== ws) return;
    if (m.data instanceof ArrayBuffer) return ((c.heardAt = performance.now()), play(c, m.data));
    const ev = JSON.parse(m.data);
    FROM_LINE[ev.type]?.(c, ev);
  };
  ws.onclose = e => {
    if (call !== c || c.ws !== ws) return;
    if (hello.back && !c.id && e.code === 4000) return connect(c, c.dial); // (the call it would rejoin is over)
    // the call waits on the other end (HOLD_MS): keep trying to get back to it.
    const lost = c.id && e.code !== 4000;
    if (lost && !c.tries) lostCall(c); // (from the first try on)
    if (lost && (c.tries = (c.tries ?? 0) + 1) <= 12) {
      c.live = false;
      reconnected(c);
      c.audio.mark('reconnecting');
      stopPlayback(c);
      callSay('Reconnecting…');
      c.bubble?.state('reconnecting');
      return setTimeout(
        () => {
          if (call === c) connect(c, { resume: c.id });
        },
        Math.min(500 * c.tries, 2500),
      );
    }
    endCall('The line dropped. Call again?');
  };
}
// What the line says, by its type
const FROM_LINE = {
  pong(c, ev) {
    c.late = Number(ev.late) || 0;
    c.heardAt = performance.now();
    forgetHeard(c, ev.heard);
  },
  call(c, ev) {
    if (ev.said) rejoined(c, ev);
    // (back in a call with guests on its page: a hang-up asks again whether to leave it to them)
    for (const name of ev.guests ?? []) if (!(c.guests ??= []).includes(name)) c.guests.push(name);
    c.t0 ??= performance.now();
    c.id = ev.id || c.id;
    c.call = Number(ev.call) || c.call;
    c.key = String(ev.key ?? '') || c.key;
    c.live = true;
    c.tries = 0;
    holdCall(c);
    if (c.stopRinging) {
      c.stopRinging();
      c.stopRinging = null;
      cue('pickUp');
    }
    resend(c, ev.heard, PING_MS);
    c.face.lit(true); // (the agent's little screen switches on)
    picturesLive(c);
    shareKey(c); // (Show my screen, once picked up)
    screenToLine(c, true);
    guestKey(c);
    guestsToLine(c);
    startDrawing(c);
  },
  state(c, ev) {
    callSay({ listening: 'Listening…', thinking: 'Thinking…', speaking: c.name }[ev.state] ?? '');
    c.bubble?.state(ev.state ?? '');
    c.face.state(ev.state ?? ''); // (the call screen's own little screen.)
    if (ev.state === 'thinking') {
      // (a turn answered: the agent's reply starts its own line, as the board's next words do, and what it drew in its
      // last one goes)
      c.said = '';
      turnEnded(c);
      wiped();
    }
  },
  // the board's turn so far, and the agent's sentences as they come: the call's transcript
  heard(c, ev) {
    c.said = '';
    wiped(); // (the board's turn: the agent's last one's rings go.)
    if (ev.back) turnTakenBack(c); // (the board went on before the reply was heard: the turn's line is open again)
    relight(c);
    transcribe(c, 'board', ev.text);
    DRAWING.heard(c, ev);
  },
  said(c, ev) {
    c.said = `${c.said ?? ''} ${ev.text}`.trim();
    relight(c);
    transcribe(c, 'agent', c.said);
    c.audio.startSentence('voice');
    c.ticking = false;
  },
  // the line's tick while a tool step runs: not a sentence, but its own start too. And the hang-up tone's start, the
  // agent's goodbye said: the little screen switches off as it plays (toneNext).
  tick(c, ev) {
    c.audio.startSentence('tick');
    c.ticking = true;
    c.toneNext = ev.tone === 'hangup';
  },
  // the line's own words when the agent can't answer (its seat at its limit, signed out, an error), from pickup on,
  // until a reply gets through: shown apart from what's being said, so they stay in view
  notice(c, ev) {
    const n = $('#call-note');
    tell(n, ev.text ?? '');
    n.hidden = !ev.text;
  },
  clear: c => stopPlayback(c),
  picture: (c, ev) => pictureState(c, ev),
  note: DRAWING.note,
  mark: DRAWING.mark,
  ask: DRAWING.ask,
  ink: DRAWING.ink,
  design: DRAWING.design,
  open: DRIVING.open,
  hand: handFromLine, // (the agent's raised hand in a design session.)
  drive: DRIVING.drive,
  // the agent hung up once the board had said goodbye: as the Hang up button does
  hangup: () => endCall(),
};
// the agent's voice as it plays, the line's tick apart, for the ON AIR sign
function play(c, buf) {
  const at = c.audio.play(new Int16Array(buf)),
    last = c.voiced.at(-1);
  if (c.toneNext) {
    c.offAt = at.start; // (the hang-up tone's first sound: switchOffOnTone switches the little screen off as it plays)
    c.toneNext = false;
  }
  if (c.ticking) return;
  if (last && at.start <= last[1] + 1e-6) last[1] = at.end;
  else c.voiced.push([at.start, at.end]);
}
function stopPlayback(c) {
  c.audio.stopPlayback();
  c.voiced = [];
}
// The agent hung up and the board spoke over its hang-up tone, or the agent said more: the line keeps the call, and the
// little screen is on again.
function relight(c) {
  c.toneNext = false;
  c.offAt = undefined;
  c.face.lit(true);
}
// The agent's little screen switches off as the hang-up tone's first sound plays (play).
function switchOffOnTone(c) {
  if (c.offAt <= c.audio.ctx.currentTime) {
    c.offAt = undefined;
    c.face.lit(false);
  }
}
// The ON AIR sign lights while someone on the call speaks: the board (the microphone loud enough to be a voice, about
// -34 dBFS once the browser has taken the room's noise out) or the agent (its voice playing). Only while the call's audio
// clock moves (callaudio.js checks it on the same tick): a context that's suspended (iOS took the audio away) or stuck (running,
// its clock frozen, the speaker paused) holds the analyser's last buffer and its clock, so neither tells anything then.
function onAir(c) {
  const t = c.audio.ctx.currentTime,
    moving = c.audio.moving;
  if (moving) {
    if (c.audio.micLevel() > 0.02) c.loudAt = performance.now();
    while (c.voiced[0]?.[1] < t) c.voiced.shift();
  } else c.loudAt = undefined;
  const speaking = c.voiced[0]?.[0] <= t,
    on = !!c.live && moving && (performance.now() - (c.loudAt ?? -1e9) < 400 || speaking);
  for (const header of document.querySelectorAll('.intercom header')) header.classList.toggle('on-air', on);
  // (the bubble's face, or the call screen's own little screen)
  (c.small ? c.bubble : c.face)?.voice(c.live && moving && speaking ? Math.min(1, c.audio.voiceLevel() * 6) : 0);
}
// What the call's screen says under its state about the call's sound (callaudio.js warn), until it's fine again
const soundNote = why =>
  !why
    ? ''
    : why === 'paused'
      ? 'The call’s sound is paused. Tap the screen to resume it.'
      : why === 'silent'
        ? 'No sound from your microphone. Check it isn’t muted.'
        : why === 'starting'
          ? `The microphone isn’t starting. Check ${names.hq}’s microphone permission.`
          : `No sound from your microphone. ${microphoneFix(why)}`;
function showSoundNote(text) {
  const n = $('#call-mic');
  if (n && n.textContent !== text) {
    tell(n, text);
    n.hidden = !text;
  }
}
function callSay(state) {
  const s = $('#call-state');
  if (s) s.textContent = state;
}
// Hang up: with guests on the call's page, the board picks first whether to end it for everyone or leave it to them
// (callguest.js askHangUp; the bubble's key opens the call for it).
function hangUp(c) {
  if (call !== c) return;
  if (c.guests?.length && c.live) expand(c);
  askHangUp(c, { end: () => call === c && endCall(), leave: () => leaveCall(c) });
}
// The board leaves the call to its guests: the line holds it for one of them to go on with on their own device, and
// HQ's side closes as at a hang-up, without its 'bye'. Calling the agent again comes back into the call (callheld.js,
// and the line's own held), where Hang up ends it.
function leaveCall(c) {
  if (call !== c) return;
  if (c.ws?.readyState !== 1) return endCall('The line dropped before your guests could take the call.');
  c.ws.send(JSON.stringify({ type: 'leave' }));
  endCall('', true);
}
function endCall(why, left = false) {
  const c = call;
  if (!c) return;
  call = null;
  c.over = true;
  clearTimeout(c.ring);
  c.stopRinging?.();
  cueInto(null);
  // (how the voice played here, numbers only, and its timeline in seconds after the line picked up)
  const { played, timeline } = c.audio.report(c.t0);
  if (c.ws?.readyState === 1 && !left) c.ws.send(JSON.stringify({ type: 'bye', played, timeline }));
  if (left)
    lostCall(c); // (left to its guests: calling the agent again comes back into it)
  else if (!why) letCallGo(); // (hung up: the line hears 'bye', or ends it once it's held long enough)
  c.ws?.close();
  c.voiced = [];
  stopPictures(c);
  stopDrop(c);
  stopDrawing(c);
  stopDriving();
  c.audio.close();
  c.watch?.stop();
  c.bubble?.close();
  hush(false, 'call');
  for (const header of document.querySelectorAll('.intercom header')) header.classList.remove('on-air');
  closeLayer(c);
  if (intercomOpen()) closeTool(); // (opened by the board while the call was small)
  if (c.agent === world.company.ceo && !c.request && c.id && !left) notesComing(); // the transcript reaches the chat in a moment
  if (c.live || c.id) watchCall(c.agent, Date.now(), c.call);
  // (a toast's tap goes where the notes appear)
  toast(
    left
      ? `<b>You left the call with ${esc(c.name)}</b><br>${esc(listed(c.guests))} can go on with ${esc(c.name)}. Call ${esc(c.name)} again to come back, or to end it.`
      : `<b>Call with ${esc(c.name)} ended</b>${why ? `<br>${esc(why)}` : ''}`,
    c.agent === world.company.ceo && !c.request ? openIntercom : () => openComputer('calls'),
  );
}
