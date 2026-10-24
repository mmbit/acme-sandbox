// Refused review reads, retained for their retries and the server's status report.
import type { DatabaseSync } from 'node:sqlite';

export function record(db: DatabaseSync, job: number, reason: string) {
  db.prepare('insert or ignore into review_refusals (job, at, reason) values (?, ?, ?)').run(job, Date.now(), reason);
}

export function reason(db: DatabaseSync, job: number) {
  return (db.prepare('select reason from review_refusals where job = ?').get(job) as { reason: string } | undefined)
    ?.reason;
}

export function report(db: DatabaseSync, now = Date.now()) {
  const refused = db
    .prepare(
      `select r.job, j.pr, j.round, coalesce(j.stage, j.kind) stage,
      iif(j.customers, '(holds a customer''s details)', r.reason) reason
      from review_refusals r join jobs j on j.id = r.job where r.at >= ? order by r.job`,
    )
    .all(now - 86_400_000);
  return ['== review reads refused in the last 24 hours', ...refused.map(read => JSON.stringify(read))].join('\n');
}
