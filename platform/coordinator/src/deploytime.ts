// Measured time from a merge to the next successful deploy finish.
import { db } from './db.ts';
import { median } from './arithmetic.ts';

// The median time from a merge to the deploy that brought it, over the last week's merges, else a first guess.
const DEPLOY_GUESS_MS = 20 * 60_000,
  WEEK_MS = 7 * 24 * 60 * 60_000;
export function deployLag(now: number) {
  const lags = (
    db
      .prepare(
        `select (julianday((select min(d.finished) from deploys d where d.finished > p.merged_at and d.ok = 1))
      - julianday(p.merged_at)) * 86400000 ms from prs p where p.merged_at > ?`,
      )
      .all(new Date(now - WEEK_MS).toISOString()) as { ms: number | null }[]
  ).flatMap(l => l.ms ?? []);
  return median(lags) ?? DEPLOY_GUESS_MS;
}
