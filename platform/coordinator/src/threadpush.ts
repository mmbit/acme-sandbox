// A task's push carries its deliverable's branch and opens its pull request.
import { db } from './db.ts';
import * as jobs from './jobs.ts';
import { findThread } from './projects.ts';
import { isTask, tasksOf, type Job } from './threadorder.ts';

// A task's finish that pushed work (a commit, a pull request) makes its branch the thread's, the branch each later task
// runs on, until it merges (threadends.ts merged). So does one that failed or was stopped after pushing a commit of its
// own (the worker's ownCommit, or GitHub's refusal of its pull request in its land), so the task taking its place pushes
// there. One that pushed nothing leaves the thread without a branch, and so does a parked or handed-up run's: its task
// goes on.
export function pushed(job: Job, r: { status: string; branch?: string; sha?: string; pr?: number }) {
  if (!isTask(job) || !r.branch || !(r.sha || r.pr)) return;
  // The task keeps the commit it pushed, from whichever of its runs pushed it (a later run that adds nothing reports
  // none, as does a landing run after a snag): its pull request's merge brings that work to main (jobs.ts failedAside).
  if (r.sha && ['done', 'failed', 'stopped', 'parked', 'up', 'snagged'].includes(r.status))
    db.prepare('update jobs set sha = ? where id = ?').run(r.sha, job.id);
  if (!['done', 'failed', 'stopped'].includes(r.status)) return;
  db.prepare("update threads set branch = ? where id = ? and branch is null and status = 'open'").run(
    r.branch,
    job.thread,
  );
}

// The thread's pull request as a task's push opens it: titled with the thread's name, its "done when" and its tasks in
// the body (the worker adds that task's report). Its later tasks' pushes are its next rounds.
export function pullOf(id: number) {
  const job = db.prepare('select id, kind, pr, thread, branch from jobs where id = ?').get(id) as Job | undefined;
  const thread = job && isTask(job) ? findThread(job.thread) : undefined;
  if (!thread) return undefined;
  const tasks = tasksOf(thread.id).map(t => `- #${t.id}, ${t.agent}: ${jobs.nameOf(t)}`);
  return {
    title: thread.name,
    body: `The deliverable ${thread.id}, done when: ${thread.goal}\n\nIts tasks:\n${tasks.join('\n')}`,
  };
}
