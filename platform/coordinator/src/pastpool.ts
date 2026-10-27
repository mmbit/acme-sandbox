// The done work the play's spot sizes and the sizers' bias match against (matching.ts pastJobs), kept for the hour
// while the server keeps it. A wide read: renewed a slice at a time between HQ's other work, the last one used until
// then, so no play reads every done job.
import { db } from './db.ts';
import { pastJobs, type PastJob } from './matching.ts';

const KEPT_MS = 3600_000,
  // (a slice reads in 13-30 ms warm on a copy at HQ's size, 70 ms cold)
  SLICE = 500,
  DONE_WORK = `select id from jobs indexed by jobs_history where kind = 'work' and status = 'done' order by id`;

let keeping = false,
  kept: { at: number; pool: PastJob[] } | undefined,
  renewing: Promise<void> | undefined;

// From now on the pool is kept: the server's (forecast.ts start), the claim's plan's (ordering.ts).
export const keep = () => void (keeping = true);

// The server's start: kept, and read ahead of the first play.
export function readAhead() {
  keep();
  renew(Date.now());
}

// The pool to match against now: the kept one, renewed in the background once an hour old. Read whole now with none
// kept yet, or with nothing keeping it (a test, a one-off).
export function pool(now = Date.now()): PastJob[] {
  if (!keeping) return pastJobs();
  if (!kept) kept = { at: now, pool: pastJobs() };
  else if (now - kept.at >= KEPT_MS) renew(now);
  return kept.pool;
}

// The kept pool, if there is one, renewed in the background once an hour old as pool's is: the sizers' bias reads its
// jobs from it rather than the database (sizerbias.ts).
export function keptPool(now = Date.now()) {
  if (!keeping || !kept) return undefined;
  if (now - kept.at >= KEPT_MS) renew(now);
  return kept.pool;
}

// The renewal under way, done when the pool is (tests wait on it).
export const renewal = () => renewing ?? Promise.resolve();

function renew(at: number) {
  renewing ??= read(at).finally(() => (renewing = undefined));
}

async function read(at: number) {
  const ids = (db.prepare(DONE_WORK).all() as { id: number }[]).map(row => row.id);
  const pool: PastJob[] = [];
  for (let i = 0; i < ids.length; i += SLICE) {
    pool.push(...pastJobs(ids.slice(i, i + SLICE)));
    await new Promise(resolve => setImmediate(resolve));
  }
  // (a play that found none kept meanwhile read a newer one whole)
  if (!kept || kept.at <= at) kept = { at, pool };
}
