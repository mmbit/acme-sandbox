// A call's screen (call.js): a layer of its own over HQ, drawn as the intercom draws a call, and the bubble it minimises
// into (callbubble.js), floating over HQ's tools and the viewer while the call goes on. Once the board picks Show my
// screen, the page is watched along: the call's agent sees what the board sees, recorded with the call
// (shared/watchalong). Minimising shares nothing.
// The screen opens on the agent's little screen, its pixel figure alive with its voice as the bubble's is, over the
// call's transcript, the board's and the agent's lines, scrolling with the newest. Minimised by the Pencil (review mode)
// or on a small screen, the bubble is slim audio bars.
import { esc, store as saved } from '../util.js';
import { startWatchalong } from './data.js';
import { cue } from './audio.js';
import { CallBubble } from './callbubble.js';
import * as world from '../world/world.js';
import { scene } from './stage.js';
import { icon } from './icons.js';
import { tell } from './desk.js';

const $ = s => document.querySelector(s);
const PICTURE = icon('picture');
const MINIMISE = icon('minimise');
const EYE = icon('eye');
// the screen's one share control, in the call's words
const SHOW = 'Show my screen',
  STOP = 'Stop showing',
  UNSHOWN = 'Your screen couldn’t be shown. Try Show my screen again.',
  UNSEEN = name => `Your screen isn’t reaching ${name} right now.`;
// A small screen, where the bubble's face would cover too much of the page: a phone either way round, a narrow window
// (an iPad mini is 744 px at its narrowest and keeps the face).
const SMALL = '(max-width: 599px), (max-height: 499px)';
// How near the transcript's end counts as reading the newest line (the board scrolled up past it: it stays put)
const FOLLOW_PX = 24;
export function openLayer(c) {
  const layer = (c.layer = document.createElement('div'));
  layer.id = 'call-layer';
  layer.setAttribute('data-watchalong-hide', ''); // (the call's own controls are never recorded)
  const big = saved.get('intercomSize') === 'large' ? ' big' : '';
  layer.innerHTML = `<div class="device intercom in-call${big}" role="dialog" aria-modal="true" aria-label="Call with ${esc(c.name)}">
    <header><span class="grille" aria-hidden="true"></span><b>Call · ${esc(c.name)}</b><span class="onair" aria-hidden="true">ON AIR</span><button class="past-btn" id="call-min" aria-label="Minimise" title="Minimise: keep talking while you look around">${MINIMISE}</button></header>
    <div class="screen"><div class="call" id="call-screen">
      <div class="call-face" id="call-face"><span class="cf-figure" aria-hidden="true"></span><p class="state" id="call-state" aria-live="polite">Connecting…</p></div>
      <p class="note" id="call-note" role="status" hidden></p>
      <p class="note" id="call-mic" role="status" hidden></p><!-- (the microphone hears nothing) -->
      <p class="note" id="call-net" role="status" hidden></p><!-- (the line hears the board late: lagging) -->
      <p class="note" id="call-unshown" role="status" hidden></p><!-- (Show my screen didn't start, or doesn't reach the agent) -->
      <ol class="lines" id="call-lines" aria-label="What you’ve both said" data-empty="What you and ${esc(c.name)} say shows here."></ol>
      <!-- pictures on a call: the strip and the attach button -->
      <ul class="pics" id="call-pics" aria-label="Pictures you showed" aria-live="polite" hidden></ul>
      <div class="row share"><button id="call-screenshare" aria-pressed="false" disabled>${EYE}<span>${SHOW}</span></button></div>
      <div class="row"><button class="mic attach" id="call-attach" title="Show a picture" aria-label="Show a picture">${PICTURE}</button><input type="file" id="call-file" accept="image/*" multiple hidden><button id="call-skip">Interrupt</button><button class="hangup" id="call-end">Hang up</button></div>
    </div></div>
  </div>`;
  document.body.append(layer);
  c.face = callFace(c, layer.querySelector('#call-face'));
  // the backdrop and the minimise key make the call small; it goes on
  layer.addEventListener('pointerdown', e => {
    c.onBackdrop = e.target === layer;
  });
  layer.addEventListener('click', e => {
    if (e.target === layer && c.onBackdrop) minimise(c);
  });
  $('#call-min').onclick = () => minimise(c);
  $('#call-screenshare').onclick = () => showScreen(c);
  cue('open');
}
export function closeLayer(c) {
  c.layer?.remove();
  c.smallScreen?.removeEventListener('change', c.slimmer);
  if (!c.small) cue('close');
}

// The agent's little screen at the top of the call's: its portrait, bobbing with its voice (call.js feeds it as it feeds
// the bubble's), leaning in while it thinks
function callFace(c, el) {
  const portrait = scene.portrait?.({ kind: 'agent', id: c.agent });
  el.firstElementChild.append(
    portrait?.img ??
      Object.assign(document.createElement('span'), { className: 'cb-initial', textContent: c.name[0] ?? '?' }),
  );
  if (portrait?.accent) el.parentElement.style.setProperty('--cb-accent', portrait.accent); // (its lines' too)
  return {
    voice(level, talking = level > 0.02) {
      el.style.setProperty('--cb-level', level.toFixed(3));
      el.classList.toggle('talking', talking);
    },
    state: state => (el.dataset.state = state),
  };
}

// The transcript: who says it ('board' or 'agent') and their words so far. The line heard goes on growing as the board
// talks (the line sends the turn so far), and the agent's as its sentences come, so the same speaker's next words fill
// their last line until its turn ends (turnEnded), and the other's start a new one. It follows the newest line unless
// the board scrolled up to read.
export function transcribe(c, who, text) {
  const list = c.layer?.querySelector('#call-lines');
  if (!list || !text) return;
  const follow = list.scrollHeight - list.scrollTop - list.clientHeight < FOLLOW_PX;
  let line = list.lastElementChild;
  if (line?.dataset.who !== who || line.dataset.done != null) {
    line = list.appendChild(document.createElement('li'));
    line.dataset.who = who;
    line.className = who;
    line.innerHTML = `<b class="who">${who === 'board' ? 'You' : esc(c.name)}</b><span></span>`;
  }
  line.lastElementChild.textContent = text;
  if (follow) list.scrollTop = list.scrollHeight;
}
// The line answers a turn (its 'thinking'): the last line is whole, and the next words, either side's, start their own
export function turnEnded(c) {
  const line = c.layer?.querySelector('#call-lines')?.lastElementChild;
  if (line) line.dataset.done = '';
}
// The line takes a turn back (the board went on before hearing the reply): the board's line, closed by its 'thinking', is
// open again, so the whole turn is written over it, and the reply's words it had begun (the agent's line after it) are gone
export function turnTakenBack(c) {
  const list = c.layer?.querySelector('#call-lines');
  while (list?.lastElementChild?.dataset.who === 'agent') list.lastElementChild.remove();
  const line = list?.lastElementChild;
  if (line?.dataset.who === 'board') delete line.dataset.done;
}

// Minimised: the screen shrinks into the bubble and HQ comes back under it (watched along only if the board showed it).
// pen: the Pencil came down on the page (calldraw.js): the bubble is slim audio bars, as on a small screen; minimised
// already, it slims
export async function minimise(c, { pen = false } = {}) {
  if (c.small) {
    if (pen) c.bubble.slim((c.pen = true));
    return;
  }
  c.pen = pen;
  c.small = true;
  const device = c.layer.querySelector('.device'),
    from = device.getBoundingClientRect();
  c.bubble ??= newBubble(c);
  c.bubble.slim(slim(c));
  c.bubble.state(c.live ? 'listening' : '');
  c.bubble.show(from);
  cue('minimise');
  c.layer.classList.add('leaving');
  await device
    .animate([{}, { transform: `translate(${bubbleShift(c, from)}) scale(.18)`, opacity: 0 }], {
      duration: 300,
      easing: 'cubic-bezier(.4, 0, .8, .4)',
    })
    .finished.catch(() => {});
  if (c.small) c.layer.hidden = true;
  c.layer.classList.remove('leaving');
}
// From the screen's middle to the bubble's
function bubbleShift(c, from) {
  const to = c.bubble.el.getBoundingClientRect();
  return `${to.left + to.width / 2 - (from.left + from.width / 2)}px, ${to.top + to.height / 2 - (from.top + from.height / 2)}px`;
}
export function expand(c) {
  if (!c.small) return;
  c.small = false;
  c.layer.hidden = false;
  const device = c.layer.querySelector('.device'),
    to = device.getBoundingClientRect();
  const shift = bubbleShift(c, to);
  c.bubble.hide(to);
  cue('restore');
  device.animate([{ transform: `translate(${shift}) scale(.18)`, opacity: 0 }, {}], {
    duration: 380,
    easing: 'cubic-bezier(.2, 1.2, .4, 1)',
  });
}

const slim = c => c.pen || c.smallScreen.matches;

function newBubble(c) {
  // (the screen turned or the window narrowed while it's small: slim, or the face again)
  c.smallScreen = matchMedia(SMALL);
  c.slimmer = () => c.small && c.bubble.slim(slim(c));
  c.smallScreen.addEventListener('change', c.slimmer);
  const portrait = scene.portrait?.({ kind: 'agent', id: c.agent });
  const face =
    portrait?.img ??
    Object.assign(document.createElement('span'), { className: 'cb-initial', textContent: c.name[0] ?? '?' });
  const bubble = new CallBubble({
    words: {
      call: `Call with ${c.name}`,
      pause: 'Pause',
      resume: 'Show again',
      hangUp: 'Hang up',
      open: `Open the call with ${c.name}`,
      watched: `${c.name} sees this page`,
    },
    icons: { eye: icon('eye'), hangUp: icon('hangup') },
    face,
    keep: 'callCorner',
    onPause: () => pauseWatch(c, true),
    onResume: () => pauseWatch(c, false),
    onHangUp: () => c.hangUp(),
    onOpen: () => expand(c),
    onSound: name => cue(name === 'settle' ? 'dock' : name),
  });
  if (portrait?.accent) bubble.el.style.setProperty('--cb-accent', portrait.accent);
  bubble.watching(watchState(c));
  return bubble;
}

// ---- the watch-along: from the board's Show my screen on, HQ records itself for the call's agent and the call's
// record (the board's typing kept, except passwords and inside private parts: shared/watchalong). Stop showing (or the
// bubble's Pause) stops it at once, as a pause the agent is told of, and only the board shows it again; it ends with
// the call. (shown by the board's choice, never by minimising) It shows as watched only while the server doesn't say the
// agent can't see it (seen, with each batch)
// It answers whether the screen is shown (a start already under way answers with it).
export function watchAlong(c) {
  if (c.watch || !c.call || c.over) return Promise.resolve(!!c.watch); // (not picked up yet: the key waits for it)
  c.watchStarting ??= startWatch(c);
  shareKey(c);
  unshown(c, '');
  return c.watchStarting;
}
async function startWatch(c) {
  try {
    const session = await startWatchalong(world.dev, c.call, c.key);
    const recorder = session.events && (await import('/shared/watchalong/watchalong.js'));
    if (c.over) return false;
    c.watch = recorder
      ? recorder.watch({
          url: session.events,
          typed: 'shown',
          canvasFps: 0.5,
          onEnd: why => watchEnded(c, why),
          onSeen: seen => watchSeen(c, seen),
        })
      : mockWatch();
    c.paused = false;
    c.seen = undefined;
    cue('toggle', true);
    return true;
  } catch (err) {
    console.error('[hq] watch-along didn’t start:', err);
    unshown(c, UNSHOWN);
    return false;
  } finally {
    c.watchStarting = null;
    showWatching(c);
  }
}
function watchEnded(c, why) {
  if (why !== 'stopped') console.error(`[hq] watch-along ended: ${why}`);
  c.watch = null;
  showWatching(c);
}
// (kept across a pause: shown again, it's as the agent's side last said)
function watchSeen(c, seen) {
  if (c.seen === seen) return;
  c.seen = seen;
  showWatching(c);
}
function pauseWatch(c, paused) {
  if (!c.watch) return;
  if (paused) c.watch.pause();
  else c.watch.resume();
  c.paused = paused;
  showWatching(c);
  cue('toggle', !paused);
}
// Show on the agent's ask to see (calldraw.js): the watch-along starts, or a paused one shows again; it answers whether
// the screen is shown
export async function share(c) {
  if (!c.watch) return watchAlong(c);
  if (c.paused) pauseWatch(c, false);
  return true;
}
// The call screen's Show my screen: starts the watch-along, or shows the paused one again; Stop showing pauses it
function showScreen(c) {
  if (!c.watch) return watchAlong(c);
  pauseWatch(c, !c.paused);
}
// (unseen: shown, but the agent can't see it: no eye, and the call screen says so; never while paused by choice)
const watchState = c => (!c.watch ? 'off' : c.paused ? 'paused' : c.seen === false ? 'unseen' : 'watched');
function showWatching(c) {
  const state = watchState(c);
  c.bubble?.watching(state);
  if (c.watch) unshown(c, state === 'unseen' ? UNSEEN(c.name) : '');
  shareKey(c);
}
// The key says what it does next, and waits for the call to pick up (call.js asks again then)
export function shareKey(c) {
  const key = c.layer?.querySelector('#call-screenshare');
  if (!key) return;
  const shown = !!c.watch && !c.paused;
  key.disabled = !c.call || !!c.watchStarting || c.over;
  key.setAttribute('aria-pressed', String(shown));
  key.lastElementChild.textContent = shown ? STOP : SHOW;
}
// The board asked to show its screen and it didn't start: said on the call screen until the next try
function unshown(c, words) {
  const n = c.layer?.querySelector('#call-unshown');
  if (!n) return;
  tell(n, words);
  n.hidden = !words;
}
// On mock data the page has nowhere to post: the controls work, nothing is recorded
const mockWatch = () => ({ pause() {}, resume() {}, stop: async () => {} });
