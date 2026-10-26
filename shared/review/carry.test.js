// node --test shared/review/carry.test.js   (a ring's inside, and its cut-out's box on the screenshot)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxOfPoints, cutOf, insideRing } from './carry.js';

const ring = (cx, cy, rx, ry, n = 44) =>
  Array.from({ length: n }, (_, i) => [
    cx + rx * Math.cos((i / n) * 2 * Math.PI),
    cy + ry * Math.sin((i / n) * 2 * Math.PI),
  ]);

test('a finger inside the ring is in it; outside, or past a ring left open at its end, is not', () => {
  const r = ring(200, 100, 150, 60);
  assert.equal(insideRing(r, [200, 100]), true);
  assert.equal(insideRing(r, [330, 100]), true);
  assert.equal(insideRing(r, [360, 100]), false);
  assert.equal(insideRing(r, [200, 170]), false);
  // (a ring whose end stops short of its start: closed by a straight line back)
  const open = ring(200, 100, 150, 60).slice(0, 40);
  assert.equal(insideRing(open, [200, 100]), true);
});

test("the cut-out is the ring's box on the screenshot, in whole device px, within it", () => {
  const box = boxOfPoints(ring(200, 100, 150, 60));
  assert.deepEqual(cutOf(box, 2, 744, 1133), { sx: 100, sy: 80, sw: 600, sh: 240 });
  assert.deepEqual(cutOf({ x: -20, y: 10.25, w: 60, h: 30 }, 2, 744, 1133), { sx: 0, sy: 20, sw: 80, sh: 61 });
  assert.deepEqual(cutOf({ x: 700, y: 1100, w: 100, h: 100 }, 1, 744, 1133), { sx: 700, sy: 1100, sw: 44, sh: 33 });
  assert.equal(cutOf({ x: 800, y: 10, w: 50, h: 50 }, 2, 744, 1133), null); // (off the screen: nothing to cut)
});
