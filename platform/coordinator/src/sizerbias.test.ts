// node --test src/sizerbias.test.ts (uses a throwaway DATA_DIR).
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('sizerbias');
const sizes = await import('./sizes.ts');
const bias = await import('./sizerbias.ts');
const predictions = await import('./predictions.ts');
const MIN = 60_000,
  HOUR = 60 * MIN;
const T0 = Math.floor(Date.now() / HOUR) * HOUR;
mock.timers.enable({ apis: ['Date'], now: T0 });
test.after(() => mock.timers.reset());
test.afterEach(() => h.cancelQueued());

// A done job juno sized at `gave` minutes that took `took`, a day ago.
const sizedJob = (gave: number, took: number, by = 'juno', carry?: string) => {
  const id = h.pastJob({
    title: `Paint the harbour ${gave}`,
    carry,
    run: { started: T0 - 24 * HOUR - took * MIN, ended: T0 - 24 * HOUR },
  });
  sizes.record(
    { job: id, by, agent_ms: gave * MIN, low_ms: null, high_ms: gave * MIN, refs: [], why: 'a guess', brief: 'x' },
    T0 - 25 * HOUR,
  );
  return id;
};

test('with too few sized jobs done, a given size plays as given', () => {
  for (let i = 0; i < bias.LEAST - 1; i++) sizedJob(60, 20);
  assert.deepEqual(bias.corrected(90 * MIN, 'juno'), { agent_ms: 90 * MIN, high_ms: 90 * MIN, bias: undefined });
});

test("a sizer's sizes play at what its jobs took for the time it gave", () => {
  sizedJob(60, 20);
  sizedJob(60, 40);
  // eleven jobs given 60 min: ten took 20, one 40 (together 240 of 660); four in five took a third or less, under the
  // usual, so the slow size is the usual
  const played = bias.corrected(90 * MIN, 'juno');
  assert.equal(played.agent_ms, Math.round((90 * MIN * 240) / 660 / 1000) * 1000);
  assert.equal(played.high_ms, played.agent_ms);
  assert.equal(played.bias?.own, true);
  assert.equal(played.bias?.jobs, 11);
  // a sizer with none of its own goes by every sizer's together, here juno's
  assert.equal(bias.corrected(90 * MIN, 'reel').agent_ms, played.agent_ms);
  assert.equal(bias.corrected(90 * MIN, 'reel').bias?.own, false);
});

test("the play counts a queued job's given size at its sizer's bias, the tool's as it is", async () => {
  await h.capacity({ claude: 1, codex: 1 });
  const planner = await h.start({ agent: 'juno', title: 'Planning', kind: 'chat' });
  const queued = await h.agent('job', planner.token, {
    agent: 'kit',
    title: 'Paint the harbour in spring',
    prompt: 'Paint the spring tiles',
    by: 'none',
    size: '1h30m',
    why: 'no comparable job: a guess',
  });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  const { sizes: played } = predictions.prepared(Date.now());
  assert.equal(played.usual.get(queued.body.id)?.agent_ms, bias.corrected(90 * MIN, 'juno').agent_ms);
  assert.ok(played.usual.get(queued.body.id)!.agent_ms < 90 * MIN);
  // the saved estimate stays as given
  assert.equal(sizes.latestOf(queued.body.id)?.agent_ms, 90 * MIN);
  // the CEO's re-size of work under way plays as given
  assert.ok(!Array.isArray(sizes.setSize(queued.body.id, '2h', 'it slipped', 'juno')), 'the CEO may re-size it');
  const { sizes: revised } = predictions.prepared(Date.now());
  assert.equal(revised.usual.get(queued.body.id)?.agent_ms, 2 * HOUR);
});

test('hq when plays the size it was given at the asker’s bias, and says so', async () => {
  const planner = await h.start({ agent: 'juno', title: 'Planning again', kind: 'chat' });
  const answer = await h.agent('when?q=Paint%20the%20harbour%20at%20night&size=90m&agent=kit', planner.token);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.size.given_minutes, 90);
  assert.equal(answer.body.size.agent_minutes, Math.round(bias.corrected(90 * MIN, 'juno').agent_ms / MIN));
  assert.equal(answer.body.size.bias.by, 'juno');
});

test('a job sized and done after the bias was read reaches it at the next read', () => {
  assert.equal(bias.corrected(HOUR, 'reel').bias?.own, false, "none of reel's own yet");
  // reel's own jobs, given an hour, took half
  for (let i = 0; i < bias.LEAST; i++) sizedJob(60, 30, 'reel');
  const played = bias.corrected(HOUR, 'reel');
  assert.deepEqual([played.agent_ms, played.bias?.own, played.bias?.jobs], [30 * MIN, true, bias.LEAST]);
});

test('mechanical occupancy never trains a model-agent sizer, whatever the title says', () => {
  const before = bias.corrected(HOUR, 'juno');
  for (let i = 0; i < bias.LEAST; i++) sizedJob(60, 0.5, 'juno', i.toString(16).padStart(40, '0'));
  assert.deepEqual(bias.corrected(HOUR, 'juno'), before);
});
