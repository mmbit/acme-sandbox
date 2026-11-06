// The board's other screens on its live call: an HQ screen that isn't the call's own (its iPad beside the desktop that
// holds the call) records itself for the call's agent while the call is live (the coordinator's watchalong.ts
// startOnScreen), so the agent sees what the board opens and points at there, as its screen 2, 3. It wears the call's
// bubble with the eye and Pause, as the call's own screen does minimised, without a hang-up: Pause stops it at once, as
// a pause the agent is told of, and holds through a reload; Show again goes on. It ends with the call. A screen that
// rings a call itself records as the call's (callscreen.js), never as both.
import { CallBubble } from './callbubble.js';
import { icon } from './icons.js';
import { cue } from './audio.js';
import { inCall } from './call.js';
import { faceOf, framePortrait } from './callscreen.js';
import * as world from '../world/world.js';

// This screen's id and the call it paused on, kept for the tab: a reload goes on as the same screen, paused or not
const SCREEN_ID = 'hq-call-screen',
  PAUSED = 'hq-call-screen-paused';
// Canvas pictures a second, as the call's own screen records (callscreen.js)
const CANVAS_FPS = 0.5;
// The call this screen shows itself on ({ call, agent, name, bubble, watch, paused, seen }), and a start under way
let on = null,
  asking = null;

// At HQ's start, and again each time the board's call goes live (events.js 'call:live')
export function followScreens() {
  if (world.dev) return;
  void showOnCall();
  document.addEventListener('call:live', () => void showOnCall());
  // (this screen rang a call itself: the call's own recording from then on)
  document.addEventListener('call:on', () => end());
}

function showOnCall() {
  if (on || inCall()) return;
  asking ??= start().finally(() => (asking = null));
}

// The screen route: 404, no live call; else the call's agent, and where this screen posts
async function start() {
  try {
    const r = await fetch('/api/watchalong/screens/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ screen: screenId() }),
    });
    if (r.status === 404) return;
    if (!r.ok) throw new Error(`the screen route answered ${r.status}`);
    const call = await r.json();
    // (the recorder loads with the first call: HQ starts without it)
    const { watch } = await import('/shared/watchalong/watchalong.js');
    if (inCall()) return;
    const paused = sessionStorage.getItem(PAUSED) === String(call.call);
    on = { call: call.call, agent: call.agent, name: world.agents.get(call.agent)?.data.name ?? call.agent, paused };
    on.bubble = bubbleFor(on);
    on.bubble.show();
    record(watch, call.events, paused);
    paint();
  } catch (err) {
    console.error('[hq] this screen wasn’t shown on the call:', err);
  }
}

function record(watch, url, paused) {
  const me = (on.watch = watch({
    url,
    typed: 'shown',
    canvasFps: CANVAS_FPS,
    paused,
    // (the call is over, or this screen can show no more of it)
    onEnd: why => {
      if (on?.watch !== me) return;
      if (why !== 'over' && why !== 'stopped') console.error(`[hq] this screen’s watch-along ended: ${why}`);
      end();
    },
    onSeen: seen => {
      if (on?.watch !== me) return;
      on.seen = seen;
      paint();
    },
  }));
}

function bubbleFor(c) {
  const bubble = new CallBubble({
    words: {
      call: `Call with ${c.name}`,
      pause: 'Pause',
      resume: 'Show again',
      open: `Call with ${c.name}, on your other screen`,
      watched: `${c.name} sees this page`,
    },
    icons: { eye: icon('eye'), pause: icon('pause'), resume: icon('eye') },
    face: faceOf(c),
    keep: 'callPosition',
    onPause: () => pause(true),
    onResume: () => pause(false),
    onSound: name => cue(name === 'settle' ? 'dock' : name),
  });
  framePortrait(c, bubble.el);
  return bubble;
}

// The bubble's Pause and Show again
function pause(paused) {
  on.paused = paused;
  if (paused) {
    on.watch.pause();
    sessionStorage.setItem(PAUSED, String(on.call));
  } else {
    on.watch.resume();
    sessionStorage.removeItem(PAUSED);
  }
  paint();
  cue('toggle', !paused);
}

// (the eye only while the agent sees it, as the call's bubble: callscreen.js watchState)
const paint = () => on.bubble.watching(on.paused ? 'paused' : on.seen === false ? 'unseen' : 'watched');

function end() {
  if (!on) return;
  const { watch: recording, bubble } = on;
  on = null;
  void recording?.stop();
  bubble.close();
}

function screenId() {
  let id = sessionStorage.getItem(SCREEN_ID);
  if (!id) sessionStorage.setItem(SCREEN_ID, (id = crypto.randomUUID()));
  return id;
}
