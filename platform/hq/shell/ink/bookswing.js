// The Notebook opening and closing as a heavy hardcover (the board's prototype's feel; its maths bookswingmath.js): its
// cover and paper one rigid board swinging round the spine at the screen's right edge, drawn each frame by transforms
// alone (perspective and a turn round the spine; the edge, leaf and pull tab book.js lays out). While it's lifted it
// reads closer, its page face shades, and the page block's edge shows at its outer edge; its one shadow is the one it
// rests with, round it all the way. HQ's page dissolves (blurred and faded) as the board lowers, gone by the
// time it lands, settles into its new room while it's gone, and only then fades back in, sharp and slowly, so the board
// never sees it jump; closing the same in reverse, on the opening's clock. The
// landing thuds: a sound, a 1 to 2 px nudge of the page, a haptic tick where there is one. Shutting, it closes with a
// gentler sound than the landing's, as a cover laid down does.
// The pull tab's gestures are here: pulled while shut (or mid-swing), it lifts the board, which follows the finger
// with a slight lag; let go, gravity or the close takes it (letGo). Held on after it lands, the book stays put for
// HOLD ms, then the same drag resizes it, the edge catching up with the finger once. Open, pulled left first, it
// resizes as the cover's edge does (book.js's). A tap is the tab's click (bookhandle.js). The page's left edge (the
// stack, book.css) swiped right lifts the open book the same way, to close it. With reduced motion, none of this:
// book.js crossfades.
import { store } from '../../util.js';
import { foley } from '../audio.js';
import { EDGE, BOOK } from './booklayout.js';
import { follow } from './bookfollow.js';
import * as link from './notebooklink.js';
import {
  UPRIGHT,
  SWING,
  step,
  resting,
  flat,
  slideAt,
  reachAt,
  angleFor,
  letGo,
  force,
  dissolveAt,
  fadeAt,
  LANDS,
  SETTLE_MAX,
  LANDED,
  NUDGE,
  reopened,
  dissolveStep,
  dissolveLook,
  easeInOut,
  CATCH_UP,
  HOLD,
} from './bookswingmath.js';

// HQ's page blurs as it dissolves only where frames keep up: the median of its last JUDGED frames slower than this (s)
// turns the blur off on this device, then and there and for good (a plain fade instead): the prototype's "measure,
// then fall back"
const SLOW_FRAME = 1 / 45,
  JUDGED = 5;
// Landed or shut, HQ's page stays gone while it lays itself out in its new room (SETTLE_MAX: bookswingmath.js); then it
// comes back in over about three of these (s)
const BACK_IN = 0.35;

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let root, parts, host;
let body = { a: UPRIGHT, w: 0 };
let mode = null; // 'drag', 'fall', 'shut', or null at rest
// the board laid out: { x: the cover's edge's left, width: the paper's, spread: lying over HQ's page, the table round it
// }
let geo = null;
let shift = 0; // how far a resize after the landing has moved the cover's edge from geo.x (px, - left)
let laidOpen = false; // HQ's page laid out beside the open book (not the whole screen)
let dis = 0; // HQ's page's dissolve, 0 clear to 1 gone
let settling = 0; // HQ's page laying itself out in its new room, kept gone meanwhile: the settle's number, 0 none
let drawnLook = null; // what the dissolve drew last
let hand = null; // the pull tab held: { d, ..., resize }
let shutFor = 0; // how long it's been swinging shut (s, the swing's clock): HQ's page fades by the opening's (fadeAt)
let met = false; // the cover has met the pages, its sound heard
let thudded = true,
  settle = 0,
  raf = 0,
  last = 0,
  frames = [];
let shade,
  block,
  lipWidth = 22;

// root: #book; parts: book.js's; host: book.js's side of it:
// { board(): the open book's { x, width, spread }, lay(at): the parts laid out there, widen(px): the leaf at least that
//   wide, laidOpen(): HQ's page beside the open book now, over(): the open book lies over HQ's page, which keeps its
//   whole width (HQ's viewer's Over, asked each frame: it may change mid-swing.),
//   landed(dx): open, the edge moved dx by a resize, shut(), edge: { start, move(dx), end(dx, v) } the cover's edge's
//   drag, pulled(dx, v): a reduced-motion pull let go, → whether it ends open,
//   moving(on): the book lifted to swing, or come to rest, so HQ's scene holds still under it rather than share the
//   book's frames with a building it mostly hides }
export function mountSwing(rootEl, partsOf, hostOf) {
  root = rootEl;
  parts = partsOf;
  host = hostOf;
  shade = div('bk-shade');
  parts.leaf.append(shade);
  block = div('bk-block');
  parts.edge.append(block);
  grip(parts.lip, { tab: true });
  grip(parts.stack, { tab: false });
}
const div = (className, html = '') => Object.assign(document.createElement('div'), { className, innerHTML: html });

// Where the book's heading: 'open' or 'shut' while it swings, null at rest
export const heading = () => (mode === 'shut' ? 'shut' : mode ? 'open' : null);
export const swinging = () => !!mode;

// Open it: from shut, a tap's nudge off upright and gravity; mid-swing, it falls from where it is
export function open(push = 0) {
  if (!mode) begin(UPRIGHT, NUDGE);
  else if (mode === 'shut') body = reopened(body);
  mode = 'fall';
  settle = 0;
  // (let go balanced upright and still, as a pull let go before a slow device drew a frame of it leaves it, gravity
  // alone would never tip it: the tap's nudge does.)
  const w = body.a > UPRIGHT - 0.01 && body.w > NUDGE ? NUDGE : body.w;
  body = { ...body, w: w + push };
  run();
}
// Shut it: the spring swings it up from where it is
export function shut() {
  if (!mode) begin(0, 0);
  if (mode !== 'shut') [shutFor, met] = [0, false];
  mode = 'shut';
  run();
}
// Stopped where it is (a new window size: book.js lays it out again at once), HQ's page clear
export function cancel() {
  mode = null;
  hand = null;
  cancelAnimationFrame(raf);
  raf = 0;
  dis = 0;
  settling = 0;
  look(0);
  rest();
}

// The board laid out where it opens, at angle a and speed w: the swing's start
function begin(a, w) {
  geo = host.board();
  shift = 0;
  laidOpen = host.laidOpen();
  host.lay(geo);
  settling = 0;
  body = { a, w };
  thudded = a > 0.05 ? false : true;
  frames = [];
  root.dataset.mode = 'swing';
  root.classList.add('bk-swinging');
  host.moving(true);
  lipWidth = parts.lip.offsetWidth || lipWidth;
  // (drawn at its angle at once, not at the next frame: laid out, the parts lie flat where it opens, and WebKit can
  // paint that before any frame's callbacks run, the tab flashing where the book last lay open)
  draw();
}
// Back at rest: the swing's own drawing taken off (book.js's layout has the parts)
function rest() {
  root.classList.remove('bk-swinging');
  host.moving(false);
  for (const el of [parts.edge, parts.leaf, parts.lip]) el.style.transformOrigin = '';
  shade.style.opacity = 0;
  block.style.transform = '';
  parts.table.style.opacity = '';
}

function run() {
  if (raf) return;
  last = performance.now();
  raf = requestAnimationFrame(frame);
}
function frame(t) {
  // (the swing steps at most SWING.frame a frame, for its physics; HQ's page coming back in at rest keeps the clock's
  // time, however few frames the device draws)
  const real = (t - last) / 1000,
    dt = Math.min(SWING.frame, real);
  last = t;
  if (mode) {
    if (dis > 0 && dis < 1) judge(real);
    if (mode === 'drag') resize(dt);
    // (held, the finger's angle; resizing, it lies flat whatever the finger does)
    body = step(body, dt, mode, hand && !hand.resize ? angleFor(hand.d, board()) : 0);
    if (body.a > 0.05) thudded = false;
    if (body.hit > SWING.thud && !thudded) {
      thudded = true;
      thud(body.hit);
    }
    if (mode === 'fall') {
      settle = resting(body) ? settle + dt : 0;
      if (settle > LANDED) landed();
    } else if (mode === 'shut') {
      shutFor += dt;
      if (body.a >= UPRIGHT) meet();
      // (upright, edge on and out of sight, it gives HQ's page its room back when an open would have landed, the page
      // gone as long)
      if (body.a >= UPRIGHT && (!laidOpen || geo?.spread || (dis >= 0.999 && shutFor >= LANDS))) closed();
    }
  }
  if (mode) draw();
  dissolve(mode ? dt : Math.min(real, 0.25));
  raf = mode || dis > 0 ? requestAnimationFrame(frame) : 0;
}
// The board's width from its outer edge to the spine (px)
const board = () => innerWidth - geo.x - shift;

function landed() {
  mode = null;
  body = { a: 0, w: 0 };
  const dx = shift;
  shift = 0;
  rest();
  host.landed(dx);
  laidOpen = host.laidOpen();
  settleIn();
}
// The cover meeting the pages: the landing's card, smaller and softer, 5 to 8 dB under its thud
function meet() {
  if (met) return;
  met = true;
  foley('hit', { material: 'card', size: 1.8, force: 0.3 }, { vol: 0.3 });
}
function closed() {
  mode = null;
  body = { a: UPRIGHT, w: 0 };
  rest();
  host.shut();
  laidOpen = false;
  settleIn();
}
// HQ's page kept gone till it has laid itself out in its new room (book.js has given it the room): then the swing's
// frames bring it back in
async function settleIn() {
  const mine = (settling = performance.now());
  await framesOut(2);
  const moving = document
    .getAnimations()
    .filter(a => a.playState === 'running' && isFinite(a.effect?.getComputedTiming().endTime))
    .filter(a => a.effect.target instanceof Element && document.body.contains(a.effect.target));
  await Promise.race([Promise.all(moving.map(a => a.finished.catch(() => {}))), wait(SETTLE_MAX)]);
  await framesOut(1);
  if (settling === mine) settling = 0;
}
const framesOut = n => new Promise(done => (n ? requestAnimationFrame(() => framesOut(n - 1).then(done)) : done()));
const wait = ms => new Promise(done => setTimeout(done, ms));
// (the swing's frames too slow for the blur on this device: a plain fade from this frame on. Judged as they come, on
// the real frame times, from the third on: judged at the end on the swing's capped steps, over at least 12, a device
// managing four frames a second never dropped it, and a blur that costs that much in WebKit, its new radius every
// frame, chugged the whole way. The median, so a single
// slow frame, the pages painted as the book shows, doesn't.)
function judge(real) {
  if (!store.get('book.blur', true)) return;
  frames.push(real);
  if (frames.length > JUDGED) frames.shift();
  const sorted = [...frames].sort((p, q) => p - q);
  if (frames.length >= 3 && sorted[sorted.length >> 1] > SLOW_FRAME) store.set('book.blur', false);
}

// The board at its angle: the edge and leaf turned round the spine in perspective, slid off the screen's edge as they
// near upright; the pull tab at the outer edge's place on the screen; the shade and the block's edge.
function draw() {
  const { a } = body,
    b = board(),
    sl = slideAt(a),
    turn = `translate3d(${(sl + shift).toFixed(2)}px, 0, 0) perspective(${SWING.persp}px) rotateY(${a.toFixed(5)}rad)`;
  for (const [el, left] of [
    [parts.edge, geo.x],
    [parts.leaf, geo.x + EDGE],
  ]) {
    el.style.transformOrigin = `${innerWidth - left - shift}px 50%`;
    el.style.transform = turn;
  }
  // (the tab follows the cover's outer edge, at the screen's edge once the board's slid off it, inside the book's edge
  // where the book lies over all of it, a margin in: book.js)
  const tab = Math.max(innerWidth - Math.max(0, reachAt(a, b)), geo.spread ? geo.x + lipWidth : 0);
  parts.lip.style.transform = `translate3d(${(tab - geo.x).toFixed(2)}px, 0, 0)`;
  // (lying over HQ's page, the table round it comes in over the page as the board lowers and goes as it lifts, in the
  // dissolve's time: booktable.js)
  if (geo.spread) parts.table.style.opacity = dissolveAt(a, false).toFixed(3);
  shade.style.opacity = (0.22 * Math.sin(a)).toFixed(3);
  block.style.transform = `scaleX(${Math.sin(a).toFixed(3)})`;
}

// HQ's page dissolving as the board lowers and back in, sharp, in its new room (never where the book lies over it)
function dissolve(dt) {
  if (still()) return look((dis = 0));
  // (coming back in at rest, slowly enough to be seen; under the finger, as quick as the board moves)
  dis = dissolveStep(dis, dissolveTarget(), dt, mode ? undefined : BACK_IN);
  look(dis);
}
// What the dissolve heads for this frame
function dissolveTarget() {
  // (HQ's page keeping its whole width, open or shut, never dissolves; laid out beside the book that will now land over
  // it, it's gone by the time the board lands, as a shut has it.)
  if (settling) return dis;
  const over = host.over();
  if (geo?.spread || (over && !laidOpen)) return 0;
  // (swinging shut from HQ's page laid out beside it: gone at the opening's pace, never back from where a lift took it)
  if (mode === 'shut' && laidOpen) return Math.max(dis, fadeAt(shutFor));
  if (over) return Math.max(dis, dissolveAt(body.a, false));
  return dissolveAt(body.a, laidOpen);
}
function look(d) {
  const { blur, opacity } = dissolveLook(d),
    page = document.body.style,
    // (and whether it's dissolving at all: the last step to clear draws as the one before it, and was skipped)
    now = `${store.get('book.blur', true) ? blur : 0} ${opacity.toFixed(3)} ${d >= 0.999} ${d > 0}`;
  if (now === drawnLook) return;
  drawnLook = now;
  ground(d > 0);
  page.filter = d && store.get('book.blur', true) && blur ? `blur(${blur}px)` : '';
  page.opacity = d ? opacity.toFixed(3) : '';
  // (wholly gone, it isn't painted at all)
  page.visibility = d >= 0.999 ? 'hidden' : '';
}

// While it dissolves, HQ's page fades into its own colour, the table's (<html> wears it: its --bk-ground, booktable.js
// tones), never into the dark ground behind it: a dissolve, not a dimming, and of a piece with what the lifted book
// uncovers, and as that colour changes midway (the viewer's told late: booktable.js tones).
let grounded = false;
function ground(on) {
  if (on === grounded) return;
  grounded = on;
  document.documentElement.style.backgroundColor = on ? 'var(--bk-ground)' : '';
}

// The landing: a soft thud as hard as it landed, HQ's page nudged a pixel or two, a haptic tick where there is one
function thud(speed) {
  const k = force(speed);
  foley('hit', { material: 'card', size: 2.6, force: 0.35 + 0.5 * k, pitch: -2 }, { vol: 0.45 + 0.4 * k });
  document.body.animate([{ translate: '0 0' }, { translate: `0 ${(1 + k).toFixed(1)}px` }, { translate: '0 0' }], {
    duration: 260,
    easing: 'cubic-bezier(.2,.8,.3,1)',
  });
  navigator.vibrate?.(10);
}

// A resize in the gesture that opened the book: once it's lain flat under the finger for HOLD ms, the cover's edge
// eases to the finger over CATCH_UP ms, then follows it. Never narrower than the book can be drawn on.
function resize(dt) {
  if (!hand.canResize) return;
  if (!hand.resize) {
    hand.flatFor = flat(body) ? hand.flatFor + dt * 1000 : 0;
    if (hand.flatFor < HOLD) return;
    hand.resize = { from: shift, t: 0 };
  }
  const width = Math.min(innerWidth - EDGE, Math.max(BOOK.min, hand.d - EDGE)),
    to = innerWidth - EDGE - width - geo.x,
    r = hand.resize;
  r.t = Math.min(1, r.t + (dt * 1000) / CATCH_UP);
  shift = r.t < 1 ? r.from + (to - r.from) * easeInOut(r.t) : to;
  host.widen(innerWidth - geo.x - shift - EDGE);
}

// The pull tab's press (tab true): a tap (its click, bookhandle.js), a lift, or (open, pulled left first) a resize.
// Held, it lifts a little. The page's left edge's (tab false): only a swipe
// right of the book open at rest, a lift to close it; anything else there is nothing.
function grip(node, { tab }) {
  let kind = null,
    reach0 = 0;
  if (tab)
    node.addEventListener('pointerdown', e => {
      if (!e.isPrimary || e.button > 0) return;
      node.classList.add('bk-gripped');
      const up = u => u.pointerId === e.pointerId && node.classList.remove('bk-gripped');
      addEventListener('pointerup', up, { once: true });
      addEventListener('pointercancel', up, { once: true });
    });
  follow(node, {
    start(dx) {
      const shutAtStart = !mode && document.documentElement.dataset.book === 'folded';
      if (!tab && (mode || shutAtStart || dx < 0)) return void (kind = null);
      kind = still() ? 'still' : tab && !mode && !shutAtStart && dx < 0 ? 'resize' : 'lift';
      if (kind === 'resize') host.edge.start();
      else link.emit('pull');
      if (kind !== 'lift') return;
      if (!mode) begin(shutAtStart ? UPRIGHT : 0, 0);
      // (the finger keeps its hold on the tab: the tab's at the screen's edge while the board's past it)
      reach0 = Math.max(0, reachAt(body.a, board()));
      hand = { d: reach0 - dx, canResize: shutAtStart, flatFor: 0, resize: null, open: !shutAtStart && !mode };
      mode = 'drag';
      run();
    },
    move(dx) {
      if (kind === 'resize') host.edge.move(dx);
      if (kind === 'lift' && hand) hand.d = Math.max(0, reach0 - dx);
    },
    end(dx, v) {
      if (!kind) return;
      if (kind === 'resize') return host.edge.end(dx, v);
      link.emit('letgo', { open: kind === 'still' ? host.pulled(dx, v) : release(v) });
    },
  });
}
// The lifted board let go: gravity or the close takes it. → whether it ends open
function release(v) {
  // (stopped under the hand, by a new window size: where book.js laid it out)
  if (mode !== 'drag' || !hand) return document.documentElement.dataset.book !== 'folded';
  const go = hand.resize ? { open: true, push: 0 } : letGo(body.a, v, hand.open);
  hand = null;
  if (go.open) open(go.push);
  else shut();
  return go.open;
}
