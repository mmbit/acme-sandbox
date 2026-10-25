// The join link's page (joinpage.ts): the lobby (the notice, a name, Join), then the call over the voice line's
// /voice/join with everyone else in the room, and the agent's drawing alive with what the call does (joinfigure.js).
//   page → line  {type: 'join', token, name, rejoin?}, then the microphone as HQ's call screen sends it (mic-worklet.js:
//                320 samples of 16 kHz PCM16, and while something plays, what played after them), {type: 'mute', on},
//                {type: 'bye'}
//   line → page  {type: 'room', you, key, people}, {type: 'people', people: [{id, name, muted}]}, {type: 'talking', id},
//                {type: 'state', state}, said, tick, clear, notice, hangup; and every 20 ms 320 samples of what this
//                person hears (the agent and the others), followed by the agent's own 320 while it speaks
//   closes       4000 the call is over, 4004 the link has closed, 4009 the room is full, 1008 the name was refused;
//                anything else drops: back into the same room for up to 2 minutes
// The call's audio is HQ's call screen's own (callaudio.js). The page keeps nothing but the name typed (sessionStorage,
// for a rejoin).
import { CallAudio } from './callaudio.js';
import { Figure } from './figure.js';
import { listPeople } from './people.js';
import { WalkThrough } from './walk.js';

const page = JSON.parse(document.getElementById('join-page').textContent);
const w = page.words;
const $ = selector => document.querySelector(selector);
const token = location.pathname.split('/').filter(Boolean).pop();
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const tile = $('.agent');
const figure = new Figure($('.drawing svg'), reduced);
const FRAME = 320; // samples in 20 ms at 16 kHz
const JITTER_S = 0.08; // the line sends in real time: a little ahead absorbs the network's jitter
const LATE_S = 0.5; // a frame that would play later than this is dropped, so the call never lags behind
const RECONNECT_MS = 120_000; // the line keeps a dropped person's place this long
let call = null;
// a walk-through: the shared preview under the call (joinwalk.js)
const walk = page.walk
  ? new WalkThrough({ words: w, token, tile, reduced, audio: () => call?.audio, onHangUp: () => call && leave(call) })
  : null;

// ---- the lobby
const form = $('.joinform'),
  input = $('#name');
input.value = sessionStorage.getItem('join-name') ?? '';
const when = iso =>
  new Date(iso).toLocaleString(page.lang, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
$('.until').textContent = w.until.replace('{time}', when(page.until));
// a call at a set time: Join waits until the link opens
const opensIn = page.opens ? Date.parse(page.opens) - Date.now() : 0;
const joinButtons = [...document.querySelectorAll('.join')];
for (const button of joinButtons) button.dataset.words = button.textContent;
if (opensIn > 0) {
  joinButtons.forEach(b => (b.disabled = true));
  $('.until').textContent = w.opens.replace('{time}', when(page.opens));
  setTimeout(
    () => {
      joinButtons.forEach(b => (b.disabled = false));
      $('.until').textContent = w.until.replace('{time}', when(page.until));
    },
    Math.min(opensIn, 2 ** 31 - 1),
  );
}
// (on a walk-through, which of its two buttons: to show our pages, or not)
form.addEventListener('submit', e => {
  e.preventDefault();
  join(e.submitter ?? joinButtons[0]);
});
// (a walk-through asks again, with both its buttons)
$('.rejoin').addEventListener('click', () => (walk ? lobby('') : join(joinButtons[0])));
// before joining, the agent looks at the pointer, and at the name as it's typed
addEventListener('pointermove', e => {
  if (!call && document.activeElement !== input) figure.lookAt(e.clientX, e.clientY);
});
const lookAtName = () => {
  const box = input.getBoundingClientRect();
  figure.lookAt(box.left + Math.min(box.width - 20, 16 + input.value.length * 10), box.top + box.height / 2);
};
input.addEventListener('focus', lookAtName);
input.addEventListener('input', lookAtName);
input.addEventListener('blur', () => figure.lookAt(null));

// the name as the line takes it (room.py clean(): one line, no control characters or colons, the transcript's "name:
// words"). Past page.nameLength characters the page says so, never cuts it.
const cleanName = () =>
  input.value
    // eslint-disable-next-line no-control-regex -- control characters out of a typed name
    .replace(/[\u0000-\u001f\u007f:]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');

async function join(button) {
  const name = cleanName();
  if (!name) return lobby(w.nameNeeded);
  const length = [...name].length;
  if (length > page.nameLength)
    return lobby(w.nameLong.replace('{length}', String(length)).replace('{most}', String(page.nameLength)));
  sessionStorage.setItem('join-name', name);
  input.value = name;
  joinButtons.forEach(b => (b.disabled = true));
  button.textContent = w.joining;
  $('.error').hidden = true;
  figure.cheer();
  const c = (call = { name, you: null, key: null, people: new Map(), colours: new Map(), levels: [] });
  c.show = button.value === 'show';
  c.audio = new CallAudio({
    worklet: '/join/assets/mic-worklet.js',
    lead: JITTER_S,
    margin: 0.01,
    late: LATE_S,
    send: frame => {
      if (c.ws?.readyState === 1 && c.you && !c.muted) c.ws.send(frame);
    },
    lost: () => leave(c, w.micDenied),
  });
  c.audio.keepAwake(); // (first, still in the tap: Safari grants the first lock only seconds after one)
  try {
    await c.audio.start();
  } catch {
    stop(c);
    return lobby(w.micDenied);
  }
  if (call !== c) return stop(c);
  connect(c);
}

// ---- the line
function connect(c) {
  const ws = (c.ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/voice/join`));
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', token, name: c.name, ...(c.key ? { rejoin: c.key } : {}) }));
  ws.onmessage = m => {
    if (call !== c || c.ws !== ws) return;
    if (m.data instanceof ArrayBuffer) return play(c, m.data);
    heard(c, JSON.parse(m.data));
  };
  ws.onclose = e => {
    if (call !== c || c.ws !== ws) return;
    if (e.code === 4000) return void (c.hangingUp = true);
    if (e.code === 4004) return over(c, 'closed');
    if (e.code === 4009) return over(c, 'full');
    if (e.code === 1008) {
      stop(c);
      return lobby(w.nameNeeded);
    }
    c.droppedAt ??= Date.now();
    c.tries = (c.tries ?? 0) + 1;
    if (Date.now() - c.droppedAt > RECONNECT_MS || (!c.you && c.tries > 3)) return over(c, 'dropped');
    stopPlayback(c);
    $('.reconnecting').hidden = !c.you;
    setTimeout(() => call === c && connect(c), Math.min(500 * c.tries, 3000));
  };
}

function heard(c, ev) {
  if (ev.type === 'room') {
    c.you = String(ev.you);
    c.key = String(ev.key); // (what gets this page back in its place)
    c.droppedAt = null;
    c.tries = 0;
    $('.reconnecting').hidden = true;
    if (!c.since) enter(c);
    showPeople(c, ev.people);
  } else if (ev.type === 'people') showPeople(c, ev.people);
  else if (ev.type === 'talking') c.talking = ev.id == null ? null : String(ev.id);
  else if (ev.type === 'state') c.state = ev.state;
  else if (ev.type === 'said') caption(c, String(ev.text ?? ''));
  else if (ev.type === 'tick') c.state = 'thinking';
  else if (ev.type === 'clear') stopPlayback(c);
  else if (ev.type === 'notice') notice(String(ev.text ?? ''));
  // the agent said goodbye and hung up: its last words play out first (frame())
  else if (ev.type === 'hangup') c.hangingUp = true;
}

// Each 20 ms of the room: the first 320 samples play, the agent's own after them (while it speaks) move its mouth, on
// the same clock, at the time they play.
function play(c, buf) {
  const pcm = new Int16Array(buf),
    split = pcm.length === 2 * FRAME;
  const at = c.audio.play(split ? pcm.subarray(0, FRAME) : pcm);
  if (at) c.levels.push([at.start, split ? loudness(pcm.subarray(FRAME)) : 0]);
}

function stopPlayback(c) {
  c.audio.stopPlayback();
  c.levels = [];
}

// the agent's voice as it plays now: the frame the speakers are at
function agentLevel(c) {
  const ctx = c.audio.ctx,
    at = ctx.currentTime - (ctx.outputLatency || 0);
  while (c.levels.length > 1 && c.levels[1][0] <= at) c.levels.shift();
  const [start, level] = c.levels[0] ?? [Infinity, 0];
  return start <= at && at < start + FRAME / 16000 ? level : 0;
}

const loudness = samples => {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length) / 32768;
};
// a voice's loudness as how open a mouth is: quiet speech a little, loud speech wide
const mouth = rms => Math.min(1, Math.max(0, (rms - 0.012) * 7)) ** 0.75;

// ---- the room on the page
function enter(c) {
  c.since = Date.now();
  document.body.classList.replace('lobby', 'incall');
  $('.lobbycard').hidden = true;
  $('.over').hidden = true;
  $('.room').hidden = false;
  $('.controls').hidden = false;
  $('.live').hidden = false;
  $('.captions').textContent = '';
  setMuted(c, false);
  c.clock = setInterval(() => {
    const s = Math.floor((Date.now() - c.since) / 1000);
    $('.live time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
  chime(c, true);
  void walk?.joined(c.show);
}

// the room's people as the line lists them: a chime as someone comes in (not this person) or goes
function showPeople(c, people) {
  const { came, went } = listPeople($('.people'), c, people, w.you);
  if (went) chime(c, false);
  if (came) chime(c, true);
  $('.count').textContent = String(c.people.size);
}

// what the agent says, a sentence at a time, its words coming in at about the pace it speaks them; the sentence before
// stays, faded
function caption(c, text) {
  const box = $('.captions');
  box.classList.remove('stale', 'notice');
  c.state = 'speaking';
  $('.waiting').hidden = true;
  const before = box.querySelector('.now');
  box.querySelector('.before')?.remove();
  if (before) before.className = 'before';
  const line = document.createElement('q');
  line.className = 'now';
  text.split(/\s+/).forEach((word, i) => {
    const span = document.createElement('span');
    span.textContent = `${word} `;
    span.style.animationDelay = `${i * 0.3}s`;
    line.append(span);
  });
  box.append(line);
  clearTimeout(c.fading);
}

function notice(text) {
  const box = $('.captions');
  box.className = 'captions notice';
  box.textContent = text;
}

function setMuted(c, on) {
  c.muted = on;
  const button = $('.mute');
  button.setAttribute('aria-pressed', String(on));
  button.querySelector('span').textContent = on ? w.unmute : w.mute;
  if (c.ws?.readyState === 1 && c.you) c.ws.send(JSON.stringify({ type: 'mute', on }));
}
$('.mute').addEventListener('click', () => call && setMuted(call, !call.muted));
$('.leave').addEventListener('click', () => call && leave(call));

// this person leaves the room; with an error (the microphone stopped), back to the lobby with it
function leave(c, error) {
  if (c.ws?.readyState === 1) c.ws.send(JSON.stringify({ type: 'bye' }));
  over(c, 'left');
  if (error) lobby(error);
}

// The call is over for this page: why, and a way back in where there is one.
// why: ended | closed | full | left | dropped
function over(c, why) {
  c.ws?.close(1000);
  stop(c);
  walk?.over();
  document.body.classList.remove('incall');
  $('.room').hidden = true;
  $('.controls').hidden = true;
  $('.live').hidden = true;
  $('.reconnecting').hidden = true;
  $('.captions').classList.add('stale');
  $('.over .said').textContent = w[why];
  $('.rejoin').hidden = why === 'ended' || why === 'closed';
  $('.over').hidden = false;
  if (why === 'ended') figure.cheer();
}

// back to the lobby with what went wrong
function lobby(error) {
  call = null;
  document.body.classList.remove('incall', 'walking');
  document.body.classList.add('lobby');
  $('.over').hidden = true;
  $('.lobbycard').hidden = false;
  for (const b of joinButtons) {
    b.disabled = false;
    b.textContent = b.dataset.words;
  }
  const message = $('.error');
  message.textContent = error;
  message.hidden = !error;
  input.focus();
}

function stop(c) {
  if (call === c) call = null;
  clearInterval(c.clock);
  c.audio?.close();
}

// A soft two notes when someone comes in (up) or goes (down), played into the call like its voice so the line's echo
// canceller takes them out too.
function chime(c, up) {
  const { ctx, voice } = c.audio;
  if (!voice || reduced) return;
  const t = ctx.currentTime + 0.02;
  (up ? [659.25, 987.77] : [987.77, 659.25]).forEach((hz, i) => {
    const tone = ctx.createOscillator(),
      gain = ctx.createGain();
    tone.frequency.value = hz;
    gain.gain.setValueAtTime(0, t + i * 0.11);
    gain.gain.linearRampToValueAtTime(0.05, t + i * 0.11 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.11 + 0.32);
    tone.connect(gain).connect(voice);
    tone.start(t + i * 0.11);
    tone.stop(t + i * 0.11 + 0.34);
  });
}

// ---- every frame: the agent's drawing, the rings of whoever talks, the agent's own ring
function frame(now) {
  requestAnimationFrame(frame);
  const c = call?.you ? call : null;
  const level = c ? mouth(agentLevel(c)) : 0;
  const own = c && !c.muted && c.audio.micLevel() > 0.02;
  // (this person's own ring from their microphone at once, everyone else's from the line)
  for (const li of document.querySelectorAll('.people li'))
    li.classList.toggle('talking', !!c && (li.dataset.id === c.talking || (li.dataset.id === c.you && own)));
  const talking = c ? (c.talking ?? (own ? c.you : null)) : null;
  if (c) {
    const playing = c.audio.next > c.audio.ctx.currentTime && c.levels.some(([, l]) => l > 0);
    if (level > 0 || playing) c.lastVoice = now;
    const speaking = now - (c.lastVoice ?? -1e9) < 350;
    if (c.hangingUp && now - (c.lastVoice ?? -1e9) > 500) return over(c, 'ended');
    const state = speaking ? 'speaking' : c.state === 'thinking' ? 'thinking' : talking ? 'listening' : 'idle';
    if (state === 'listening' && tile.dataset.state === 'speaking') fade(c);
    figure.state = state;
    tile.dataset.state = state;
    const who =
      talking &&
      document.querySelector(`.people li[data-id="${CSS.escape(talking)}"] .avatar`)?.getBoundingClientRect();
    if (state === 'listening' && who) figure.lookAt(who.left + who.width / 2, who.top + who.height / 2);
    else figure.lookAt(null);
  } else if (tile.dataset.state !== 'idle') figure.state = tile.dataset.state = 'idle';
  // (minimised over a walk-through, the bubble's face moves instead)
  if (walk?.frame(now, tile.dataset.state, level)) return;
  tile.style.setProperty('--level', level.toFixed(3));
  figure.level = level;
  figure.frame(now);
}
requestAnimationFrame(frame);

// once the agent has finished speaking, its words fade a little after a while
function fade(c) {
  clearTimeout(c.fading);
  c.fading = setTimeout(() => $('.captions').classList.add('stale'), 6000);
}
