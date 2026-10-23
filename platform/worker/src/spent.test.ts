// node --test src/spent.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relaunched, report, see, spentOn } from './spent.ts';

const result = (output: number) => ({
  type: 'result',
  modelUsage: { 'claude-opus': { inputTokens: 1, outputTokens: output } },
});

test("a run's token use: the last running total counts, and a second launch's adds to the first's", () => {
  const spent = spentOn('claude');
  see(spent, result(3), null, true);
  see(spent, result(5), null, true);
  assert.deepEqual(report(spent), {
    usage: {
      models: { 'claude-opus': { input: 1, cacheWrite: 0, cacheRead: 0, output: 5, cost: 0 } },
      cost: 0,
      resumed: true,
    },
    solo: true,
  });
  relaunched(spent);
  see(spent, result(2), null, true);
  assert.equal(report(spent).usage?.models['claude-opus']?.output, 7);
});
