// A job's log, step by step, as the projects view shows it when the board opens a job: each tool call as it was made
// (the command, the file, the search) and what the agent said between them, from the worker (its detailOf, steps.ts).
// A job holding a customer's details sends only the kind of step it takes as its text, which is all anything agents can
// read gets (infra/report.sh), and the line itself as board, for the board's own HQ session alone (jobLog, HQ's
// /api/jobs/log). Redacted as it comes in, like every event; the newest LOG_MAX lines of a job are kept, for LOG_DAYS.
import { db, redacted } from './db.ts';
import { redact } from './events.ts';

const LOG_MAX = 400,
  LOG_DAYS = 14;
const TEXT_MAX = 2000;

db.exec(`create table if not exists job_log (id integer primary key, job integer not null, ts text not null, agent text,
  text text not null, board text)`);
db.exec('create index if not exists job_log_job on job_log (job, id)');
db.exec('create index if not exists job_log_ts on job_log (ts)');
redacted('job_log', 'text', 'board');

// a line of job's log, by agent (the lead or a team member); board: the line itself, of a job holding a customer's
// details (its text then the kind of step, or empty for what its agent said)
export function logStep(job: number, agent: string, text: string, board?: string) {
  const line = redact(text.slice(0, TEXT_MAX))?.trim() ?? '',
    boardLine = redact(board?.slice(0, TEXT_MAX))?.trim() || null;
  if (!line && !boardLine) return;
  db.prepare('insert into job_log (job, ts, agent, text, board) values (?, ?, ?, ?, ?)').run(
    job,
    new Date().toISOString(),
    agent,
    line,
    boardLine,
  );
  db.prepare(
    'delete from job_log where job = ? and id <= (select id from job_log where job = ? order by id desc limit 1 offset ?)',
  ).run(job, job, LOG_MAX);
  db.prepare('delete from job_log where ts < ?').run(new Date(Date.now() - LOG_DAYS * 864e5).toISOString());
}

// a job's log, oldest first, as the board's HQ shows it: each line itself
export const jobLog = (job: number) =>
  db.prepare('select ts, agent, coalesce(board, text) text from job_log where job = ? order by id').all(job) as {
    ts: string;
    agent: string;
    text: string;
  }[];
