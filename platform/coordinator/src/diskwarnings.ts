// Durable disk warnings reach the job's session hook independently of command output.
import { db, redacted, inOneStep } from './db.ts';

const OFFER_AGAIN_MS = 60_000; // longer than the session hook's two requests

db.exec(`create table if not exists disk_warnings (event text primary key, job integer not null,
  text text not null, offered integer, delivered integer)`);
redacted('disk_warnings', 'text');

export function record(event: string, job: number, text: string) {
  db.prepare('insert or ignore into disk_warnings (event, job, text) values (?, ?, ?)').run(event, job, text);
  return { text };
}

export function take(job: number, stopping: boolean) {
  if (stopping) return [];
  const now = Date.now();
  return inOneStep(() => {
    const warnings = db
      .prepare(
        `select event disk, text from disk_warnings where job = ? and delivered is null
        and (offered is null or offered < ?)`,
      )
      .all(job, now - OFFER_AGAIN_MS) as { disk: string; text: string }[];
    for (const warning of warnings)
      db.prepare('update disk_warnings set offered = ? where event = ?').run(now, warning.disk);
    return warnings;
  });
}

export function ack(job: number, events: unknown) {
  if (!Array.isArray(events) || events.some(event => typeof event !== 'string')) return 400;
  for (const event of events)
    db.prepare(`update disk_warnings set delivered = ? where event = ? and job = ? and offered is not null`).run(
      Date.now(),
      event,
      job,
    );
}
