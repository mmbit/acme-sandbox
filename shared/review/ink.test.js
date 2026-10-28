// node --test shared/review/ink.test.js   (the pen's live line is the line it keeps: what's drawn as a hand moves is
// the very shape draw() puts on the dry canvas at the lift, so nothing moves, thickens or fades as it goes dry; its
// pixels in a real browser are shared/review/inkcheck.mjs's wetDry)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as inkjs from './ink.js';
import { HALO } from './inkshape.js';

const K = 2; // device px to the CSS px, an iPad's
const RED = { color: '#ff5a5f', size: 5 };
const shapes = d => d.match(/M[^M]*/g) ?? [];

// Just enough of a page for pen(): canvases that keep their pixels (a device px inked where a filled path covers its
// centre, nonzero, with no soft edges) and write down what's filled on them, and a surface to send events to (their
// pixels; their clipping)
globalThis.devicePixelRatio = K;
globalThis.scrollX = globalThis.scrollY = 0;
globalThis.Path2D = class {
  constructor(d) {
    this.d = d;
  }
};
globalThis.CustomEvent ??= class {
  constructor(type, init) {
    Object.assign(this, { type, detail: init?.detail });
  }
};
globalThis.document = { dispatchEvent() {}, createElement: () => canvas() };
const box = () => ({ left: 0, top: 0, width: 400, height: 300 });
function canvas() {
  const c = { style: {}, width: 0, height: 0, fills: [], getBoundingClientRect: box };
  // (one byte a device px, blank again when the canvas changes size, as a real one is)
  c.pixels = () => (c.px?.length === c.width * c.height ? c.px : (c.px = new Uint8Array(c.width * c.height)));
  c.inked = (x, y) => c.pixels()[Math.floor(y) * c.width + Math.floor(x)] === 1;
  let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const saved = [], // (save and restore keep the transform)
    at = (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]; // (a point in device px)
  const g = {
    canvas: c,
    fillStyle: '#000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    save: () => saved.push(m),
    restore: () => (m = saved.pop() ?? m),
    beginPath() {},
    rect() {},
    clip() {},
    clearRect(x, y, w, h) {
      const px = c.pixels();
      for (const [i] of within(c, ...at(x, y), ...at(x + w, y + h))) px[i] = 0;
    },
    getTransform: () => ({ ...m }),
    setTransform(a, b, cc, d, e, f) {
      m = typeof a === 'object' ? { ...a } : { a, b, c: cc, d, e, f };
    },
    // (what's filled on a scratch canvas lands where it's copied, in device px, what falls off the canvas dropped)
    drawImage(from, sx, sy, w, h, x, y) {
      c.fills.push(...from.fills.splice(0));
      const px = c.pixels(),
        src = from.pixels();
      for (const [i, col, row] of within(c, x, y, x + w, y + h))
        px[i] = src[(sy + row - y) * from.width + sx + col - x];
    },
    fill(p) {
      c.fills.push({ d: p.d, color: g.fillStyle, alpha: g.globalAlpha, op: g.globalCompositeOperation });
      const px = c.pixels(),
        turns = new Map(); // (a path's winding at each px it may cover: its rings' added up)
      for (const ring of rings(p.d).map(r => r.map(([x, y]) => at(x, y)))) {
        const xs = ring.map(q => q[0]),
          ys = ring.map(q => q[1]);
        for (const [i, col, row] of within(c, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)))
          turns.set(i, (turns.get(i) ?? 0) + winding(ring, col + 0.5, row + 0.5));
      }
      for (const [i, n] of turns) if (n) px[i] = 1;
    },
  };
  c.getContext = () => g;
  return c;
}
// The canvas's px whose centres are in a box of device px: each one's index, column and row
function* within(c, x0, y0, x1, y1) {
  const from = v => Math.max(0, Math.ceil(v - 0.5));
  for (let y = from(y0); y < Math.min(c.height, Math.ceil(y1 - 0.5)); y++)
    for (let x = from(x0); x < Math.min(c.width, Math.ceil(x1 - 0.5)); x++) yield [y * c.width + x, x, y];
}
// An SVG path as the closed rings it fills (M, L, A and Z, either case; arcs circular, as a disc's)
function rings(d) {
  const words = d.match(/[a-z]|-?[\d.]+(?:e-?\d+)?/gi),
    pathRings = [],
    num = () => Number(words.shift());
  let ring = [],
    x = 0,
    y = 0,
    cmd = '';
  while (words.length) {
    if (/[a-z]/i.test(words[0])) cmd = words.shift();
    const rel = cmd === cmd.toLowerCase(),
      to = () => [(rel ? x : 0) + num(), (rel ? y : 0) + num()];
    const kind = cmd.toUpperCase();
    if (kind === 'Z') [x, y] = ring[0];
    else if (kind === 'M') {
      pathRings.push((ring = [([x, y] = to())]));
      cmd = rel ? 'l' : 'L';
    } else if (kind === 'L') ring.push(([x, y] = to()));
    else if (kind === 'A') {
      const r = num(),
        [, , large, sweep] = [num(), num(), num(), num()],
        end = to();
      ring.push(...arc([x, y], r, large, sweep, end));
      [x, y] = end;
    }
  }
  return pathRings;
}
// A circular arc's points, from a to b
function arc([ax, ay], r, large, sweep, [bx, by]) {
  const hx = (bx - ax) / 2,
    hy = (by - ay) / 2,
    half = Math.hypot(hx, hy),
    rr = Math.max(r, half),
    k = ((large === sweep ? -1 : 1) * Math.sqrt(rr * rr - half * half)) / (half || 1),
    cx = ax + hx - k * hy,
    cy = ay + hy + k * hx,
    from = Math.atan2(ay - cy, ax - cx);
  let turn = Math.atan2(by - cy, bx - cx) - from;
  if (sweep && turn < 0) turn += 2 * Math.PI;
  if (!sweep && turn > 0) turn -= 2 * Math.PI;
  return Array.from({ length: 16 }, (_, i) => [
    cx + rr * Math.cos(from + (turn * (i + 1)) / 16),
    cy + rr * Math.sin(from + (turn * (i + 1)) / 16),
  ]);
}
// How many times a ring winds around a point (nonzero: inside where it isn't 0)
function winding(ring, x, y) {
  let n = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i],
      [bx, by] = ring[(i + 1) % ring.length],
      side = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
    if (ay <= y && by > y && side > 0) n++;
    else if (ay > y && by <= y && side < 0) n--;
  }
  return n;
}
// A line drawn with pen() from these events (the first a pointerdown, the last a pointerup): the stroke it ended with,
// and the shapes filled on the wet canvas and the under one as it was drawn. each(): what's on screen after each event
// ({ e, wet, under, stroke }, the line as far as it went)
function live(events, ink = RED, { halo = false, each } = {}) {
  const on = {},
    surface = {
      getBoundingClientRect: box,
      setPointerCapture() {},
      addEventListener: (type, f) => (on[type] = f),
    },
    wet = canvas(),
    under = canvas();
  let stroke = null,
    drawing = null;
  document.dispatchEvent = ({ detail }) => (drawing = detail.stroke);
  inkjs.pen(surface, wet, { halo, under, ink: () => ink, end: s => (stroke = s) });
  events.forEach((e, n) => {
    on[n === 0 ? 'pointerdown' : n === events.length - 1 ? 'pointerup' : 'pointermove']({
      pointerId: 1,
      preventDefault() {},
      ...e,
    });
    each?.({ e, wet, under, stroke: { ...drawing, points: [...drawing.points] } });
  });
  return { stroke, wet: wet.fills, under: under.fills, underOpacity: under.style.opacity };
}
const union = fills => new Set(fills.flatMap(f => shapes(f.d)));

// Hands, as pointer events: a pen pressing harder and lighter along a curve, its moves bringing three samples each
// (one with an empty list, as Chromium's can be), lifting with pressure 0 as iPad Safari's does; a mouse; a fast
// flick of a finger; a pen trembling under 0.6 px; and a loop that crosses itself
function hand(kind, n, at, { coalesce = 0, lift = 0 } = {}) {
  const raw = Array.from({ length: n }, (_, i) => ({ pointerType: kind, timeStamp: 1000 + i * 8, ...at(i) })),
    down = raw[0],
    up = { ...raw[n - 1], timeStamp: raw[n - 1].timeStamp + 8, pressure: lift };
  if (!coalesce) return [down, ...raw.slice(1, -1), up];
  const moves = [];
  for (let i = 1; i < n - 1; i += coalesce) {
    const group = raw.slice(i, Math.min(n - 1, i + coalesce)),
      last = group[group.length - 1];
    moves.push({ ...last, getCoalescedEvents: () => (moves.length === 4 ? [] : group) });
  }
  return [down, ...moves, up];
}
const HANDS = {
  pen: hand(
    'pen',
    60,
    i => ({
      clientX: 20 + i * 4.3,
      clientY: 80 + Math.sin(i / 6) * 40,
      pressure: 0.2 + 0.7 * Math.abs(Math.sin(i / 9)),
    }),
    { coalesce: 3 },
  ),
  mouse: hand('mouse', 40, i => ({ clientX: 30 + i * 3.7 + (i % 3) * 0.37, clientY: 200 - i * 2.1, pressure: 0.5 })),
  flick: hand('touch', 7, i => ({ clientX: 40 + i * 55, clientY: 40 + i * i * 3, pressure: 0 })),
  tremble: hand('pen', 50, i => ({
    clientX: 100 + i * 0.29 + (i % 2) * 0.4,
    clientY: 150 + (i % 3) * 0.25,
    pressure: 0.5,
  })),
  loop: hand('pen', 70, i => ({
    clientX: 200 + Math.cos(i / 8) * (40 + i),
    clientY: 150 + Math.sin(i / 8) * 40,
    pressure: 0.3 + (i % 10) / 20,
  })),
};

for (const [name, events] of Object.entries(HANDS)) {
  test(`${name}: the live pieces are the kept line's every disc and band, and nothing else`, () => {
    const { stroke, wet } = live(events);
    assert.ok(stroke.points.length > 1);
    assert.deepEqual(union(wet), new Set(shapes(inkjs.outline(stroke))));
  });
  test(`${name}: with a white edge, the live edge is the kept line's, on the canvas under the dry ink`, () => {
    const { stroke, wet, under, underOpacity } = live(events, RED, { halo: true });
    assert.deepEqual(union(wet), new Set(shapes(inkjs.outline(stroke))));
    assert.ok(wet.every(f => f.color === RED.color));
    assert.deepEqual(union(under), new Set(shapes(inkjs.outline(stroke, 2))));
    assert.ok(under.every(f => f.color === '#fff' && f.alpha === 1));
    assert.equal(Number(underOpacity), 0.9);
  });
}

test('a pen lifting with pressure 0 ends the line as a lift with its last pressure would', () => {
  const events = HANDS.pen,
    last = events[events.length - 2].pressure;
  const zero = live(events).stroke,
    kept = live([...events.slice(0, -1), { ...events[events.length - 1], pressure: last }]).stroke;
  assert.deepEqual(zero, kept);
});

test('a move whose coalesced list is empty still draws its own point', () => {
  const [down, , up] = HANDS.mouse,
    move = { ...HANDS.mouse[20], getCoalescedEvents: () => [] };
  const { stroke } = live([down, move, up]);
  assert.ok(stroke.points.some(([x]) => Math.abs(x - move.clientX) < 30 && x > down.clientX + 30));
});

// Each move of the pen bringing the browser's predicted points: two more samples along the way it's going
const PREDICTED = HANDS.pen.map((e, n, all) =>
  e.getCoalescedEvents
    ? {
        ...e,
        getPredictedEvents: () =>
          [1, 2].map(j => ({
            clientX: e.clientX + 4.3 * j,
            clientY: e.clientY + (e.clientY - all[n - 1].clientY) * j,
          })),
      }
    : e,
);

test('predicted points draw a tail that ends at the last of them, never kept in the stroke', () => {
  const plain = live(HANDS.pen, RED, { halo: true });
  let tails = 0;
  const { stroke } = live(PREDICTED, RED, {
    halo: true,
    each: ({ e, wet, under }) => {
      const end = e.getPredictedEvents?.().at(-1);
      if (!end) return;
      // (8 px on from it, the way it goes: past the widest ink and its white edge)
      const dx = end.clientX - e.clientX,
        dy = end.clientY - e.clientY,
        on = 8 / Math.hypot(dx, dy),
        past = [(end.clientX + dx * on) * K, (end.clientY + dy * on) * K];
      for (const c of [wet, under]) {
        assert.ok(c.inked(end.clientX * K, end.clientY * K), 'the tail reaches the last predicted point');
        assert.ok(!c.inked(...past), 'and ends there');
      }
      tails++;
    },
  });
  assert.ok(tails > 10);
  assert.deepEqual(stroke, plain.stroke);
});

// What draw() shows of a stroke (with its white edge grown by grow), on a canvas the surface's size
function dry(stroke, grow = 0) {
  const c = canvas();
  [c.width, c.height] = [400 * K, 300 * K];
  c.getContext().setTransform(K, 0, 0, K, 0, 0);
  c.getContext().fill(new Path2D(inkjs.outline(stroke, grow)));
  return c.pixels();
}
// How many px differ between two canvases
const changes = (a, b) => a.reduce((n, v, i) => n + (v !== b[i]), 0);

test('the next sample wipes the tail: the screen shows only the line, where the pen went', () => {
  const [down, first, next] = HANDS.pen,
    // (the browser guessing wrong: 30 px down, where the pen never goes)
    off = { clientX: first.clientX, clientY: first.clientY + 30 },
    seen = [];
  live([down, { ...first, getPredictedEvents: () => [off] }, next, HANDS.pen.at(-1)], RED, {
    halo: true,
    each: ({ wet, under, stroke }) =>
      seen.push({
        tail: wet.inked(off.clientX * K, off.clientY * K) && under.inked(off.clientX * K, off.clientY * K),
        wet: changes(wet.pixels(), dry(stroke)),
        under: changes(under.pixels(), dry(stroke, HALO)),
      }),
  });
  assert.ok(seen[1].tail, 'the tail is drawn');
  assert.deepEqual(seen.slice(2), [
    { tail: false, wet: 0, under: 0 },
    { tail: false, wet: 0, under: 0 },
  ]);
});

test("a mouse's or a finger's predicted points draw no tail: the line stays behind the pointer", () => {
  for (const kind of ['mouse', 'touch']) {
    const events = PREDICTED.map(e => ({ ...e, pointerType: kind }));
    const plain = live(events.map(e => ({ ...e, getPredictedEvents: undefined })));
    assert.deepEqual(live(events).wet, plain.wet, kind);
  }
});

test("a highlighter's live line has no white edge", () => {
  const { stroke, wet, under } = live(HANDS.pen, { color: '#ffd23f', size: 20, alpha: 0.45 }, { halo: true });
  assert.equal(under.length, 0);
  assert.deepEqual(union(wet), new Set(shapes(inkjs.outline(stroke))));
});
