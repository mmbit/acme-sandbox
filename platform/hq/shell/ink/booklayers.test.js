// node --test platform/hq/shell/ink/booklayers.test.js   (a scrap's stack and Select's step through it; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runsOf, stackOf } from './booklayers.js';
import { restacked } from './bookselectlayer.js';

const line = (x, more = {}) => ({
  color: '#2a2352',
  size: 4,
  points: [
    [x, 10, 0.5, 0],
    [x + 20, 30, 0.5, 9],
  ],
  ...more,
});
const picture = (x, more = {}) => ({ file: `${x}.png`, x, y: 0, w: 40, h: 40, tilt: 0, ...more });
const order = (pictures, ink) => stackOf(pictures, ink).map(x => x.it);

test('a scrap never moved lies as it always has: its pictures, then its ink, the marker under the pen', () => {
  const [a, b] = [picture(0), picture(50)],
    pen = line(0),
    marker = line(5, { alpha: 0.4 });
  assert.deepEqual(order([a, b], [pen, marker]), [a, b, marker, pen]);
  assert.deepEqual(runsOf([a, b], [pen, marker]), [{ pictures: [a, b] }, { ink: [marker, pen] }]);
});

test('the marker lies under the pencil and the pen, whichever came first; each kind in its own order', () => {
  const pen1 = line(0),
    marker1 = line(5, { alpha: 0.42 }),
    pencil = line(10, { alpha: 0.7 }),
    marker2 = line(15, { alpha: 0.42 }),
    pen2 = line(20);
  assert.deepEqual(order([], [pen1, marker1, pencil, marker2, pen2]), [marker1, marker2, pencil, pen1, pen2]);
});

test('things with a place lie in it, under everything without one, so what comes after a move lands on top', () => {
  const pen = line(0, { layer: 0 }),
    a = picture(0, { layer: 1 }),
    fresh = line(10),
    pasted = picture(20);
  assert.deepEqual(order([a, pasted], [fresh, pen]), [pen, a, pasted, fresh]);
  assert.deepEqual(runsOf([a, pasted], [fresh, pen]), [{ ink: [pen] }, { pictures: [a, pasted] }, { ink: [fresh] }]);
});

test('a step up passes the next thing over it that it overlaps, a step down the next under it; none: nothing moves', () => {
  // (a meets b, b meets c, c meets d; e lies far from them all)
  const [a, b, c, d, e] = [0, 30, 60, 90, 300].map(x => picture(x));
  const things = [a, b, c, d, e];
  const step = (picked, up) => {
    const swap = restacked({ scraps: things, ink: [] }, { ink: [], scraps: picked }, up);
    if (!swap) return null;
    const moved = things.map(x => swap.get(x) ?? x);
    return order(moved, []).map(x => x.x);
  };
  assert.deepEqual(step([b], true), [0, 60, 30, 90, 300]);
  assert.deepEqual(step([b], false), [30, 0, 60, 90, 300]);
  assert.equal(step([e], true), null, 'on top already');
  assert.equal(step([d], true), null, 'nothing over it overlaps it');
  // (what's picked goes as one, in its own order)
  assert.deepEqual(step([a, c], true), [30, 90, 0, 60, 300]);
});

test("the board's moodboard: a drawing sent behind a picture, then the picture behind it again, every thing keeping its place", () => {
  const photo = picture(0),
    other = picture(200),
    pen = line(10);
  const page = { scraps: [photo, other], ink: [pen] };
  const back = restacked(page, { ink: [pen], scraps: [] }, false);
  const now = x => back.get(x) ?? x;
  assert.deepEqual(order(page.scraps.map(now), page.ink.map(now)), [now(pen), now(photo), now(other)]);
  assert.equal(now(other).layer, 2, 'every thing on the scrap given its place, the one far away too');
  // (the picture that doesn't meet the line is no step: a picture sent back passes the line)
  page.scraps = page.scraps.map(now);
  page.ink = page.ink.map(now);
  const again = restacked(page, { ink: [], scraps: [page.scraps[0]] }, false);
  const then = x => again.get(x) ?? x;
  assert.deepEqual(
    order(page.scraps.map(then), page.ink.map(then)).map(x => x.file ?? 'pen'),
    ['0.png', 'pen', '200.png'],
  );
  assert.equal(restacked(page, { ink: [], scraps: [page.scraps[1]] }, true), null, 'on top of all it overlaps');
});
