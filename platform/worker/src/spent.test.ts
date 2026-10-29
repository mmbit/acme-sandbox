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

// Claude Code's stream: one assistant event per content block, sharing the message's id and usage.
const said = (id: string, usage: Record<string, number>, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { id, usage: { output_tokens: 7, ...usage } },
});

test("a run's opening context and turns: the main thread's first message, and its messages counted once each", () => {
  const spent = spentOn('claude');
  const opening = { input_tokens: 3, cache_creation_input_tokens: 40_000, cache_read_input_tokens: 12_000 };
  see(spent, said('m1', opening), null, true);
  see(spent, said('m1', opening), null, true); // the same message's next content block
  see(spent, said('h1', { input_tokens: 90_000 }, 'toolu_1'), null, true); // a team member's: not the main thread
  see(spent, said('m2', { input_tokens: 1, cache_read_input_tokens: 52_000 }), null, true);
  see(spent, result(5), null, true);
  assert.deepEqual(report(spent).usage, {
    models: { 'claude-opus': { input: 1, cacheWrite: 0, cacheRead: 0, output: 5, cost: 0 } },
    cost: 0,
    opening: 52_003,
    openingWritten: 40_000,
    turns: 2,
    resumed: true,
  });
  relaunched(spent);
  see(spent, said('a1', { input_tokens: 500 }), null, true);
  see(spent, result(2), null, true);
  assert.deepEqual([report(spent).usage?.opening, report(spent).usage?.turns], [52_003, 3]);
});

test('Codex: no opening or turns, only its token use', () => {
  const spent = spentOn('codex');
  see(
    spent,
    { type: 'turn.completed', usage: { input_tokens: 900, cached_input_tokens: 600, output_tokens: 10 } },
    'gpt-5.5',
    false,
  );
  assert.deepEqual(report(spent).usage, {
    models: { 'gpt-5.5': { input: 300, cacheWrite: 0, cacheRead: 600, output: 10 } },
    resumed: false,
  });
});

test("a run's last reply on its main thread, as it came: not a member's, nor one read again", () => {
  const spent = spentOn('claude');
  see(spent, said('m1', { input_tokens: 3 }), null, false, 1000);
  see(spent, said('h1', { input_tokens: 3 }, 'toolu_1'), null, false, 2000); // a team member's
  see(spent, said('m2', { input_tokens: 3 }), null, false); // read again by a worker that took the run over
  see(spent, result(5), null, false, 3000);
  assert.equal(report(spent).usage?.lastTurn, 1000);
  const codex = spentOn('codex');
  see(codex, { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }, 'gpt-5.5', false, 4000);
  see(codex, { type: 'turn.completed', usage: { input_tokens: 9, output_tokens: 1 } }, 'gpt-5.5', false, 5000);
  assert.equal(report(codex).usage?.lastTurn, 4000);
});
