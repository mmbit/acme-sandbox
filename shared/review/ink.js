// Ink: pressure-sensitive pen strokes as plain data, drawn the same way wherever they show: review mode's marks on a
// page and in its screenshot (review.js), and HQ's Sketchbook. The coordinator serves this file at /__review/ink.js on
// every host.
//
// A stroke is { color: '#rrggbb', size, alpha, points: [[x, y, pressure, t], ...] }: x and y in CSS px on the surface it
// was drawn on, pressure 0–1 and t in ms from its first point, so anything can draw it again, at any scale, or replay it
// as it was drawn (draw's `until`). A pen's pressure is its own; a mouse's or a finger's comes from its speed. A filled
// shape has fill: true, its points going round it: the line and everything inside it are ink.

// The stroke's shapes are inkshape.js's, and the live line's repaints and its tail inklive.js's, which draws with the
// same shapes: neither imports this file back
import { HALO, HALO_ALPHA, outline } from './inkshape.js';
import { ahead, dropTail, samples, show } from './inklive.js';
export { outline }; // (the book's page picture draws with it)

// The pens' colours, the notebook's (HQ's bookpalette.js) and the pin's strip's alike, so a colour picked in one is found
// in the other (the board, call 161.)
export const PENS = [
  { name: 'Night', color: '#2a2352' },
  { name: 'Red', color: '#d0443a' },
  { name: 'Blue', color: '#2f6bdc' },
  { name: 'Green', color: '#1d9a5b' },
];
const penInk = name => ({ ...PENS.find(p => p.name === name), size: 5 });
// The inks a small tool strip offers: red first (a call's only ink: pencil.js), then the notebook's other pens and its
// first see-through highlighter
export const INKS = [
  penInk('Red'),
  penInk('Night'),
  penInk('Blue'),
  penInk('Green'),
  { name: 'Highlighter', color: '#ffd23f', size: 20, alpha: 0.42 },
];

// how far a line's point goes towards the pointer, the rest left behind against a hand's jitter (an ink can have its own)
const FOLLOW = 0.6;

// Draws strokes on a 2D canvas context, in its current transform. halo: a white edge around each (not a highlighter),
// all the halos first, so none covers another stroke's ink. until: only what was drawn by then (ms from each stroke's
// start), for a replay.
export function draw(g, strokes, { halo = false, until = Infinity } = {}) {
  const shown = strokes
    .map(s => (until === Infinity ? s : { ...s, points: s.points.filter(q => q[3] <= until) }))
    .filter(s => s.points.length);
  g.save();
  if (halo) {
    g.fillStyle = '#fff';
    for (const s of shown)
      if (!(s.alpha < 1)) {
        g.globalAlpha = HALO_ALPHA;
        g.fill(new Path2D(outline(s, HALO)));
      }
  }
  for (const s of shown) {
    g.globalAlpha = s.alpha ?? 1;
    g.fillStyle = s.color;
    g.fill(new Path2D(outline(s)));
  }
  g.restore();
}

// The strokes as an SVG picture of the given size (an agent's or the Sketchbook's copy)
export function svg(strokes, w, h, { halo = false } = {}) {
  const path = (s, grow, fill, alpha) =>
    `<path d="${outline(s, grow)}" fill="${fill}"${alpha < 1 ? ` fill-opacity="${alpha}"` : ''}/>`;
  const halos = halo ? strokes.filter(s => !(s.alpha < 1)).map(s => path(s, HALO, '#fff', HALO_ALPHA)) : [];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${halos.join('')}${strokes.map(s => path(s, 0, s.color, s.alpha ?? 1)).join('')}</svg>`;
}

// A canvas the size of its box, in device pixels, cleared and drawn in CSS px
export function fit(canvas) {
  const k = devicePixelRatio || 1,
    r = canvas.getBoundingClientRect(),
    w = Math.round(r.width * k),
    h = Math.round(r.height * k);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const g = canvas.getContext('2d');
  g.setTransform(k, 0, 0, k, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  return g;
}

// The pen on a surface: strokes drawn live on `wet`, a canvas over the surface (with no pointer events of its own).
// opts:
//   use(e): whether this pointer draws (review mode: once a pen has drawn, only the pen: a resting palm doesn't)
//   ink(): the ink to draw with, { color, size, alpha, follow? (its smoothing: extend's) }
//   halo: a white edge around the ink, as draw's
//   under: with halo, a canvas the same size as `wet` under the dry ink, where the live line's white edge goes (ink.js
//     gives it draw's opacity), so it sits under every line's ink as draw puts it, and the line doesn't change as it
//     goes on the dry canvas. Without it the edge is drawn on `wet`, under its own line but over older lines' ink.
//   shape(e): 'rect' for a rectangle from where it starts to where it is (Shift held, in review mode)
//   pictured: its dry ink is on canvases a watch-along records (the book's).
//   end(stroke, e): a stroke finished; the wet canvas still shows it until clear()
// start(e) begins a stroke from a pointerdown that reached another element first (review mode's pen on the page),
// move(e) carries it on from a pointermove that did too, and end(e) ends it from a pointerup that did (the Pencil on
// HQ, followed on the window).
// Anything may follow the ink as data (a walk-through call's recording): the document hears an 'ink:stroke' event as
// a stroke starts, grows and ends or is cancelled, its detail { phase: 'start' | 'move' | 'end' | 'cancel', stroke,
// left, top, scroll, halo, pictured }: the surface's place on screen and the page's scroll as the stroke started,
// whether it's drawn with a white edge, and whether its dry ink is in recorded canvas pictures (opts.pictured). A
// surface's dry ink drawn again (shown) is { phase: 'shown', canvas, strokes, halo }.
export function pen(surface, wet, opts) {
  const under = opts.halo ? opts.under : null;
  if (under) under.style.opacity = HALO_ALPHA;
  let line = null;
  function start(e) {
    if (line || (opts.use && !opts.use(e))) return false;
    line = begin(e, surface, wet, under, opts);
    capture(surface, e.pointerId);
    show(line, follow(line, e, 'start'));
    tell('start', line);
    return true;
  }
  const move = e => {
    if (!line || e.pointerId !== line.id) return;
    // (the tail, and its timeout)
    show(line, follow(line, e, 'move'), ahead(line, e));
    dropTail(line, () => line);
    tell('move', line);
  };
  function finish(e) {
    if (!line || e.pointerId !== line.id) return;
    show(line, follow(line, e, 'end'), null); // (no tail)
    tell('end', line);
    const done = line.stroke;
    line = null;
    opts.end(done, e);
  }
  const cancel = e => {
    if (!line || (e && e.pointerId !== line.id)) return;
    tell('cancel', line);
    line = null;
    clear();
    opts.cancel?.();
  };
  const clear = () => [wet, under].forEach(c => c && fit(c));
  surface.addEventListener('pointerdown', e => start(e) && e.preventDefault());
  surface.addEventListener('pointermove', move);
  surface.addEventListener('pointerup', finish);
  surface.addEventListener('pointercancel', cancel);
  return {
    start,
    move,
    end: finish,
    cancel,
    clear,
    get drawing() {
      return !!line;
    },
  };
}

const capture = (surface, id) => {
  try {
    surface.setPointerCapture(id);
  } catch {
    /* gone already */
  }
};

// A line being drawn on screen: its line as data (track) and the canvases that show it
function begin(e, surface, wet, under, opts) {
  const r = surface.getBoundingClientRect(),
    ink = opts.ink();
  wet.style.opacity = ink.alpha ?? 1;
  const line = track(e, r, ink, { rect: opts.shape?.(e) === 'rect', halo: !!opts.halo });
  return {
    ...line,
    g: fit(wet),
    u: under && fit(under),
    scroll: [Math.round(scrollX), Math.round(scrollY)],
    pictured: !!opts.pictured,
  };
}

// What the pen keeps of a line, from its first pointer event: where its surface was, when it started, and its stroke
const track = (e, at, ink, { rect = false, halo = false } = {}) => ({
  id: e.pointerId,
  left: at.left,
  top: at.top,
  t0: e.timeStamp,
  kind: e.pointerType,
  rect,
  halo: halo && !(ink.alpha < 1),
  stroke: { color: ink.color, size: ink.size, ...(ink.alpha < 1 ? { alpha: ink.alpha } : {}), points: [] },
  // (how far each point goes towards the pointer: less is a steadier line.)
  follow: ink.follow ?? FOLLOW,
  speed: 0, // (a mouse's or a finger's, for its pressure)
  pressure: 0, // (a pen's last, for a lift that reports none)
});

// What one pointer event ('start', 'move' or 'end') adds to a line: the indexes of the points it kept. A rectangle's
// points are all made again each time: null.
function follow(line, e, phase) {
  if (line.rect) return phase === 'end' ? [] : (boxed(line, e), null);
  const kept = [];
  for (const s of phase === 'move' ? samples(e) : [e])
    if (extend(line, s, phase)) kept.push(line.stroke.points.length - 1);
  return kept;
}

// A point, smoothed a little against a hand's jitter (FOLLOW, or the ink's own); a pen's pressure is its own, anything
// else's from its speed.
// It's kept rounded, and drawn as kept: the dry canvas draws it from the stroke, so the live line must be that one.
function extend(line, e, phase = 'move') {
  const x = e.clientX - line.left,
    y = e.clientY - line.top,
    t = Math.max(0, Math.round(e.timeStamp - line.t0)),
    pts = line.stroke.points,
    prev = pts[pts.length - 1];
  let p;
  // (a pen lifting says pressure 0 on iPad Safari: it keeps the last, or the line's end would change width)
  if (line.kind === 'pen' && e.pressure > 0) p = line.pressure = e.pressure;
  else if (line.kind === 'pen' && line.pressure) p = line.pressure;
  else {
    if (prev) line.speed += (Math.hypot(x - prev[0], y - prev[1]) / Math.max(1, t - prev[3]) - line.speed) * 0.3;
    p = Math.max(0.3, 0.62 - line.speed * 0.12);
  }
  // (the lift's point is where the pointer lifted, so a steady line still ends there.)
  const k = phase === 'end' ? 1 : line.follow;
  const q =
    prev && phase !== 'start'
      ? [prev[0] + (x - prev[0]) * k, prev[1] + (y - prev[1]) * k, prev[2] + (p - prev[2]) * 0.5, t]
      : [x, y, p, t];
  const kept = q.map((v, i) => (i === 3 ? v : Math.round(v * 100) / 100));
  if (prev && Math.hypot(kept[0] - prev[0], kept[1] - prev[1]) < 0.6) return false;
  pts.push(kept);
  return true;
}

// A rectangle, from where it started to where it is now: its four corners as the line, back to the first
function boxed(line, e) {
  const x = e.clientX - line.left,
    y = e.clientY - line.top,
    t = Math.max(0, Math.round(e.timeStamp - line.t0));
  const [x0, y0] = (line.start ??= [x, y]);
  const corners = [
    [x0, y0],
    [x, y0],
    [x, y],
    [x0, y],
    [x0, y0],
  ];
  line.stroke.points = corners.map(([a, b], i) => [Math.round(a), Math.round(b), 0.5, i ? t : 0]);
}

const tell = (phase, { stroke, left, top, scroll, halo, pictured }) =>
  document.dispatchEvent(
    new CustomEvent('ink:stroke', { detail: { phase, stroke, left, top, scroll, halo, pictured } }),
  );

// What a canvas of dry ink shows now, after it's drawn again (a note's lines, fewer after an undo, none once sent), for
// whatever follows the ink: strokes in the canvas's CSS px. A canvas whose own pictures are recorded (a sketch's
// page) says none: its pictures carry them.
export const shown = (canvas, strokes, { halo = false } = {}) =>
  document.dispatchEvent(new CustomEvent('ink:stroke', { detail: { phase: 'shown', canvas, strokes, halo } }));
