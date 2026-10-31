// node --test platform/hq/shell/ink/bookassignmath.test.js   (the assign gesture's maths; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bowed, evenly, leftRing, ringAt } from './bookassignmath.js';

// a circle of radius r round (cx, cy), `turns` times round, a point every 5 degrees
const circle = (cx, cy, r, turns = 1.1) =>
  Array.from({ length: Math.round(72 * turns) + 1 }, (_, i) => {
    const a = (i * 5 * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
const ringOf = path => {
  for (let at = 1; at < path.length; at++) {
    const ring = ringAt(path, at, 12, 200);
    if (ring) return ring;
  }
  return null;
};

test('a circle drawn past its start closes a ring there, from its first point', () => {
  const path = circle(100, 100, 80);
  const ring = ringOf(path);
  assert.ok(ring, 'a ring');
  assert.equal(ring.from, 0);
  assert.ok(ring.to >= 70 && ring.to <= 73, 'closed about one turn round');
});

test('a short wiggle, a straight line and a circle that stops short close no ring', () => {
  const wiggle = Array.from({ length: 30 }, (_, i) => [i * 2, i % 2 ? 4 : 0]);
  const straight = Array.from({ length: 50 }, (_, i) => [i * 8, 0]);
  assert.equal(ringOf(wiggle), null);
  assert.equal(ringOf(straight), null);
  assert.equal(ringOf(circle(100, 100, 80, 0.8)), null);
});

test('a line out of a ring has left it only once it is outside and far enough from every point of it', () => {
  const ring = circle(100, 100, 80, 1);
  assert.equal(leftRing(ring, [100, 100], 30), false, 'inside');
  assert.equal(leftRing(ring, [195, 100], 30), false, 'just outside');
  assert.equal(leftRing(ring, [215, 100], 30), true, 'well clear');
});

test('points spaced evenly along a bent line keep its ends and its bend', () => {
  const line = [
    [0, 0],
    [100, 0],
    [100, 100],
  ];
  const points = evenly(line, 4);
  assert.deepEqual(points, [
    [0, 0],
    [50, 0],
    [100, 0],
    [100, 50],
    [100, 100],
  ]);
});

test('a bowed flight starts and ends at its ends, and bends off the straight line', () => {
  const points = bowed([0, 0], [100, 0], 10);
  assert.deepEqual(
    [points[0], points.at(-1)],
    [
      [0, 0],
      [100, 0],
    ],
  );
  assert.ok(Math.abs(points[5][1]) > 5, 'away from the straight line half way');
});
