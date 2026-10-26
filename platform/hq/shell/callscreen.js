// A call's screen (call.js): a layer of its own over HQ, drawn as the intercom draws a call, and the bubble it minimises
// into (callbubble.js), floating over HQ's tools and the viewer while the call goes on. Once the board picks Show my
// screen, the page is watched along: the call's agent sees what the board sees, recorded with the call
// (shared/watchalong). Minimising shares nothing.
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
  UNSHOWN = 'Your screen couldn’t be shown. Try Show my screen again.';
export function openLayer(c) {
  const layer = (c.layer = document.createElement('div'));
  layer.id = 'call-layer';
  layer.setAttribute('data-watchalong-hide', ''); // (the call's own controls are never recorded)
  const big = saved.get('intercomSize') === 'large' ? ' big' : '';
  layer.innerHTML = `<div class="device intercom in-call${big}" role="dialog" aria-modal="true" aria-label="Call with ${esc(c.name)}">
    <header><span class="grille" aria-hidden="true"></span><b>Call · ${esc(c.name)}</b><span class="onair" aria-hidden="true">ON AIR</span><button class="past-btn" id="call-min" aria-label="Minimise" title="Minimise: keep talking while you look around">${MINIMISE}</button></header>
    <div class="screen"><div class="call" id="call-screen">
      <p class="state" id="call-state" aria-live="polite">Connecting…</p>
      <p class="note" id="call-note" role="status" hidden></p>
      <p class="note" id="call-mic" role="status" hidden></p><!-- (the microphone hears nothing) -->
      <p class="note" id="call-net" role="status" hidden></p><!-- (the line hears the board late: lagging) -->
      <p class="note" id="call-unshown" role="status" hidden></p><!-- (Show my screen didn't start) -->
      <p class="said" id="call-said"></p>
      <!-- pictures on a call: the strip and the attach button -->
      <ul class="pics" id="call-pics" aria-label="Pictures you showed" aria-live="polite" hidden></ul>
      <div class="row share"><button id="call-screenshare" aria-pressed="false" disabled>${EYE}<span>${SHOW}</span></button></div>
      <div class="row"><button class="mic attach" id="call-attach" title="Show a picture" aria-label="Show a picture">${PICTURE}</button><input type="file" id="call-file" accept="image/*" multiple hidden><button id="call-skip">Interrupt</button><button class="hangup" id="call-end">Hang up</button></div>
    </div></div>
  </div>`;
  document.body.append(layer);
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
  if (!c.small) cue('close');
}

// Minimised: the screen shrinks into the bubble and HQ comes back under it (watched along only if the board showed it)
export async function minimise(c) {
  if (c.small) return;
  c.small = true;
  const device = c.layer.querySelector('.device'),
    from = device.getBoundingClientRect();
  c.bubble ??= newBubble(c);
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

function newBubble(c) {
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
// the call. (shown by the board's choice, never by minimising)
export async function watchAlong(c) {
  if (c.watch || c.watchStarting || !c.call || c.over) return; // (not picked up yet: the key waits for it)
  c.watchStarting = true;
  shareKey(c);
  unshown(c, '');
  try {
    const session = await startWatchalong(world.dev, c.call, c.key);
    const recorder = session.events && (await import('/shared/watchalong/watchalong.js'));
    if (c.over) return;
    c.watch = recorder
      ? recorder.watch({ url: session.events, typed: 'shown', canvasFps: 0.5, onEnd: why => watchEnded(c, why) })
      : mockWatch();
    c.paused = false;
    cue('toggle', true);
  } catch (err) {
    console.error('[hq] watch-along didn’t start:', err);
    unshown(c, UNSHOWN);
  } finally {
    c.watchStarting = false;
    showWatching(c);
  }
}
function watchEnded(c, why) {
  if (why !== 'stopped') console.error(`[hq] watch-along ended: ${why}`);
  c.watch = null;
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
// Show on the agent's ask to see (calldraw.js): the watch-along starts, or a paused one shows again
export function share(c) {
  if (!c.watch) return watchAlong(c);
  if (c.paused) pauseWatch(c, false);
}
// The call screen's Show my screen: starts the watch-along, or shows the paused one again; Stop showing pauses it
function showScreen(c) {
  if (!c.watch) return watchAlong(c);
  pauseWatch(c, !c.paused);
}
const watchState = c => (!c.watch ? 'off' : c.paused ? 'paused' : 'watched');
function showWatching(c) {
  c.bubble?.watching(watchState(c));
  shareKey(c);
}
// The key says what it does next, and waits for the call to pick up (call.js asks again then)
export function shareKey(c) {
  const key = c.layer?.querySelector('#call-screenshare');
  if (!key) return;
  const shown = watchState(c) === 'watched';
  key.disabled = !c.call || c.watchStarting || c.over;
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
