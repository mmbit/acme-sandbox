// node --test platform/hq/shell/ink/bookswingmath.test.js   (the Notebook's opening and closing physics)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UPRIGHT,
  SWING,
  step,
  resting,
  slideAt,
  projAt,
  reachAt,
  angleFor,
  letGo,
  dissolveAt,
  fadeAt,
  LANDS,
  LANDED,
  NUDGE,
  dissolveStep,
  dissolveLook,
  easeInOut,
} from './bookswingmath.js';

const FRAME = 1 / 60;
// Run a mode from a body for up to s seconds (or until done says so): the frames' bodies and the hits
function run(body, mode, { s = 3, target = 0, done = () => false } = {}) {
  const frames = [];
  for (let t = 0; t < s && !done(body); t += FRAME) {
    body = step(body, FRAME, mode, target);
    frames.push(body);
  }
  return frames;
}

test('gravity: no torque upright, the most near flat, so it tips slowly and falls faster and faster', () => {
  const tip = step({ a: UPRIGHT, w: 0 }, FRAME, 'fall');
  assert.ok(Math.abs(tip.w) < 1e-9, 'upright and still, it stays');
  const near = step({ a: UPRIGHT - 0.05, w: 0 }, FRAME, 'fall'),
    low = step({ a: 0.3, w: 0 }, FRAME, 'fall');
  assert.ok(near.w < 0 && low.w < 0);
  assert.ok(Math.abs(low.w) > 10 * Math.abs(near.w), 'the pull near flat dwarfs the pull near upright');
  // falling from a nudge, its speed only grows till it strikes the desk
  const fall = run({ a: UPRIGHT, w: -1.4 }, 'fall', { done: b => b.hit > 0 });
  for (let i = 1; i < fall.length - 1; i++) assert.ok(fall[i].w <= fall[i - 1].w + 1e-9);
});

test('the landing: one firm hit, a rebound of about an eighth, then it settles flat within a few frames', () => {
  const frames = run({ a: UPRIGHT, w: -1.4 }, 'fall', { s: 2 });
  const hits = frames.filter(f => f.hit > 0);
  assert.ok(hits[0].hit > SWING.thud, 'the first strike thuds');
  // (a rebound at most 0.12 of the strike, killed below `still`: never a second thud)
  assert.ok(hits.slice(1).every(f => f.hit < SWING.thud));
  const peak = Math.max(...frames.slice(frames.indexOf(hits[0])).map(f => f.a));
  assert.ok(peak < 0.02, `the bounce is tiny (${peak.toFixed(4)} rad)`);
  const landedAt = frames.findIndex(resting);
  assert.ok(landedAt > 0 && landedAt - frames.indexOf(hits[0]) < 12, 'still within a fifth of a second');
  assert.ok(
    frames.slice(landedAt).every(f => f.a < 0.002),
    'and stays down',
  );
});

test('a tap opens it in about a third of a second; a flick left throws it down faster', () => {
  const t = push => run({ a: UPRIGHT, w: -1.4 + push }, 'fall', { done: b => b.hit > 0 }).length * FRAME;
  const tap = t(0);
  assert.ok(tap > 0.25 && tap < 0.6, `a tap's fall: ${tap.toFixed(2)} s`);
  assert.ok(t(letGo(UPRIGHT, -2).push) < tap * 0.8, 'the flick is quicker');
});

test('dragged, it follows the finger with a lag, never overshooting it by more than a hair (near-critical)', () => {
  const frames = run({ a: UPRIGHT, w: 0 }, 'drag', { target: 0.6, s: 1.5 });
  assert.ok(frames[2].a > 0.6 + 0.5, 'it lags behind the finger at first');
  const within = frames.findIndex(f => Math.abs(f.a - 0.6) < 0.01);
  assert.ok(within * FRAME > 0.12 && within * FRAME < 0.5, `caught up in ${(within * FRAME).toFixed(2)} s`);
  assert.ok(Math.min(...frames.map(f => f.a)) > 0.6 - 0.01, 'no overshoot to speak of');
});

test('shut: the spring swings it up and it stops dead at upright, never past it, never back into view', () => {
  const frames = run({ a: 0, w: 0 }, 'shut', { s: 2 });
  assert.ok(frames.every(f => f.a <= UPRIGHT));
  const up = frames.findIndex(f => f.a === UPRIGHT);
  assert.ok(up > 0 && up * FRAME < 0.6, `upright in ${(up * FRAME).toFixed(2)} s`);
  assert.ok(
    frames.slice(up).every(f => f.a === UPRIGHT),
    'and stays there',
  );
  assert.ok(
    frames.every(f => f.hit === 0),
    'a close never thuds',
  );
});

test('a long frame (a stalled tab) is stepped as at most 33 ms: no leap through the desk', () => {
  const b = step({ a: 0.2, w: -8 }, 1, 'fall');
  assert.ok(b.a >= 0 && b.a < 0.2);
});

test("the slide: none in the board's last 0.4 rad, all 20 px at upright, smooth between", () => {
  assert.equal(slideAt(0), 0);
  assert.equal(slideAt(UPRIGHT - 0.4), 0);
  assert.equal(slideAt(UPRIGHT), SWING.slide);
  assert.ok(slideAt(UPRIGHT - 0.2) > 0 && slideAt(UPRIGHT - 0.2) < SWING.slide);
});

test("perspective: flat, the edge is the board's width away; lifted, it reads closer (wider than its cos)", () => {
  assert.equal(projAt(0, 500), 500);
  assert.ok(Math.abs(projAt(UPRIGHT, 500)) < 1e-9);
  assert.ok(projAt(0.8, 500) > 500 * Math.cos(0.8));
  assert.ok(reachAt(UPRIGHT, 500) < 0, 'shut, the edge is past the screen');
});

test('angleFor puts the edge under the finger, and anything past the flat reach lies flat', () => {
  // (in the board's first tenth of a radian, perspective brings its edge nearer than flat: that reach is flat's)
  assert.equal(angleFor(reachAt(0.1, 480), 480), 0);
  for (const a of [0.5, 1, 1.4]) assert.ok(Math.abs(angleFor(reachAt(a, 480), 480) - a) < 1e-5);
  assert.equal(angleFor(480, 480), 0);
  assert.equal(angleFor(900, 480), 0);
  assert.ok(Math.abs(angleFor(-5, 480) - UPRIGHT) < 0.4, 'a finger past the screen edge: nearly upright');
});

test('let go: a flick right shuts it; mostly upright and not going left shuts it; else it falls, a flick left harder', () => {
  assert.deepEqual(letGo(0.2, 0.8), { open: false, push: 0 });
  assert.deepEqual(letGo(1.2, 0), { open: false, push: 0 });
  assert.deepEqual(letGo(0.8, 0), { open: true, push: 0 });
  assert.equal(letGo(1.2, -0.5).open, true);
  assert.equal(letGo(1.2, -0.5).push, -1.25);
});

test('the dissolve: gone by the time the board lands, back in at the new room; easing back, never jumping', () => {
  assert.equal(dissolveAt(UPRIGHT, false), 0);
  assert.equal(dissolveAt(0.1 * UPRIGHT, false), 1);
  assert.equal(dissolveAt(0, true), 0);
  // (shutting, the same: gone 90% of the way up, back once it's shut.)
  assert.equal(dissolveAt(0.9 * UPRIGHT, true), 1);
  assert.equal(dissolveAt(UPRIGHT, false), 0);
  assert.equal(dissolveAt(0.5 * UPRIGHT, true), dissolveAt(0.5 * UPRIGHT, false), 'halfway, the same both ways');
  let d = 1;
  const back = [];
  for (let i = 0; i < 30 && d > 0; i++) back.push((d = dissolveStep(d, 0, FRAME)));
  assert.ok(back.length > 6 && back.length < 30, `back in over ${back.length} frames`);
  assert.equal(back.at(-1), 0);
  assert.equal(dissolveStep(0.3, 0.6, FRAME), 0.6, 'as it lowers the dissolve follows at once');
  assert.deepEqual(dissolveLook(1), { blur: 10, opacity: 0 });
  assert.equal(dissolveLook(0.53).blur, 5.5, 'half-pixel steps');
});

// (the board, 28 Oct)
test("the close's dissolve keeps the opening's time: the spring's quicker swing up waits for it", () => {
  const opened = run({ a: UPRIGHT, w: NUDGE }, 'fall', { done: b => b.a < 0.1 * UPRIGHT }),
    shut = run({ a: 0, w: 0 }, 'shut', { done: b => b.a >= UPRIGHT });
  const gone = opened.length * FRAME;
  assert.ok(shut.length * FRAME < gone, 'the spring shuts it sooner than the board falls');
  assert.ok(fadeAt(0) === 0 && fadeAt(gone - 2 * FRAME) < 1, 'fading over the fall');
  assert.equal(fadeAt(gone + FRAME), 1, 'gone as the open board is');
  for (const s of [0.1, 0.2, 0.3]) assert.ok(fadeAt(s) <= fadeAt(s + FRAME), 'never back while it goes');
  // (and gone as long: it gives HQ's page its room when the open board would land, lying still LANDED s: the board's
  // call 160)
  let still = 0;
  const lands = run({ a: UPRIGHT, w: NUDGE }, 'fall', {
    done: b => (still = resting(b) ? still + FRAME : 0) > LANDED,
  });
  assert.ok(Math.abs(LANDS - (lands.length + 1) * FRAME) <= FRAME, `lands at ${LANDS}, not ${lands.length * FRAME}`);
  assert.ok(LANDS > gone + 0.1, 'the open board lands a while after the page is gone');
});

test('the catch-up eases in and out, from 0 to 1', () => {
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.equal(easeInOut(0.5), 0.5);
  assert.ok(easeInOut(0.1) < 0.1 && easeInOut(0.9) > 0.9);
});
