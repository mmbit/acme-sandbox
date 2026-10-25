// Measured review and consolidation durations used by the queue's play.
import { db } from './db.ts';
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
  // (the week's runs first, by their end, then their jobs: one that started in the week ended in it)
  // jobs_review_runs covers the jobs columns here to skip wide job rows (db.ts).
  const runs = db
    .prepare(
      `select j.kind, sum((julianday(r.ended) - julianday(r.started)) * 86400000) ms from runs r
      cross join jobs j indexed by jobs_review_runs on j.id = r.job
      where j.kind in ('review', 'consolidate') and j.status = 'done' and r.started > ? and r.ended > ?
      group by j.id`,
    )
    .all(...Array(2).fill(iso(now - WEEK_MS))) as { kind: string; ms: number }[];
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
