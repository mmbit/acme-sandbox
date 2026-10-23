// node --test platform/hq/renderers/wire/pace.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pace, BARS } from './pace.js';

const MIN = 60_000,
  NOW = Date.parse('2026-10-13T12:00:00Z');

test('a job two minutes in fills every bar, over those two minutes', () => {
  const readings = Array.from({ length: 13 }, (_, i) => [NOW - 2 * MIN + i * 10_000, i * 100]);
  const p = pace(readings, NOW - 2 * MIN, NOW);
  assert.equal(p.bars.length, BARS);
  assert.ok(
    p.bars.every(n => n === 100),
    JSON.stringify(p.bars),
  );
  assert.equal(p.perMinute, 600);
});

test('a long job shows its last quarter of an hour, and nothing before its first reading counts', () => {
  const p = pace(
    [
      [NOW - 5 * MIN, 9000],
      [NOW - 30_000, 9600],
    ],
    NOW - 60 * MIN,
    NOW,
  );
  assert.equal(
    p.bars.reduce((a, b) => a + b, 0),
    600,
  );
  assert.equal(p.perMinute, 40); // (600 over the quarter of an hour shown)
  assert.equal(pace([], NOW - MIN, NOW), null);
});
