// Recorded tokens and attributed seat-week consumption, with missing reports kept visible.
import { db } from './db.ts';
import './seatcost.ts';

export type CostPhase = 'work' | 'reviews' | 'fixes' | 'feedback';
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
  for (const phase of ['work', 'reviews', 'fixes', 'feedback'] as const)
    addSpend(target.split[phase], source.split[phase]);
  addSpend(target.total, source.total);
  target.missing_usage += source.missing_usage;
}
export function jobSpend(job: number, from = -Infinity, until = Infinity) {
  const rows = db.prepare(`select ts, input, cache_write, cache_read, output from usage where job = ?`).all(job) as {
    ts: string;
    input: number;
    cache_write: number;
    cache_read: number;
    output: number;
  }[];
  const spend = emptySpend();
  for (const row of rows) {
    const at = Date.parse(row.ts);
    if (at <= from || at > until) continue;
    for (const key of ['input', 'cache_write', 'cache_read', 'output'] as const) spend[key] += row[key];
  }
  spend.tokens = spend.input + spend.cache_write + spend.cache_read + spend.output;
  const meters = db.prepare('select end, week, milliseconds from seat_cost_jobs where job = ?').all(job) as {
    end: number;
    week: number;
    milliseconds: number;
  }[];
  for (const meter of meters)
    if (meter.end > from && meter.end <= until) {
      spend.seat_weeks = (spend.seat_weeks ?? 0) + meter.week;
      spend.metered_ms += meter.milliseconds;
    }
  return {
    spend,
    reported: rows.some(row => Date.parse(row.ts) > from && Date.parse(row.ts) <= until),
    ran: jobRan(job, from, until),
  };
}

function jobRan(job: number, from: number, until: number) {
  const start = Number.isFinite(from) ? new Date(from).toISOString() : '0001-01-01';
  const end = Number.isFinite(until) ? new Date(until).toISOString() : '9999-12-31';
  return !!db
    .prepare('select 1 from runs where job = ? and started < ? and (ended is null or ended > ?) limit 1')
    .get(job, end, start);
}
