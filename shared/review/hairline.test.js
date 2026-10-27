// node --test shared/review/hairline.test.js   (a hairline's reach, its card's place and its time)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REACH, cardPlace, distanceTo, fadeLeft, hairAt, segmentDistance, sentLabel } from './hairline.js';

const line = (...points) => ({ color: '#ff5a5f', size: 5, points: points.map(([x, y]) => [x, y, 0.5, 0]) });

test('a point is as far from a segment as from its nearest point on it', () => {
  assert.equal(segmentDistance([5, 3], [0, 0], [10, 0]), 3);
  assert.equal(segmentDistance([-4, 3], [0, 0], [10, 0]), 5); // (past its end: from the end)
  assert.equal(segmentDistance([3, 4], [0, 0], [0, 0]), 5); // (a segment of one point)
});

test("a note's lines are as near as their nearest piece, a dot too", () => {
  const ring = [line([0, 0], [100, 0], [100, 100], [0, 100], [0, 0])];
  assert.equal(distanceTo(ring, [50, 4]), 4);
  assert.equal(distanceTo(ring, [50, 50]), 50); // (inside the ring, far from its line)
  assert.equal(distanceTo([line([10, 10])], [13, 14]), 5);
  assert.equal(distanceTo([], [0, 0]), Infinity);
});

test('a tap lands on the nearest hairline within reach, and on none further off', () => {
  const a = { note: { id: 1 }, lines: [line([0, 0], [200, 0])] },
    b = { note: { id: 2 }, lines: [line([0, 20], [200, 20])] };
  assert.equal(hairAt([a, b], [50, 8])?.note.id, 1);
  assert.equal(hairAt([a, b], [50, 13])?.note.id, 2);
  assert.equal(hairAt([a, b], [50, -REACH])?.note.id, 1);
  assert.equal(hairAt([a, b], [50, -REACH - 1]), null); // (a tap that isn't on one stays the page's)
  assert.equal(hairAt([], [0, 0]), null);
});

test('the card sits beside the tap, on the right where there is room, else on the left, on the page', () => {
  const page = { w: 600, h: 800 },
    card = { w: 260, h: 120 };
  assert.deepEqual(cardPlace([100, 300], card, page), { x: 114, y: 240 });
  assert.deepEqual(cardPlace([500, 300], card, page), { x: 226, y: 240 });
  assert.deepEqual(cardPlace([500, 20], card, page), { x: 226, y: 8 }); // (not above the page's top)
  assert.deepEqual(cardPlace([500, 790], card, page), { x: 226, y: 672 }); // (nor past its foot)
  assert.deepEqual(cardPlace([150, 300], card, { w: 300, h: 800 }), { x: 20, y: 240 }); // (no room either side)
});

test('when it went: the day and the time, in the page’s own time', () => {
  assert.equal(sentLabel(new Date(2026, 9, 26, 8, 16)), 'Sent Mon 08:16');
  assert.equal(sentLabel(new Date(2026, 9, 25, 21, 5).toISOString()), 'Sent Sun 21:05');
  assert.equal(sentLabel(null), 'Sent');
});

test('a sent mark fades into its hairline: whole at first, eased, gone at the end and after', () => {
  assert.equal(fadeLeft(-0.1), 1);
  assert.equal(fadeLeft(0), 1);
  assert.equal(fadeLeft(0.5), 0.5);
  assert.ok(fadeLeft(0.1) > 0.95 && fadeLeft(0.9) < 0.05, 'slow at both ends');
  assert.ok(fadeLeft(0.3) > fadeLeft(0.6), 'only ever fainter');
  assert.equal(fadeLeft(1), 0);
  assert.equal(fadeLeft(2), 0);
});
