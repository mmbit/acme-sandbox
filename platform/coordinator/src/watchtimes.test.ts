// node --test src/watchtimes.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeZone } from './company.ts';
import { when } from './watchtimes.ts';

const NOW = Date.UTC(2026, 9, 29, 9, 30, 0);
// the page's clock 2 s behind the server's
const watch = { moments: { list: [{ n: 3, at: 1_000, kind: 'tap' as const, words: 'tapped "Pay"' }] }, clockMs: 2_000 };
// A time on the company's clock as an agent types it
const clockAt = (ms: number) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: timeZone(), timeStyle: 'medium', hourCycle: 'h23' }).format(ms);

test("a time asked for in words is a time on the page's clock: some time ago, a moment's, or a time of day", () => {
  assert.equal(when('-20s', watch, NOW), NOW - 20_000 - 2_000);
  assert.equal(when('-2m', watch, NOW), NOW - 120_000 - 2_000);
  assert.equal(when('#3', watch, NOW), 1_000);
  assert.equal(when('#4', watch, NOW), undefined, 'a moment there is none of');
  assert.equal(when(clockAt(NOW - 10_000), watch, NOW), NOW - 10_000 - 2_000, "today's");
  assert.equal(when(clockAt(NOW - 10_000).slice(0, 5), watch, NOW), NOW - 60_000 - 2_000, 'to the minute');
  assert.equal(when(clockAt(NOW + 5 * 60_000), watch, NOW), NOW + 5 * 60_000 - 86_400_000 - 2_000, 'later: yesterday');
  for (const spec of ['soon', '25:00', '12:60', '-5h', '#x']) assert.equal(when(spec, watch, NOW), undefined, spec);
});
