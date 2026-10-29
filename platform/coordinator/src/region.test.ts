// node --test src/region.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regionOf } from './region.ts';

test('a region is four fractions with an area, inside the picture; none asked for is undefined', () => {
  assert.equal(regionOf(undefined), undefined);
  assert.equal(regionOf(null), undefined);
  assert.deepEqual(regionOf({ x: 0, y: 0.5, width: 0.5, height: 0.5 }), { x: 0, y: 0.5, width: 0.5, height: 0.5 });
  const third = 1 / 3;
  assert.deepEqual(regionOf({ x: 2 * third, y: 0, width: third, height: 1 }), {
    x: 2 * third,
    y: 0,
    width: third,
    height: 1,
  });
  for (const asked of [
    'all',
    { x: 0, y: 0, width: 0.5 },
    { x: '0', y: 0, width: 0.5, height: 0.5 },
    { x: -0.1, y: 0, width: 0.5, height: 0.5 },
    { x: 0, y: 0, width: 1.5, height: 0.5 },
    { x: 0, y: 0, width: 0, height: 0.5 },
    { x: 0.8, y: 0, width: 0.5, height: 1 },
    { x: 0, y: 0.6, width: 1, height: 0.5 },
  ])
    assert.equal(regionOf(asked), null, JSON.stringify(asked));
});
