// node --test shared/review/eraser.test.js   (how far the eraser's pass is from a line, review mode's and the book's)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromSegment, segmentsApart } from './eraser.js';

test('a point is as far from a segment as from its nearest point on it, an end when it lies beyond', () => {
  assert.equal(fromSegment([5, 3], [0, 0], [10, 0]), 3);
  assert.equal(fromSegment([13, 4], [0, 0], [10, 0]), 5);
  assert.equal(fromSegment([3, 4], [0, 0], [0, 0]), 5, 'a dot is a segment too');
});

test('two segments that cross are 0 apart, whatever their ends', () => {
  assert.equal(segmentsApart([0, 0], [10, 10], [0, 10], [10, 0]), 0);
  assert.equal(segmentsApart([-100, 1], [100, 1], [0, -100], [0, 100]), 0);
});

test("two segments that don't cross are as far apart as their nearest ends or sides", () => {
  assert.equal(segmentsApart([0, 0], [10, 0], [0, 4], [10, 4]), 4, 'side by side');
  assert.equal(segmentsApart([0, 0], [10, 0], [13, -2], [13, 9]), 3, "one's end to the other's side");
  assert.equal(segmentsApart([0, 0], [10, 0], [13, 4], [20, 8]), 5, 'end to end');
  assert.equal(segmentsApart([0, 0], [10, 0], [5, 2], [5, 2]), 2, 'a dot beside a line');
});
