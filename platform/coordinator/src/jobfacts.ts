// A job's record as the back of its card in HQ's projects view reads it (shell/jobsheet.js), beside its steps (log.ts):
// when it started and finished, its agent time (its runs, agenttime.ts, waits left out) against the size HQ gave it as it
// was queued (predictions.ts), and its pull request: its number, where it stands, when it merged, its lines and the
// review's verdict. A review loop job's is the round's pull request; a work job's the latest on its branch.
import { db } from './db.ts';

type Row = {
  id: number;
  started: string | null;
  finished: string | null;
  agent_ms: number | null;
  estimate_ms: number | null;
  pr: number | null;
};
type Pr = {
  number: number;
  status: string;
  merged_at: string | null;
  added: number | null;
  removed: number | null;
  verdict: string | null;
};

export function jobFacts(id: number) {
  const job = db
    .prepare(
      `select j.id, coalesce((select min(r.started) from runs r where r.job = j.id), j.started) started, j.finished,
      (select sum((julianday(coalesce(r.ended, $now)) - julianday(r.started)) * 86400000) from runs r where r.job = j.id) agent_ms,
      (select p.agent_ms from predictions p where p.job = j.id) estimate_ms,
      coalesce(j.pr, (select max(p.number) from prs p where p.branch = coalesce(j.branch, 'job/' || j.id))) pr
      from jobs j where j.id = $id`,
    )
    .get({ id, now: new Date().toISOString() }) as Row | undefined;
  if (!job) return 404;
  const pr = job.pr
    ? (db.prepare('select number, status, merged_at, added, removed, verdict from prs where number = ?').get(job.pr) as
        Pr | undefined)
    : undefined;
  return {
    started: job.started,
    finished: job.finished,
    agent_ms: job.agent_ms === null ? null : Math.round(job.agent_ms),
    estimate_ms: job.estimate_ms === null ? null : Math.round(job.estimate_ms),
    pr: pr ?? null,
  };
}
