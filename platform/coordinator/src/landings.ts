// When work landed, from HQ's own records: a work job's latest pull request merged, or its end where it opened none.
// Work whose pull request is still open, or closed unmerged, hasn't landed. The prediction log, the backtest and the
// calibration score against this.
import { db } from './db.ts';
import { workBranch } from './jobs.ts';

// Each of these jobs that landed: its landing time, by job id.
export function landings(jobs: number[]) {
  const rows = db
    .prepare(
      `select j.id, j.finished, pr.status, pr.merged_at from jobs j
      left join prs pr on pr.number = (select max(number) from prs where branch = ${workBranch('j')})
      where j.id in (select value from json_each(?)) and j.kind = 'work' and j.status = 'done'`,
    )
    .all(JSON.stringify(jobs)) as { id: number; finished: string; status: string | null; merged_at: string | null }[];
  const landed = new Map<number, number>();
  for (const r of rows) {
    if (r.status === null) landed.set(r.id, Date.parse(r.finished));
    else if (r.merged_at) landed.set(r.id, Date.parse(r.merged_at));
  }
  return landed;
}
