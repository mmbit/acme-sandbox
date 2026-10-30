// node --test platform/hq/renderers/brownstone/arcade.test.js   (the arcade's wall art along its wall, no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arcadeWall, NOTICE } from './layout.js';

const KIND = [
    ['neon', 20],
    ['laptops', 14],
  ],
  NEON = 20 / 16,
  SHELF = 14 / 16;

test('the smallest arcade with people keeps its shelf beside the neon, both past the back row', () => {
  // 2 people: 6 tiles. The back row ends at 3.5 tiles; the wall's last 0.25 stays clear
  const row = arcadeWall(6, KIND);
  assert.deepEqual(
    row.map(([name]) => name),
    ['neon', 'laptops'],
  );
  const [[, neon], [, shelf]] = row;
  assert.equal(neon, 4);
  assert.ok(neon - NEON / 2 >= 3.375 && shelf - SHELF / 2 >= neon + NEON / 2 && shelf + SHELF / 2 <= 6 - 0.25);
});

test("a bigger arcade's wall goes on in the same row to its far end", () => {
  const row = arcadeWall(10, KIND);
  assert.deepEqual(
    row.map(([name]) => name),
    ['neon', 'laptops', 'neon', 'laptops', 'neon'],
  ); // (five along it, as main drew)
  assert.ok(row.at(-1)[1] + NEON / 2 <= 10 - 0.25);
});

test('the neon leads by name, wherever the kind lists it, and an arcade with no wall past its back row has none', () => {
  assert.deepEqual(
    arcadeWall(6, KIND.toReversed()).map(([name]) => name),
    ['neon', 'laptops'],
  );
  assert.deepEqual(arcadeWall(4, [['vacant', NOTICE.w], ...KIND]), []); // (an empty one: the back row is all its wall)
});
