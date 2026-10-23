// node --test src/claimobservation.test.ts (throwaway DATA_DIR and company).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('claim-observation', {
  env: { GIT_COMMIT: 'observation-revision' },
  before: repo =>
    writeFileSync(`${repo}/company/observations.yaml`, 'claim_plans:\n  id: trial\n  duration_ms: 1000\n'),
});
const observation = await import('./claimobservation.ts');

test('the agent read includes every sample, strict 100 ms failures and CPU, then freezes at its stated boundary', async t => {
  const job = await h.start({ agent: 'bolt' });
  const read = async () => {
    const reply = await h.agent('claim-plans', job.token);
    assert.equal(reply.status, 200);
    return reply.body.cohorts[0];
  };
  const at = Date.now();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: at });
  observation.start();
  let wall = 0;
  t.mock.method(performance, 'now', () => wall);
  for (const ms of [99.99, 100, 299, 300]) {
    const started = observation.begin();
    wall += ms;
    observation.record(started, 'new_job');
  }
  const kept = observation.begin();
  wall += 0.5;
  observation.record(kept, 'kept');
  const failed = observation.begin();
  wall += 20;
  observation.record(failed, 'hq_log', true);
  const collecting = await read();
  assert.equal(collecting.revision, 'observation-revision');
  assert.equal(collecting.coverage, 'incomplete interval');
  assert.equal(collecting.dropped, null);
  assert.deepEqual([collecting.started_at, collecting.ends_at], [at, at + 1000]);
  assert.equal(collecting.summary.new_job.count, 4);
  assert.equal(collecting.summary.new_job.failures, 3);
  assert.equal(collecting.summary.new_job.under300, 3);
  assert.equal(collecting.summary.new_job.failures_under300, 2);
  assert.equal(collecting.fresh.count, 5);
  assert.equal(collecting.fresh.failures, 3);
  assert.equal(collecting.fresh.errors, 1);
  assert.equal(collecting.kept.count, 1);
  assert.equal(collecting.summary.new_job.max_ms, 300);
  assert.equal(collecting.summary.new_job.wall_ms, 798.99);
  assert.equal(collecting.summary.kept.count, 1);
  assert.equal(collecting.summary.hq_log.errors, 1);
  assert.ok(collecting.summary.new_job.cpu_user_ms >= 0);
  assert.ok(collecting.summary.new_job.cpu_system_ms >= 0);
  assert.ok(collecting.summary.new_job.cpu_max_ms >= 0);
  assert.deepEqual(collecting.missing_fresh_reasons, ['start', 'hq_status', 'expiry']);
  // A play entering before the boundary is included even if it completes after it.
  t.mock.timers.tick(999);
  const crossing = observation.begin();
  t.mock.timers.setTime(at + 1001);
  wall += 150;
  observation.record(crossing, 'expiry');
  assert.equal(observation.begin(), undefined);
  t.mock.timers.tick(1);
  const complete = await read();
  assert.equal(complete.state, 'complete');
  assert.equal(complete.dropped, 0);
  assert.equal(complete.summary.expiry.count, 1);
  observation.start();
  t.mock.timers.tick(5000);
  assert.equal(observation.begin(), undefined);
  assert.deepEqual(await read(), complete, 'the same id never starts again');
});

test('a new process interrupts the same id without extending its boundary or mixing deployed revisions', async () => {
  writeFileSync(`${h.repo}/company/observations.yaml`, 'claim_plans:\n  id: restart-trial\n  duration_ms: 3600000\n');
  const modulePath = new URL('./claimobservation.ts', import.meta.url).href;
  const run = (revision: string) =>
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const observation = await import(${JSON.stringify(modulePath)}); observation.start();`,
      ],
      { env: { ...process.env, GIT_COMMIT: revision }, encoding: 'utf8' },
    );
  run('first-revision');
  const before = observation.listCohorts().find(cohort => cohort.id === 'restart-trial')!;
  assert.equal(before.state, 'collecting');
  run('later-revision');
  const after = observation.listCohorts().find(cohort => cohort.id === 'restart-trial')!;
  assert.equal(after.state, 'interrupted');
  assert.equal(after.revision, 'first-revision');
  assert.equal(after.started_at, before.started_at);
  assert.equal(after.ends_at, before.ends_at);
  assert.equal(after.dropped, null);
  assert.equal(after.coverage, 'incomplete interval');
  assert.equal(after.summary.new_job.max_ms, null, 'an absent cohort has no maximum');
});

test('the boundary timer persists samples and completes after a boundary call is rolled back', async t => {
  writeFileSync(`${h.repo}/company/observations.yaml`, 'claim_plans:\n  id: idle-trial\n  duration_ms: 1000\n');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  observation.start();
  const { inOneStep } = await import('./db.ts');
  inOneStep(() => observation.record(observation.begin(), 'start'), { keep: false });
  const cohort = () => observation.listCohorts().find(cohort => cohort.id === 'idle-trial')!;
  assert.equal(cohort().fresh.count, 0, 'the transaction rolled back its observation write');
  t.mock.timers.setTime(cohort().ends_at);
  inOneStep(() => observation.begin(), { keep: false });
  t.mock.timers.tick(1000);
  assert.equal(cohort().state, 'complete', 'no later claim was needed');
  assert.equal(cohort().fresh.count, 1, 'the final summary includes the real play in that trial');
  assert.equal(cohort().dropped, 0);
  assert.equal(observation.begin(), undefined);
});

test('sample and final write failures propagate without discarding the active cohort', async t => {
  writeFileSync(
    `${h.repo}/company/observations.yaml`,
    'claim_plans:\n  id: write-failure-trial\n  duration_ms: 1000\n',
  );
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  observation.start();
  const { db } = await import('./db.ts');
  const cohort = () => observation.listCohorts().find(cohort => cohort.id === 'write-failure-trial')!;
  db.exec('pragma query_only = on');
  try {
    assert.throws(() => observation.record(observation.begin(), 'start'), { code: 'ERR_SQLITE_ERROR' });
    assert.equal(cohort().fresh.count, 0);
    assert.throws(() => t.mock.timers.tick(1000), { code: 'ERR_SQLITE_ERROR' });
    assert.equal(cohort().state, 'collecting');
    assert.equal(cohort().dropped, null);
  } finally {
    db.exec('pragma query_only = off');
  }
  observation.start();
  assert.equal(
    cohort().state,
    'collecting',
    'the failed final write retained active instead of reopening its stored row',
  );
});
