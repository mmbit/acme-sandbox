// The call's agent's ring: a loop in its ink where it aims on its picture of the board's screen, as a hand draws one.
// drive.js draws it, on HQ's own page or a preview in HQ's viewer, over the page and never kept: it catches the board's
// eye until what it's on goes, or the call ends.
import { svg } from './ink.js';

// This far round its target, a hand-drawn loop that overshoots its start a little
const RING_PAD = 10,
  RING_POINTS = 56,
  RING_MS = 14; // (between its points, as a hand draws it: about 0.8 s)
// The words beside it: wrapped to this width, in a hand of its own (marks.js's tag on HQ's pages)
const TAG_W = 240,
  HAND = '600 15px "Bradley Hand", "Segoe Print", "Chalkboard SE", "Comic Sans MS", cursive';

// A ring round a box (screen px) as a hand draws one: a loop a little out of round, starting top left, overshooting
// where it began, lighter at its ends. seed: its wobble, so no two rings are alike
export function ringAround(b, color, seed) {
  let s = seed >>> 0 || 1;
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const cx = b.x + b.w / 2,
    cy = b.y + b.h / 2,
    rx = b.w / 2 + RING_PAD,
    ry = b.h / 2 + RING_PAD,
    from = -2.4 + rand() * 0.5,
    turn = 2 * Math.PI + 0.35 + rand() * 0.25,
    [p, q] = [rand() * 6, rand() * 6];
  const points = [];
  for (let i = 0; i <= RING_POINTS; i++) {
    const f = i / RING_POINTS,
      a = from + turn * f,
      k = (1 + 0.04 * Math.sin(2 * a + p) + 0.025 * Math.sin(3 * a + q)) * (1 + 0.07 * f);
    points.push([
      Math.round((cx + rx * k * Math.cos(a)) * 10) / 10,
      Math.round((cy + ry * k * Math.sin(a)) * 10) / 10,
      Math.round((0.35 + 0.4 * Math.sin(Math.PI * f)) * 100) / 100,
      i * RING_MS,
    ]);
  }
  return { color, size: 4, points };
}

// ---- a ring over the page: a layer of its own at a box on the screen (px), following what's under its middle as the
// page scrolls, the agent's name and words beside it. The watch-along records it, so the agent sees its own ring.
const rings = new Set();
export async function ringAt(b, { color = '#7b5ea7', name = '', words = '' }) {
  const stroke = ringAround({ x: 0, y: 0, w: b.w, h: b.h }, color, Date.now());
  const layer = document.createElement('div'),
    tag = words ? document.createElement('p') : null;
  layer.className = 'hq-ring';
  layer.setAttribute('data-call-ink', '');
  layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = `<style>
    .hq-ring { position: fixed; left: 0; top: 0; z-index: 2147483645; pointer-events: none; }
    .hq-ring svg { position: absolute; left: 0; top: 0; overflow: visible; }
    .hq-ring p { position: absolute; margin: 0; width: max-content; max-width: ${TAG_W}px; font: ${HAND}; color: var(--ink); line-height: 18px;
      paint-order: stroke; -webkit-text-stroke: 4px rgb(255 255 255 / .92); }
  </style><svg></svg>`;
  layer.style.setProperty('--ink', color);
  if (tag) {
    // (beside it on the right, else under it)
    tag.textContent = name ? `${name}: ${words}` : words;
    const right = b.x + b.w + RING_PAD + TAG_W < innerWidth;
    Object.assign(
      tag.style,
      right ? { left: `${b.w + RING_PAD + 6}px`, top: '4px' } : { left: '0', top: `${b.h + RING_PAD + 6}px` },
    );
    layer.append(tag);
  }
  const ring = { layer, ...under(b) };
  rings.add(ring);
  follow();
  place(ring);
  document.body.append(layer);
  if (tag) keepOnScreen(tag);
  await unroll(layer, stroke, b);
}
// What the ring follows: what's under its middle (never a ring or pointer of the call's own), and where the ring sits
// from it, with what it had scrolled (a ring on a scrolling box's own space moves with what scrolls in it)
function under(b) {
  const el =
    document.elementsFromPoint(b.x + b.w / 2, b.y + b.h / 2).find(e => !e.closest('[data-call-ink], .hq-pointer')) ??
    document.documentElement;
  const at = el.getBoundingClientRect();
  return { el, dx: b.x - at.left, dy: b.y - at.top, scrolled: scrolledOf(el) };
}
// (the page's own scroller moves its box with it already)
const scrolledOf = el =>
  el === document.scrollingElement ? { x: 0, y: 0 } : { x: el.scrollLeft || 0, y: el.scrollTop || 0 };
// The words kept on the screen, as they were first placed (under the ring, at its left edge, they would run off a narrow
// screen's right edge): moved left to end inside it, and above the ring when there's no room under it
function keepOnScreen(tag) {
  const t = tag.getBoundingClientRect(),
    margin = 8;
  const left = Math.min(0, innerWidth - margin - t.right);
  tag.style.left = `${parseFloat(tag.style.left) + left}px`;
  if (t.bottom > innerHeight - margin) tag.style.top = `${-(t.height + RING_PAD + 6)}px`;
}
// Every ring the agent drew here gone (the call ended)
export function wipeRings() {
  for (const ring of rings) ring.layer.remove();
  rings.clear();
}

// The ring drawn as a hand would; at once if the board asked for less motion
function unroll(layer, stroke, b) {
  const end = stroke.points.at(-1)[3],
    start = performance.now(),
    reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const drawUntil = t => {
    const shown = { ...stroke, points: stroke.points.filter(p => p[3] <= t) };
    layer.querySelector('svg').outerHTML = svg([shown], b.w, b.h, { halo: true });
    // (its size kept against a page's own rule for its icons, HQ's 18 px)
    Object.assign(layer.querySelector('svg').style, { width: `${b.w}px`, height: `${b.h}px` });
  };
  return new Promise(done => {
    const frame = () => {
      const t = reduced ? end : performance.now() - start;
      drawUntil(t);
      if (t < end) requestAnimationFrame(frame);
      else done();
    };
    requestAnimationFrame(frame);
  });
}

// Each ring where what it's on is now: moved as anything scrolls or the screen turns, gone with it
let following = false;
function follow() {
  if (following) return;
  following = true;
  let asked = 0;
  const again = () =>
    (asked ||= requestAnimationFrame(() => {
      asked = 0;
      for (const ring of rings) place(ring);
    }));
  addEventListener('scroll', again, { capture: true, passive: true });
  addEventListener('resize', again);
}
function place(ring) {
  const b = ring.el.isConnected && ring.el.getBoundingClientRect();
  if (!b?.width && !b?.height) {
    ring.layer.remove();
    return rings.delete(ring);
  }
  const now = scrolledOf(ring.el),
    x = b.left + ring.dx - (now.x - ring.scrolled.x),
    y = b.top + ring.dy - (now.y - ring.scrolled.y);
  ring.layer.style.transform = `translate(${x}px, ${y}px)`;
}
