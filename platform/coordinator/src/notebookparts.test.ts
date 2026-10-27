// node --test src/notebookparts.test.ts   (a group's elements as one: pure, no server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxOf, emptyGroup, hasAny, joined, picks, shifted } from './notebookparts.ts';

const stroke = {
  color: '#000',
  size: 4,
  points: [
    [10, 20, 0.5, 0],
    [50, 60, 0.5, 16],
  ],
};
const text = { x: 100, y: 0, w: 80, text: 'two\nlines' };
const picture = { file: '1-g-00000000.png', x: -20, y: 30, w: 40, h: 10, tilt: 0 };

test("a group's box holds its strokes' width, its words' lines and its pictures", () => {
  assert.equal(boxOf(emptyGroup), null);
  assert.deepEqual(boxOf({ ...emptyGroup, ink: [stroke] }), { x: 8, y: 18, w: 44, h: 44 });
  assert.deepEqual(boxOf({ ink: [stroke], texts: [text], pictures: [picture] }), { x: -20, y: 0, w: 200, h: 62 });
});

test('shifted moves every element, its pressure and time kept; joined keeps both in order', () => {
  const moved = shifted({ ink: [stroke], texts: [text], pictures: [picture] }, 5, -5);
  assert.deepEqual(moved.ink, [
    {
      ...stroke,
      points: [
        [15, 15, 0.5, 0],
        [55, 55, 0.5, 16],
      ],
    },
  ]);
  assert.deepEqual([moved.texts, moved.pictures], [[{ ...text, x: 105, y: -5 }], [{ ...picture, x: -15, y: 25 }]]);
  const both = joined({ ...emptyGroup, ink: [stroke] }, { ...emptyGroup, texts: [text] });
  assert.deepEqual(both, { ink: [stroke], texts: [text], pictures: [] });
  assert.equal(hasAny(both), true);
  assert.equal(hasAny(emptyGroup), false);
});

test("a lasso's picks are the group's own indexes, once each, or refused", () => {
  assert.deepEqual(picks(undefined, [1, 2]), []);
  assert.deepEqual(picks([1, 1, 0], [1, 2]), [1, 0]);
  for (const bad of [[2], [-1], [0.5], 'x', [null]]) assert.equal(picks(bad, [1, 2]), null, JSON.stringify(bad));
});
