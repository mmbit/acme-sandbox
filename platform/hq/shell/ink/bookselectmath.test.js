// node --test platform/hq/shell/ink/bookselectmath.test.js   (the select tool's maths; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundsOf,
  boxPoly,
  gestureOf,
  inside,
  mapBox,
  moveBy,
  movedScrap,
  movedStroke,
  movedText,
  movedThings,
  pasteAt,
  picked,
  scaleAt,
  scrapBox,
  topAt,
} from './bookselectmath.js';

const square = boxPoly([0, 0], [100, 100]);
// a box of words measured as its x, y, its width and one line high
const boxOfText = t => ({ x0: t.x, y0: t.y, x1: t.x + t.w, y1: t.y + 25 });
const line = (points, extra = {}) => ({
  color: '#2a2352',
  size: 4,
  points: points.map(([x, y]) => [x, y, 0.5, 0]),
  ...extra,
});

test('a point is inside a polygon, outside it, and inside a concave one only where it is', () => {
  assert.equal(inside(square, [50, 50]), true);
  assert.equal(inside(square, [150, 50]), false);
  const vee = [
    [0, 0],
    [50, 60],
    [100, 0],
    [100, 100],
    [0, 100],
  ];
  assert.equal(inside(vee, [50, 30]), false, 'in the notch');
  assert.equal(inside(vee, [50, 80]), true);
});

test('a drag roughly straight from corner to corner is a box from its start to its end', () => {
  const path = [
    [10, 10],
    [40, 45],
    [80, 70],
    [120, 110],
  ];
  assert.deepEqual(gestureOf(path, 4), { kind: 'box', poly: boxPoly([10, 10], [120, 110]) });
});

test('a drag that goes round is a lasso: its own path, closed', () => {
  const loop = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
    [5, 10],
  ];
  assert.deepEqual(gestureOf(loop, 4), { kind: 'lasso', poly: loop });
  // a C that doesn't close strays far from the line between its ends: a lasso too
  const c = [
    [100, 0],
    [0, 0],
    [0, 100],
    [100, 100],
  ];
  assert.equal(gestureOf(c, 4).kind, 'lasso');
});

test('a stroke is taken in when most of its points are; a picture or words when their middle is', () => {
  const ink = [
      line([
        [10, 10],
        [20, 20],
        [150, 20],
      ]),
      line([
        [10, 10],
        [150, 20],
        [160, 30],
      ]),
    ],
    scraps = [
      { x: 60, y: 60, w: 30, h: 30, tilt: 2 },
      { x: 80, y: 80, w: 60, h: 60, tilt: 0 },
    ],
    texts = [
      { x: 10, y: 50, w: 60, text: 'in' },
      { x: 70, y: 50, w: 80, text: 'out' },
    ];
  const got = picked(square, { ink, scraps, texts }, boxOfText);
  assert.deepEqual(got.ink, [ink[0]]);
  assert.deepEqual(got.scraps, [scraps[0]]);
  assert.deepEqual(got.texts, [texts[0]]);
  assert.equal(got.ink[0], ink[0], "the page's own objects");
});

test('the thing on top under a point: words over ink, ink over a highlighter, all over a picture', () => {
  const pic = { x: 0, y: 0, w: 200, h: 200, tilt: 0 },
    marker = line(
      [
        [0, 100],
        [200, 100],
      ],
      { size: 18, alpha: 0.42 },
    ),
    pen = line([
      [100, 0],
      [100, 200],
    ]),
    words = { x: 90, y: 90, w: 30 };
  const page = { ink: [pen, marker], scraps: [pic], texts: [words] };
  assert.deepEqual(topAt([100, 100], page, boxOfText, 3), { kind: 'texts', item: words });
  assert.deepEqual(topAt([101, 50], page, boxOfText, 3), { kind: 'ink', item: pen });
  assert.deepEqual(topAt([30, 104], page, boxOfText, 3), { kind: 'ink', item: marker });
  assert.deepEqual(topAt([30, 30], page, boxOfText, 3), { kind: 'scraps', item: pic });
  assert.equal(topAt([300, 300], page, boxOfText, 3), null);
  // a filled shape is ink all over its inside
  const blob = line(
    [
      [300, 300],
      [400, 300],
      [400, 400],
      [300, 400],
    ],
    { fill: true },
  );
  assert.deepEqual(topAt([350, 350], { ink: [blob], scraps: [], texts: [] }, boxOfText, 3), {
    kind: 'ink',
    item: blob,
  });
});

test("the selection's bounds hold its ink's width, its pictures as they're turned and its words", () => {
  const s = line([
    [10, 10],
    [50, 20],
  ]);
  assert.deepEqual(boundsOf({ ink: [s] }, boxOfText), { x0: 6, y0: 6, x1: 54, y1: 24 });
  const turned = scrapBox({ x: 0, y: 0, w: 100, h: 50, tilt: 90 });
  assert.ok(Math.abs(turned.x0 - 25) < 1e-9 && Math.abs(turned.y0 + 25) < 1e-9 && Math.abs(turned.x1 - 75) < 1e-9);
  assert.deepEqual(boundsOf({ texts: [{ x: 100, y: 200, w: 40 }], ink: [s] }, boxOfText), {
    x0: 6,
    y0: 6,
    x1: 140,
    y1: 225,
  });
  assert.equal(boundsOf({}, boxOfText), null);
});

test('a stroke moved and scaled about a corner: new points to 2 decimals, its line scaled, its fields kept', () => {
  const s = line(
    [
      [10, 10],
      [20, 30],
    ],
    { fill: true, alpha: 0.5 },
  );
  const tr = { k: 1.5, ax: 10, ay: 10, dx: 0, dy: 0 };
  const m = movedStroke(s, tr);
  assert.notEqual(m, s, 'a new stroke');
  assert.deepEqual(m.points, [
    [10, 10, 0.5, 0],
    [25, 40, 0.5, 0],
  ]);
  assert.equal(m.size, 6);
  assert.equal(m.fill, true);
  assert.equal(m.alpha, 0.5);
  assert.deepEqual(s.points[1], [20, 30, 0.5, 0], 'the old one untouched');
  assert.deepEqual(movedStroke(s, moveBy(1 / 3, 0)).points[0], [10.33, 10, 0.5, 0]);
});

test('a picture scales about the corner with its middle; words move with their middle and keep their size', () => {
  const img = {},
    s = { x: 20, y: 20, w: 40, h: 20, tilt: 3, img, file: 'f' };
  const m = movedScrap(s, { k: 2, ax: 0, ay: 0, dx: 5, dy: 0 });
  assert.deepEqual(m, { x: 45, y: 40, w: 80, h: 40, tilt: 3, img, file: 'f' });
  const t = { x: 100, y: 100, w: 60, text: 'hi' };
  assert.deepEqual(movedText(t, { k: 2, ax: 0, ay: 0, dx: 0, dy: 0 }, boxOfText(t)), {
    x: 230,
    y: 212.5,
    w: 60,
    text: 'hi',
  });
});

test('a corner handle scales about the opposite corner, never below a few screen px', () => {
  const b = { x0: 100, y0: 100, x1: 200, y1: 150 };
  const out = scaleAt(b, 2, [300, 200]);
  assert.deepEqual(out, { k: 2, ax: 100, ay: 100, dx: 0, dy: 0 });
  assert.deepEqual(mapBox(out, b), { x0: 100, y0: 100, x1: 300, y1: 200 });
  // dragged past the anchor: as small as it goes
  assert.equal(scaleAt(b, 2, [0, 0]).k, 12 / 50);
  // zoomed in 4×, smaller still on the page
  assert.equal(scaleAt(b, 2, [0, 0], 4).k, 3 / 50);
  // the top-left handle goes on past the page's top-left: the paper is endless every way
  const tl = scaleAt(b, 0, [-500, -500]);
  assert.deepEqual([tl.ax, tl.ay, tl.k], [200, 150, 8.2]);
});

test("a resize keeps every picked stroke's line within what the store keeps (0.5 to 200)", () => {
  const b = { x0: 0, y0: 0, x1: 400, y1: 300 },
    line = size => ({ color: '#2a2352', size, alpha: 1, points: [[10, 10, 0.5, 0]] });
  // a big selection shrunk to its least: its pen of 5 stops at 0.5, not 0.2
  const pen = [line(5), line(12)],
    shrunk = scaleAt(b, 2, [0, 0], 1, pen);
  assert.equal(shrunk.k, 0.1);
  assert.deepEqual(
    pen.map(s => movedStroke(s, shrunk).size),
    [0.5, 1.2],
  );
  // a highlighter grown: its 20 stops at 200, not 1,081
  const marker = [line(20), line(2)],
    grown = scaleAt(b, 2, [21_600, 16_200], 1, marker);
  assert.equal(grown.k, 10);
  assert.deepEqual(
    marker.map(s => movedStroke(s, grown).size),
    [200, 20],
  );
  // and a line of 3 shrinks to a size the store keeps once rounded
  assert.equal(movedStroke(line(3), scaleAt(b, 2, [0, 0], 1, [line(3)])).size, 0.5);
});

test('a paste lands its middle on the point, then a step on, past the top-left too', () => {
  const b = { x0: 20, y0: 30, x1: 60, y1: 50 };
  assert.deepEqual(pasteAt(b, [200, 200]), moveBy(160, 160));
  assert.deepEqual(pasteAt(b, [200, 200], 2, 16), moveBy(192, 192));
  assert.deepEqual(pasteAt(b, [-100, 0]), moveBy(-140, -40));
});

test('things moved together: each to a new self, the words by their measured box', () => {
  const s = line([[0, 0]]),
    pic = { x: 0, y: 0, w: 10, h: 10, tilt: 0 },
    t = { x: 5, y: 5, w: 40 };
  const moved = movedThings({ ink: [s], scraps: [pic], texts: [t] }, moveBy(10, 20), boxOfText);
  assert.deepEqual(moved.get(s).points, [[10, 20, 0.5, 0]]);
  assert.deepEqual(moved.get(pic), { ...pic, x: 10, y: 20 });
  assert.deepEqual(moved.get(t), { x: 15, y: 25, w: 40 });
});
