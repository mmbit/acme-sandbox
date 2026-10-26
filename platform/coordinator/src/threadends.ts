// A thread's end (../docs/projects.md, "Threads in order"): a merge clears the thread's branch and wakes the owner of
// each thread with nothing left open to judge it (threadjudge.ts).
import { db, once, planChange } from './db.ts';
import * as reviewclosure from './reviewclosure.ts';
import * as jobs from './jobs.ts';
import { tasksOf, type Task } from './threadorder.ts';
import { findThread, type Thread } from './projects.ts';
import { oneTask } from './made.ts';
import * as threadjudge from './threadjudge.ts';

// A pull request merged (review.ts pullRequestMerged): the thread starts its next task on a new branch. Each thread
// whose work it held stays open with nothing in it open or still to merge, and its owner judges it (threadjudge.ts
// wake): they close it (hq plan done) or draw its next task. A judge's own thread closes once all of it is in.
export function merged(pr: number) {
  const row = db.prepare('select branch from prs where number = ?').get(pr) as { branch: string } | undefined;
  if (!row) return;
  settled(row.branch);
}
export function settled(branch: string) {
  for (const original of reviewclosure.originals(branch)) {
    db.prepare('update threads set branch = null where branch = ?').run(original);
    const threads = db
      .prepare(
        `select distinct thread from jobs where kind = 'work' and pr is null and thread is not null
      and coalesce(branch, 'job/' || id) = ?`,
      )
      .all(original) as { thread: string }[];
    for (const { thread } of threads)
      if (threadjudge.judges(thread)) closeIfDone(thread);
      else
        try {
          threadjudge.wake(thread);
        } catch (err) {
          console.error(`${thread}'s owner not woken to judge it:`, err);
        }
  }
}

export function closeSettled() {
  once('2026-10-20-threads-done-at-merge', () => {
    const open = db.prepare("select id from threads where status = 'open' order by id").all() as { id: string }[];
    for (const { id } of open) if (tasksOf(id).some(t => latestPr(t) === 'merged')) closeIfDone(id);
  });
}
const latestPr = (t: Task) => reviewclosure.status(jobs.workBranchOf(t));
// (failedEnds: a failed task with no replacement is in too, as in a routine's run: endedEmpty)
function closeIfDone(id: string, failedEnds = false) {
  const thread = findThread(id);
  if (thread?.status !== 'open') return;
  const tasks = tasksOf(thread.id);
  const settled = (t: Task) =>
    (failedEnds && t.status === 'failed') ||
    (t.status === 'done' && ['merged', 'dropped'].includes(latestPr(t) ?? 'merged'));
  if (!tasks.length || !tasks.every(settled)) return;
  close(thread);
}
const close = (thread: Thread) => {
  db.prepare("update threads set status = 'done', done = ?, branch = null where id = ?").run(
    new Date().toISOString(),
    thread.id,
  );
  planChange({ project: thread.project, thread: thread.id, what: 'thread done: its work settled', by: 'hq' });
};

// A job that ended done with nothing to merge (no pull request, and none to come from its thread's branch: jobs.ts
// handOn), failed, or was cancelled (ledger.ts cancelled, a meeting's end: meetingseats.ts) ends its thread as a merge
// would, if it's one of HQ's one-task threads (made.ts oneTaskThread: a routine's run, HQ's own check), once all of it
// is in. In a routine's run a failed task with no replacement is in too: the routine runs again at its next time, in a
// thread of its own. HQ's other one-task threads (a check, a note's job, a repair) wait for a failed task's takeover
// (takeover.ts), which goes on in its thread. A cancelled task is no task at all (threadorder.ts tasksOf). Never while
// the thread's branch holds pushed work (threadorder.ts pushed), and never an owner's thread, which may get its next task
// yet (hq plan done ends it). A one-task thread with no tasks (a meeting's: its seats aren't tasks; a cancelled run's)
// ends once none of its jobs is open.
export function endedEmpty(id: string) {
  const thread = findThread(id);
  if (thread?.status !== 'open' || thread.branch || !oneTask(thread.id)) return;
  if (tasksOf(thread.id).length) return closeIfDone(thread.id, routineRun(thread.id));
  if (!db.prepare(`select 1 from jobs where thread = ? and status in ${jobs.OPEN_JOBS}`).get(thread.id)) close(thread);
}
// Whether a thread is a routine's run: its job is one the schedule recorded (schedule.ts run)
const routineRun = (thread: string) =>
  !!db.prepare('select 1 from schedule_runs r join jobs j on j.id = r.job where j.thread = ?').get(thread);
