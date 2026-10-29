// The Notebook's opening and closing as physics (bookswing.js draws it): its cover one rigid, heavy board with one degree
// of freedom, its angle a round the spine at the screen's right edge (UPRIGHT shut, 0 lying open on the screen), and
// its angular speed w. Dragged, a near-critically damped spring pulls it towards the angle under the finger, so it
// follows the hand with a slight lag; let go, gravity takes it (its torque by cos a: nothing upright, most near flat)
// onto the desk, a floor at 0 it barely bounces off; shut, an underdamped spring swings it up and it stops dead at
// upright. The board's prototype's feel, ported (its tuning panel's values). Plain maths, so node tests it:
// bookswingmath.test.js.

export const UPRIGHT = Math.PI / 2;
export const SWING = {
  // the view's distance (px): how much closer the lifted board reads
  persp: 3600,
  // gravity's pull (the book's weight), in rad/s² at flat
  g: 42,
  // the hand's spring and how near its damping is to critical (1): a hair under, the lag that sells the weight
  hand: { k: 380, damp: 0.9 },
  // the close's spring towards upright: underdamped, though upright stops it dead
  shut: { k: 150, damp: 0.7 },
  // the desk's restitution, and the rebound (rad/s) too small to show, killed so it settles cleanly
  bounce: 0.12,
  still: 0.3,
  // fixed substeps per frame, for stability; the longest frame stepped (s), a stalled tab's catching up never a leap
  sub: 4,
  frame: 0.033,
  // how far the board slides off the screen's edge as it nears upright (px), so the shut book leaves no strip
  slide: 20,
  // a landing at least this fast (rad/s) thuds
  thud: 1,
};

// One frame of the board's motion. body { a, w }; mode: 'drag' (towards target, the finger's angle), 'fall' (gravity)
// or 'shut' (the spring up). Returns the next { a, w, hit }: hit the speed it struck the desk at (rad/s), else 0.
export function step({ a, w }, dt, mode, target = 0, p = SWING) {
  const h = Math.min(dt, p.frame) / p.sub;
  let hit = 0;
  for (let i = 0; i < p.sub; i++) {
    const acc =
      mode === 'drag'
        ? spring(p.hand, target - a, w)
        : mode === 'shut'
          ? spring(p.shut, UPRIGHT - a, w)
          : -p.g * Math.cos(a);
    w += acc * h;
    a += w * h;
    if (a < 0) {
      // (a strike, not the desk holding it up: gravity's frame of speed at rest is no landing)
      if (mode !== 'shut' && -w > p.still) hit = Math.max(hit, -w);
      a = 0;
      w = -w * p.bounce;
      if (Math.abs(w) < p.still) w = 0;
    }
    // (upright is as far as it goes: it never swings past it, back into view)
    if (a >= UPRIGHT) {
      a = UPRIGHT;
      w = Math.min(w, 0);
    }
  }
  return { a, w, hit };
}
const spring = ({ k, damp }, dx, w) => k * dx - 2 * Math.sqrt(k) * damp * w;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Lying still on the desk: so near flat and so slow that it's landed (the fall's end is this held a few frames)
export const resting = ({ a, w }) => a < 0.002 && Math.abs(w) < 0.05;
// How long it lies still before it has landed (s)
export const LANDED = 0.06;
// Flat enough under a held finger to count as landed (the hold before a resize starts counting from here)
export const flat = ({ a, w }) => a < 0.003 && Math.abs(w) < 0.2;

// How far past the screen's edge the board has slid at angle a (px): none till 0.4 rad from upright, then eased in
export function slideAt(a, p = SWING) {
  const t = clamp((a - (UPRIGHT - 0.4)) / 0.4, 0, 1);
  return p.slide * t * t * (3 - 2 * t);
}
// How far from the spine the board's outer edge shows at angle a, b px wide, in perspective (px)
export function projAt(a, b, p = SWING) {
  const z = b * Math.sin(a);
  return (b * Math.cos(a) * p.persp) / (p.persp - z);
}
// How far in from the screen's edge the board's outer edge reaches, slide and all
export const reachAt = (a, b, p = SWING) => projAt(a, b, p) - slideAt(a, p);
// The angle that puts the board's outer edge d px in from the screen's edge (0 for anything past its flat reach)
export function angleFor(d, b, p = SWING) {
  if (d >= reachAt(0, b, p)) return 0;
  let lo = 0,
    hi = UPRIGHT;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    if (reachAt(m, b, p) > d) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

// The pull tab let go mid-lift at angle a, moving at v px per ms (+ right): it shuts on a flick right, or when it's let
// go mostly upright and not moving left; else it falls open, a flick left throwing it down faster (push, rad/s).
export function letGo(a, v) {
  if (v > 0.6 || (a > 1.05 && v > -0.3)) return { open: false, push: 0 };
  return { open: true, push: v < -0.3 ? v * 2.5 : 0 };
}

// How hard a landing at speed s (rad/s) lands, 0 to 1: the nudge's depth and the thud's force
export const force = s => Math.min(1, s / 6);

// A tap's nudge off upright (rad/s): gravity alone would take its time to tip it
export const NUDGE = -1.4;

// The page under the book dissolving (blurred and faded) as the board swings away from where the page is laid out for,
// and back in, sharp, once it's laid out in its new room: 0 clear to 1 gone. Laid out for the shut book, it's gone by
// the time the board has come 90% of the way down; for the open one, 90% of the way up, the same both ways. Narrow (the
// book on top of the page), it never dissolves.
export function dissolveAt(a, laidOpen) {
  const t = clamp((laidOpen ? a / UPRIGHT : 1 - a / UPRIGHT) / 0.9, 0, 1);
  return t * t * (3 - 2 * t);
}
// The dissolve s seconds into a tapped open (the board falling from upright under its nudge), and when that open lands
// (s: lying still, as bookswing.js's landing counts it): a tapped close's pace too, the spring's swing up being quicker
// than the fall, so HQ's page fades and blurs the same way, stays gone as long and comes back as late, whichever way
// the book goes (bookswing.js). (the board, 28 Oct and its call 160)
const FADE_FRAME = 1 / 60;
// The fall played frame by frame: the dissolve at each frame (fade), and the second it lands (lands)
function openingFade() {
  const fade = [0];
  let b = { a: UPRIGHT, w: NUDGE },
    still = 0;
  while (still <= LANDED) {
    b = step(b, FADE_FRAME, 'fall');
    still = resting(b) ? still + FADE_FRAME : 0;
    fade.push(dissolveAt(b.a, false));
  }
  return { fade, lands: fade.length * FADE_FRAME };
}
const OPENING = openingFade();
export const fadeAt = s => OPENING.fade[Math.min(OPENING.fade.length - 1, Math.max(0, Math.floor(s / FADE_FRAME)))];
export const LANDS = OPENING.lands;
// Landed or shut, HQ's page stays gone while it lays itself out in its new room: two frames, then whatever its own
// transitions and animations do about it, at most this long (ms)
export const SETTLE_MAX = 450;
// The dissolve a frame later: on at once as the board lowers, easing back (over tau s, 70 ms unless said) as the page
// comes back
export function dissolveStep(now, target, dt, tau = 0.07) {
  const next = target >= now ? target : now + (target - now) * (1 - Math.exp(-dt / tau));
  return next < 0.004 && target === 0 ? 0 : next;
}
// What the dissolve draws: blur (px, capped at 10, in half-pixel steps so the filter changes rarely) and opacity
export const dissolveLook = d => ({ blur: Math.round(d * 20) / 2, opacity: 1 - d * d });

// The edge catching up with the finger once a resize starts: in and out over its 160 ms, then under the finger
export const CATCH_UP = 160;
export const easeInOut = t => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
// How long the open book stays put under a held finger after it lands before a drag resizes it (ms): its weight
export const HOLD = 200;
