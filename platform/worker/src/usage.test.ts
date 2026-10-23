// node --test src/usage.test.ts
// The events are what the real CLIs printed against a scripted model (Claude Code 2.1.283, codex-cli 0.157.1), trimmed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumUsage, usageOf } from './usage.ts';

test("Claude's result: tokens and price per model, and the total price", () => {
  const result = { type: 'result', subtype: 'success', result: 'reply 0', total_cost_usd: 0.00612,
    usage: { input_tokens: 1000, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 50 },
    modelUsage: {
      'claude-sonnet-5': { inputTokens: 2000, outputTokens: 100, thinkingTokens: 0, cacheReadInputTokens: 600,
        cacheCreationInputTokens: 400, webSearchRequests: 0, costUSD: 0.00612, contextWindow: 200000 },
      'claude-haiku-4-5-20251001': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.00004 } } };
  assert.deepEqual(usageOf(result), { cost: 0.00612, models: {
    'claude-sonnet-5': { input: 2000, cacheWrite: 400, cacheRead: 600, output: 100, cost: 0.00612 },
    'claude-haiku-4-5-20251001': { input: 10, cacheWrite: 0, cacheRead: 0, output: 5, cost: 0.00004 } } });
});

test("Codex's turn.completed: input without the cached part, under the model the job runs on", () => {
  const e = { type: 'turn.completed', usage: { input_tokens: 2000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 40 } };
  assert.deepEqual(usageOf(e, 'gpt-5.5'), { models: { 'gpt-5.5': { input: 1400, cacheWrite: 0, cacheRead: 600, output: 100 } } });
  assert.deepEqual(Object.keys(usageOf(e)!.models), ['codex']);   // no model set: Codex's own default
});

test('other events, text and odd numbers carry nothing', () => {
  for (const e of [{ type: 'assistant', message: { usage: { input_tokens: 5 } } }, { type: 'result', result: 'no figures' },
    { type: 'turn.completed' }, { type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }, null])
    assert.equal(usageOf(e), undefined);
  const odd = usageOf({ type: 'result', total_cost_usd: -1, modelUsage: { m: { inputTokens: 'lots', outputTokens: Infinity, costUSD: null } } });
  assert.deepEqual(odd, { cost: 0, models: { m: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0 } } });
});

test('two sessions in one run: their totals add up per model, a model only one used kept as it is', () => {
  const t = (n: number, cost?: number) => ({ input: n, cacheWrite: n, cacheRead: n, output: n, ...(cost === undefined ? {} : { cost }) });
  assert.deepEqual(sumUsage({ models: { a: t(1, 0.5), b: t(2) }, cost: 0.5 }, { models: { a: t(3, 0.25), c: t(4) }, cost: 0.25 }),
    { models: { a: t(4, 0.75), b: t(2), c: t(4) }, cost: 0.75 });
  assert.deepEqual(sumUsage({ models: { b: t(2) } }, { models: { b: t(1) } }), { models: { b: { ...t(3), cost: undefined } }, cost: undefined });
});
