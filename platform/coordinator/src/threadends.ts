// A thread's end, and the switch's (../docs/projects.md, "Threads in order"): a merge clears the thread's branch and
// closes each thread whose work is all in, switch on or off; switching threads in order off drains them, each thread
// branch's work opening its pull request (the revert).
import { db, once, planChange, remember } from './db.ts';
import * as reviewclosure from './reviewclosure.ts';
import { projects } from './company.ts';
import * as jobs from './jobs.ts';
import { MODE, mode, openPr, tasksOf, type Task } from './threadorder.ts';
import { findThread, type Thread } from './projects.ts';
import { oneTask } from './made.ts';

// A pull request merged (review.ts pullRequestMerged): the thread starts its next task on a new branch. Each thread
// whose work it held is done once every task in it is done and merged (or done with nothing to merge).
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
    for (const { thread } of threads) closeIfDone(thread);
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

// ---- the switch

// Every minute (server.ts): projects.yaml's `planning:` moves the switch HQ holds (threadorder.ts mode), which the claim
// reads. On, it is on at once. Off, it drains first: each thread whose branch holds pushed work and whose tasks are idle
// opens that work's pull request, and the thread's queued tasks wait for it to merge; meanwhile the order still holds,
// and a task that hasn't started waits for its thread's pull request (threadorder.ts waits). It is off once every thread
// is through. A file that doesn't parse throws here, and the switch stays as it was.
export function watch() {
  if (projects().planning === 'threads') {
    if (mode() !== 'threads') remember(MODE, 'threads');
    return;
  }
  if (mode() === 'off') return;
  remember(MODE, 'draining');
  const open = () => db.prepare("select * from threads where status = 'open' order by id").all() as Thread[];
  for (const t of open().filter(t => t.branch && !busy(t.id)))
    try {
      reopen(t);
    } catch (err) {
      console.error(`Planning off: ${t.id}'s pull request not opened:`, err);
    }
  if (!open().some(t => t.branch || busy(t.id))) remember(MODE, 'off');
}
// A thread with a task running, waiting for the board, or back in the queue to go on in its session (its gates)
const busy = (thread: string) =>
  tasksOf(thread).some(t => t.status === 'running' || t.status === 'blocked' || (t.status === 'queued' && t.session));
// A thread's branch, drained: its work opens its pull request, reviewed by today's panel (one already open stays), and
// the thread's queued tasks wait for it to merge, so nothing runs on work it can't see. Opening it is a job of the agent
// of the last task that pushed to it, on the branch: bring it up to date and stop, the worker opens it. The thread is
// left without a branch.
function reopen(t: Thread) {
  const last = db
    .prepare(
      `select id, agent from jobs where kind = 'work' and status in ('done', 'failed') and coalesce(branch, 'job/' || id) = ?
      order by id desc limit 1`,
    )
    .get(t.branch) as { id: number; agent: string } | undefined;
  const pr = openPr(t.branch!);
  const waitOn = !last
    ? undefined
    : pr
      ? last.id
      : jobs.createJob({
          agent: last.agent,
          title: `Opening the pull request of the thread "${t.name}"`,
          prompt:
            `The company plans its work today's way again, so the thread "${t.name}" (${t.id}) opens its pull request now ` +
            `with the work its tasks pushed to ${t.branch}, which you are on. Merge origin/main into it (keep both sides), ` +
            `run \`npm run gates\` and fix what they report, and stop: the worker opens the pull request for the review. ` +
            `Change nothing else; the thread's queued tasks wait for it to merge.`,
          branch: t.branch!,
          thread: t.id,
        }).id;
  const queued = tasksOf(t.id).filter(q => q.status === 'queued' && q.id !== waitOn);
  // (before them in the thread's order, should the company plan by threads again while it's queued)
  if (waitOn && !pr && queued.length)
    db.prepare('update jobs set seq = (select coalesce(seq, id) from jobs where id = ?) - 0.5 where id = ?').run(
      queued[0].id,
      waitOn,
    );
  const wait = db.prepare('insert or ignore into waits (job, on_job) values (?, ?)');
  if (waitOn) for (const q of queued) wait.run(q.id, waitOn);
  db.prepare('update threads set branch = null where id = ?').run(t.id);
  planChange({
    project: t.project,
    thread: t.id,
    what: !waitOn
      ? `planning off: ${t.branch} had no finished task to open its pull request`
      : `planning off: ${pr ? `pull request #${pr.number}` : `job #${waitOn} opens the pull request`} of ${t.branch}, which ${queued.length} queued task(s) wait for`,
    by: 'hq',
  });
}
