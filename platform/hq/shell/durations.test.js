// node --test platform/hq/shell/durations.test.js   (how long ago HQ says, in the design system's time words)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago } from '../world/clock.js';

test('ago says durations in time words', () => {
  const at = ms => new Date(Date.now() - ms).toISOString();
  assert.equal(ago(at(10_000)), 'just now');
  assert.equal(ago(''), '');
  assert.equal(ago('nonsense'), '');
  assert.doesNotMatch(ago(at(70 * 60_000)), /⅛|\.\d/);
  assert.match(ago(at(5 * 60_000)), / ago$/);
});
