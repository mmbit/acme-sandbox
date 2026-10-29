// A job on a pull request's branch (a fix round, a touch-up check, the board's notes) goes on in its author's last session
// there, from the home the worker keeps of that job while the pull request can still merge (worker.ts settle; the
// coordinator's jobs.ts resumes and ended).
import { existsSync } from 'node:fs';
import { resumeOn } from './clis.ts';
import { runAs, type Agent } from './git.ts';
import { jobDirs, own } from './slots.ts';

// The job whose session it goes on in, that session as the job saved it, and the Codex seat it ran on
export type Resumes = { job: number; session: string; seat: string | null };
// Or, once that session has gone cold, the author's done jobs on the branch with their closing reports, oldest first
// (the coordinator's carryover.ts)
export type ClosingReports = { reports: { job: number; report: string }[] };

// How Claude names a project's folder: the project's path, with a dash for each character but a letter or digit
export const project = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-');

// Copies the session job.resumes names into the job's home (its folders under `work`) as `me`, the slot that runs it on
// the seat: the kept home goes to the slot, and the session goes under the new clone's project for Claude, into the
// sessions folder for Codex. Returns the session to resume, or null for a fresh start: a session of another CLI, a Codex
// one of another seat (its account), or one whose home is gone.
type Carried = { id: number; engine: string; resumes: Resumes };
export function carrySession(work: string, job: Carried, seat: { id: string; cli: string }, me: Agent) {
  const from = job.resumes,
    cli = seat.cli;
  const session = cli !== 'codex' || from.seat === seat.id ? resumeOn(cli, job.engine, from.session).session : null;
  if (!session || !/^[\w-]{1,100}$/.test(session)) return null;
  const before = jobDirs(work, from.job),
    { dir, home } = jobDirs(work, job.id);
  const claude = `${before.home}/.claude/projects/${project(before.dir)}`,
    codex = `${before.home}/.codex/sessions`;
  if (cli === 'claude' && existsSync(`${claude}/${session}.jsonl`)) {
    own([before.home], me);
    runAs(me, 'mkdir', ['-p', `${home}/.claude/projects`]);
    runAs(me, 'cp', ['-aT', '--', claude, `${home}/.claude/projects/${project(dir)}`]);
    return session;
  }
  if (cli === 'codex' && existsSync(codex)) {
    own([before.home], me);
    runAs(me, 'mkdir', ['-p', `${home}/.codex/sessions`]);
    const copied = runAs(me, 'sh', [
      '-c',
      'cd "$1" && find . -type f -name "*$2*.jsonl" -exec cp -a --parents -t "$3" -- {} + -print',
      'sh',
      codex,
      session,
      `${home}/.codex/sessions`,
    ]);
    return copied.trim() ? session : null;
  }
  return null;
}

// A job whose author's session went cold starts a fresh session. Its briefing gets, beside its brief, what the author
// wrote at the end of each job on the branch, and the branch's own commits (`git log`, one line each).
export function closingLines(closing: ClosingReports, log: string) {
  const reports = closing.reports.map(r => `Job #${r.job}'s closing report:\n\n${r.report.trim()}`).join('\n\n');
  return `This job goes on with work already on this branch, in a new session: the session that did that work ended over
an hour ago. What its author wrote as each job on the branch ended, and the branch's commits, are below. Start from
them and the code, rather than redoing what's there.

${reports}

The branch's commits since main, newest first:
${log.trim() || '(none)'}`;
}
