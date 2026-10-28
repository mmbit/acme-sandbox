// The lift: a mark's ink, once its note is in the book, rising off the page as one layer and drifting into the book,
// shrinking into where the note lands there.
import { draw } from './ink.js';
import { boxOfLines } from './mark.js';

// The flight: picked up for its first part (a rise, a tilt, its shadow under it), then an arc into the landing rect, the
// ink fading as it gets there. Long enough to follow, short enough to be done before the pen moves on.
const FLIGHT_MS = 500,
  PICKUP = 0.18,
  FADE_FROM = 0.84,
  // into a handle (the folded book's) the ink is gone before it's as small as the handle
  FADE_FROM_HANDLE = 0.62;
// With reduced motion the ink fades where it is, this quickly
const FADE_MS = 160;
// Picked up: how far it rises (px), how much it grows and turns
const RISE_PX = 9,
  GROW = 1.035,
  TILT_DEG = -1.6;
// Room round the ink on its canvas for the white halo and the shadow's blur (px)
const PAD = 8;
// Keyframes along the arc: enough that the linear steps between them read as a curve at 120 Hz
const STEPS = 36;
// When the landing is asked again on the way (shares of the flight): before the arc's top, and once more near the end
const AIM_AT = [0.4, 0.6, 0.75];

// The ink lifted into the book. lines: the mark's strokes in screen px (ink.js's); note: { id, page }, the book page it
// went on (group: true, a Notebook scrap's: its group's id and page); snip: its snip (a data URL) or null. Resolves once it has landed.
// Where it lands is asked on the document, synchronously: 'pencil:landing' with { id, page, snip, from, land: null },
// from the ink's box ({ x, y, w, h }, screen px). A listener (the book) sets land to the rect to land in, turning the
// book there first; land.handle: true when that's a folded book's handle, land.turn: the degrees it lands turned. It
// may also set aim(), asked again on the way for a better rect (or null), and arrived(), called the moment the ink is
// there. No answer: it drifts off the screen's right edge.
export function lift(_r, { lines, note, snip = null }) {
  const strokes = (lines ?? []).filter(l => l.points?.length);
  if (!strokes.length) return Promise.resolve();
  const from = boxOfLines(strokes),
    ask = {
      ...{ id: note?.id ?? null, page: note?.page ?? null, snip, from, land: null, aim: null, arrived: null },
      group: !!note?.group, // (a scrap's group, not a sheet's note)
    };
  document.dispatchEvent(new CustomEvent('pencil:landing', { detail: ask }));
  const layer = layerOf(strokes, from);
  const flights = matchMedia('(prefers-reduced-motion: reduce)').matches
    ? [layer.box.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'ease-out', fill: 'forwards' })]
    : fly(layer, from, ask.land ?? offscreen(from), ask.land && ask.aim);
  return Promise.all(flights.map(a => a.finished)).then(
    () => landed(layer, ask),
    () => landed(layer, ask),
  );
}

function landed(layer, ask) {
  layer.host.remove();
  try {
    ask.arrived?.();
  } catch (e) {
    console.error(e);
  }
}

// The ink as one layer of its own over everything (the page may clip what's in it, and the book is outside it): a host
// at the ink's box, its shadow and its ink as two canvases in a closed shadow root
function layerOf(strokes, from) {
  const host = document.createElement('review-lift'),
    w = from.w + 2 * PAD,
    h = from.h + 2 * PAD;
  host.setAttribute(
    'style',
    `all:initial;position:fixed;left:${from.x - PAD}px;top:${from.y - PAD}px;width:${w}px;height:${h}px;` +
      'z-index:2147483647;pointer-events:none;display:block;will-change:transform,opacity',
  );
  const root = host.attachShadow({ mode: 'closed' });
  const canvas = (css = '') => {
    const c = document.createElement('canvas');
    c.setAttribute('style', `position:absolute;left:0;top:0;width:${w}px;height:${h}px;${css}`);
    return root.appendChild(c);
  };
  const shadow = canvas('filter:blur(3px);opacity:0'),
    ink = canvas();
  document.documentElement.append(host);
  const here = strokes.map(s => ({
    ...s,
    points: s.points.map(([x, y, ...rest]) => [x - from.x + PAD, y - from.y + PAD, ...rest]),
  }));
  draw(fitted(ink, w, h), here, { halo: true });
  draw(
    fitted(shadow, w, h),
    here.map(s => ({ ...s, color: '#1d1a2f', alpha: 0.5 })),
  );
  return { host, box: host, shadow };
}
// A canvas in device px for a CSS size (ink.js's fit, without waiting for a layout to measure)
function fitted(c, w, h) {
  const k = devicePixelRatio || 1;
  c.width = Math.ceil(w * k);
  c.height = Math.ceil(h * k);
  const g = c.getContext('2d');
  g.setTransform(k, 0, 0, k, 0, 0);
  return g;
}

// The flight to a rect: the host along its arc, its shadow under it while it's held up. aim(): asked again as it flies,
// for a rect shown since (where the note is now drawn), which the rest of its arc bends towards.
function fly(layer, from, land, aim) {
  const fadeFrom = land.handle ? FADE_FROM_HANDLE : FADE_FROM,
    timing = { duration: FLIGHT_MS, easing: 'linear', fill: 'forwards' };
  let path = pathTo(from, land);
  const box = layer.box.animate(framesOf(path, from, fadeFrom), timing);
  if (aim)
    for (const at of AIM_AT)
      setTimeout(() => {
        const next = box.playState === 'running' ? aim() : null;
        if (!next || ['x', 'y', 'w', 'h'].every(k => Math.abs(next[k] - land[k]) < 1)) return;
        path = bent(path, box.currentTime / FLIGHT_MS, pathTo(from, next));
        land = next;
        box.effect.setKeyframes(framesOf(path, from, fadeFrom));
      }, at * FLIGHT_MS);
  return [
    box,
    layer.shadow.animate(
      [
        { opacity: 0, transform: 'translate(0, 0)' },
        { opacity: 0.32, transform: 'translate(2px, 7px)', offset: PICKUP + 0.04 },
        { opacity: 0.22, transform: 'translate(2px, 6px)', offset: fadeFrom },
        { opacity: 0, transform: 'translate(0, 1px)' },
      ],
      timing,
    ),
  ];
}
// Where the ink is at t (0 to 1) on its way to a rect: its centre, scale and turn. Picked up first (a rise, a grow, a
// tilt), then along an arc whose top is above the higher end by a share of the way, as a sheet tossed onto a desk.
function pathTo(from, land) {
  const c0 = centre(from),
    c1 = centre(land),
    s1 = Math.max(0.04, Math.min(land.w / Math.max(from.w, 1), land.h / Math.max(from.h, 1))),
    up = { x: c0.x, y: c0.y - RISE_PX },
    dist = Math.hypot(c1.x - up.x, c1.y - up.y),
    ctrl = { x: (up.x + c1.x) / 2, y: Math.min(up.y, c1.y) - Math.min(120, Math.max(24, dist * 0.22)) },
    turn = land.turn ?? 0;
  return t => {
    if (t <= PICKUP) {
      const u = easeOut(t / PICKUP);
      return { ...lerp(c0, up, u), s: 1 + (GROW - 1) * u, r: TILT_DEG * u };
    }
    const u = easeInOut((t - PICKUP) / (1 - PICKUP));
    return { ...bezier(up, ctrl, c1, u), s: GROW + (s1 - GROW) * u, r: TILT_DEG + (turn - TILT_DEG) * u };
  };
}
// A path that leaves another from t0 on, easing over to a new one by the end
const bent = (path, t0, next) => t => {
  const a = path(t);
  if (t <= t0) return a;
  const b = next(t),
    u = easeInOut((t - t0) / (1 - t0));
  return { ...lerp(a, b, u), s: a.s + (b.s - a.s) * u, r: a.r + (b.r - a.r) * u };
};
// A path as the host's keyframes: moved from where the ink is, the ink fading from fadeFrom on
function framesOf(path, from, fadeFrom) {
  const c0 = centre(from);
  return Array.from({ length: STEPS + 1 }, (_, i) => {
    const t = i / STEPS,
      { x, y, s, r } = path(t);
    return {
      offset: t,
      opacity: t <= fadeFrom ? 1 : 1 - easeIn((t - fadeFrom) / (1 - fadeFrom)),
      transform: `translate(${(x - c0.x).toFixed(2)}px, ${(y - c0.y).toFixed(2)}px) rotate(${r.toFixed(2)}deg) scale(${s.toFixed(4)})`,
    };
  });
}
// No book to land in: off past the screen's right edge, halfway down, small
const offscreen = from => {
  const w = Math.min(48, from.w),
    h = (w / Math.max(from.w, 1)) * from.h;
  return { x: innerWidth + 12, y: innerHeight / 2 - h / 2, w, h, handle: true };
};

const centre = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const bezier = (a, b, c, t) => ({
  x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * b.x + t * t * c.x,
  y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * b.y + t * t * c.y,
});
const lerp = (a, b, u) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
const easeOut = t => 1 - (1 - t) ** 3;
const easeIn = t => t * t;
const easeInOut = t => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
