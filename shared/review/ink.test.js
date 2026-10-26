// node --test shared/review/ink.test.js   (the pen's live line is the line it keeps: what's drawn as a hand moves is
// the very shape draw() puts on the dry canvas at the lift, so nothing moves, thickens or fades as it goes dry; its
// pixels in a real browser are shared/review/inkcheck.mjs's wetDry)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as inkjs from './ink.js';

const K = 2; // device px to the CSS px, an iPad's
const RED = { color: '#ff5a5f', size: 5 };
const shapes = d => d.match(/M[^M]*/g) ?? [];

// Just enough of a page for pen(): canvases that write down what's filled on them, and a surface to send events to
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
  let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const g = {
    canvas: c,
    fillStyle: '#000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    clearRect() {},
    getTransform: () => ({ ...m }),
    setTransform(a, b, cc, d, e, f) {
      m = typeof a === 'object' ? { ...a } : { a, b, c: cc, d, e, f };
    },
    // (a scratch canvas's fills land where it's copied)
    drawImage(from) {
      c.fills.push(...from.fills.splice(0));
    },
    fill(p) {
      c.fills.push({ d: p.d, color: g.fillStyle, alpha: g.globalAlpha, op: g.globalCompositeOperation });
    },
  };
  c.getContext = () => g;
  return c;
}

// A line drawn with pen() from these events (the first a pointerdown, the last a pointerup): the stroke it ended with,
// and the shapes filled on the wet canvas and the under one as it was drawn
function live(events, ink = RED, { halo = false } = {}) {
  const on = {},
    surface = {
      getBoundingClientRect: box,
      setPointerCapture() {},
      addEventListener: (type, f) => (on[type] = f),
    },
    wet = canvas(),
    under = canvas();
  let stroke = null;
  inkjs.pen(surface, wet, { halo, under, ink: () => ink, end: s => (stroke = s) });
  events.forEach((e, n) =>
    on[n === 0 ? 'pointerdown' : n === events.length - 1 ? 'pointerup' : 'pointermove']({
      pointerId: 1,
      preventDefault() {},
      ...e,
    }),
  );
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

test("a highlighter's live line has no white edge", () => {
  const { stroke, wet, under } = live(HANDS.pen, { color: '#ffd23f', size: 20, alpha: 0.45 }, { halo: true });
  assert.equal(under.length, 0);
  assert.deepEqual(union(wet), new Set(shapes(inkjs.outline(stroke))));
});
