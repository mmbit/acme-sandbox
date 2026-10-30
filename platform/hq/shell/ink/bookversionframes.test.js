// node --test platform/hq/shell/ink/bookversionframes.test.js   (the frame a mark on a try's versions is on)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameUnder } from './bookversionframes.js';

test('a mark is on the frame it covers most, else the nearest', () => {
  const frames = [
    { x: 0, y: 0, w: 200, h: 150 },
    { x: 222, y: 0, w: 200, h: 150 },
    { x: 0, y: 218, w: 200, h: 150 },
  ];
  // a ring a little outside the second frame, reaching into the gaps round it
  assert.equal(frameUnder({ x0: 208, y0: -14, x1: 436, y1: 164 }, frames), 1);
  // a tick on the third's lower half
  assert.equal(frameUnder({ x0: 60, y0: 300, x1: 120, y1: 340 }, frames), 2);
  // a ring round the first that reaches over the second's edge: the first it covers most
  assert.equal(frameUnder({ x0: -10, y0: -10, x1: 240, y1: 160 }, frames), 0);
  // in the paper below them all, touching none: the nearest
  assert.equal(frameUnder({ x0: 250, y0: 400, x1: 300, y1: 420 }, frames), 2);
  assert.equal(frameUnder({ x0: 0, y0: 0, x1: 1, y1: 1 }, []), -1);
});
