// node --test src/backtest.test.ts   (uses a throwaway DATA_DIR): the play's input kept hourly and at each new thread,
// pruned after 30 days, and hq estimate --backtest: the play replayed on it and scored against what landed.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { harness } from './harness.ts';
import type { Forecast } from './forecast.ts';
import type { QueuedJob } from './eta.ts';

const h = await harness('backtest');
const snapshots = await import('./snapshots.ts');

const MIN = 60_000,
  HOUR = 60 * MIN,
  DAY = 24 * HOUR;
const T0 = Math.floor(Date.now() / HOUR) * HOUR;
mock.timers.enable({ apis: ['Date'], now: T0 });
test.after(() => mock.timers.reset());

// A work job that landed: done, its pull request merged at `landed`.
const landedAt = (landed: number) => h.pastJob({ created: landed - DAY, finished: landed - 10 * MIN, merged: landed });

// The queue at `now` as the forecast played it: the job queued, an hour of agent time (an hour and a half at the slow
// pace) and no review, on one free Claude seat; its thread among the threads with open work.
function forecastAt(now: number, job: number, threads = ['hq/estimates']): Forecast {
  const queued: QueuedJob = {
    ...{ id: job, agent: 'kit', title: 'Paint the harbour', kind: 'work', origin: 'work', status: 'queued' },
    ...{ engine: 'claude', for_seat: null, downtime: 0, created: now, finished: null },
    ...{
      notBefore: 0,
      seat: null,
      pr: null,
      board: 0,
      spentMs: 0,
      after: 'released',
      waitsFor: [],
      cards: [],
      wakes: [],
    },
    ...{ due: null, review: null, reasons: [], thread: threads[0] },
  };
  const outlook = { start: now, done: null, merged: null, left_ms: 0, waits: [], cards: [] };
  return {
    ...{ now, version: 3 },
    snapshot: {
      now,
      planner: 3,
      jobs: [queued],
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
          stop: 1,
        },
      ],
      rates: {},
      slots: { claude: 1 },
      room: 1,
      deployLagMs: 0,
    },
    sizes: {
      usual: new Map([[job, { agent_ms: HOUR }]]),
      slow: new Map([[job, { agent_ms: 1.5 * HOUR }]]),
    },
    sizedBy: new Map([[job, 'tool']]),
    ...{ usual: new Map([[job, outlook]]), slow: new Map([[job, outlook]]) },
    threads: new Map(threads.map(t => [t, { thread: t } as never])),
  };
}
const kept = () => (h.db.prepare('select at from play_snapshots order by at').all() as { at: number }[]).map(r => r.at);

test('the backtest replays the play on two kept snapshots and scores each lead against the landing', async () => {
  const landed = T0 - HOUR;
  const job = landedAt(landed);
  // six and a half hours before it landed the play said 5 h 30 min too soon, and the slow time didn't hold; 70 minutes
  // before, 10 minutes too soon, and the slow time (20 minutes after the landing) held
  const early = landed - 6.5 * HOUR,
    late = landed - 70 * MIN;
  snapshots.keep(forecastAt(early, job));
  snapshots.keep(forecastAt(late, job));
  assert.deepEqual(kept(), [early, late]);
  const reader = await h.start({ agent: 'bolt', title: 'Backtesting' });
  const r = await h.agent('estimate/backtest', reader.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.snapshots, 2);
  assert.deepEqual(
    r.body.leads.map((l: any) => [l.lead, l.count, l.median_miss_minutes, l.late_share, l.held_share]),
    [
      ['an hour', 1, 10, 1, 1],
      ['six hours', 1, 330, 1, 0],
      ['a day', 0, null, null, null],
    ],
  );
  const { out } = await h.hq(reader, 'estimate', '--backtest');
  assert.match(out, /replayed on 2 snapshots of the last 7 days/);
  assert.match(out, /an hour ahead: 1 job, the median miss 10 min, 100% later than said, 100% by the time a promise/);
  const file = `${mkdtempSync(`${tmpdir()}/saved-`)}/saved.json`;
  const saved = await h.hq(reader, 'estimate', '--backtest', '--save', file);
  assert.equal(saved.code, 0, saved.out);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(
    [written.snapshots.map((s: any) => s.snapshot.now), written.landed],
    [[early, late], [[job, landed]]],
  );
});

test('a snapshot is kept hourly and at a thread none had, and kept 30 days', () => {
  h.db.exec('delete from play_snapshots');
  const job = h.queue({ agent: 'kit', title: 'Kept', engine: 'claude' });
  const from = T0 + DAY;
  snapshots.keep(forecastAt(from, job));
  snapshots.keep(forecastAt(from + 30 * MIN, job));
  assert.deepEqual(kept(), [from], 'within the hour, nothing new');
  snapshots.keep(forecastAt(from + 40 * MIN, job, ['hq/estimates', 'hq/projects']));
  snapshots.keep(forecastAt(from + 60 * MIN, job, ['hq/estimates', 'hq/projects']));
  assert.deepEqual(kept(), [from, from + 40 * MIN], 'a new thread is kept at once, then hourly');
  snapshots.keep(forecastAt(from + 100 * MIN, job));
  assert.deepEqual(kept(), [from, from + 40 * MIN, from + 100 * MIN]);
  snapshots.keep(forecastAt(from + 30 * DAY + 50 * MIN, job));
  assert.deepEqual(kept(), [from + 100 * MIN, from + 30 * DAY + 50 * MIN], 'older than 30 days, gone');
});

test('kept snapshots omit titles without changing the play or the live forecast', async () => {
  const f = forecastAt(T0 + 40 * DAY, 999, ['hq/title-free']);
  snapshots.keep(f);
  const saved = (await snapshots.listSince(f.now))[0].read();
  assert.equal(saved.snapshot.jobs[0].title, '');
  assert.equal(f.snapshot.jobs[0].title, 'Paint the harbour');
  const { play } = await import('./eta.ts');
  assert.deepEqual(play(saved.snapshot, new Map(saved.sizes.usual)), play(f.snapshot, f.sizes.usual));
});

test('a snapshot pruned while a backtest runs is still played: the request keeps the rows it listed', async () => {
  h.db.exec('delete from play_snapshots');
  const landed = T0 + 45 * DAY;
  const job = landedAt(landed);
  snapshots.keep(forecastAt(landed - 70 * MIN, job));
  const listed = await snapshots.listSince(landed - DAY);
  // (as keep() prunes those past KEEP_DAYS while the request waits for its next turn)
  h.db.exec('delete from play_snapshots');
  const { score } = await import('./backtest.ts');
  const { play } = await import('./eta.ts');
  const [hour] = await score(listed, new Map([[job, landed]]), play);
  assert.equal(hour.count, 1);
  assert.deepEqual(JSON.parse(listed[0].json().toString()), listed[0].read());
});
