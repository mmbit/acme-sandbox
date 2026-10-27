// The pen's ink in a watch-along: the recorder's `ink` events (hearInk, at the end), and the strokes on screen at any
// moment read back from them, for whatever draws them again (the mirror's pictures, the player) and folds them into
// moments. Plain JS, for a browser and Node alike. README.md has the design.
//
// The recorder (watchalong.js) marks each stroke of ink.js's pen as custom events tagged 'ink', their payload:
//   { phase: 'start', n, id, stroke, left, top }  the stroke as it began (ink.js's { color, size, alpha, points })
//   { phase: 'move', n, id, points }              the points since the last (sampled: at most one every INK_MS),
//   { phase: 'move', n, id, points, all: true }   or all of them, when the line was redrawn (a rectangle's corners)
//   { phase: 'end', n, id, stroke, left, top, box, under }  the stroke whole, where on screen it is (box, CSS px of the
//                                                  document's viewport) and what's under it (watchalong.js described);
//                                                  pictured: true when its dry ink is on canvases recorded as pictures
//                                                  (the Sketchbook's page): drawn until a canvas picture after it, then
//                                                  that picture holds it, wherever the page has gone since
//   { phase: 'cancel', n, id }                    the stroke went (a palm, a second finger)
//   { phase: 'shown', id, canvas, strokes, left, top, halo }  a canvas of dry ink drawn again (ink.js shown): what it
//                                                  shows now takes the place of the document's finished strokes (a
//                                                  note's lines, fewer after an undo, none once sent). A canvas whose
//                                                  own pictures are recorded (a sketch's page) says none: its finished
//                                                  strokes stay until its next picture (rrweb's canvas mutation).
// n numbers a document's strokes; id is rrweb's id of the document drawn on (a frame's, made the framing page's by
// rrweb on the way up: a custom event's top-level `id` is), so a frame's strokes are placed over its frame. left and
// top: the drawing surface's place in that document's viewport as the stroke began; a stroke's points are on it. halo:
// drawn with a white edge (review mode's).

export const INK_MS = 100;
// A canvas picture this long after a pictured stroke's end holds it: the picture was taken before it was encoded and
// sent
const PICTURED_MS = 300;
const FULL_SNAPSHOT = 2,
  INCREMENTAL = 3,
  CUSTOM = 5,
  CANVAS_MUTATION = 9;

// The strokes as the events come: shown lists those on screen, each { key, id, stroke, left, top, halo, at, end? }
// (at: when it began, end: when it ended, on the page's clock; a stroke still being drawn has no end)
export class Inks {
  strokes = new Map();
  pictured = new Map(); // a canvas → the finished strokes its next picture holds
  add(event) {
    // (a new page on top: the ink of everything before it goes)
    if (event.type === FULL_SNAPSHOT) return this.strokes.clear();
    if (event.type === INCREMENTAL && event.data?.source === CANVAS_MUTATION)
      return this.drop(event.data.id, event.timestamp);
    if (event.type !== CUSTOM || event.data?.tag !== 'ink') return;
    const ink = event.data.payload ?? {},
      key = `${ink.id}:${ink.n}`;
    if (ink.phase === 'shown') this.redrawn(ink, event.timestamp);
    else if (ink.phase === 'cancel') this.strokes.delete(key);
    else if (ink.phase === 'start' && ink.stroke)
      this.strokes.set(key, { key, id: ink.id, ...placed(ink), stroke: copy(ink.stroke), at: event.timestamp });
    else if (ink.phase === 'move' && Array.isArray(ink.points)) {
      const s = this.strokes.get(key);
      if (s) s.stroke.points = [...(ink.all ? [] : s.stroke.points), ...ink.points.map(point)];
    } else if (ink.phase === 'end' && ink.stroke) {
      const s = this.strokes.get(key);
      this.strokes.set(key, {
        key,
        id: ink.id,
        ...placed(ink),
        stroke: copy(ink.stroke),
        at: s?.at ?? event.timestamp - (ink.stroke.points?.at(-1)?.[3] ?? 0),
        end: event.timestamp,
        ...(ink.pictured ? { pictured: true } : {}),
      });
    }
  }
  get shown() {
    return [...this.strokes.values()];
  }
  // A canvas of dry ink drawn again: its strokes in place of the document's finished ones, or (none) those kept until
  // the canvas's next picture
  redrawn(ink, at) {
    const finished = [...this.strokes.values()].filter(s => s.id === ink.id && s.end !== undefined);
    const strokes = Array.isArray(ink.strokes) ? ink.strokes : [];
    if (!strokes.length && ink.canvas != null) {
      this.pictured.set(ink.canvas, [...(this.pictured.get(ink.canvas) ?? []), ...finished.map(s => s.key)]);
      return;
    }
    for (const s of finished) this.strokes.delete(s.key);
    strokes.forEach((stroke, i) => {
      const key = `${ink.id}:shown${i}`;
      this.strokes.set(key, { key, id: ink.id, ...placed(ink), stroke: copy(stroke), at, end: at });
    });
  }
  drop(canvas, at) {
    for (const key of this.pictured.get(canvas) ?? []) this.strokes.delete(key);
    this.pictured.delete(canvas);
    for (const [key, s] of this.strokes) if (s.pictured && at - s.end >= PICTURED_MS) this.strokes.delete(key);
  }
}

// The strokes on screen at a time (the page's clock), from the events in order: each cut to what was drawn by then
export function inkAt(events, time) {
  const inks = new Inks();
  for (const event of events) {
    if (event.timestamp > time) break;
    inks.add(event);
  }
  return inks.shown.map(s => ({
    ...s,
    stroke: { ...s.stroke, points: s.stroke.points.filter(p => p[3] <= time - s.at) },
  }));
}

// Draws strokes with ink.js's draw (passed in: `ink`), each in its document's place: where(id) is that document's
// viewport's top left on the canvas (null: not on screen, its frame gone). The canvas context is in CSS px of the
// screen replayed. until: a time on the page's clock, for a stroke drawn as it was (the player), else all of it.
export function paint(ink, g, strokes, where, { until = Infinity } = {}) {
  for (const s of strokes) {
    const at = where(s.id);
    if (!at) continue;
    g.save();
    g.translate(at.x + s.left, at.y + s.top);
    ink.draw(g, [s.stroke], { halo: s.halo, until: until - s.at });
    g.restore();
  }
}

// rrweb's replayer: where the document of this id (a recorded page's or a frame's) sits in the top page's viewport
export function placer(replayer) {
  return id => {
    const doc = replayer.getMirror().getNode(id);
    const top = replayer.iframe?.contentDocument;
    if (!doc || !top) return null;
    if (doc === top || doc.ownerDocument === top) return { x: 0, y: 0 };
    let x = 0,
      y = 0;
    for (let frame = (doc.defaultView ?? doc.ownerDocument?.defaultView)?.frameElement; frame;) {
      if (!frame.isConnected) return null;
      const r = frame.getBoundingClientRect();
      x += r.left + frame.clientLeft;
      y += r.top + frame.clientTop;
      if (frame.ownerDocument === top) return { x, y };
      frame = frame.ownerDocument.defaultView?.frameElement;
    }
    return null;
  };
}

const placed = ink => ({ left: Number(ink.left) || 0, top: Number(ink.top) || 0, halo: !!ink.halo });
// (only what draws a stroke, as numbers and a colour: a recording is a page's word, and the ink goes into an SVG)
const copy = stroke => ({
  color: /^#[0-9a-f]{6}$/i.test(stroke.color) ? stroke.color : '#ff5a5f',
  size: Math.min(200, Math.max(0.5, Number(stroke.size) || 5)),
  ...(Number(stroke.alpha) < 1 ? { alpha: Math.max(0.05, Number(stroke.alpha)) } : {}),
  points: (Array.isArray(stroke.points) ? stroke.points : []).map(point),
});
const point = p => [0, 1, 2, 3].map(i => Number(p?.[i]) || 0);

// ---------------------------------------------------------------- the recorder's side (watchalong.js)
// The pen's ink (ink.js's 'ink:stroke' on the document) as 'ink' moments in rrweb's `record`, as read back above: a
// stroke's start and end whole, its moves as the points since the last, at most one every INK_MS, and a canvas of dry
// ink drawn again (shown). `id` is the document's (rrweb makes a frame's the framing page's). The end says where the
// stroke is on the screen and what's under it, each thing as named(element) names it ({ control, role, label }, or
// null: never recorded). Returns what stops listening.
export function hearInk(record, named) {
  const lines = new WeakMap(); // a stroke being drawn → its number, how many of its points went, and when
  let strokes = 0;
  const hear = ({ detail }) => {
    const { phase, stroke } = detail ?? {};
    const id = record.mirror.getId(document);
    if (phase === 'shown' && detail.canvas instanceof Element)
      return record.addCustomEvent('ink', shown(record, id, detail));
    if (!stroke) return;
    const place = { left: Math.round(detail.left ?? 0), top: Math.round(detail.top ?? 0), halo: !!detail.halo };
    const now = performance.now();
    if (phase === 'start') {
      lines.set(stroke, { n: ++strokes, sent: stroke.points.length, tail: stroke.points.at(-1), at: now });
      return record.addCustomEvent('ink', { phase, n: strokes, id, stroke: drawn(stroke), ...place });
    }
    const line = lines.get(stroke);
    if (!line) return;
    if (phase === 'move') {
      if (now - line.at < INK_MS) return;
      const pts = stroke.points,
        grown = pts.length >= line.sent && pts[line.sent - 1] === line.tail;
      if (grown && pts.length === line.sent) return;
      const points = grown ? pts.slice(line.sent) : pts;
      Object.assign(line, { sent: pts.length, tail: pts.at(-1), at: now });
      return record.addCustomEvent('ink', { phase, n: line.n, id, points, ...(grown ? {} : { all: true }) });
    }
    lines.delete(stroke);
    if (phase === 'cancel') return record.addCustomEvent('ink', { phase, n: line.n, id });
    if (phase !== 'end') return;
    const box = boxOf(stroke, place);
    record.addCustomEvent('ink', {
      phase,
      n: line.n,
      id,
      stroke: drawn(stroke),
      ...place,
      box,
      under: under(box, named),
      ...(detail.pictured ? { pictured: true } : {}),
    });
  };
  document.addEventListener('ink:stroke', hear);
  return () => document.removeEventListener('ink:stroke', hear);
}
const drawn = stroke => ({ ...stroke, points: stroke.points.map(point => [...point]) });
// A canvas of dry ink drawn again: where it is, and what it shows
function shown(record, id, { canvas, strokes, halo }) {
  const r = canvas.getBoundingClientRect();
  const ink = { phase: 'shown', id, canvas: record.mirror.getId(canvas), left: r.left, top: r.top, halo: !!halo };
  return { ...ink, strokes: (strokes ?? []).map(drawn) };
}
// Where a stroke's ink is on the screen, in CSS px of this page's viewport
function boxOf(stroke, { left, top }) {
  const xs = stroke.points.map(p => p[0]),
    ys = stroke.points.map(p => p[1]),
    r = stroke.size / 2;
  const x = Math.min(...xs) - r + left,
    y = Math.min(...ys) - r + top;
  const round = n => Math.round(n);
  return {
    x: round(x),
    y: round(y),
    width: round(Math.max(...xs) + r + left - x),
    height: round(Math.max(...ys) + r + top - y),
  };
}
// What's under a stroke, at most two things by their own names (named: never a private part's words), the ones
// most of whose box the stroke covers first. A thin stroke (a line under something) looks just above it.
const UNDER_LINE_PX = 24,
  UNDER = 2,
  MOSTLY = 0.15;
function under(box, named) {
  const flat = box.height < UNDER_LINE_PX;
  const probes = [];
  for (let i = 0; i < 5; i++)
    for (let j = 0; j < (flat ? 1 : 5); j++)
      probes.push([box.x + (box.width * (i + 0.5)) / 5, flat ? box.y - 8 : box.y + (box.height * (j + 0.5)) / 5]);
  const found = new Map();
  for (const [x, y] of probes)
    for (const element of document.elementsFromPoint(x, y)) {
      const { control, role, label } = named(element) ?? {};
      if (!label || found.has(control)) continue;
      const r = control.getBoundingClientRect();
      const inside =
        (Math.max(0, Math.min(r.right, box.x + box.width) - Math.max(r.left, box.x)) *
          Math.max(
            0,
            Math.min(r.bottom, box.y + box.height + (flat ? UNDER_LINE_PX : 0)) -
              Math.max(r.top, box.y - (flat ? UNDER_LINE_PX : 0)),
          )) /
        Math.max(1, r.width * r.height);
      found.set(control, { role, label, inside });
      break;
    }
  // (a box the stroke covers little of, the page's main part, only when there's nothing else)
  const all = [...found.values()].sort((a, b) => b.inside - a.inside);
  return (all.some(one => one.inside >= MOSTLY) ? all.filter(one => one.inside >= MOSTLY) : all.slice(0, 1))
    .slice(0, UNDER)
    .map(({ role, label }) => ({ role, label }));
}
