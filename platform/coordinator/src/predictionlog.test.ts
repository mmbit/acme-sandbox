// node --test src/predictionlog.test.ts   (uses a throwaway DATA_DIR): the prediction log's rows as the forecast plays,
// and hq estimate --calibration, both layers' misses: the sizes by sizer, the logged ETAs by lead.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import type { Forecast } from './forecast.ts';
import type { Outlook } from './eta.ts';

const h = await harness('predictionlog');
const predictionlog = await import('./predictionlog.ts');
const sizes = await import('./sizes.ts');

const MIN = 60_000,
  HOUR = 60 * MIN;
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
const logged = (job: number) =>
  h.db.prepare('select * from prediction_log where job = ? order by id').all(job) as any[];
const threadRows = () => h.db.prepare("select * from prediction_log where thread = 'hq/estimates'").all() as any[];

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
// minutes by the tool (its stored prediction) or by `by`.
function done(agent: string, minutes: number, size: number, merged: number, files: string[], by = 'tool') {
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
  });
  if (by !== 'tool')
    sizes.record({ job: id, by, agent_ms: size * MIN, low_ms: null, high_ms: null, refs: [], why: '', brief: 'b' });
  return id;
}

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
