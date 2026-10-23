// node --test shared/signs/signs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastChannels } from '../contrast/contrast.js';
import {
  ago,
  lasted,
  glance,
  clock,
  fromNow,
  countText,
  pixelDigits,
  ringColour,
  ring,
  pulseMarks,
  BEAT_MS,
} from './signs.js';

const MIN = 60_000;
const now = Date.parse('2026-10-22T14:00:00Z'); // a Thursday
const channels = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

test('how long ago, short for a badge', () => {
  assert.deepEqual(
    [20_000, 4 * MIN, 47 * MIN, 125 * MIN, 3 * 1440 * MIN].map(back => ago(now - back, now)),
    ['now', '4m', '47m', '2h', '3d'],
  );
});

test('how long, in words', () => {
  assert.deepEqual([10_000, 47 * MIN, 65 * MIN, 180 * MIN, 2 * 1440 * MIN].map(lasted), [
    '1 min',
    '47 min',
    '1 h 5 min',
    '3 h',
    '2 d',
  ]);
});

test('a glance: to the five minutes, the half hour, then whole hours', () => {
  assert.deepEqual([MIN, 23 * MIN, 88 * MIN, 120 * MIN, 650 * MIN].map(glance), [
    '5 min',
    '25 min',
    '1½ h',
    '2 h',
    '11 h',
  ]);
});

test('a time of day in the company’s clock, with its day when it isn’t today', () => {
  assert.equal(clock(now + 2 * 60 * MIN, { now, timeZone: 'UTC' }), '16:00');
  assert.equal(clock(now + 2 * 60 * MIN, { now, timeZone: 'Europe/Amsterdam' }), '18:00');
  assert.equal(clock(now + 20 * 60 * MIN, { now, timeZone: 'UTC' }), 'Fri 10:00');
});

test('when it’s due: a glance, its day, then its date; a time past as its clock time', () => {
  const at = minutes => fromNow(now + minutes * MIN, { now, timeZone: 'UTC' });
  assert.deepEqual(
    [at(25), at(95), at(2 * 1440), at(7 * 1440), at(-30)],
    ['25 min', '1½ h', 'Sat', 'Thu 29 Oct', '13:30'],
  );
});

test('a count: none hides, past 99 reads 99+, in pixel digits for a pixel look', () => {
  assert.deepEqual([0, 3, 99, 140].map(countText), ['', '3', '99', '99+']);
  assert.match(pixelDigits('99+'), /viewBox="0 0 17 7" width="34"/);
});

test('the ring keeps its own colour where it shows, and deepens or lifts one that would vanish', () => {
  assert.equal(ringColour('#3b6ea8', '#f7f3ec'), '#3b6ea8'); // (a denim shirt on a pale key)
  for (const [shirt, key] of [
    ['#f6f1e6', '#f7f3ec'], // (a cream shirt on a white key)
    ['#26222e', '#20232a'], // (a black one on a dark key)
  ])
    assert.ok(contrastChannels(channels(ringColour(shirt, key)), channels(key)) >= 2, shirt);
  assert.match(ring(), /class="ring turning"/);
  assert.doesNotMatch(ring({ working: false }), /turning/);
});

test('the pulse: a voice of three bars each, on beats spread from the clock', () => {
  const marks = pulseMarks(3, BEAT_MS * 10);
  assert.equal(marks.match(/class="voice"/g).length, 3);
  assert.equal(marks.match(/class="beat"/g).length, 9);
  assert.match(marks, /--at: -0ms/);
});
