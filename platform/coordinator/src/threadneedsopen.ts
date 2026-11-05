// A thread's needs still open: each thread it needs whose work is still to merge, with its last task to merge, as the
// claim and the play read them (threadorder.ts reader).
// (its messages say deliverable, the board's word for a thread)
import { db, mergePending, prepared } from './db.ts';
import { findThread, needsOf } from './projects.ts';
import * as jobs from './jobs.ts';
import * as reviewclosure from './reviewclosure.ts';
import type { Task } from './threadorder.ts';

// Each thread's open needs read once a reading, and the branches' review states once for all of them (reading them
// builds the redraws' relations whole). (failedHold: the reading's own, needsOpen)
export function needsReader(failedHold: (thread: string) => number | null) {
  const needs = new Map<string, ReturnType<typeof needsOpen>>();
  let statusOf: ReturnType<typeof reviewclosure.statuses> | undefined;
  const status = (branch: string) => (statusOf ??= reviewclosure.statuses())(branch);
  return (thread: string) => {
    if (!needs.has(thread)) needs.set(thread, needsOpen(thread, status, failedHold));
    return needs.get(thread)!;
  };
}
// Each thread whose work is still needed, with its last task still to merge. One whose work is all pushed and whose pull
// request is stuck holds no start, nor does one whose next task a failed task holds (failedHold), which waits for its
// owner, not for its work: what needs it runs beside it, and merges after it only when they share files (mergeorder.ts).
function needsOpen(
  thread: string,
  status: (branch: string) => string | null,
  failedHold: (thread: string) => number | null,
) {
  return needsOf(thread).flatMap(n => {
    const needed = findThread(n);
    if (!needed || needed.status === 'done' || failedHold(needed.id) !== null) return [];
    const last = db
      .prepare(
        `select j.id, j.status, j.branch from jobs j where j.thread = ? and j.kind = 'work' and j.pr is null
        and ${mergePending('j')} order by coalesce(j.seq, j.id) desc, j.id desc limit 1`,
      )
      .get(needed.id) as Pick<Task, 'id' | 'status' | 'branch'> | undefined;
    if (last && stuckAside(needed.id, last, status)) return [];
    if (!last) {
      const tasks = prepared(
        "select id, status, branch from jobs where thread = ? and kind = 'work' and pr is null",
      ).all(needed.id) as Pick<Task, 'id' | 'status' | 'branch'>[];
      const settled = (t: (typeof tasks)[number]) =>
        t.status === 'cancelled' ||
        (t.status === 'done' && ['merged', 'dropped'].includes(status(jobs.workBranchOf(t)) ?? 'merged'));
      if (tasks.length && tasks.every(settled)) return [];
    }
    return [{ thread: needed.id, task: last?.id ?? null }];
  });
}
// The thread's last task pushed, its pull request stuck (redraws resolved, as for a settled thread above), and none of
// its tasks still to run
const stuckAside = (
  thread: string,
  last: Pick<Task, 'id' | 'status' | 'branch'>,
  status: (branch: string) => string | null,
) =>
  last.status === 'done' &&
  status(jobs.workBranchOf(last)) === 'stuck' &&
  !prepared(
    "select 1 from jobs where thread = ? and kind = 'work' and pr is null and status in ('queued', 'running', 'blocked')",
  ).get(thread);
