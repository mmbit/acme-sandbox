// A thread's release (../docs/projects.md, "Threads in order"): the work its one pull request carries ends at the first
// task that can't run before that pull request merges (server.ts hq job).
import { db } from './db.ts';
import * as jobs from './jobs.ts';
import { threadOfBranch } from './panel.ts';
import type { Wake } from './wakes.ts';

// One thread, one pull request: its tasks are the work that pull request carries, so none of them can wait for it to
// merge. A task waiting for the thread's own work deployed (hq job --when deployed: on one of its tasks or its pull
// request) starts only after the merge, so hq job puts it in a thread of its own (server.ts): whether these wakes wait
// for the thread's own work to be deployed.
export function waitsForRelease(thread: string, wakes: Wake[]) {
  return wakes.some(w => w.kind === 'deployed' && threadOfWork(w.arg) === thread);
}
// The thread of a deployed: wake's work: its job's, or that of the pull request's branch
function threadOfWork(arg: string) {
  if (!arg.startsWith('pr:')) return jobs.threadOf(Number(arg));
  const pr = db.prepare('select branch from prs where number = ?').get(Number(arg.slice(3))) as { branch: string };
  return threadOfBranch(pr.branch);
}
