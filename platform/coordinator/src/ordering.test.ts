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
