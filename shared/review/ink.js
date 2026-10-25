// Ink: pressure-sensitive pen strokes as plain data, drawn the same way wherever they show: review mode's marks on a
// page and in its screenshot (review.js), and HQ's Sketchbook. The coordinator serves this file at /__review/ink.js on
// every host.
//
// A stroke is { color: '#rrggbb', size, alpha, points: [[x, y, pressure, t], ...] }: x and y in CSS px on the surface it
// was drawn on, pressure 0–1 and t in ms from its first point, so anything can draw it again, at any scale, or replay it
// as it was drawn (draw's `until`). A pen's pressure is its own; a mouse's or a finger's comes from its speed.

// The inks a small tool strip offers: the review pin's red first, then black, blue, green and a see-through highlighter
export const INKS = [
  { name: 'Red', color: '#ff5a5f', size: 5 },
  { name: 'Black', color: '#2b2230', size: 5 },
  { name: 'Blue', color: '#2f6bdc', size: 5 },
  { name: 'Green', color: '#1d9a5b', size: 5 },
  { name: 'Highlighter', color: '#ffd23f', size: 20, alpha: 0.45 },
];

// a line's radius at a point: a light touch draws about a third of the ink's size, a firm press half again as wide
const radius = (size, pressure) => (size * (0.3 + 1.2 * Math.min(1, Math.max(0.05, pressure)))) / 2;
const HALO = 2; // px of white around review mode's ink, so it shows on any page (not under a highlighter)

// Where a stroke's ink is: one disc per point and the band between each two, filled together (nonzero), which gives
// round ends and joins at any width. As an SVG path, so a canvas (Path2D) and an SVG <path> draw the very same shape.
export function outline(stroke, grow = 0) {
  const pts = stroke.points,
    size = stroke.size;
  let d = '';
  for (let i = 0; i < pts.length; i++) {
    const [x, y, p] = pts[i],
      r = radius(size, p) + grow;
    d += disc(x, y, r);
    if (i) d += band(pts[i - 1], radius(size, pts[i - 1][2]) + grow, x, y, r);
  }
  return d;
}
const f = n => Math.round(n * 100) / 100;
// (both turn the same way, clockwise on screen, so the nonzero rule joins them and never cuts a hole)
const disc = (x, y, r) =>
  `M${f(x - r)} ${f(y)}a${f(r)} ${f(r)} 0 1 1 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 1 ${f(-2 * r)} 0Z`;
function band([ax, ay], ra, bx, by, rb) {
  const dx = bx - ax,
    dy = by - ay,
    len = Math.hypot(dx, dy);
  if (len < 0.01) return '';
  const nx = -dy / len,
    ny = dx / len;
  return `M${f(ax - nx * ra)} ${f(ay - ny * ra)}L${f(bx - nx * rb)} ${f(by - ny * rb)}L${f(bx + nx * rb)} ${f(by + ny * rb)}L${f(ax + nx * ra)} ${f(ay + ny * ra)}Z`;
}

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
        g.globalAlpha = 0.9;
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
  const halos = halo ? strokes.filter(s => !(s.alpha < 1)).map(s => path(s, HALO, '#fff', 0.9)) : [];
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
//   ink(): the ink to draw with, { color, size, alpha }
//   halo: a white edge around the ink, as draw's
//   shape(e): 'rect' for a rectangle from where it starts to where it is (Shift held, in review mode)
//   end(stroke, e): a stroke finished; the wet canvas still shows it until clear()
// start(e) begins a stroke from a pointerdown that reached another element first (review mode's pen on the page), and
// move(e) carries it on from a pointermove that did too.
// Anything may follow the ink as data (a walk-through call's recording): the document hears an 'ink:stroke' event as
// a stroke starts, grows and ends or is cancelled, its detail { phase: 'start' | 'move' | 'end' | 'cancel', stroke,
// left, top, scroll, halo }: the surface's place on screen and the page's scroll as the stroke started, and whether
// it's drawn with a white edge. A surface's dry ink drawn again (shown) is { phase: 'shown', canvas, strokes, halo }.
export function pen(surface, wet, opts) {
  let line = null;
  function start(e) {
    if (line || (opts.use && !opts.use(e))) return false;
    line = begin(e, surface, wet, opts);
    try {
      surface.setPointerCapture(e.pointerId);
    } catch {
      /* gone already */
    }
    extend(line, e, true);
    tell('start', line);
    return true;
  }
  const move = e => {
    if (!line || e.pointerId !== line.id) return;
    for (const c of e.getCoalescedEvents?.() ?? [e]) extend(line, c);
    tell('move', line);
  };
  function finish(e) {
    if (!line || e.pointerId !== line.id) return;
    if (!line.rect) extend(line, e);
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
  const clear = () => fit(wet);
  surface.addEventListener('pointerdown', e => start(e) && e.preventDefault());
  surface.addEventListener('pointermove', move);
  surface.addEventListener('pointerup', finish);
  surface.addEventListener('pointercancel', cancel);
  return {
    start,
    move,
    cancel,
    clear,
    get drawing() {
      return !!line;
    },
  };
}

// A line being drawn: where its surface was, when it started, what draws it, and its stroke so far
function begin(e, surface, wet, opts) {
  const r = surface.getBoundingClientRect(),
    ink = opts.ink();
  wet.style.opacity = ink.alpha ?? 1;
  return {
    id: e.pointerId,
    left: r.left,
    top: r.top,
    t0: e.timeStamp,
    kind: e.pointerType,
    rect: opts.shape?.(e) === 'rect',
    halo: !!opts.halo && !(ink.alpha < 1),
    stroke: { color: ink.color, size: ink.size, ...(ink.alpha < 1 ? { alpha: ink.alpha } : {}), points: [] },
    wet,
    g: fit(wet),
    speed: 0, // (a mouse's or a finger's, for its pressure)
    scroll: [Math.round(scrollX), Math.round(scrollY)],
  };
}

// A point, smoothed a little against a hand's jitter; a pen's pressure is its own, anything else's from its speed
function extend(line, e, first = false) {
  const x = e.clientX - line.left,
    y = e.clientY - line.top,
    t = Math.max(0, Math.round(e.timeStamp - line.t0)),
    pts = line.stroke.points,
    prev = pts[pts.length - 1];
  if (line.rect) return boxed(line, x, y, t);
  let p;
  if (line.kind === 'pen' && e.pressure > 0) p = e.pressure;
  else {
    if (prev) line.speed += (Math.hypot(x - prev[0], y - prev[1]) / Math.max(1, t - prev[3]) - line.speed) * 0.3;
    p = Math.max(0.3, 0.62 - line.speed * 0.12);
  }
  const q =
    prev && !first
      ? [prev[0] + (x - prev[0]) * 0.6, prev[1] + (y - prev[1]) * 0.6, prev[2] + (p - prev[2]) * 0.5, t]
      : [x, y, p, t];
  if (prev && Math.hypot(q[0] - prev[0], q[1] - prev[1]) < 0.6) return;
  pts.push(q.map((v, i) => (i === 3 ? v : Math.round(v * 100) / 100)));
  piece(line, prev, q);
}

// Only the new piece, so a long line costs no more per frame than a short one: its ink over what's there, its halo
// under it (drawn opaque: the wet canvas's own opacity is the ink's)
function piece(line, a, b) {
  const g = line.g,
    bit = { size: line.stroke.size, points: a ? [a, b] : [b] };
  g.fillStyle = line.stroke.color;
  g.fill(new Path2D(outline(bit)));
  if (!line.halo) return;
  g.globalCompositeOperation = 'destination-over';
  g.globalAlpha = 0.9;
  g.fillStyle = '#fff';
  g.fill(new Path2D(outline(bit, HALO)));
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

// A rectangle, from where it started to where it is now: its four corners as the line, back to the first
function boxed(line, x, y, t) {
  const [x0, y0] = (line.start ??= [x, y]);
  const corners = [
    [x0, y0],
    [x, y0],
    [x, y],
    [x0, y],
    [x0, y0],
  ];
  line.stroke.points = corners.map(([a, b], i) => [Math.round(a), Math.round(b), 0.5, i ? t : 0]);
  line.g = fit(line.wet);
  draw(line.g, [{ ...line.stroke, alpha: 1 }], { halo: line.halo });
}

const tell = (phase, line) =>
  document.dispatchEvent(
    new CustomEvent('ink:stroke', {
      detail: { phase, stroke: line.stroke, left: line.left, top: line.top, scroll: line.scroll, halo: line.halo },
    }),
  );

// What a canvas of dry ink shows now, after it's drawn again (a note's lines, fewer after an undo, none once sent), for
// whatever follows the ink: strokes in the canvas's CSS px. A canvas whose own pictures are recorded (a sketch's
// page) says none: its pictures carry them.
export const shown = (canvas, strokes, { halo = false } = {}) =>
  document.dispatchEvent(new CustomEvent('ink:stroke', { detail: { phase: 'shown', canvas, strokes, halo } }));
