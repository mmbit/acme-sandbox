// node --test src/carrysizes.test.ts (throwaway DATA_DIR): carry evidence at estimate, calibration and plan boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('carrysizes');
const predictions = await import('./predictions.ts');
const matching = await import('./matching.ts');
const sizes = await import('./sizes.ts');
const { play } = await import('./eta.ts');
const MINUTE = 60_000;
const T = Date.now();
const sha = (n: number) => n.toString(16).padStart(40, '0');
const reader = await h.start({ agent: 'bolt', title: 'Compare execution evidence', kind: 'chat' });
const ask = async (query: string) => {
  const response = await h.agent(`estimate?${new URLSearchParams({ q: query })}`, reader.token);
  assert.equal(response.status, 200);
  return response.body;
};
const history = (title: string, minutes: number, carry?: string) =>
  h.pastJob({
    agent: 'kit',
    title,
    queued_by: null,
    carry,
    created: T - 180 * MINUTE,
    run: { started: T - 120 * MINUTE, ended: T - (120 - minutes) * MINUTE },
    sized: minutes * MINUTE * (carry ? 2 : 1),
  });

test('carry comparisons ignore title and keeper while engineering sizes retain their own evidence', async () => {
  const engineering = [40, 60, 80].map(minutes => history('Repair the gates and tests on main', minutes));
  const original = predictions.predict({ title: 'Repair the gates and tests on main', origin: 'hq', agent: 'kit' });
  const carries = [
    history('A foundation arrival', 0.3, sha(1)),
    history('Run the suite', 0.5, sha(2)),
    history('The gates and tests on main', 0.7, sha(3)),
  ];
  const missing = h.pastJob({ title: 'No carry measurement', carry: sha(4), finished: T - MINUTE });
  h.pastJob({
    title: 'Rebuilt carry measurement',
    carry: sha(5),
    run: {
      started: T - 2 * MINUTE,
      ended: T - MINUTE,
      seat: null,
      outcome: 'rebuilt',
    },
  });
  for (const [index, title] of ['Unrelated words', 'Repair the gates and tests on main'].entries()) {
    const id = h.queue({ agent: index ? 'lark' : 'kit', title, carry: sha(10 + index), engine: 'claude' });
    const found = await ask(`#${id}`);
    assert.equal(found.estimate.origin, 'carry');
    assert.equal(found.estimate.agent_minutes, 0.5);
    for (const [actual, expected] of [
      [found.typical.agent_minutes, 0.5],
      [found.typical.low, 0.3],
      [found.typical.high, 0.5],
    ])
      assert.ok(Math.abs(actual - expected) < 0.001);
    assert.deepEqual(found.jobs.map((j: any) => j.id).sort(), [...carries].sort());
    assert.ok(found.jobs.every((j: any) => j.origin === 'carry' && j.agent_minutes > 0));
    assert.ok(!found.jobs.some((j: any) => j.id === missing));
    assert.equal(predictions.stored(id)!.size.agent_ms, 30_000);
    const cli = await h.hq(reader, 'estimate', `#${id}`);
    assert.equal(cli.code, 0, cli.out);
    assert.match(
      cli.out,
      /Typical work split of these: 30 sec of worker occupancy \(the middle half 18 sec to 30 sec\)/,
    );
  }
  const repair = h.queue({ agent: 'kit', title: 'Repair the gates and tests on main', engine: 'claude' });
  const found = await ask(`#${repair}`);
  assert.equal(found.estimate.origin, 'hq');
  assert.equal(predictions.stored(repair)!.size.agent_ms, original.size.agent_ms);
  assert.deepEqual(found.jobs.map((j: any) => j.id).sort(), engineering.sort());
  assert.equal(typeof sizes.readQueuedSize({ size: '1m', refs: carries, why: 'Repair work' }), 'string');
  const pool = matching.pastJobs();
  assert.deepEqual(
    matching.picksFor(
      { title: 'gates', origin: 'carry' },
      pool.filter(j => j.origin !== 'carry'),
    ).picks,
    [],
  );
  assert.deepEqual(
    matching.picksFor(
      { title: 'gates', origin: 'work' },
      pool.filter(j => j.origin === 'carry'),
    ).picks,
    [],
  );
});

test('the plan keeps measured worker occupancy and frees its slot without inventing review rounds', async () => {
  const prepared = predictions.prepared(T);
  const checks = prepared.snapshot.jobs.filter(j => j.origin === 'carry');
  assert.equal(checks.length, 2);
  for (const job of checks) {
    assert.equal(prepared.sizes.usual.get(job.id)!.agent_ms, 30_000);
    assert.equal(job.opensReview, false);
    assert.equal(job.reviewPlan, undefined);
  }
  const snapshot = {
    ...prepared.snapshot,
    jobs: checks,
    pacing: false,
    slots: { claude: 1 },
    memory: undefined,
    seatRuns: { claude: 1 },
    room: 1,
    seats: [
      {
        id: 'claude-a',
        engine: 'claude',
        state: 'ready',
        until: null,
        fiveHour: 0,
        fiveHourResets: null,
        week: 0,
        weekResets: null,
        stop: 0.9,
      },
    ],
  };
  const played = play(snapshot, prepared.sizes.usual);
  const first = played.get(checks[0].id)!;
  const second = played.get(checks[1].id)!;
  assert.deepEqual([first.start, first.done, first.merged], [T, T + 30_000, T + 30_000]);
  assert.deepEqual([second.start, second.done, second.merged], [T + 30_000, T + 60_000, T + 60_000]);
});

test('weekly scores retain carry occupancy separately and never rewrite saved estimates or runs', async () => {
  const saved = () => ({
    predictions: h.db.prepare('select * from predictions order by job').all(),
    runs: h.db.prepare('select * from runs order by id').all(),
  });
  const before = saved();
  for (const mode of ['accuracy', 'calibration']) {
    const response = await h.agent(`estimate/${mode}?days=1`, reader.token);
    assert.equal(response.status, 200);
    const report = response.body;
    assert.equal(report.tasks.work_size.count, 3);
    assert.equal(report.tasks.carry_checks.count, 3);
    assert.equal(report.tasks.carry_checks.sum_ratio, 2);
    assert.equal(report.tasks.carry_checks.median_factor, 2);
    const carry = report.tasks.rows.find((j: any) => j.origin === 'carry' && !j.timing_quality.length);
    assert.ok(carry.actual_work_ms > 0 && carry.actual_work_ms < MINUTE);
    assert.equal(carry.whole.split.reviews, 0);
    assert.equal(report.tasks.coverage.missing_runs, 1);
    const missing = report.tasks.rows.find((j: any) => j.timing_quality.includes('missing_runs'));
    assert.equal(missing.actual_work_ms, null);
    assert.equal(missing.work_miss_minutes, null);
    if (mode === 'accuracy') {
      assert.equal(report.agent_time.count, 3);
      assert.equal(report.carry_checks.count, 3);
      assert.ok(report.carry_checks.worst.every((job: any) => job.actual_minutes > 0));
    } else {
      assert.equal(report.sizes.count, 3);
      assert.equal(report.sizes.carry_checks.count, 3);
    }
    const cli = await h.hq(reader, 'estimate', `--${mode}`, '--days', '1');
    assert.equal(cli.code, 0, cli.out);
    assert.match(cli.out, /Mechanical carry checks, worker occupancy: 3/);
  }
  assert.deepEqual(saved(), before);
});

test('old cross-mode references remain in saved history without becoming current carry comparisons', async () => {
  const engineering = matching.pastJobs().find(job => job.origin === 'hq')!;
  const id = h.queue({ agent: 'kit', title: 'Previously sized carry check', carry: sha(20), engine: 'claude' });
  sizes.recordQueued(id, 'juno', 'The original scope', {
    agent_ms: 60 * MINUTE,
    refs: [engineering.id],
    why: 'Historical comparison',
  });
  const saved = sizes.history(id);
  const found = await ask(`#${id}`);
  assert.deepEqual(found.jobs, []);
  assert.equal(found.estimate.agent_minutes, 60);
  assert.deepEqual(found.sizes[0].refs, [engineering.id]);
  assert.deepEqual(sizes.history(id), saved);
});
