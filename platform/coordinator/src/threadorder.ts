// Threads in order (../docs/projects.md, "Threads in order"): while the company plans by threads (projects.yaml
// `planning: threads`), a thread's tasks run one at a time in their order (jobs.seq, else their ids) on one branch, the
// first to push work's, and each task's push opens the thread's one pull request or starts its next round. The thread's
// next task to start waits until every thread it needs is done and merged, and until no job of that pull request is open
// that pushes to its branch. The claim and the play take the order as edges of planner.ts precedence
// (backlog.ts puts them on the queue), the worker through the claim's answer (inThread) and thread-push. Off, nothing
// here holds anything; switching it off drains the threads first, each thread branch's work opening its pull request
// (threadends.ts).
import { db, mergePending, prepared, setting } from './db.ts';
import { ceo, type Project } from './company.ts';
import { findProject, findThread, needsOf, type Thread } from './projects.ts';
import * as jobs from './jobs.ts';
import * as reviewclosure from './reviewclosure.ts';
import type { Planned } from './eta.ts';
import { mergeBoundaries } from './threadboundary.ts';

// Threads with every thread they need (in the list) before them, otherwise in their order
export function inNeedsOrder(threads: Thread[]) {
  const left = new Map(threads.map(t => [t.id, t])),
    ordered: Thread[] = [];
  const visit = (t: Thread) => {
    if (!left.delete(t.id)) return;
    for (const n of needsOf(t.id)) if (left.has(n)) visit(left.get(n)!);
    ordered.push(t);
  };
  for (const t of threads) visit(t);
  return ordered;
}

// The switch as HQ holds it, moved after projects.yaml's `planning:` by threadends.ts watch: threads; draining, switched
// off with thread work still to open its pull request, the order holding meanwhile; or off. The claim reads this, never
// the file.
export type Mode = 'threads' | 'draining' | 'off';
export const MODE = 'planning.mode';
export const mode = () => (setting(MODE) ?? 'off') as Mode;
// Planning by threads: the refusals and the placeholders
export const on = () => mode() === 'threads';
// The order holds the queue: planning by threads, or draining out of it
export const ordered = () => mode() !== 'off';

// A task: a work job in a thread that isn't a pull request's (its fixes and updates are the pull request's).
type Job = { id: number; kind: string; pr: number | null; thread: string | null; branch: string | null };
export const isTask = (j: Job): j is Job & { thread: string } => j.kind === 'work' && j.pr === null && !!j.thread;
export type Task = jobs.Named & {
  id: number;
  agent: string;
  status: string;
  branch: string | null;
  session: string | null;
  started: string | null;
  until: number; // (the time it waits for, hq job --when, while it waits)
};
const OPEN = ['queued', 'running', 'blocked'];

// A thread's tasks in order: those cancelled, and those failed with another in their place or an open pull request on their
// branch (jobs.ts failedAside), aside. A replacement takes the place of the task it replaces (jobs.ts createJob).
export const tasksOf = (thread: string) => {
  return prepared(
    `select j.id, j.agent, j.title, j.step, j.round, j.status, j.branch, j.session, j.started,
      max(0, coalesce((select max(cast(arg as real)) from wakes where job = j.id and kind = 'at' and met is null), 0)) until
      from jobs j where j.thread = ? and j.kind = 'work' and j.pr is null and j.status != 'cancelled' and not ${jobs.failedAside('j')}
      order by coalesce(j.seq, j.id), j.id`,
  ).all(thread) as Task[];
};

// The thread's tasks in the order they take their turns: those started, as they started; then those not started in the
// thread's order, but one waiting for a time still to come (hq job --when) behind them, so a clock holds no task that
// can start before it. Its time come, it takes its place again before the tasks that haven't started. The order as drawn
// (tasksOf) stays for the rest.
export function inTurn(tasks: Task[], now = Date.now()) {
  const started = (t: Task) => t.status !== 'queued' || !!t.started;
  const timed = (t: Task) => t.until > now;
  const begun = tasks.filter(started).sort((a, b) => compareTimestamps(a.started ?? '', b.started ?? ''));
  const waiting = tasks.filter(t => !started(t) && !timed(t)),
    later = tasks.filter(t => !started(t) && timed(t));
  return { turn: [...begun, ...waiting, ...later], timedFrom: begun.length + waiting.length };
}
const compareTimestamps = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// What holds a task in its thread's order: the task before it still to end (follows: until it's done, pushed with its
// gates passed), a task before it that failed with nothing in its place (failed), and for the thread's next task to
// start the open job of the thread's pull request that pushes to its branch (round: a fix, or a ruling that may touch
// it up), so two sessions never push to one branch, and each thread it needs that isn't done (needs: that thread's last
// task still to merge, until it merges; null for a thread with no such task, which holds it until its owner draws it or
// closes it). Draining: while the company switches planning off, a task that hasn't started waits for its thread
// branch's work to open its pull request (threadends.ts).
export type Waits = {
  follows: number | null;
  failed: number | null;
  round: number | null;
  needs: { thread: string; task: number | null }[];
  draining: boolean;
};
// The thread's tasks and each one's waits in their turns (inTurn), read once per thread for a whole queue (the claim's,
// the play's, a list's).
export function reader() {
  type Read = {
    tasks: Task[];
    turn: Task[];
    timedFrom: number;
    first: number | null;
    branch: string | null;
    round: number | null;
  };
  const threads = new Map<string, Read>();
  const draining = mode() === 'draining';
  const of = (thread: string) => {
    if (!threads.has(thread)) {
      const tasks = tasksOf(thread),
        { turn, timedFrom } = inTurn(tasks);
      const branch = findThread(thread)?.branch ?? null;
      threads.set(thread, {
        tasks,
        turn,
        timedFrom,
        first: turn.find(t => OPEN.includes(t.status))?.id ?? null,
        branch,
        round: branch ? pushingOn(branch) : null,
      });
    }
    return threads.get(thread)!;
  };
  const waits = (id: number, thread: string): Waits => {
    const { turn, timedFrom, branch, round } = of(thread),
      at = turn.findIndex(t => t.id === id);
    // (work not in the thread yet, hq when's: at its end, before the tasks waiting for a time)
    const before = at < 0 ? turn.slice(0, timedFrom) : turn.slice(0, at);
    const next = !before.some(t => OPEN.includes(t.status));
    return {
      follows: before.findLast(t => OPEN.includes(t.status))?.id ?? null,
      failed: before.find(t => t.status === 'failed')?.id ?? null,
      round: next ? round : null,
      needs: next ? needsOpen(thread) : [],
      draining: draining && !!branch && !turn[at]?.session,
    };
  };
  return { of, waits };
}
// The open job of the branch's open pull request that pushes to the branch: its author's fix or update, or a ruling
// that may push touch-ups (review.ts touchupFiles)
function pushingOn(branch: string) {
  const job = prepared(
    `select j.id from jobs j join prs p on p.number = j.pr where p.branch = ? and p.status in ${jobs.OPEN_PRS}
    and j.status in ('queued', 'running', 'blocked') and (j.kind = 'work' or (j.kind = 'consolidate' and j.writes is not null))
    order by j.id desc limit 1`,
  ).get(branch) as { id: number } | undefined;
  return job?.id ?? null;
}
// Each thread whose work is still needed, with its last task still to merge
function needsOpen(thread: string) {
  return needsOf(thread).flatMap(n => {
    const needed = findThread(n);
    if (!needed || needed.status === 'done') return [];
    const last = db
      .prepare(
        `select j.id from jobs j where j.thread = ? and j.kind = 'work' and j.pr is null and ${mergePending('j')}
        order by coalesce(j.seq, j.id) desc, j.id desc limit 1`,
      )
      .get(needed.id) as { id: number } | undefined;
    if (!last) {
      const tasks = prepared(
        "select id, status, branch from jobs where thread = ? and kind = 'work' and pr is null",
      ).all(needed.id) as Pick<Task, 'id' | 'status' | 'branch'>[];
      const settled = (t: (typeof tasks)[number]) =>
        t.status === 'cancelled' ||
        (t.status === 'done' && ['merged', 'dropped'].includes(reviewclosure.status(jobs.workBranchOf(t)) ?? 'merged'));
      if (tasks.length && tasks.every(settled)) return [];
    }
    return [{ thread: needed.id, task: last?.id ?? null }];
  });
}

// ---- the queue (backlog.ts): the edges, the branch its review is on

export type Placed = {
  follows?: number;
  needs?: number[];
  stalls: string[];
  branch: string;
};
// Each open task of the queue as its thread's order places it, given the threads' placeholders (a thread with no task
// drawn yet plays as one: placeholders). A need on a thread with neither holds it (stalls), as does a failed task before it.
export function placing(placeholders: Pick<Planned, 'id' | 'thread'>[] = [], rows: (Job & { status: string })[] = []) {
  const read = reader();
  const standIn = new Map(placeholders.map(p => [p.thread!, p.id]));
  const boundaries = new Map<string, Map<number, number>>();
  const threads = new Set(rows.filter(row => isTask(row) && OPEN.includes(row.status)).map(row => row.thread!));
  const allTasks = [...threads].flatMap(thread => read.of(thread).tasks);
  const jobIds = [...new Set([...rows, ...allTasks].map(task => task.id))];
  const waits = jobs.outstandingWaitsByJob(jobIds);
  const place = (row: Job & { status: string }): Placed | undefined => {
    if (!isTask(row) || !OPEN.includes(row.status)) return undefined;
    const w = read.waits(row.id, row.thread);
    const needs = w.needs.map(n => ({ ...n, task: n.task ?? standIn.get(n.thread) ?? null }));
    const { tasks, first, branch: threadBranch } = read.of(row.thread);
    // A task waiting for an earlier task's merge starts a fresh branch after that merge clears the thread's branch.
    if (!boundaries.has(row.thread)) boundaries.set(row.thread, mergeBoundaries(tasks, waits));
    const boundary = boundaries.get(row.thread)!.get(row.id);
    const branch = row.branch ?? (boundary ? `job/${boundary}` : (threadBranch ?? `job/${first ?? row.id}`));
    const follows = w.follows ?? w.round;
    return {
      ...(follows !== null && { follows }),
      ...(needs.some(n => n.task !== null) && { needs: needs.flatMap(n => n.task ?? []) }),
      stalls: [
        ...(w.failed === null ? [] : [`task #${w.failed} before it in its thread failed with nothing in its place`]),
        ...needs
          .filter(n => n.task === null)
          .map(n => `it needs ${n.thread}, which has no work to merge: its owner draws it or closes it (hq plan)`),
        ...(w.draining ? [DRAINING] : []),
      ],
      branch,
    };
  };
  return { place, waits };
}

const DRAINING = "planning is switching off: it starts once its thread branch's work has opened its pull request";

// The open threads with no task yet, each played as one piece of its owner's work under its name and "done when"
// (sized by predictions.ts prepared), with ids of their own below hq when's. A thread's tasks are read from jobs_tasks,
// whose condition is the task's: left to the planner, it takes jobs_thread_state and reads every job row of each open
// thread for its kind and pull request, past the brief (a second a play on a cold file).
export function placeholders(): Omit<Planned, 'size'>[] {
  if (!on()) return [];
  const empty = db
    .prepare(
      `select t.* from threads t where t.status = 'open' and not exists (select 1 from jobs j indexed by jobs_tasks
      where j.thread = t.id and j.kind = 'work' and j.pr is null and j.status != 'cancelled') order by t.created, t.id`,
    )
    .all() as Thread[];
  return empty.flatMap((t, i) => {
    const owner = findProject(t.project)?.owner;
    if (!owner) return [];
    const engine = jobs.findAgent(owner)?.engine ?? 'claude';
    return [{ id: -1000 - i, agent: owner, title: `${t.name}: ${t.goal}`, engine, thread: t.id, placeholder: true }];
  });
}

export const openPr = (branch: string) =>
  prepared(`select number from prs where branch = ? and status in ${jobs.OPEN_PRS} order by number desc limit 1`).get(
    branch,
  ) as { number: number } | undefined;

// ---- what the claim and the worker read

// A task the claim starts (jobs.ts claim): one after the thread's work was pushed runs on the thread's branch
// (jobs.branch), the thread's first on its own. Its place for the briefing (the worker's inThread).
export function claimed(job: Job) {
  if (!ordered() || !isTask(job)) return undefined;
  const thread = findThread(job.thread);
  if (!thread) return undefined;
  if (thread.branch && !job.branch) {
    db.prepare('update jobs set branch = ? where id = ?').run(thread.branch, job.id);
    job.branch = thread.branch;
  }
  const tasks = inTurn(tasksOf(thread.id)).turn,
    at = tasks.findIndex(t => t.id === job.id);
  const before = at > 0 ? tasks[at - 1] : undefined;
  return {
    ...{ id: thread.id, name: thread.name, goal: thread.goal, place: at + 1, of: tasks.length },
    before: before ? { id: before.id, agent: before.agent, title: jobs.nameOf(before) } : null,
  };
}

// A task's finish that pushed work (a commit, a pull request) makes its branch the thread's, the branch each later task
// runs on, until it merges (threadends.ts merged). So does one that failed after its push, with GitHub's refusal of its
// pull request (the worker's land), so the task taking its place pushes there. One that pushed nothing leaves the
// thread without a branch.
export function pushed(job: Job, r: { status: string; branch?: string; sha?: string; pr?: number }) {
  if (!ordered() || !isTask(job) || !['done', 'failed'].includes(r.status) || !r.branch || !(r.sha || r.pr)) return;
  db.prepare("update threads set branch = ? where id = ? and branch is null and status = 'open'").run(
    r.branch,
    job.thread,
  );
}

// The thread's pull request as a task's push opens it: titled with the thread's name, its "done when" and its tasks in
// the body (the worker adds that task's report). Its later tasks' pushes are its next rounds.
export function pullOf(id: number) {
  const job = db.prepare('select id, kind, pr, thread, branch from jobs where id = ?').get(id) as Job | undefined;
  const thread = job && ordered() && isTask(job) ? findThread(job.thread) : undefined;
  if (!thread) return undefined;
  const tasks = tasksOf(thread.id).map(t => `- #${t.id}, ${t.agent}: ${jobs.nameOf(t)}`);
  return {
    title: thread.name,
    body: `The thread ${thread.id}, done when: ${thread.goal}\n\nIts tasks:\n${tasks.join('\n')}`,
  };
}

// A task that ended on its thread's branch: its waits are met when the thread's work merges, never stranded (jobs.ts
// finish)
export function onThreadBranch(job: Job, branch = jobs.workBranchOf(job)) {
  return isTask(job) && findThread(job.thread)?.branch === branch;
}

// ---- who changes a plan, and hq job's refusals

// Why `agent` may not change the project's plan (plan.ts), with what to do instead; undefined when it may.
export function refusal(project: Project, agent: string) {
  if (agent === project.owner || agent === ceo()) return undefined;
  return `${project.name}'s plan is ${project.owner}'s (and the CEO's) to change: propose it to ${project.owner} with hq propose --project ${project.id} "title" <brief-file>`;
}

// hq job from a running job while the company plans by threads (server.ts): only the project's owner or the CEO adds
// a task to a thread (anyone else proposes it), and no job waits --after a job in another thread (a need, the owner's to
// draw) or in its own (its tasks run in order).
export function jobRefusal(agent: string, thread: string | null, after?: number) {
  if (!on() || !thread) return undefined;
  const project = findProject(thread.split('/')[0]);
  const notYours = project && refusal(project, agent);
  if (notYours) return `${thread}'s tasks are drawn by its owner: ${notYours}`;
  const theirs = after ? jobs.threadOf(after) : null;
  if (!theirs) return undefined;
  return theirs === thread
    ? `#${after} is in ${thread} too, whose tasks run one after another already: leave out --after (hq plan move reorders them)`
    : `#${after} is in ${theirs}: a wait between threads is a need, drawn by ${thread}'s owner: hq plan need ${thread} ${theirs}`;
}

// ---- in words (hq jobs, HQ's line: jobs.ts jobRows) and for checks that read the queue without the plan

// What holds a queued task in its thread's order, in words, each thread read once for a list
export function words() {
  const read = reader(),
    planning = ordered();
  return (row: Job & { status: string }) => (planning ? heldWords(read, row) : []);
}
function heldWords(read: ReturnType<typeof reader>, row: Job & { status: string }) {
  if (!isTask(row) || row.status !== 'queued') return [];
  const w = read.waits(row.id, row.thread);
  return [
    ...(w.follows === null ? [] : [`after #${w.follows} in its thread`]),
    ...(w.failed === null ? [] : [`task #${w.failed} before it failed`]),
    ...(w.round === null ? [] : [`until #${w.round} on its thread's pull request ends`]),
    ...w.needs.map(n => `until ${n.thread} merges`),
    ...(w.draining ? ["until its thread's pull request opens (planning switching off)"] : []),
  ];
}
// Whether the order holds the job (followthrough.ts's and stalls.ts's ready work)
export function holds(id: number) {
  if (!ordered()) return false;
  const row = db.prepare('select id, kind, pr, thread, branch, status from jobs where id = ?').get(id) as
    (Job & { status: string }) | undefined;
  return !!row && words()(row).length > 0;
}
