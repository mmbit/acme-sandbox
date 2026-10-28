// Measured review and consolidation durations used by the queue's play.
import { prepared } from './db.ts';
import { fitIn, mean } from './arithmetic.ts';

const MINUTE_MS = 60_000,
  WEEK_MS = 7 * 24 * 60 * MINUTE_MS;
const iso = (ms: number) => new Date(ms).toISOString();

// A review run's or check's time, by its kind, over the last week (those done: one cut by a limit isn't a review's
// length): usual, the mean; slow, the time four in five fit in (as a work job's slow size: predictions.ts). A first guess
// where its kind has none.
const LOOP_GUESS_MS = 15 * MINUTE_MS;
export const SLOW_SHARE = 0.8;
export function loopSizes(now: number) {
  // (the week's runs: one that started in the week ended in it)
  const runs = weekOfReviews(now)
    .filter(job => (job.kind === 'review' || job.kind === 'consolidate') && job.week_ms !== null)
    .map(job => ({ kind: job.kind, ms: job.week_ms! }));
  const sizes = new Map(
    [...Map.groupBy(runs, run => run.kind)].map(([kind, runs]) => {
      const ms = runs.map(run => run.ms);
      return [kind, { usual: mean(ms)!, slow: fitIn(ms, SLOW_SHARE)! }] as const;
    }),
  );
  return (kind: string, pace: Pace) => sizes.get(kind)?.[pace] ?? LOOP_GUESS_MS;
}
// The usual sizes, or the slow ones a time told should hold to.
export type Pace = 'usual' | 'slow';

// The done review, consolidation and fix jobs with a run that ended in the week before `now`, one row each. `ms` sums
// those runs' time, and `week_ms` only the ones that also started in the week (null when none did). `measuredKind` is
// the kind the review plan sizes it by: a triage stage counts as 'triage'. `running` says one of its runs hasn't ended.
// loopSizes and the review plan's measured sizes (reviewplan.ts records) both read it in every play, so it's kept for
// the same `now` while the database is unchanged (total_changes for this connection's writes, data_version for
// another's).
// (runs first, by their end, then their jobs; jobs_review_runs covers the jobs columns to skip wide job rows: db.ts.)
export type ReviewWeek = {
  id: number;
  kind: string;
  measuredKind: string;
  engine: string;
  running: number;
  ms: number;
  week_ms: number | null;
};
let week: { key: string; jobs: ReviewWeek[] } | undefined;
export function weekOfReviews(now: number) {
  const { changes, version } = prepared(
    'select total_changes() changes, (select data_version from pragma_data_version) version',
  ).get() as { changes: number; version: number };
  const key = `${now} ${changes} ${version}`;
  if (week?.key === key) return week.jobs;
  const from = iso(now - WEEK_MS);
  const jobs = prepared(
    `select j.id, j.kind, case when j.stage = 'triage' then 'triage' else j.kind end measuredKind, j.engine,
    exists (select 1 from runs o where o.job = j.id and o.ended is null) running,
    sum((julianday(r.ended) - julianday(r.started)) * 86400000) ms,
    sum(iif(r.started > :from, (julianday(r.ended) - julianday(r.started)) * 86400000, null)) week_ms
    from runs r cross join jobs j indexed by jobs_review_runs on j.id = r.job
    left join review_fix_tasks f on f.job = j.id
    where r.ended > :from and j.status = 'done'
    and (j.kind in ('review', 'consolidate') or j.stage = 'fix' and coalesce(f.round, j.round) is not null)
    group by j.id`,
  ).all({ from }) as ReviewWeek[];
  week = { key, jobs };
  return jobs;
}
