// node --test src/predictionlog.test.ts   (uses a throwaway DATA_DIR): the prediction log's rows as the forecast plays,
// and hq estimate --calibration, both layers' misses: the sizes by sizer and by how the job was queued, the given sizes
// as the play counts them, the logged ETAs by lead; and the threads' work, review and waiting time.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import type { Forecast } from './forecast.ts';
import type { Outlook } from './eta.ts';

const h = await harness('predictionlog');
const predictionlog = await import('./predictionlog.ts');
const sizes = await import('./sizes.ts');

const MIN = 60_000,
  HOUR = 60 * MIN,
  DAY = 24 * HOUR;
const T0 = Math.floor(Date.now() / HOUR) * HOUR;
mock.timers.enable({ apis: ['Date'], now: T0 });
test.after(() => mock.timers.reset());

const outlook = (start: number | null, merged: number | null): Outlook => ({
  ...{ start, done: merged, merged, left_ms: 30 * MIN, waits: [], cards: [] },
});
// A play at `now` of one queued work job in the thread hq/estimates: it starts at `start` and merges at `merged`, the
// thread with it; the slow play an hour later.
function played(now: number, job: number, start: number, merged: number, version = 2): Forecast {
  const size = { agent_ms: 30 * MIN };
  const thread = {
    thread: 'hq/estimates',
    jobs: [job],
    runs: [],
    left_ms: 30 * MIN,
    eta: merged,
    held: merged + HOUR,
    finish: merged,
    deadline: null,
    aim: null,
    slack: null,
  };
  return {
    ...{ now, version },
    snapshot: {
      ...{ now, jobs: [{ id: job, kind: 'work', status: 'queued', thread: 'hq/estimates' }] as never[] },
      ...{ seats: [], rates: {}, slots: {}, deployLagMs: 0 },
    },
    sizes: { usual: new Map([[job, size]]), slow: new Map([[job, size]]) },
    sizedBy: new Map([[job, 'tool']]),
    usual: new Map([[job, outlook(start, merged)]]),
    slow: new Map([[job, outlook(start, merged + HOUR)]]),
    threads: new Map([['hq/estimates', { ...thread, waits: [], cards: [], chain: [], next: job, undrawn: [] }]]),
  };
}
// (the rows the plays kept, written first: predictionlog.write)
const logged = (job: number) => (
  predictionlog.write(),
  h.db.prepare('select * from prediction_log where job = ? order by id').all(job) as any[]
);
const threadRows = () => (
  predictionlog.write(),
  h.db.prepare("select * from prediction_log where thread = 'hq/estimates'").all() as any[]
);

test('a prediction is logged when it moves five minutes or more, or the play changes, and not for less', () => {
  const job = h.queue({ agent: 'kit', title: 'Log me', engine: 'claude' });
  const start = T0 + 10 * MIN,
    merged = T0 + 2 * HOUR;
  predictionlog.record(played(T0, job, start, merged));
  assert.equal(logged(job).length, 1);
  const threadsBefore = threadRows().length;
  predictionlog.record(played(T0 + MIN, job, start + 4 * MIN, merged + 4 * MIN));
  assert.equal(logged(job).length, 1, 'four minutes is no move');
  assert.equal(threadRows().length, threadsBefore);
  predictionlog.record(played(T0 + 2 * MIN, job, start + 4 * MIN, merged + 5 * MIN));
  assert.equal(logged(job).length, 2, 'five minutes from the last row is one');
  assert.equal(threadRows().length, threadsBefore + 1);
  predictionlog.record(played(T0 + 3 * MIN, job, start + 4 * MIN, merged + 5 * MIN, 3));
  const rows = logged(job);
  assert.equal(rows.length, 3, 'a new play version is one');
  assert.deepEqual(
    rows.map(r => [r.at, r.start, r.merged, r.held, r.agent_ms, r.sized_by, r.version]),
    [
      [T0, start, merged, merged + HOUR, 30 * MIN, 'tool', 2],
      [T0 + 2 * MIN, start + 4 * MIN, merged + 5 * MIN, merged + 5 * MIN + HOUR, 30 * MIN, 'tool', 2],
      [T0 + 3 * MIN, start + 4 * MIN, merged + 5 * MIN, merged + 5 * MIN + HOUR, 30 * MIN, 'tool', 3],
    ],
  );
  assert.deepEqual(
    threadRows().map(r => [r.job, r.start, r.merged, r.held, r.agent_ms]),
    [
      [null, null, merged, merged + HOUR, 30 * MIN],
      [null, null, merged + 5 * MIN, merged + 5 * MIN + HOUR, 30 * MIN],
      [null, null, merged + 5 * MIN, merged + 5 * MIN + HOUR, 30 * MIN],
    ],
  );
});

test("after a restart a thread's last row is one seek on the log's index, never a sort of its rows", async () => {
  const job = h.queue({ agent: 'kit', title: 'Log me after a restart', engine: 'claude' });
  const merged = T0 + 5 * HOUR;
  predictionlog.record(played(T0 + 10 * MIN, job, T0 + 20 * MIN, merged));
  const before = threadRows().length;
  // (the server started again: a module with no last rows read yet)
  const restarted = await import(`./predictionlog.ts?restart=${job}`);
  restarted.record(played(T0 + 11 * MIN, job, T0 + 20 * MIN, merged + 4 * MIN));
  restarted.write();
  assert.equal(threadRows().length, before, 'four minutes from the logged ETA is no move');
  for (const [by, sql] of Object.entries(predictionlog.LAST_ROW)) {
    const plan = h.db.prepare(`explain query plan ${sql}`).all(by === 'job' ? job : 'hq/estimates') as {
      detail: string;
    }[];
    assert.ok(
      plan.some(p => p.detail.includes(`prediction_log_${by === 'job' ? 'job' : 'thread_at'}`)),
      by,
    );
    assert.ok(!plan.some(p => p.detail.includes('TEMP B-TREE')), `${by}: ${JSON.stringify(plan)}`);
  }
});

test("a play's rows wait for the minute's write, so an outside reader of hq.db never holds the play; they move with a renamed thread", async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const regroup = await import('./regroup.ts');
  const job = h.queue({ agent: 'kit', title: 'Log me later', engine: 'claude' });
  const reader = new DatabaseSync(`${h.dataDir}/hq.db`, { readOnly: true });
  reader.exec('begin');
  reader.prepare('select count(*) from prediction_log').get(); // (its read lock, kept until the commit)
  const t = performance.now();
  predictionlog.record(played(T0 + 20 * MIN, job, T0 + 30 * MIN, T0 + 3 * HOUR));
  const ms = performance.now() - t;
  reader.exec('commit');
  reader.close();
  assert.ok(ms < 200, `record() took ${Math.round(ms)} ms`);
  assert.equal((h.db.prepare('select count(*) n from prediction_log where job = ?').get(job) as { n: number }).n, 0);
  regroup.newId('hq/estimates', 'hq/estimated', 'hq');
  const moved = h.db.prepare("select count(*) n from prediction_log where thread = 'hq/estimates'").get() as {
    n: number;
  };
  assert.equal(moved.n, 0, "the thread's kept row was written before the move, and moved");
  assert.equal(logged(job).length, 1);
  regroup.newId('hq/estimated', 'hq/estimates', 'hq');
});

test("a play's rows written in a step whose commit fails come back for the next write, and a step writes them once", async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { inOneStep } = await import('./db.ts');
  const regroup = await import('./regroup.ts');
  const job = h.queue({ agent: 'kit', title: 'Log me through a failed rename', engine: 'claude' });
  const at = T0 + 40 * MIN,
    play = played(at, job, T0 + 50 * MIN, T0 + 4 * HOUR);
  predictionlog.record(play);
  // the rename's commit turned away by an outside reader (report.sh), its writes rolled back
  const reader = new DatabaseSync(`${h.dataDir}/hq.db`, { readOnly: true });
  reader.exec('begin');
  reader.prepare('select count(*) from prediction_log').get(); // (its read lock, kept until the commit)
  try {
    assert.throws(() => regroup.newId('hq/estimates', 'hq/estimated', 'hq'), /database is locked/);
  } finally {
    reader.exec('commit');
    reader.close();
  }
  predictionlog.record(play); // (unchanged: nothing new to keep)
  assert.equal(predictionlog.ofJobs([job]).length, 1, "the job's row, written after all");
  assert.equal(predictionlog.threadAt('hq/estimates', at)?.merged, T0 + 4 * HOUR, "the thread's row, under its own id");
  // a second write in the same step (a read after regroup's) inserts nothing again
  predictionlog.record(played(at + MIN, job, T0 + 50 * MIN, T0 + 5 * HOUR));
  inOneStep(() => {
    predictionlog.write();
    predictionlog.write();
  });
  assert.equal(logged(job).length, 2);
});

test("a logged size names who gave it: the sizer's, an agent's, or the estimate tool's", async () => {
  const job = h.queue({ agent: 'kit', title: 'Size me', engine: 'claude' });
  sizes.record({
    job,
    by: 'haiku',
    agent_ms: 30 * MIN,
    low_ms: 20 * MIN,
    high_ms: 50 * MIN,
    refs: [],
    why: 'like #1',
    brief: 'b',
  });
  // (the play reads who sized each of its jobs: predictions.ts prepared.)
  const forecast = await import('./forecast.ts');
  predictionlog.record(forecast.play(T0));
  assert.equal(logged(job)[0].sized_by, 'haiku');
});

// ---- hq estimate --calibration

// A done job of `agent`'s that ran `minutes`, its pull request (changing `files`) merged at `merged`, sized at `size`
// minutes by the tool (its stored prediction) or by `by`, with any other `columns` of its row.
function done(
  agent: string,
  minutes: number,
  size: number,
  merged: number,
  files: string[],
  by = 'tool',
  columns: Record<string, unknown> = {},
) {
  const ended = merged - 30 * MIN,
    started = ended - minutes * MIN;
  const id = h.pastJob({
    agent,
    title: 'Calibrate the seats',
    created: started - HOUR,
    run: { started, ended },
    merged,
    files,
    sized: size * MIN,
    ...columns,
  });
  if (by !== 'tool')
    sizes.record(
      { job: id, by, agent_ms: size * MIN, low_ms: null, high_ms: null, refs: [], why: '', brief: 'b' },
      started - HOUR,
    );
  return id;
}

test("hq estimate --calibration splits the sizes by how the job was queued, and counts given sizes at their sizer's bias", async () => {
  // wren's sizes ran at half of what the work took: ten done the week before, then three this week, each queued another
  // way (a board call's, HQ's own, an agent's hq job)
  for (let i = 0; i < 10; i++) done('wren', 60, 30, T0 - 8 * DAY, [], 'wren');
  for (const columns of [{ call: 1 }, { queued_by: null }, {}])
    done('wren', 60, 30, T0 - 2 * HOUR, [], 'wren', columns);
  const reader = await h.start({ agent: 'bolt', title: 'Calibrating by queue' });
  const r = await h.agent('estimate/calibration', reader.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { by_queue, given_sizes, given_sizes_corrected } = r.body.sizes;
  assert.deepEqual(
    by_queue.map((g: any) => [g.key, g.count]),
    [
      ['agent', 1],
      ['call', 1],
      ['hq', 1],
    ],
  );
  assert.deepEqual([given_sizes.count, given_sizes.median_factor, given_sizes.sum_ratio], [3, 2, 0.5]);
  assert.deepEqual(
    [given_sizes_corrected.count, given_sizes_corrected.median_factor, given_sizes_corrected.sum_ratio],
    [3, 1, 1],
  );
  const { out } = await h.hq(reader, 'estimate', '--calibration');
  assert.match(out, /a board call, 1 job: the median miss ×2 either way/);
  assert.match(out, /Sizes given by agents and models, as given: 3 jobs, the median miss ×2 either way/);
  assert.match(out, /the same, as the play now counts them: the median miss ×1 either way/);
});

test('hq estimate --calibration splits the sizes by agent, area and sizer, and the ETAs by lead from the log', async () => {
  const landed = T0 - 2 * HOUR;
  // the tool sized two of kit's on the coordinator at a third and half of what they took (the lower middle: ×2); haiku one of ada's right
  const a = done('kit', 60, 20, landed, [
    'platform/coordinator/src/a.ts',
    'platform/coordinator/src/b.ts',
    'README.md',
  ]);
  done('kit', 40, 20, landed, ['platform/coordinator/src/c.ts']);
  done('ada', 30, 30, landed, ['products/carrel/app.js'], 'haiku');
  // a's ETA as logged: a day and more before it landed, an hour late; seven hours before, 20 minutes early; two
  // hours before, on time (its slow time a quarter of an hour after)
  const log = h.db.prepare(
    'insert into prediction_log (at, job, start, merged, held, agent_ms, sized_by, version) values (?, ?, null, ?, ?, 0, ?, 2)',
  );
  log.run(landed - 30 * HOUR, a, landed - HOUR, landed - HOUR, 'tool');
  log.run(landed - 7 * HOUR, a, landed + 20 * MIN, landed + 20 * MIN, 'tool');
  log.run(landed - 2 * HOUR, a, landed, landed + 15 * MIN, 'tool');
  const reader = await h.start({ agent: 'bolt', title: 'Calibrating' });
  const r = await h.agent('estimate/calibration', reader.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const group = (list: any[], key: string) => list.find(g => g.key === key);
  assert.deepEqual(
    [group(r.body.sizes.by_sizer, 'tool').count, group(r.body.sizes.by_sizer, 'tool').median_factor],
    [2, 2],
  );
  assert.deepEqual(
    [group(r.body.sizes.by_sizer, 'haiku').count, group(r.body.sizes.by_sizer, 'haiku').median_factor],
    [1, 1],
  );
  assert.equal(group(r.body.sizes.by_agent, 'kit').count, 2);
  assert.equal(group(r.body.sizes.by_area, 'platform/coordinator').count, 2);
  assert.equal(group(r.body.sizes.by_area, 'products/carrel').count, 1);
  const lead = (name: string) => r.body.eta.find((l: any) => l.lead === name);
  assert.deepEqual(
    ['an hour', 'six hours', 'a day'].map(name => [
      lead(name).count,
      lead(name).median_miss_minutes,
      lead(name).held_share,
    ]),
    [
      [1, 0, 1],
      [1, 20, 1],
      [1, 60, 0],
    ],
  );
  const { out } = await h.hq(reader, 'estimate', '--calibration');
  assert.match(out, /haiku, 1 job: the median miss ×1 either way/);
  assert.match(out, /a day ahead: 1 job, the median miss 1 h, 100% later than said, 0% by the time a promise holds to/);
});

test('hq estimate --calibration times the threads merged lately: work, review and waiting, and the hand-offs between them', async () => {
  h.clearReviewHistory();
  // hq/a: kit's task and ada's after it on kit's branch, one pull request merged after one round (a review and its
  // ruling, overlapping a quarter of an hour), 4 hours from the first task queued to the merge
  const a1 = h.pastJob({
    agent: 'kit',
    thread: 'hq/a',
    created: T0 - 10 * HOUR,
    run: { started: T0 - 10 * HOUR, ended: T0 - 9 * HOUR },
    merged: T0 - 6 * HOUR,
    pr: 9101,
    byBranch: true,
  });
  const a2 = h.pastJob({
    agent: 'ada',
    thread: 'hq/a',
    branch: `job/${a1}`,
    created: T0 - 9.5 * HOUR,
    run: { started: T0 - 9 * HOUR, ended: T0 - 8 * HOUR },
  });
  h.pastJob({
    agent: 'quill',
    kind: 'review',
    pr: 9101,
    round: 1,
    run: { started: T0 - 8 * HOUR, ended: T0 - 7.5 * HOUR },
  });
  h.pastJob({
    agent: 'juno',
    kind: 'consolidate',
    pr: 9101,
    round: 1,
    run: { started: T0 - 7.75 * HOUR, ended: T0 - 7 * HOUR },
  });
  // hq/b: wren's task queued --after ada's, waiting two hours for hq/a's review and merge, then an hour to start
  h.pastJob({
    agent: 'wren',
    thread: 'hq/b',
    after: a2,
    created: T0 - 9 * HOUR,
    run: { started: T0 - 5 * HOUR, ended: T0 - 4 * HOUR },
    merged: T0 - 2 * HOUR,
    pr: 9102,
    byBranch: true,
  });
  const reader = await h.start({ agent: 'bolt', title: 'Calibrating the threads' });
  const r = await h.agent('estimate/calibration', reader.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = r.body.threads;
  assert.deepEqual([t.count, t.one_agent, t.tasks, t.pull_requests, t.rounds, t.review_runs], [2, 1, 3, 2, 1, 2]);
  assert.deepEqual(
    [t.work, t.review, t.waiting],
    [
      { total: 180, median: 60 },
      { total: 60, median: 0 },
      { total: 420, median: 60 },
    ],
  );
  assert.deepEqual([t.review_share, t.waiting_share], [0.09, 0.64]);
  assert.deepEqual(t.handoffs, { count: 1, review: { total: 120, median: 120 }, start: { total: 60, median: 60 } });
  const { out } = await h.hq(reader, 'estimate', '--calibration');
  assert.match(out, /2 threads: 1 with one agent, 1 with two or more/);
  assert.match(out, /review 9% and waiting 64% of all thread time/);
});

test("the forecast's every play is logged, and its input kept for the backtest", async () => {
  const forecast = await import('./forecast.ts');
  await import('./snapshots.ts');
  const job = h.queue({ agent: 'kit', title: 'Played for real', engine: 'claude' });
  const f = forecast.refresh(T0 + 3 * HOUR);
  const [row] = logged(job);
  assert.deepEqual([row.at, row.merged, row.sized_by], [T0 + 3 * HOUR, f.usual.get(job)!.merged, 'tool']);
  const kept = h.db.prepare('select at from play_snapshots where at = ?').get(T0 + 3 * HOUR);
  assert.ok(kept);
});
