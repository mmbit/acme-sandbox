// node --test src/lowmemory.test.ts   (the worker's judgment of a low-memory spell and its cause, from its looks)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryWatch } from './lowmemory.ts';

const GB = 1024;
const uses = (...mb: [number, number][]) => new Map(mb);

test('with 12 GB free one job taking 5 is nothing; with 5 GB free a job taking 3.5 is a low spell, and it is the cause', () => {
  const roomy = memoryWatch(2 * GB, 3 * GB);
  roomy(12 * GB, uses([7, 300]));
  assert.deepEqual(roomy(7 * GB, uses([7, 5300])), { verdict: 'calm' });

  const tight = memoryWatch(2 * GB, 3 * GB);
  tight(5 * GB, uses([7, 300], [8, 400]));
  assert.deepEqual(
    tight(3 * GB, uses([7, 2300], [8, 400])),
    { verdict: 'calm' },
    '2 GB of 5 leaves 3: pushing it, not low',
  );
  const tooMuch = memoryWatch(2 * GB, 3 * GB);
  tooMuch(5 * GB, uses([7, 300], [8, 400]));
  const low = tooMuch(1.5 * GB, uses([7, 3800], [8, 400]));
  assert.equal(low.verdict, 'low');
  assert.deepEqual(low.cause, { job: 7, tookMb: 3500, freeMb: 5 * GB }, 'of what was free at the last calm look');
});

test('a spell holds between the two lines and ends at the upper one, so it never flaps on a look', () => {
  const watch = memoryWatch(2 * GB, 3 * GB);
  watch(4 * GB, uses());
  assert.equal(watch(1.9 * GB, uses([7, 2100])).verdict, 'low');
  assert.equal(watch(2.4 * GB, uses([7, 1700])).verdict, 'between');
  assert.equal(watch(1.95 * GB, uses([7, 2100])).verdict, 'low');
  assert.equal(watch(3 * GB, uses([7, 1000])).verdict, 'calm');
});

test('memory taken a little by many jobs has no one cause; a job started meanwhile counts all it holds', () => {
  const watch = memoryWatch(2 * GB, 3 * GB);
  watch(5 * GB, uses([1, 500], [2, 500], [3, 500], [4, 500]));
  const many = watch(1.5 * GB, uses([1, 1400], [2, 1400], [3, 1400], [4, 1400]));
  assert.deepEqual(many, { verdict: 'low' });

  const fresh = memoryWatch(2 * GB, 3 * GB);
  fresh(5 * GB, uses([1, 500]));
  assert.deepEqual(fresh(1.8 * GB, uses([1, 600], [9, 3100])).cause, { job: 9, tookMb: 3100, freeMb: 5 * GB });
});
