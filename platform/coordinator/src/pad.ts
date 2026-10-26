// The CEO's page (hq pad): one text the CEO rewrites whole whenever its thinking changes, its goals and why, the bets
// running for each, what it watches and when it judges it, what it does next. The hourly check carries it after the
// foundation's instructions (heartbeat.ts), a call with the CEO has it in its briefing, and the board reads it at the top
// of HQ's projects view. Every version is kept, with its time and the job that wrote it.
import { db, redacted } from './db.ts';
import { ceo } from './company.ts';
import { holdsCustomerData } from './jobs.ts';

db.exec(
  'create table if not exists pad_versions (id integer primary key, text text not null, by text not null, job integer, at text not null)',
);
redacted('pad_versions', 'text');

export type PadVersion = { id: number; text: string; by: string; job: number | null; at: string };

// The page as it is now, or null before the CEO first writes it
export const pad = () =>
  (db.prepare('select * from pad_versions order by id desc limit 1').get() as PadVersion | undefined) ?? null;

// hq pad --history: every version, newest first
export const padHistory = () => db.prepare('select * from pad_versions order by id desc').all() as PadVersion[];

// hq pad write -: the whole page anew, from one of the CEO's jobs. No length cap: the instructions keep it short,
// because it's read every hour.
export function writePad(text: unknown, writer: { agent: string; job: number }) {
  if (writer.agent !== ceo()) return "the page is the CEO's: only its jobs rewrite it";
  // every job reads the page (house rule 7): one holding a customer's own details leaves it to a job that holds none
  if (holdsCustomerData(writer.job))
    return "this job holds a customer's own details, and the page is read by every job: they stay in this job. Rewrite the page from a job that holds none";
  const page = String(text ?? '').trim();
  if (!page) return 'the page is empty: give it whole on stdin (hq pad write - < page.md)';
  if (page === pad()?.text) return 'the page reads that already';
  const at = new Date().toISOString();
  const { lastInsertRowid } = db
    .prepare('insert into pad_versions (text, by, job, at) values (?, ?, ?, ?)')
    .run(page, writer.agent, writer.job, at);
  return { id: Number(lastInsertRowid), at };
}
