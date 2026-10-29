// A job on a pull request's branch (a fix round, a touch-up check, the board's notes): it goes on in its author's last
// session there, which the worker keeps while the pull request can still merge (jobs.ts ended), as long as that session
// is warm. Otherwise it starts a fresh one with the author's closing reports (the worker's carry.ts).
import { db } from './db.ts';

// The engines' prompt caches last an hour from a request. A session resumed after that writes its whole context to the
// cache again, which costs more than a fresh start that reads the closing reports.
export const COLD_MS = 60 * 60_000;

type Branched = {
  id: number;
  kind: string;
  agent: string;
  branch: string | null;
  pr: number | null;
  session: string | null;
};
// The job whose session it goes on in, that session as the job saved it, and the Codex seat it ran on
type Resumes = { job: number; session: string; seat: string | null };
// The author's done jobs on the branch, oldest first, each with its closing report (the first one's is the pull
// request's description)
type ClosingReports = { reports: { job: number; report: string }[] };

// Nothing for a job that has run already (it goes on in its own session) or one with no pull request.
export function carryOver(job: Branched): { resumes?: Resumes; closingReports?: ClosingReports } {
  if (job.kind !== 'work' || job.pr === null || job.session) return {};
  const last = db
    .prepare(
      `select id job, session, for_seat seat from jobs where kind = 'work' and status = 'done' and agent = ?
  and coalesce(branch, 'job/' || id) = ? and session is not null and id < ? order by id desc limit 1`,
    )
    .get(job.agent, job.branch, job.id) as Resumes | undefined;
  if (!last) return {};
  if (Date.now() - lastTurn(last.session) <= COLD_MS) return { resumes: last };
  const reports = db
    .prepare(
      `select id job, result report from jobs where kind = 'work' and status = 'done' and agent = ?
  and coalesce(branch, 'job/' || id) = ? and result is not null and id < ? order by id`,
    )
    .all(job.agent, job.branch, job.id) as ClosingReports['reports'];
  return { closingReports: { reports } };
}

// When the session's model last replied on its main thread, whichever job ran it (usage.ts last_turn). A session with no
// such time on record (a run that reported none, one taken over after it ended) counts as cold.
function lastTurn(session: string) {
  const row = db.prepare('select max(last_turn) at from usage where session = ?').get(session) as { at: string | null };
  return row.at ? Date.parse(row.at) : 0;
}
