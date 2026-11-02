// Recorded tokens and attributed seat-week consumption, with missing reports kept visible.
import { db } from './db.ts';
import { seatCosts } from './seatcost.ts';

import { COST_PHASES, type CostPhase } from './taskphases.ts';
export type Spend = {
  tokens: number;
  input: number;
  cache_write: number;
  cache_read: number;
  output: number;
  seat_weeks: number | null;
  metered_ms: number;
};
export type Cost = {
  split: Record<CostPhase, Spend>;
  total: Spend;
  missing_usage: number;
  allocation: 'recorded_tokens_and_run_share_of_meter';
};
export const emptySpend = (): Spend => ({
  tokens: 0,
  input: 0,
  cache_write: 0,
  cache_read: 0,
  output: 0,
  seat_weeks: null,
  metered_ms: 0,
});
export const emptyCost = (): Cost => ({
  split: { work: emptySpend(), reviews: emptySpend(), fixes: emptySpend(), feedback: emptySpend() },
  total: emptySpend(),
  missing_usage: 0,
  allocation: 'recorded_tokens_and_run_share_of_meter',
});
export function addSpend(target: Spend, source: Spend, share = 1) {
  for (const key of ['tokens', 'input', 'cache_write', 'cache_read', 'output', 'metered_ms'] as const)
    target[key] += source[key] * share;
  if (source.seat_weeks !== null) target.seat_weeks = (target.seat_weeks ?? 0) + source.seat_weeks * share;
}
export function addCost(target: Cost, source: Cost) {
  for (const phase of COST_PHASES) addSpend(target.split[phase], source.split[phase]);
  addSpend(target.total, source.total);
  target.missing_usage += source.missing_usage;
}
export const jobSpend = (job: number, from = -Infinity, until = Infinity) => jobSpends([job])(job, from, until);
export function jobSpends(jobs: number[] | null = null) {
  const selected = jobs ? [JSON.stringify(jobs)] : [];
  const where = jobs ? 'where job in (select value from json_each(?))' : '';
  const usageRows = db
    .prepare(
      `select job, ts, input, cache_write, cache_read, output from usage
    ${where}`,
    )
    .all(...selected) as Usage[];
  const runRows = db
    .prepare(
      `select job, started, ended, no_engine from runs
    ${where} order by started`,
    )
    .all(...selected) as Run[];
  const usage = Map.groupBy(usageRows, row => row.job),
    history = Map.groupBy(runRows, run => run.job);
  const meters = seatCosts(jobs);
  return (job: number, from = -Infinity, until = Infinity) => {
    const jobUsage = usage.get(job) ?? [];
    const spend = emptySpend();
    for (const row of jobUsage) {
      const at = Date.parse(row.ts);
      if (at <= from || at > until) continue;
      for (const key of ['input', 'cache_write', 'cache_read', 'output'] as const) spend[key] += row[key];
    }
    spend.tokens = spend.input + spend.cache_write + spend.cache_read + spend.output;
    Object.assign(spend, meters(job, from, until));
    const jobRuns = history.get(job) ?? [];
    const relevant = jobRuns.filter(
      run => Date.parse(run.started) < until && (run.ended === null || Date.parse(run.ended) > from),
    );
    const reports = jobUsage.map(row => Date.parse(row.ts)).filter(at => at > from && at <= until);
    return { spend, reported: reportsCoverRuns(jobRuns, relevant, reports, until), ran: relevant.length > 0 };
  };
}
type Usage = Pick<Spend, 'input' | 'cache_write' | 'cache_read' | 'output'> & { job: number; ts: string };
type Run = { job: number; started: string; ended: string | null; no_engine: number };

// Each report belongs to the latest started run. An earlier report cannot cover a later retry.
function reportsCoverRuns(runs: Run[], relevant: Run[], reports: number[], until: number) {
  if (!relevant.length) return reports.length > 0;
  return relevant.every(run => {
    if (run.ended === null) return false;
    const ended = Date.parse(run.ended);
    if (run.no_engine && ended <= until) return true;
    const next = runs[runs.indexOf(run) + 1];
    return reports.some(at => at >= ended && (!next || at < Date.parse(next.started)));
  });
}
