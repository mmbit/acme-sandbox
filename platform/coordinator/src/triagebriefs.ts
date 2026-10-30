// What a triage was briefed with beyond its round's facts (its links and the note after the brief), so a retry is briefed
// again on who may review and rule now, never on a copy of the old brief (review.ts retriage).
import { db, redacted } from './db.ts';

db.exec('create table if not exists triage_briefs (job integer primary key, links text not null, note text not null)');
redacted('triage_briefs', 'note');

export function keep(job: number, links: string[], note: string) {
  db.prepare('insert or replace into triage_briefs (job, links, note) values (?, ?, ?)').run(
    job,
    JSON.stringify(links),
    note,
  );
}

export function kept(job: number) {
  const row = db.prepare('select links, note from triage_briefs where job = ?').get(job) as
    { links: string; note: string } | undefined;
  return row && { links: JSON.parse(row.links) as string[], note: row.note };
}
