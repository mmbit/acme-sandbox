// node --test platform/hq/shell/floating.test.js   (no DOM)
// clearSpot: the small call's place, clear of the controls and over as little as can be of what the board reads
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearSpot } from './floating.js';

const box = (left, top, right, bottom) => ({ left, top, right, bottom });
// a sideways phone's page: the bubble's home its bottom right corner, a scrap's handle there, the scrap above it
const ROOM = box(12, 12, 832, 378),
  SIZE = { w: 64, h: 64 },
  HOME = [{ room: ROOM, at: { x: 768, y: 314 } }],
  HANDLE = box(760, 330, 800, 350),
  SCRAP = box(560, 40, 800, 330);

test('clear of a control, the nearest spot: a step up or down before one sideways', () => {
  const spot = clearSpot(SIZE, HOME, [HANDLE]);
  assert.deepEqual([spot.x, spot.y], [768, 254]);
});

test('clear of a control, a spot over none of what the board reads when there is one', () => {
  const spot = clearSpot(SIZE, HOME, [HANDLE], [SCRAP]);
  assert.equal(spot.covers, 0);
  assert.ok(spot.x + SIZE.w <= SCRAP.left || spot.x >= SCRAP.right || spot.y >= SCRAP.bottom, JSON.stringify(spot));
  assert.ok(spot.x + SIZE.w <= HANDLE.left || spot.y >= HANDLE.bottom || spot.y + SIZE.h <= HANDLE.top);
});

test('where all of it is read, the nearest clear spot', () => {
  const spot = clearSpot(SIZE, HOME, [HANDLE], [box(0, 0, 844, 390)]);
  assert.deepEqual([spot.x, spot.y, spot.covers], [768, 254, SIZE.w * SIZE.h]);
});
