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
const HALO_ALPHA = 0.9; // (the white's, a little see-through; a pen's under canvas has it as its opacity)

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
//   ink(): the ink to draw with, { color, size, alpha }
//   halo: a white edge around the ink, as draw's
//   under: with halo, a canvas the same size as `wet` under the dry ink, where the live line's white edge goes (ink.js
//     gives it draw's opacity), so it sits under every line's ink as draw puts it, and the line doesn't change as it
//     goes on the dry canvas. Without it the edge is drawn on `wet`, under its own line but over older lines' ink.
//   shape(e): 'rect' for a rectangle from where it starts to where it is (Shift held, in review mode)
//   end(stroke, e): a stroke finished; the wet canvas still shows it until clear()
// start(e) begins a stroke from a pointerdown that reached another element first (review mode's pen on the page),
// move(e) carries it on from a pointermove that did too, and end(e) ends it from a pointerup that did (the Pencil on
// HQ, followed on the window).
// Anything may follow the ink as data (a walk-through call's recording): the document hears an 'ink:stroke' event as
// a stroke starts, grows and ends or is cancelled, its detail { phase: 'start' | 'move' | 'end' | 'cancel', stroke,
// left, top, scroll, halo }: the surface's place on screen and the page's scroll as the stroke started, and whether
// it's drawn with a white edge. A surface's dry ink drawn again (shown) is { phase: 'shown', canvas, strokes, halo }.
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
    show(line, follow(line, e, 'move'));
    tell('move', line);
  };
  function finish(e) {
    if (!line || e.pointerId !== line.id) return;
    show(line, follow(line, e, 'end'));
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
  speed: 0, // (a mouse's or a finger's, for its pressure)
  pressure: 0, // (a pen's last, for a lift that reports none)
});

// The samples a pointer event brings: those a fast hand left between two frames, else the event itself. The list can
// be there and empty (Chromium's pointerdown, and an event a script made in any browser), which is no samples at all.
const samples = e => {
  const c = e.getCoalescedEvents?.();
  return c?.length ? c : [e];
};

// What one pointer event ('start', 'move' or 'end') adds to a line: the indexes of the points it kept. A rectangle's
// points are all made again each time: null.
function follow(line, e, phase) {
  if (line.rect) return phase === 'end' ? [] : (boxed(line, e), null);
  const kept = [];
  for (const s of phase === 'move' ? samples(e) : [e])
    if (extend(line, s, phase === 'start')) kept.push(line.stroke.points.length - 1);
  return kept;
}

// A point, smoothed a little against a hand's jitter; a pen's pressure is its own, anything else's from its speed.
// It's kept rounded, and drawn as kept: the dry canvas draws it from the stroke, so the live line must be that one.
function extend(line, e, first = false) {
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
  const q =
    prev && !first
      ? [prev[0] + (x - prev[0]) * 0.6, prev[1] + (y - prev[1]) * 0.6, prev[2] + (p - prev[2]) * 0.5, t]
      : [x, y, p, t];
  const kept = q.map((v, i) => (i === 3 ? v : Math.round(v * 100) / 100));
  if (prev && Math.hypot(kept[0] - prev[0], kept[1] - prev[1]) < 0.6) return false;
  pts.push(kept);
  return true;
}

// What drawing point i of a stroke repaints, for a canvas k device px to the CSS px: a box of whole device px around
// its new disc and band (and their white edge, grow), and the stroke's every disc and band that reaches into it, as
// outline() has them. Inside the box the canvas is cleared and those are filled again together, so each pixel there
// is filled once, by the very shapes and in the very way draw() fills the whole stroke: pieces filled one over
// another would add up their soft edges, and the line would thin and lighten as it goes dry. Only a few shapes
// around the new point are filled, each found by a box test over the stroke's points (cheap, though it grows with the
// line).
function piece(stroke, i, { grow = 0, k = 1 } = {}) {
  const pts = stroke.points,
    size = stroke.size,
    // (a soft edge reaches a device px past its shape)
    reach = 1 / k;
  const boxOf = (j, g) => {
    const [x, y, p] = pts[j],
      r = radius(size, p) + g + reach;
    return [x - r, y - r, x + r, y + r];
  };
  const joined = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  const meets = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const near = i ? joined(boxOf(i - 1, grow), boxOf(i, grow)) : boxOf(i, grow);
  const box = [Math.floor(near[0] * k), Math.floor(near[1] * k), Math.ceil(near[2] * k), Math.ceil(near[3] * k)];
  const inBox = box.map(v => v / k);
  const shapes = g => {
    let d = '';
    for (let j = 0; j < pts.length; j++) {
      const own = boxOf(j, g),
        [x, y, p] = pts[j],
        r = radius(size, p) + g;
      if (meets(own, inBox)) d += disc(x, y, r);
      if (j && meets(joined(boxOf(j - 1, g), own), inBox))
        d += band(pts[j - 1], radius(size, pts[j - 1][2]) + g, x, y, r);
    }
    return d;
  };
  return { box, ink: shapes(0), halo: grow ? shapes(grow) : '' };
}

// The line's new points on its canvases (null: all of it again, a rectangle's)
function show(line, kept) {
  if (!kept) return paint(line, null, outline(line.stroke), line.halo ? outline(line.stroke, HALO) : '');
  const k = line.g.getTransform().a;
  for (const i of kept) {
    const p = piece(line.stroke, i, { grow: line.halo ? HALO : 0, k });
    paint(line, p.box, p.ink, p.halo);
  }
}

// Ink, and its white edge, filled once in a box of whole device px (null: the whole canvas), what was there wiped.
// The edge goes on the under canvas, opaque (the canvas has draw's opacity), else under the ink on the wet one.
function paint(line, box, ink, halo) {
  const inked = [ink, line.stroke.color, 1];
  if (!halo) fill(line.g, box, [inked]);
  else if (line.u) {
    fill(line.u, box, [[halo, '#fff', 1]]);
    fill(line.g, box, [inked]);
  } else fill(line.g, box, [[halo, '#fff', HALO_ALPHA], inked]);
}

// A rasteriser fills a soft edge a little differently where a clip or the canvas's own edge cuts the path (Skia, in
// Chromium and WebKit, a few px in): a box is filled on a scratch canvas this many device px bigger all round, and
// only the box is copied, pixel for pixel. With 8, the live line is the dry one but for a stray pixel; with none, a
// few hundred per line differ. Each canvas has its own scratch, of its own kind (drawn on the CPU when it is), so both
// fill paths the same way.
const SPARE = 8;
const scratches = new WeakMap();
function fill(c, box, layers) {
  const m = c.getTransform(),
    paths = g => {
      for (const [d, color, alpha] of layers) {
        g.globalAlpha = alpha;
        g.fillStyle = color;
        g.fill(new Path2D(d));
      }
    };
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (!box) {
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
    c.setTransform(m);
    paths(c);
    return c.restore();
  }
  const [x0, y0, x1, y1] = box,
    w = x1 - x0,
    h = y1 - y0;
  let scratch = scratches.get(c.canvas);
  if (!scratch) {
    scratch = document.createElement('canvas');
    scratch.getContext('2d', { willReadFrequently: !!c.getContextAttributes?.().willReadFrequently });
    scratches.set(c.canvas, scratch);
  }
  if (scratch.width < w + 2 * SPARE) scratch.width = w + 2 * SPARE;
  if (scratch.height < h + 2 * SPARE) scratch.height = h + 2 * SPARE;
  const g = scratch.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, w + 2 * SPARE, h + 2 * SPARE);
  g.setTransform(m.a, m.b, m.c, m.d, m.e + SPARE - x0, m.f + SPARE - y0);
  paths(g);
  c.clearRect(x0, y0, w, h);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  c.drawImage(scratch, SPARE, SPARE, w, h, x0, y0, w, h);
  c.restore();
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
