// node --test src/roundscore.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { QueuedJob, Size } from './playtypes.ts';
import type { Kept } from './snapshots.ts';

process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/roundscore-`);
const { play } = await import('./eta.ts');
const { scoreRounds } = await import('./roundscore.ts');
const MINUTE_MS = 60_000;

function work(id: number, due: number | null = 1_000_000): QueuedJob {
  return {
    id,
    agent: 'kit',
    title: '',
    kind: 'work',
    origin: 'work',
    status: 'queued',
    engine: 'claude',
    for_seat: null,
    downtime: 0,
    created: 0,
    finished: null,
    notBefore: 0,
    seat: null,
    pr: null,
    board: 0,
    spentMs: 0,
    after: 'released',
    waitsFor: [],
    cards: [],
    wakes: [],
    due,
    review: null,
    reasons: [],
    reviewPlan: { panel: 'standard', count: 1, stages: [], terminal: null },
  };
}
function kept(at: number, jobs: QueuedJob[], agentMinutes = 20, reviewMinutes = 10): Kept {
  const sizes: [number, Size][] = jobs.map(job => [job.id, { agent_ms: agentMinutes * MINUTE_MS }]);
  for (const job of jobs)
    job.reviewPlan = {
      panel: 'one',
      count: 1,
      terminal: 'review',
      stages: [
        {
          key: 'review',
          kind: 'review',
          agent: 'reader',
          engine: 'claude',
          usualMs: reviewMinutes * MINUTE_MS,
          slowMs: reviewMinutes * MINUTE_MS,
          after: [],
        },
      ],
    };
  return {
    at,
    version: 3,
    snapshot: {
      now: at,
      planner: 3,
      jobs,
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
      room: 4,
      slots: { claude: 4 },
      rates: {},
      deployLagMs: 0,
    },
    sizes: { usual: sizes, slow: sizes },
  };
}

test('the rounds report counts each windowed job once and keeps unmerged jobs in its denominator', async () => {
  const early = kept(0, [work(1)], 20, 60);
  const late = kept(MINUTE_MS, [work(1), { ...work(2), after: 'never' }, work(3, null)], 20, 10);
  const large = kept(2 * MINUTE_MS, [work(4)], 45, 90);
  const legacy = kept(3 * MINUTE_MS, [work(5)]);
  delete legacy.snapshot.planner;
  const report = await scoreRounds([early, late, large, legacy], play);
  assert.equal(report.snapshots, 3);
  assert.equal(report.total_snapshots, 4);
  assert.deepEqual(report.groups, [
    { size: 'small', count: 2, no_merge: 1, median_minutes: 10, worst_minutes: 10 },
    { size: 'large', count: 1, no_merge: 0, median_minutes: 90, worst_minutes: 90 },
  ]);
});

test('old snapshots explicitly have no played-round sample', async () => {
  const old = kept(0, [work(1)]);
  delete old.snapshot.planner;
  const report = await scoreRounds([old], play);
  assert.equal(report.snapshots, 0);
  const { score } = await import('./backtest.ts');
  const leads = await score([old], new Map([[1, 80 * MINUTE_MS]]), play);
  assert.ok(leads.every(lead => lead.count === 0));
  assert.deepEqual(
    report.groups.map(group => [group.count, group.median_minutes, group.worst_minutes]),
    [
      [0, null, null],
      [0, null, null],
    ],
  );
});

test('the historical score uses the slow measured review run for its held time', async () => {
  const { play } = await import('./eta.ts');
  const { score } = await import('./backtest.ts');
  const job = work(1);
  const input = kept(0, [job], 10, 0);
  job.reviewPlan = {
    panel: 'one',
    count: 1,
    terminal: 'review',
    stages: [
      {
        key: 'review',
        kind: 'review',
        agent: 'reader',
        engine: 'claude',
        usualMs: 10 * MINUTE_MS,
        slowMs: 80 * MINUTE_MS,
        after: [],
      },
    ],
  };
  input.snapshot.seats = [
    {
      id: 'claude',
      engine: 'claude',
      state: 'ready',
      until: null,
      fiveHour: 0,
      fiveHourResets: null,
      week: 0,
      weekResets: null, // (no pace)
      stop: 1,
    },
  ];
  const [hour] = await score([input], new Map([[1, 80 * MINUTE_MS]]), play);
  assert.equal(hour.count, 1);
  assert.equal(hour.late_share, 1);
  assert.equal(hour.held_share, 1);
});
