// How far each sizer's sizes have run from the agent time their jobs took, so the play counts a size an agent (or a
// model) gave as what that sizer's sizes have lately come to, so ETAs track how fast the work really goes. The saved
// size stays as given (sizes.ts): only the play and hq when read it corrected.
import { db } from './db.ts';
import { cleanPastJobs, pastJobs, type PastJob } from './matching.ts';
import { latestGiven } from './sizes.ts';
import { fitIn, wholeSeconds } from './arithmetic.ts';
import { SLOW_SHARE } from './reviewtime.ts';

const DAY_MS = 24 * 60 * 60_000,
  KEPT_MS = 60 * 60_000;
// The sized jobs a bias stands on: those done in the last two weeks (calibration.ts's backtest reads the same).
export const WINDOW_MS = 14 * DAY_MS;
// The fewest done jobs a sizer's own factors stand on; with fewer, every sizer's together, and with fewer than that none.
export const LEAST = 10;

// usual: the agent time the sizer's jobs took per hour it gave, all of them together (what a sum of sizes, a thread's
// ETA, needs right). slow: the share four in five of them took or less (a time told holds to that). own: its own jobs,
// not every sizer's together.
export type Bias = { usual: number; slow: number; jobs: number; own: boolean };

// The done clean jobs of the last two weeks that had a given size before they ended, by who gave it: [given, took] in ms.
// A job whose latest size is the CEO's revision (sizes.ts revised) is left out: the bias is that of guesses at queue time.
export function measured(now: number, pool: PastJob[]) {
  const since = new Date(now - WINDOW_MS).toISOString();
  const ids = (db.prepare('select distinct job from sizes where at > ?').all(since) as { job: number }[]).map(
    r => r.job,
  );
  if (!ids.length) return new Map<string, [number, number][]>();
  const given = latestGiven(ids);
  const pairs = new Map<string, [number, number][]>();
  for (const j of cleanPastJobs(pool.filter(job => given.has(job.id)))) {
    const size = given.get(j.id);
    if (
      j.origin === 'carry' ||
      !size ||
      size.revised ||
      j.finished < since ||
      size.at > j.finished ||
      !(j.agent_ms > 0)
    )
      continue;
    pairs.set(size.by, [...(pairs.get(size.by) ?? []), [size.agent_ms, j.agent_ms]]);
  }
  return pairs;
}

export function biasOf(pairs: [number, number][], own: boolean): Bias | undefined {
  const sum = (i: 0 | 1) => pairs.reduce((total, pair) => total + pair[i], 0);
  const usual = usualOf(pairs.length, sum(0), sum(1));
  if (usual === undefined) return undefined;
  const ratios = pairs.map(([gave, took]) => took / gave);
  return { usual, slow: Math.max(fitIn(ratios, SLOW_SHARE)!, usual), jobs: pairs.length, own };
}

// The usual bias from the sums of so many jobs' sizes and the agent time they took, none on fewer than LEAST.
// calibration.ts reads it from running sums.
export const usualOf = (jobs: number, given: number, took: number) => (jobs < LEAST ? undefined : took / given);

// Each sizer's bias: its own with enough jobs, else every sizer's together. It is read again once the done work changes
// (a new pool) and hourly as its two weeks move on.
let kept: { at: number; pool: PastJob[]; of: (by: string) => Bias | undefined } | undefined;
export function sizerBias(now = Date.now()) {
  const pool = pastJobs();
  if (kept && kept.pool === pool && now - kept.at < KEPT_MS && now >= kept.at) return kept.of;
  const pairs = measured(now, pool);
  const sizers = new Map([...pairs].map(([by, list]) => [by, biasOf(list, true)] as const));
  const all = biasOf([...pairs.values()].flat(), false);
  const of = (by: string) => sizers.get(by) ?? all;
  kept = { at: now, pool, of };
  return of;
}

// A size as the play counts it: the given time at its sizer's bias, the slow one never below the usual. Unchanged
// with no bias to go on.
export function corrected(agentMs: number, by: string, now = Date.now()) {
  const bias = sizerBias(now)(by);
  if (!bias) return { agent_ms: agentMs, high_ms: agentMs, bias };
  const usual = wholeSeconds(agentMs * bias.usual);
  return { agent_ms: usual, high_ms: Math.max(wholeSeconds(agentMs * bias.slow), usual), bias };
}
