// The Notebook opening and closing as a heavy hardcover (the board's prototype's feel; its maths bookswingmath.js): its
// cover and paper one rigid board swinging round the spine at the screen's right edge, drawn each frame by transforms
// alone (perspective and a turn round the spine; the edge, leaf and pull tab book.js lays out). While it's lifted it
// reads closer, its page face shades, the page block's edge shows at its outer edge, and it casts a soft shadow on HQ's
// page that tightens as it nears the surface. HQ's page dissolves (blurred and faded) as the board lowers, gone by the
// time it lands, settles into its new room while it's gone, and only then fades back in, sharp and slowly; closing the
// same in reverse. (settled first, slower: the board's call 148) The landing thuds: a sound,
// a 1 to 2 px nudge of the page, a haptic tick where there is one. Shutting, it closes with a gentler sound than the
// landing's (the board's call 149).
// The pull tab's gestures are here: pulled while shut (or mid-swing), it lifts the board, which follows the finger
// with a slight lag; let go, gravity or the close takes it (letGo). Held on after it lands, the book stays put for
// HOLD ms, then the same drag resizes it, the edge catching up with the finger once. Open, pulled left first, it
// resizes as the cover's edge does (book.js's). A tap is the tab's click (bookhandle.js). With reduced motion, none of
// this: book.js crossfades.
import { store } from '../../util.js';
import { foley } from '../audio.js';
import { EDGE, BOOK } from './booklayout.js';
import { follow } from './bookfollow.js';
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
  dissolveStep,
  dissolveLook,
  easeInOut,
  CATCH_UP,
  HOLD,
} from './bookswingmath.js';

// A tap's nudge off upright (rad/s): gravity alone would take its time to tip it
const NUDGE = -1.4;
// HQ's page blurs as it dissolves only where frames keep up: the swing's median frame slower than this (s) turns the
// blur off on this device, for good (a plain fade instead): the prototype's "measure, then fall back"
const SLOW_FRAME = 1 / 45;
// The book's own shadow on HQ's page grows in over the last this much of its drop (px of height over the page)
const REST = 240;
// Landed or shut, HQ's page stays gone while it lays itself out in its new room: two frames, then whatever its own
// transitions and animations do about it, at most this long (ms); then it comes back in over about three of these (s)
const SETTLE_MAX = 450,
  BACK_IN = 0.35;

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let root, parts, host;
let body = { a: UPRIGHT, w: 0 };
let mode = null; // 'drag', 'fall', 'shut', or null at rest
let geo = null; // the board laid out: { x: the cover's edge's left, width: the paper's, over: lying over HQ's page }
let shift = 0; // how far a resize after the landing has moved the cover's edge from geo.x (px, - left)
let laidOpen = false; // HQ's page laid out beside the open book (not the whole screen)
let dis = 0; // HQ's page's dissolve, 0 clear to 1 gone
let settling = 0; // HQ's page laying itself out in its new room, kept gone meanwhile: the settle's number, 0 none
let drawnLook = null; // what the dissolve drew last
let hand = null; // the pull tab held: { d, ..., resize }
let thudded = true,
  settle = 0,
  raf = 0,
  last = 0,
  frames = [];
let cast,
  shade,
  block,
  lipWidth = 22;

// root: #book; parts: book.js's; host: book.js's side of it:
// { board(): the open book's { x, width, over }, lay(at): the parts laid out there, widen(px): the leaf at least that
//   wide, laidOpen(): HQ's page beside the open book now, landed(dx): open, the edge moved dx by a resize, shut(),
//   edge: { start, move(dx), end(dx, v) } the cover's edge's drag, pulled(dx, v): a reduced-motion pull let go }
export function mountSwing(rootEl, partsOf, hostOf) {
  root = rootEl;
  parts = partsOf;
  host = hostOf;
  cast = div('bk-cast', '<i class="bk-cast-soft"></i><i class="bk-cast-tight"></i>');
  parts.table.after(cast);
  shade = div('bk-shade');
  parts.leaf.append(shade);
  block = div('bk-block');
  parts.edge.append(block);
  grip(parts.lip);
}
const div = (className, html = '') => Object.assign(document.createElement('div'), { className, innerHTML: html });

// Where the book's heading: 'open' or 'shut' while it swings, null at rest
export const heading = () => (mode === 'shut' ? 'shut' : mode ? 'open' : null);
export const swinging = () => !!mode;

// Open it: from shut, a tap's nudge off upright and gravity; mid-swing, it falls from where it is
export function open(push = 0) {
  if (!mode) begin(UPRIGHT, NUDGE);
  mode = 'fall';
  settle = 0;
  body = { ...body, w: body.w + push };
  run();
}
// Shut it: the spring swings it up from where it is
export function shut() {
  if (!mode) begin(0, 0);
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
  cast.style.width = `${innerWidth - geo.x}px`;
  lipWidth = parts.lip.offsetWidth || lipWidth;
}
// Back at rest: the swing's own drawing taken off (book.js's layout has the parts)
function rest() {
  root.classList.remove('bk-swinging', 'bk-lifted');
  for (const el of [parts.edge, parts.leaf, parts.lip]) el.style.transformOrigin = '';
  cast.style.visibility = 'hidden';
  shade.style.opacity = 0;
  block.style.transform = '';
  root.style.removeProperty('--bk-rest');
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
    if (dis > 0 && dis < 1) frames.push(dt);
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
      if (settle > 0.06) landed();
    } else if (mode === 'shut' && body.a >= UPRIGHT) closed();
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
  slow();
  const dx = shift;
  shift = 0;
  rest();
  host.landed(dx);
  laidOpen = host.laidOpen();
  settleIn();
}
function closed() {
  mode = null;
  // (the cover meeting the pages: the landing's card, smaller and softer, 5 to 8 dB under its thud)
  foley('hit', { material: 'card', size: 1.8, force: 0.3 }, { vol: 0.3 });
  body = { a: UPRIGHT, w: 0 };
  slow();
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
// (the swing's frames too slow for the blur on this device: a plain fade from now on)
function slow() {
  if (frames.length < 12 || !store.get('book.blur', true)) return;
  const sorted = frames.sort((p, q) => p - q);
  if (sorted[sorted.length >> 1] > SLOW_FRAME) store.set('book.blur', false);
}

// The board at its angle: the edge and leaf turned round the spine in perspective, slid off the screen's edge as they
// near upright; the pull tab at the outer edge's place on the screen; the shade, the block's edge and the shadow.
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
  // (the tab follows the cover's outer edge, at the screen's edge once the board's slid off it, inside the screen where
  // the book lies over all of it)
  const tab = Math.max(innerWidth - Math.max(0, reachAt(a, b)), geo.over ? lipWidth : 0);
  parts.lip.style.transform = `translate3d(${(tab - geo.x).toFixed(2)}px, 0, 0)`;
  root.classList.toggle('bk-lifted', a > 0.002);
  shade.style.opacity = (0.22 * Math.sin(a)).toFixed(3);
  block.style.transform = `scaleX(${Math.sin(a).toFixed(3)})`;
  // (the shadow reaches past the board's edge the higher it's held, as a light above and behind the screen would throw
  // it, and draws in under it as it lands)
  const z = b * Math.sin(a),
    x = reachAt(a, b) + z * 0.12,
    lift = Math.min(1, z / 300),
    dark = 0.5 - lift * 0.28;
  cast.style.visibility = z < 1 || x < 4 ? 'hidden' : 'visible';
  cast.style.transform = `translate3d(${sl.toFixed(1)}px, ${(z * 0.03).toFixed(1)}px, 0) scaleX(${(Math.max(0, x) / (innerWidth - geo.x)).toFixed(4)})`;
  cast.firstChild.style.opacity = (dark * lift).toFixed(3);
  cast.lastChild.style.opacity = (dark * (1 - lift)).toFixed(3);
  // (the book's own shadow on the page beside it grows in over the last REST px of its drop, as the cast draws in
  // under it, and goes as it lifts: never popping in as it lands. The board's call 152)
  root.style.setProperty('--bk-rest', ((1 - Math.min(1, z / REST)) ** 2).toFixed(3));
}

// HQ's page dissolving as the board lowers and back in, sharp, in its new room (never where the book lies over it)
function dissolve(dt) {
  if (still()) return look((dis = 0));
  const target = geo?.over ? 0 : settling ? dis : dissolveAt(body.a, laidOpen);
  // (coming back in at rest, slowly enough to be seen; under the finger, as quick as the board moves)
  dis = dissolveStep(dis, target, dt, mode ? undefined : BACK_IN);
  look(dis);
}
function look(d) {
  const { blur, opacity } = dissolveLook(d),
    page = document.body.style,
    now = `${store.get('book.blur', true) ? blur : 0} ${opacity.toFixed(3)} ${d >= 0.999}`;
  if (now === drawnLook) return;
  drawnLook = now;
  ground(d > 0);
  page.filter = d && store.get('book.blur', true) && blur ? `blur(${blur}px)` : '';
  // (the table's checkerboard where the book lay, blurred as the page is)
  parts.table.style.setProperty('--bk-blur', `${page.filter ? blur : 0}px`);
  page.opacity = d ? opacity.toFixed(3) : '';
  // (wholly gone, it isn't painted at all)
  page.visibility = d >= 0.999 ? 'hidden' : '';
}

// While it dissolves, HQ's page fades into its own colours (<html> wears the page's background), never into the dark
// ground behind it: a dissolve, not a dimming. (The table stays: its checkerboard is what the lifted book shows.)
let grounded = false;
function ground(on) {
  if (on === grounded) return;
  grounded = on;
  const html = document.documentElement.style,
    page = getComputedStyle(document.body);
  html.backgroundColor = on ? page.backgroundColor : '';
  html.backgroundImage = on ? page.backgroundImage : '';
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

// The pull tab's press: a tap (its click, bookhandle.js), a lift, or (open, pulled left first) a resize. Held, it
// lifts a little.
function grip(lip) {
  let kind = null,
    reach0 = 0;
  lip.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button > 0) return;
    lip.classList.add('bk-gripped');
    const up = u => u.pointerId === e.pointerId && lip.classList.remove('bk-gripped');
    addEventListener('pointerup', up, { once: true });
    addEventListener('pointercancel', up, { once: true });
  });
  follow(lip, {
    start(dx) {
      const shutAtStart = !mode && document.documentElement.dataset.book === 'folded';
      kind = still() ? 'still' : !mode && !shutAtStart && dx < 0 ? 'resize' : 'lift';
      if (kind === 'resize') host.edge.start();
      if (kind !== 'lift') return;
      if (!mode) begin(shutAtStart ? UPRIGHT : 0, 0);
      // (the finger keeps its hold on the tab: the tab's at the screen's edge while the board's past it)
      reach0 = Math.max(0, reachAt(body.a, board()));
      hand = { d: reach0 - dx, canResize: shutAtStart, flatFor: 0, resize: null };
      mode = 'drag';
      run();
    },
    move(dx) {
      if (kind === 'resize') host.edge.move(dx);
      if (kind === 'lift' && hand) hand.d = Math.max(0, reach0 - dx);
    },
    end(dx, v) {
      if (kind === 'resize') return host.edge.end(dx, v);
      if (kind === 'still') return host.pulled(dx, v);
      if (mode !== 'drag' || !hand) return;
      const go = hand.resize ? { open: true, push: 0 } : letGo(body.a, v);
      hand = null;
      if (go.open) open(go.push);
      else shut();
    },
  });
}
