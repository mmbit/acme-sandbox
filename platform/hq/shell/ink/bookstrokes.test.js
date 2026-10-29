// node --test platform/hq/shell/ink/bookstrokes.test.js   (the book's shapes and eraser as plain numbers; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// (the browser has review mode's files at /__review/, as the coordinator serves them)
const REVIEW = new URL('../../../../shared/review/', import.meta.url);
registerHooks({
  resolve: (specifier, context, next) =>
    next(
      specifier.startsWith('/__review/') ? new URL(specifier.slice('/__review/'.length), REVIEW).href : specifier,
      context,
    ),
});
const { SHAPE_P, shape } = await import('./bookinkmath.js');
const { cut, inside, radius, rub } = await import('./bookstrokes.js');

const INK = { color: '#2a2352', size: 4 };
const line = (pts, more = {}) => ({ ...INK, ...more, points: pts.map(([x, y], i) => [x, y, 0.5, i * 10]) });

test("a shape's line is the ink's size across, everywhere along it", () => {
  assert.ok(Math.abs(radius(4, SHAPE_P) * 2 - 4) < 0.02);
  for (const kind of ['ellipse', 'rect', 'line', 'arrow'])
    assert.ok(
      shape(kind, [0, 0], [50, 30], INK).points.every(p => p[2] === SHAPE_P),
      kind,
    );
});

test('a rectangle goes round its box and back; filled, it says so; a line or an arrow never fills', () => {
  const r = shape('rect', [10, 20], [110, 70], INK, { fill: true });
  assert.deepEqual(
    r.points.map(p => p.slice(0, 2)),
    [
      [10, 20],
      [110, 20],
      [110, 70],
      [10, 70],
      [10, 20],
    ],
  );
  assert.equal(r.fill, true);
  assert.equal(r.color, INK.color);
  assert.ok(!('fill' in shape('rect', [10, 20], [110, 70], INK)));
  assert.ok(!('fill' in shape('line', [0, 0], [40, 40], INK, { fill: true })));
  assert.ok(!('fill' in shape('arrow', [0, 0], [40, 40], INK, { fill: true })));
  // (times rise as a hand would draw it, for a replay)
  assert.ok(r.points.every((p, i) => i === 0 || p[3] > r.points[i - 1][3]));
});

test('an ellipse fits its box, closed, with more points the bigger it is', () => {
  const e = shape('ellipse', [0, 0], [200, 100], INK);
  const xs = e.points.map(p => p[0]),
    ys = e.points.map(p => p[1]);
  const fits = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  assert.ok(
    fits.every((v, i) => Math.abs(v - [0, 200, 0, 100][i]) < 0.1),
    String(fits),
  );
  assert.deepEqual(e.points[0].slice(0, 2), e.points.at(-1).slice(0, 2));
  const small = shape('ellipse', [0, 0], [20, 20], INK);
  assert.ok(small.points.length >= 25 && e.points.length > small.points.length);
  assert.ok(shape('ellipse', [0, 0], [5000, 5000], INK).points.length <= 181, 'never more than it needs');
});

test('Shift: a square, a circle, a line at 45°; a click is no shape', () => {
  const sq = shape('rect', [0, 0], [100, -40], INK, { even: true });
  assert.deepEqual(sq.points[2].slice(0, 2), [100, -100]);
  const ln = shape('line', [0, 0], [100, 90], INK, { even: true });
  assert.ok(Math.abs(ln.points[1][0] - ln.points[1][1]) < 0.02, 'on the diagonal');
  const flat = shape('arrow', [0, 0], [100, 8], INK, { even: true });
  assert.equal(flat.points[1][1], 0, 'level');
  assert.equal(shape('rect', [10, 10], [11, 12], INK), null);
});

test("an arrow's head is at its tip, both barbs back along the line", () => {
  const a = shape('arrow', [0, 0], [100, 0], INK);
  assert.deepEqual(a.points[1].slice(0, 2), [100, 0]);
  assert.deepEqual(a.points[3].slice(0, 2), [100, 0]);
  const [b1, b2] = [a.points[2], a.points[4]];
  assert.ok(b1[0] < 100 && b2[0] < 100, 'the barbs point back');
  assert.ok(Math.abs(b1[1] + b2[1]) < 0.02 && Math.abs(b1[1]) > 5, 'one each side, alike');
  // (a short arrow's head is in proportion)
  const short = shape('arrow', [0, 0], [10, 0], INK);
  assert.ok(short.points[2][0] > 4);
});

test('the eraser cuts a line where it passes, in two, and leaves the rest as it was', () => {
  const s = line([
    [0, 0],
    [200, 0],
  ]);
  const pieces = cut(s, [100, -50], [100, 50], 10);
  assert.equal(pieces.length, 2);
  const [left, right] = pieces;
  const gap = right.points[0][0] - left.points.at(-1)[0];
  const r = radius(4, 0.5);
  // (the eraser's width, and the line's own round ends on either side of it)
  assert.ok(gap >= 20 + 2 * r && gap <= 20 + 2 * r + 2 * 2.5 + 0.01, `the gap ${gap}`);
  assert.deepEqual(left.points[0], s.points[0]);
  assert.deepEqual(right.points.at(-1), s.points[1]);
  assert.equal(left.color, s.color);
  assert.equal(left.size, s.size);
  assert.equal(cut(s, [100, 30], [120, 30], 10), null, 'out of reach: untouched');
});

test('a pass over the end of a line shortens it; over all of it, takes it', () => {
  const s = line([
    [0, 0],
    [40, 0],
  ]);
  const shorter = cut(s, [40, -20], [40, 20], 8);
  assert.equal(shorter.length, 1);
  assert.ok(shorter[0].points.at(-1)[0] < 40 - 8);
  assert.deepEqual(cut(s, [-20, 0], [60, 0], 8), []);
});

test('a filled shape the eraser touches goes whole, by its line or its inside; an outlined one is cut', () => {
  const box = shape('rect', [0, 0], [100, 100], INK, { fill: true });
  assert.deepEqual(cut(box, [50, 50], [52, 50], 5), [], 'inside');
  assert.deepEqual(cut(box, [-3, 50], [-3, 52], 5), [], 'its line');
  assert.equal(cut(box, [150, 50], [160, 50], 5), null);
  const ring = shape('rect', [0, 0], [100, 100], INK);
  assert.equal(cut(ring, [50, 50], [52, 50], 5), null, "an outline's inside is paper");
  assert.equal(cut(ring, [50, -20], [50, 20], 5).length, 1, 'cut open: one line round');
});

test('a rub over a page: only what it touched changes, and says where', () => {
  const a = line([
      [0, 0],
      [100, 0],
    ]),
    b = line([
      [0, 300],
      [100, 300],
    ]);
  const done = rub([a, b], [50, -20], [50, 20], 6);
  assert.equal(done.ink.length, 3);
  assert.equal(done.ink[2], b, 'the other line the same object');
  assert.ok(done.box.y1 < 50 && done.box.x0 <= 0);
  assert.equal(rub([a, b], [50, 100], [60, 100], 6), null);
});

test("a point is inside a closed run of points or it isn't", () => {
  const sq = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ];
  assert.ok(inside(sq, [5, 5]));
  assert.ok(!inside(sq, [15, 5]));
});
