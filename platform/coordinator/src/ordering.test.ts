// node --test src/ordering.test.ts   (throwaway DATA_DIR and the test company): the claim's plan is kept between reads
// through a running job's own steps, and played again once HQ changes something. A kept plan still reads its waits afresh
// each time (ordering.ts eligibility).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('ordering', {
  before: repo =>
    writeFileSync(`${repo}/company/observations.yaml`, 'claim_plans:\n  id: ordering-trial\n  duration_ms: 3600000\n'),
});
const ordering = await import('./ordering.ts');
ordering.start();

test("the plan is kept through a running job's steps, and played again for a job queued", async () => {
  const job = await h.start({ agent: 'bolt' });
  const plan = ordering.current().timings;
  assert.equal((await h.agent('event', job.token, { type: 'log', text: 'Bash: npm run gates' })).status, 200);
  assert.equal(ordering.current().timings, plan, 'the same plan');
  h.queue({ agent: 'bolt' });
  assert.notEqual(ordering.current().timings, plan, 'a new plan');
});

test('the cohort distinguishes kept calls, new jobs, published HQ changes and the unchanged ten-second expiry', async t => {
  const { publish } = await import('./events.ts');
  const observation = await import('./claimobservation.ts');
  const counts = () =>
    Object.fromEntries(
      Object.entries(observation.listCohorts()[0].summary).map(([reason, summary]) => [reason, summary.count]),
    );
  ordering.current();
  const before = counts();
  const plan = ordering.current().timings;
  publish({ type: 'log', agent: 'bolt', text: 'Agent step' }, 'agent');
  publish({ type: 'status', agent: 'bolt', state: 'working' }, 'agent');
  assert.equal(ordering.current().timings, plan);
  h.queue({ agent: 'bolt' });
  const newJob = ordering.current().timings;
  assert.notEqual(newJob, plan);
  publish({ type: 'log', agent: 'bolt', text: 'HQ change' });
  const changed = ordering.current().timings;
  assert.notEqual(changed, newJob);
  publish({ type: 'status', agent: 'bolt', state: 'idle' });
  const at = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const status = ordering.current().timings;
  assert.notEqual(status, changed);
  t.mock.timers.tick(10_000);
  assert.equal(ordering.current().timings, status, 'kept at exactly ten seconds');
  t.mock.timers.tick(1);
  assert.notEqual(ordering.current().timings, status, 'fresh after ten seconds');
  const after = counts();
  assert.equal(after.kept - before.kept, 3);
  for (const reason of ['new_job', 'hq_log', 'hq_status', 'expiry'])
    assert.equal(after[reason] - before[reason], 1, reason);
  assert.ok(after.start > 0);
});

test("HQ's queue rank reads the latest plan, kept or not, and never plays one for the asking", async () => {
  const jobs = await import('./jobs.ts');
  const observation = await import('./claimobservation.ts');
  const plays = () =>
    Object.entries(observation.listCohorts()[0].summary).reduce(
      (n, [reason, s]) => n + (reason === 'kept' ? 0 : s.count),
      0,
    );
  const plan = ordering.current().timings;
  const queued = h.queue({ agent: 'bolt' });
  const before = plays();
  const [row] = jobs.jobRows('j.id = $id', Date.now(), { id: queued });
  assert.equal(typeof row.rank, 'number', 'ranked');
  assert.equal(plays(), before, 'no play for the rank');
  assert.equal(ordering.lastTimings(), plan, 'the plan played before the job was queued');
  const next = ordering.current().timings;
  assert.equal(plays(), before + 1, "the claim's read plays it");
  assert.equal(ordering.lastTimings(), next);
});

test('a kept plan still reads each claim whether a job it waits on has merged since', () => {
  const prior = h.ended({ agent: 'bolt' });
  h.storedPr(9101, prior, 'open');
  const waiter = h.queue({ agent: 'bolt', after: prior });
  const plan = ordering.current();
  assert.equal(plan.eligible(waiter), false, 'its pull request is open');
  h.mergedPr(9101);
  const next = ordering.current();
  assert.equal(next.timings, plan.timings, 'the same plan');
  assert.equal(next.eligible(waiter), true, 'merged since');
});

test("a claim's plan plays in turns of HQ's thread, and the claim's every read of it is that plan", async () => {
  h.queue({ agent: 'bolt' });
  let turns = 0;
  const count = () => {
    turns++;
    if (turns < 1000) setImmediate(count);
  };
  setImmediate(count);
  let turnsBefore = 0;
  const [claim, other] = await Promise.all([
    ordering.withPlan(() => ((turnsBefore = turns), [ordering.current().timings, ordering.current().timings])),
    ordering.withPlan(() => ordering.current().timings),
  ]);
  turns = 1000;
  assert.ok(turnsBefore > 1, 'HQ had turns while it played');
  assert.equal(claim[0], claim[1], 'one plan for the whole claim');
  assert.equal(other, claim[0], 'a claim asking meanwhile waits for the same play');
  assert.equal(ordering.current().timings, claim[0], 'and the plan is kept');
});

test('a job queued or a change published while the plan plays in turns plays it again', async () => {
  const { publish } = await import('./events.ts');
  h.queue({ agent: 'bolt' });
  let queued = 0;
  setImmediate(() => (queued = h.queue({ agent: 'bolt' })));
  const timings = await ordering.withPlan(() => ordering.current().timings);
  assert.ok(queued > 0 && timings.has(queued), 'the job queued meanwhile is in the plan');
  h.queue({ agent: 'bolt' });
  let published = false;
  setImmediate(() => {
    publish({ type: 'log', agent: 'bolt', text: 'HQ change' });
    published = true;
  });
  const played = await ordering.withPlan(() => {
    assert.ok(published, 'published while it played');
    return ordering.current().timings;
  });
  assert.equal(ordering.current().timings, played, 'played again after the change, and kept');
});

test("a wait added while the claim's plan plays in turns holds its job back in the claim's step", async () => {
  const { publish } = await import('./events.ts');
  const jobs = await import('./jobs.ts');
  const [waiter, prior] = [h.queue({ agent: 'bolt' }), h.queue({ agent: 'bolt' })];
  // (two turns of HQ's thread in: the play has placed its queue's waits by then)
  setImmediate(() => setImmediate(() => jobs.holdForMerge(waiter, prior, 'bolt')));
  assert.equal(await ordering.withPlan(() => ordering.current().eligible(waiter)), false, 'it waits for the merge');
  // HQ changing something at every turn: the plays in turns are overtaken, and the step plays its own
  const [other, next] = [h.queue({ agent: 'bolt' }), h.queue({ agent: 'bolt' })];
  let changing = true;
  const change = () => {
    publish({ type: 'log', agent: 'bolt', text: 'HQ change' });
    if (changing) setImmediate(change);
  };
  setImmediate(() => (jobs.holdForMerge(other, next, 'bolt'), change()));
  const eligible = await ordering.withPlan(() => ((changing = false), ordering.current().eligible(other)));
  assert.equal(eligible, false, 'it waits for the merge too');
});
