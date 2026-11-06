// A past job's adjusted time: what its work would cost now, after a process change made its measurement stale (a gate
// dropped, a test route moved), with why, who set it and when. The measurement (matching.ts PastJob.agent_ms, from its
// runs) never changes: the adjusted time stands beside it. A later adjustment of the same job adds a row and the
// newest counts, so the history stays; a row with no time withdraws it. The weekly estimate check
// (shared/routines/estimates.md) writes them, one job at a time, each with its own reason: no factor over a set.
// Read by the picks and the size from them (matching.ts sizeOf) and shown beside the measurement by hq estimate; never
// by the scoring of estimates against what happened (accuracy, calibration, the prediction log, the timing audit).
import { db, inOneStep, redacted } from './db.ts';
import { ceo, roles } from './company.ts';
import { publish } from './events.ts';
import { oneLine, readSize } from './sizes.ts';
import { duration } from '../../worker/hq/waits.ts';

db.exec(`create table if not exists adjusted_times (id integer primary key, job integer not null, agent_ms real,
  why text not null, by text not null, at text not null);
  create index if not exists adjusted_times_job on adjusted_times (job, id)`);
redacted('adjusted_times', 'why');

export type Adjusted = { agent_ms: number; why: string; by: string; at: string };

// The time a past job counts at in the picks and the size from them: its adjusted time where it has one.
export const countedMs = (j: { agent_ms: number; adjusted?: Adjusted | null }) => j.adjusted?.agent_ms ?? j.agent_ms;

// matching.ts past(): each job's newest adjustment, joined by job (a withdrawn one has no time)
export const ADJUSTED_JOIN = `left join adjusted_times a on a.id = (select max(x.id) from adjusted_times x where x.job = j.id)`,
  ADJUSTED_COLUMNS = 'a.agent_ms adjusted_ms, a.why adjusted_why, a.by adjusted_by, a.at adjusted_at';
export type AdjustedRow = {
  adjusted_ms: number | null;
  adjusted_why: string | null;
  adjusted_by: string | null;
  adjusted_at: string | null;
};
export const adjustedOf = (r: AdjustedRow): Adjusted | null =>
  r.adjusted_ms === null
    ? null
    : { agent_ms: r.adjusted_ms, why: r.adjusted_why!, by: r.adjusted_by!, at: r.adjusted_at! };

// Who may write one: the estimates role (org.yaml's roles.estimates) and the CEO, as with the CEO's revisions of queued
// sizes (sizes.ts setSize). Every estimate stands on these done jobs, every company's agents and HQ's play alike, so one
// set carelessly would move every plan that leans on it: only the agent who answers for the estimates writes them.
export const mayAdjust = (by: string) => by === roles().estimates || by === ceo();

export type Adjustment = { job: unknown; time: unknown; why: unknown };
const WHY_MAX = 300,
  // (a time of "none" withdraws the job's adjustment)
  NONE = 'none';

// hq estimate adjust: each job's adjusted time with its own reason, all of them or none. A job must be done work.
export function adjust(list: Adjustment[], by: string, now = Date.now()): [number, string] | { adjusted: number[] } {
  if (!mayAdjust(by))
    return [
      403,
      "the estimates role (org.yaml's roles.estimates) or the CEO adjusts past jobs' times: tell them (hq say)",
    ];
  if (!Array.isArray(list) || !list.length) return [400, 'give at least one adjustment: job, time and why'];
  const rows: { job: number; agent_ms: number | null; why: string }[] = [];
  for (const a of list) {
    const job = Number(a?.job),
      time = String(a?.time ?? '').trim(),
      why = oneLine(String(a?.why ?? ''), WHY_MAX);
    if (!Number.isInteger(job) || job < 1) return [400, `"${String(a?.job).slice(0, 20)}" isn't a job number`];
    const found = db.prepare("select status from jobs where id = ? and kind = 'work'").get(job) as
      { status: string } | undefined;
    if (!found) return [404, `there's no work job #${job}`];
    if (found.status !== 'done') return [409, `job #${job} is ${found.status}: only a done job's time is adjusted`];
    if (!why) return [400, `give job #${job}'s reason: the process change and what it changed in this job's work`];
    const ms = time.toLowerCase() === NONE ? null : readSize(time);
    if (typeof ms === 'string') return [400, `job #${job}: ${ms}, or "none" to withdraw its adjustment`];
    rows.push({ job, agent_ms: ms, why });
  }
  const at = new Date(now).toISOString(),
    add = db.prepare('insert into adjusted_times (job, agent_ms, why, by, at) values (?, ?, ?, ?, ?)');
  inOneStep(() => {
    for (const r of rows) add.run(r.job, r.agent_ms, r.why, by, at);
  });
  const words = rows.map(r => `#${r.job} ${r.agent_ms === null ? 'withdrawn' : `to ${duration(r.agent_ms / 60_000)}`}`);
  publish({ type: 'log', agent: by, text: `Adjusted past jobs' times: ${words.join(', ')}` });
  return { adjusted: rows.map(r => r.job) };
}
