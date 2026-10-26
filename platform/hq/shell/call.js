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
import { hush, cue, cueRepeating } from './audio.js';
import { CallAudio } from './callaudio.js';
import * as world from '../world/world.js';
import { toast } from './hud.js';
import { names } from './brand.js';
import {
  openLayer,
  closeLayer,
  minimise,
  expand,
  shareKey,
  transcribe,
  turnEnded,
  turnTakenBack,
} from './callscreen.js';
import { startPictures, picturesLive, pictureState, stopPictures } from './callpictures.js';
import { FROM_LINE as DRAWING, reconnected, startDrawing, stopDrawing } from './calldraw.js';
import { FROM_LINE as DRIVING, stopDriving } from './calldrive.js';
import { ceoName, openIntercom, openComputer, intercomOpen, notesComing, say, tell, watchCall } from './desk.js';

const $ = s => document.querySelector(s);
let call = null;
export const inCall = () => !!call;
// The call open over HQ, its screen in front: Escape makes it small (desk.js)
export const callInFront = () => !!call && !call.small;
export const minimiseCall = () => call && minimise(call);

// Call someone: the call opens over whatever is on screen (their panel, a card, Reviews, the intercom), which is there
// again when it ends. request: the card it's about. onIntercom: started from the intercom, which shows why it ended, if
// not by hanging up.
// walk: from a card's Walk me through it (calldraw.js).
export async function callAgent(
  agent = world.company.ceo,
  name = ceoName(),
  request = 0,
  onIntercom = false,
  walk = false,
) {
  if (call) return expand(call);
  const c = (call = { agent, name, request, onIntercom, walk, voiced: [], kept: [], keptFrom: 0 });
  c.hangUp = () => endCall();
  c.audio = new CallAudio({
    worklet: 'shell/mic-worklet.js',
    lead: 0.05,
    send: frame => sendFrame(c, frame),
    lost: err => endCall(`The microphone stopped. ${microphoneFix(err)}`),
    warn: why => showSoundNote(soundNote(why)),
    tick: () => {
      onAir(c);
      lagging(c);
    },
  });
  openLayer(c);
  hush(true, 'call');
  // it rings from the tap until the line picks up, as a phone does, and the handset clacks then (FROM_LINE.call)
  c.stopRinging = cueRepeating('ringing', 5);
  if (onIntercom) say(''); // (the last call's "the line dropped" goes)
  $('#call-skip').onclick = () => {
    stopPlayback(c);
    c.ws?.send(JSON.stringify({ type: 'interrupt' }));
  };
  $('#call-end').onclick = () => endCall();
  startPictures(c);
  callSay('Starting the microphone…');
  c.audio.keepAwake(); // (first, still in the tap: Safari grants the first lock only seconds after one)
  try {
    await c.audio.start();
  } catch {
    return endCall(`The microphone didn’t start. Check ${names.hq}’s microphone permission.`);
  }
  const l = await loadLanguage(world.dev).catch(() => null); // the board's language, which the line speaks and hears
  if (call !== c) return;
  if (!l) return endCall('The language can’t be read right now. Try again in a moment.');
  callSay('Dialling…');
  // never stuck: if nobody picks up, say so
  c.ring = setTimeout(() => {
    if (call === c && !c.live) endCall(`${name} didn’t pick up. Try again in a moment.`);
  }, 30000);
  connect(c, { agent, lang: l.lang, request, ...(walk && request ? { walk } : {}) }); // (walk)
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
  ws.onopen = () => {
    if (!c.id) callSay('Ringing…');
    ws.send(JSON.stringify(hello));
  };
  ws.onmessage = m => {
    if (call !== c || c.ws !== ws) return;
    if (m.data instanceof ArrayBuffer) return ((c.heardAt = performance.now()), play(c, m.data));
    const ev = JSON.parse(m.data);
    FROM_LINE[ev.type]?.(c, ev);
  };
  ws.onclose = e => {
    if (call !== c || c.ws !== ws) return;
    // the call waits 30 s on the other end: keep trying to get back to it
    if (c.id && e.code !== 4000 && (c.tries = (c.tries ?? 0) + 1) <= 12) {
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
    c.t0 ??= performance.now();
    c.id = ev.id || c.id;
    c.call = Number(ev.call) || c.call;
    c.key = String(ev.key ?? '') || c.key;
    c.live = true;
    c.tries = 0;
    if (c.stopRinging) {
      c.stopRinging();
      c.stopRinging = null;
      cue('pickUp');
    }
    resend(c, ev.heard);
    picturesLive(c);
    shareKey(c); // (Show my screen, once picked up)
    startDrawing(c);
  },
  state(c, ev) {
    callSay({ listening: 'Listening…', thinking: 'Thinking…', speaking: c.name }[ev.state] ?? '');
    c.bubble?.state(ev.state ?? '');
    c.face?.state(ev.state ?? ''); // (the call screen's own little screen)
    if (ev.state === 'thinking') {
      // (a turn answered: the agent's reply starts its own line, as the board's next words do)
      c.said = '';
      turnEnded(c);
    }
  },
  // the board's turn so far, and the agent's sentences as they come: the call's transcript
  heard(c, ev) {
    c.said = '';
    if (ev.back) turnTakenBack(c); // (the board went on before the reply was heard: the turn's line is open again)
    transcribe(c, 'board', ev.text);
    DRAWING.heard(c, ev);
  },
  said(c, ev) {
    c.said = `${c.said ?? ''} ${ev.text}`.trim();
    transcribe(c, 'agent', c.said);
    c.audio.startSentence('voice');
    c.ticking = false;
  },
  // the line's tick while a tool step runs: not a sentence, but its own start too
  tick(c) {
    c.audio.startSentence('tick');
    c.ticking = true;
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
  ask: DRAWING.ask,
  ink: DRAWING.ink,
  open: DRIVING.open,
  drive: DRIVING.drive,
  // the agent hung up once the board had said goodbye: as the Hang up button does
  hangup: () => endCall(),
};
// The board's words outlast a dropped connection. From pickup on, each microphone frame (FRAME samples) is kept until
// the line says it has it (`heard`: its samples so far, all call, with each pong): what was still queued in a socket
// that dropped, and what the microphone made while reconnecting. None is dropped unheard: the pongs clear it twice a
// second while connected, it grows only as the socket's own queue does on a weak uplink, and a reconnect ends within
// the line's 30 s hold. The line's `call` on the new connection says what it has; the rest goes first, with a ping
// from when it was made every PING_MS, so the line reads it as late and waits for all of it before it answers
// (platform/voice, LATE). (An older line says nothing: none is kept.).
const FRAME = 320;
function sendFrame(c, frame) {
  if (!c.id) return; // (not picked up yet: nobody hears it)
  c.kept.push({ frame, at: performance.now() });
  if (c.ws?.readyState === 1 && c.live) c.ws.send(frame);
}
function forgetHeard(c, heard) {
  const n = Number.isFinite(heard) ? Math.min(c.kept.length, Math.floor((heard - c.keptFrom) / FRAME)) : c.kept.length;
  if (n > 0) {
    c.kept.splice(0, n);
    c.keptFrom += n * FRAME;
  }
}
function resend(c, heard) {
  forgetHeard(c, heard);
  let pinged = -Infinity;
  for (const { frame, at } of c.kept) {
    if (at - pinged >= PING_MS) {
      pinged = at;
      c.ws.send(JSON.stringify({ type: 'ping', t: Math.round(at) }));
    }
    c.ws.send(frame);
  }
}
// the agent's voice as it plays, the line's tick apart, for the ON AIR sign
function play(c, buf) {
  const at = c.audio.play(new Int16Array(buf)),
    last = c.voiced.at(-1);
  if (c.ticking) return;
  if (last && at.start <= last[1] + 1e-6) last[1] = at.end;
  else c.voiced.push([at.start, at.end]);
}
function stopPlayback(c) {
  c.audio.stopPlayback();
  c.voiced = [];
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
// The line running behind. On a weak connection the microphone's frames back up and reach the line late, in a burst
// (nothing is lost on the way, nor with a dropped connection: sendFrame), and the line waits for them before it answers
// (platform/voice, LATE). Twice a second a ping goes beside the frames, and the line answers how late it came, on HQ's
// monotonic clock against its own. The screen says so while the line hears the board over 1.5 s
// late, nothing has come back from it for 4 s since this connection's first ping, or the frames wait here unsent
// (bufferedAmount, at the 64 kB a second they come to at most), and until 3 s after it caught up; each spell goes in
// the timeline. (How late the line hears, not how long a pong takes: the pongs come back behind the reply's audio,
// which goes out ahead of its playing, so its audio coming counts as the line answering.)
const PING_MS = 500,
  LAGGING_S = 1.5,
  UNANSWERED_MS = 4000,
  CAUGHT_UP_MS = 3000;
function lagging(c) {
  const now = performance.now(),
    ws = c.ws;
  if (!c.live || ws?.readyState !== 1) return;
  if (now - (c.pinged ?? -PING_MS) >= PING_MS) {
    c.pinged = now;
    c.heardAt ??= now;
    ws.send(JSON.stringify({ type: 'ping', t: Math.round(now) }));
  }
  const silent = now - c.heardAt,
    behind = Math.max(c.late, ws.bufferedAmount / 64000, silent > UNANSWERED_MS ? silent / 1000 : 0);
  if (behind > LAGGING_S) {
    if (!c.lagAt) c.audio.mark('lagging');
    c.lagAt = now;
    c.lagMax = Math.max(c.lagMax ?? 0, behind);
    c.lagShown = Math.round(behind);
  } else if (c.lagAt && now - c.lagAt > CAUGHT_UP_MS) {
    c.audio.mark('caught up', undefined, c.lagMax);
    c.lagAt = c.lagMax = 0;
  }
  const n = $('#call-net'),
    text = c.lagAt ? `Weak connection: ${c.name} hears you about ${c.lagShown} s late.` : '';
  if (n && n.textContent !== text) {
    tell(n, text);
    n.hidden = !text;
  }
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
function endCall(why) {
  const c = call;
  if (!c) return;
  call = null;
  c.over = true;
  clearTimeout(c.ring);
  c.stopRinging?.();
  // (how the voice played here, numbers only, and its timeline in seconds after the line picked up)
  const { played, timeline } = c.audio.report(c.t0);
  if (c.ws?.readyState === 1) c.ws.send(JSON.stringify({ type: 'bye', played, timeline }));
  c.ws?.close();
  c.voiced = [];
  stopPictures(c);
  stopDrawing(c);
  stopDriving();
  c.audio.close();
  c.watch?.stop();
  c.bubble?.close();
  hush(false, 'call');
  for (const header of document.querySelectorAll('.intercom header')) header.classList.remove('on-air');
  closeLayer(c);
  if (c.agent === world.company.ceo && !c.request && c.id) notesComing(); // the transcript reaches the chat in a moment
  if (c.live || c.id) watchCall(c.agent, Date.now(), c.call);
  // (a call from the intercom, still open under it, says why it ended there, if not by hanging up: the chat says the
  // notes are coming. Elsewhere a toast's tap goes where they appear.)
  if (c.onIntercom && intercomOpen()) return say(why ?? '', true);
  toast(
    `<b>Call with ${esc(c.name)} ended</b>${why ? `<br>${esc(why)}` : ''}`,
    c.agent === world.company.ceo && !c.request ? openIntercom : () => openComputer('calls'),
  );
}
