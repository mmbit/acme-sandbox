// Threads in order (../docs/projects.md, "Deliverables in order"), how the platform plans: a thread's tasks run one at a time
// in their order (jobs.seq, else their ids) on one branch, the first to push work's, and a task's push opens the thread's
// one pull request or starts its next round, unless the thread's next task starts now (nextReady): then the review waits
// for that task's push. The thread's next task to start waits until every thread it needs is done and merged, and until
// no job of that pull request is open that pushes to its branch. The claim and the play take the order as edges of
// planner.ts precedence (backlog.ts puts them on the queue), the worker through the claim's answer (inThread) and
// thread-push.
// (its messages say deliverable, the board's word for a thread)
import { db, prepared } from './db.ts';
import { ceo, type Project } from './company.ts';
import { findProject, findThread, needsOf, type Thread } from './projects.ts';
import * as jobs from './jobs.ts';
import type { Planned } from './eta.ts';
import { mergeBoundaries } from './threadboundary.ts';
import { needsReader } from './threadneedsopen.ts';
import { waitsUntil } from './wakes.ts';
import * as redraws from './redraws.ts';

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

// A task: a work job in a thread that isn't a pull request's (its fixes and updates are the pull request's).
export type Job = { id: number; kind: string; pr: number | null; thread: string | null; branch: string | null };
// A fix for a round's findings or the board's notes (matching.ts ORIGIN's 'fix'), a thread's task or a pull request's
export const answersRound = (j: { stage: string | null; round: number | null }) =>
  j.stage === 'feedback' || (j.stage === 'fix' && j.round !== null);
export const isTask = (j: Job): j is Job & { thread: string } => j.kind === 'work' && j.pr === null && !!j.thread;
// An --after (`job`'s, on `prior`, SQL row aliases) on a task before it in its own thread: the waiting task needs its
// work, so the thread's order holds it behind that task (follows: until it's done, inTurn), and the thread's one pull
// request merges only with the waiting task's own work, so as a merge wait it would wait for itself. The claim (jobs.ts
// READY) and the play (placing's inOrder) read it as the order. A wait (hq waits) on such a task stays a merge: the
// waiting task starts a branch of its own (threadboundary.ts). (needs its work)
export function afterInOrder(job: string, prior: string) {
  return `(${prior}.thread = ${job}.thread and ${prior}.kind = 'work' and ${prior}.pr is null and ${job}.kind = 'work'
    and ${job}.pr is null and (coalesce(${prior}.seq, ${prior}.id), ${prior}.id) < (coalesce(${job}.seq, ${job}.id), ${job}.id))`;
}
export type Task = jobs.Named & {
  id: number;
  agent: string;
  status: string;
  branch: string | null;
  session: string | null;
  started: string | null;
  created: string;
  finished: string | null;
  after: number | null;
  until: number; // (the time it waits for, hq job --when, while it waits)
};
const OPEN = ['queued', 'running', 'blocked'];

// A thread's tasks in order: those cancelled, and those failed with another in their place, an open pull request on their
// branch, or their own pushed work merged (jobs.ts failedAside), aside. A replacement takes the place of the task it
// replaces (jobs.ts createJob). (created and finished)
export const tasksOf = (thread: string) => {
  return prepared(
    `select j.id, j.agent, j.title, j.step, j.round, j.status, j.branch, j.session, j.started, j.created, j.finished,
      j.after, max(0, ${waitsUntil('j.id')}) until
      from jobs j where j.thread = ? and j.kind = 'work' and j.pr is null and j.status != 'cancelled' and not ${jobs.failedAside('j')}
      order by coalesce(j.seq, j.id), j.id`,
  ).all(thread) as Task[];
};

// The thread's tasks in the order they take their turns: those started, as they started; then those not started in the
// thread's order, but one held by a wait of its own (a time still to come, a card, a job, an event: `held`, heldTasks) or
// queued --after a task before it that's held (it needs that task's work) behind them, so no wait holds a task that can
// start before it. Its wait met, it takes its place again before the tasks that haven't started. The order as drawn
// (tasksOf) stays for the rest. (waits besides a time, and --after)
export function inTurn(tasks: Task[], held: ReadonlySet<number>, now = Date.now()) {
  const started = (t: Task) => t.status !== 'queued' || !!t.started;
  const waiting = new Set<number>();
  for (const t of tasks)
    if (!started(t) && (t.until > now || held.has(t.id) || (t.after !== null && waiting.has(t.after))))
      waiting.add(t.id);
  const begun = tasks.filter(started).sort((a, b) => compareTimestamps(a.started ?? '', b.started ?? ''));
  const ready = tasks.filter(t => !started(t) && !waiting.has(t.id)),
    later = tasks.filter(t => waiting.has(t.id));
  return { turn: [...begun, ...ready, ...later], heldFrom: begun.length + ready.length };
}
// The queued tasks not started held by a wait of their own but a time (jobs.ts OWN_WAIT), in every thread, or in one.
// Read from the open tasks' index (db.ts jobs_open_tasks), never every job's row.
export function heldTasks(thread?: string) {
  const rows = prepared(
    redraws.query(`select j.id from jobs j indexed by jobs_open_tasks where j.kind = 'work' and j.pr is null
      and j.status in ('queued', 'running', 'blocked') and j.status = 'queued' and j.started is null
      and ($thread is null and j.thread is not null or j.thread = $thread) and ${jobs.OWN_WAIT}`),
  ).all({ thread: thread ?? null }) as { id: number }[];
  return new Set(rows.map(row => row.id));
}
// A thread's tasks in their turns (inTurn)
export const turnOf = (thread: string) => inTurn(tasksOf(thread), heldTasks(thread));
const compareTimestamps = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// What holds a task in its thread's order: the task before it still to end (follows: until it's done, pushed with its
// gates passed), a task before it that failed with nothing in its place before the task was drawn (failed), and for
// the thread's next task to start the open job of the thread's pull request that pushes to its branch (round: a fix,
// or a ruling that may touch it up), so two sessions never push to one branch, and each thread it needs that isn't
// done (needs: that thread's last task still to merge, until it merges; null for a thread with no such task, which
// holds it until its owner draws it or closes it). (failed, drawn before)
export type Waits = {
  follows: number | null;
  failed: number | null;
  round: number | null;
  needs: { thread: string; task: number | null }[];
};
type ThreadReading = {
  tasks: Task[];
  turn: Task[];
  heldFrom: number;
  first: number | null;
  branch: string | null;
  status: Thread['status'] | undefined;
  round: number | null;
};
// A failed task holds the tasks drawn before it ended, which counted on its work. One drawn since (the next step, a
// failed task's redo queued without --lands) is its owner's call, made knowing it failed, as is work not drawn yet:
// held, it would wait for a replacement that is already there. (A stopped task's redo takes its place: takeover.ts
// stopFor.) The failed task still keeps the deliverable unfinished, and its
// merge wakes the owner (threadends.ts). (drawnAt: when the task was drawn; null for work not drawn yet)
function failedBefore(before: Task[], drawnAt: string | null) {
  const countedOn = (t: Task) => drawnAt !== null && (t.finished === null || drawnAt < t.finished);
  return before.find(t => (t.status === 'failed' || t.status === 'stopped') && countedOn(t))?.id ?? null;
}
// The thread's tasks and each one's waits in their turns (inTurn), read once per thread for a whole queue (the claim's,
// the play's, a list's).
export function reader() {
  const threads = new Map<string, ThreadReading>();
  const openNeeds = needsReader(thread => failedHold(thread));
  let heldNow: Set<number> | undefined;
  const held = () => (heldNow ??= heldTasks());
  const of = (thread: string) => {
    if (!threads.has(thread)) {
      const tasks = tasksOf(thread),
        { turn, heldFrom } = inTurn(tasks, held());
      const current = findThread(thread);
      const branch = current?.branch ?? null;
      threads.set(thread, {
        tasks,
        turn,
        heldFrom,
        first: turn.find(t => OPEN.includes(t.status))?.id ?? null,
        branch,
        status: current?.status,
        round: branch ? pushingOn(branch) : null,
      });
    }
    return threads.get(thread)!;
  };
  // The failed task that holds the thread's next task to start, if one does: none of its tasks starts until its owner
  // acts (failedWords).
  const failedHold = (thread: string) => {
    const { turn } = of(thread),
      at = turn.findIndex(t => OPEN.includes(t.status));
    return at < 0 ? null : failedBefore(turn.slice(0, at), turn[at].created);
  };
  const waits = (id: number, thread: string): Waits => {
    const { turn, heldFrom, round } = of(thread),
      at = turn.findIndex(t => t.id === id);
    // (work not in the thread yet, hq when's: at its end, before the tasks held by a wait of their own)
    const before = at < 0 ? turn.slice(0, heldFrom) : turn.slice(0, at);
    const next = !before.some(t => OPEN.includes(t.status));
    return {
      follows: before.findLast(t => OPEN.includes(t.status))?.id ?? null,
      failed: failedBefore(before, at < 0 ? null : turn[at].created),
      round: next ? round : null,
      needs: next ? openNeeds(thread) : [],
    };
  };
  return { of, waits, failedHold };
}
// The project's open threads whose next task a failed task holds (reader's failedHold), each with that task: what's
// drawn next chains past them (newthread.ts chainedAfter).
export function failedHeld(project: string) {
  const read = reader();
  const open = prepared(
    `select t.id from threads t where t.project = ? and t.status = 'open' and exists (select 1 from jobs j
      where j.thread = t.id and j.kind = 'work' and j.pr is null and j.status in ('queued', 'running', 'blocked'))`,
  ).all(project) as { id: string }[];
  const held = new Map<string, number>();
  for (const t of open) {
    const failed = read.failedHold(t.id);
    if (failed !== null) held.set(t.id, failed);
  }
  return held;
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
    const { turn, first, branch: threadBranch } = read.of(row.thread);
    // A task waiting for an earlier task's merge starts a fresh branch after that merge clears the thread's branch, and
    // so do the tasks after it in the thread's turn (inTurn). (the turn)
    if (!boundaries.has(row.thread)) boundaries.set(row.thread, mergeBoundaries(turn, waits));
    const boundary = boundaries.get(row.thread)!.get(row.id);
    const branch = row.branch ?? (boundary ? `job/${boundary}` : (threadBranch ?? `job/${first ?? row.id}`));
    const follows = w.follows ?? w.round;
    return {
      ...(follows !== null && { follows }),
      ...(needs.some(n => n.task !== null) && { needs: needs.flatMap(n => n.task ?? []) }),
      stalls: [
        ...(w.failed === null ? [] : [failedWords(w.failed)]),
        ...needs
          .filter(n => n.task === null)
          .map(n => `it needs ${n.thread}, which has no work to merge: its owner draws it or closes it (hq plan)`),
      ],
      branch,
    };
  };
  const branchTask = branchCarrier(read, rows, place);
  // (an --after on a task before it in its thread, which the order covers: afterInOrder, whatever that task's status)
  const inOrder = (row: Job, prior: number) =>
    !!prepared(`select 1 from jobs j join jobs a on a.id = ? where j.id = ? and ${afterInOrder('j', 'a')}`).get(
      prior,
      row.id,
    );
  return { place, waits, inOrder, branchTask };
}

// A failed task's hold, with what ends it: its owner lands its work again, or puts a task queued since in its place
// (takeover.ts landing, stopFor).
const failedWords = (failed: number) =>
  `task #${failed} before it in its deliverable failed with nothing in its place: its owner lands it again ` +
  `(hq job --lands ${failed}) or puts a task queued or under way since in its place (hq stop ${failed} "why" --for <job>)`;

// A finished task's wait follows the last remaining task on its open deliverable's current branch.
function branchCarrier(
  read: ReturnType<typeof reader>,
  rows: (Job & { status: string })[],
  place: (row: Job & { status: string }) => Placed | undefined,
) {
  const remaining = new Map(rows.map(row => [row.id, row]));
  return (before: Job & { status: string }) => {
    if (before.status !== 'done' || !isTask(before)) return;
    const { turn, branch, status } = read.of(before.thread);
    if (status !== 'open' || branch !== jobs.workBranchOf(before)) return;
    return turn.findLast(task => {
      const row = remaining.get(task.id);
      return row && place(row)?.branch === branch;
    })?.id;
  };
}

// The open threads with no task yet, each played as one piece of its owner's work under its name and "done when"
// (sized by predictions.ts prepared), with ids of their own below hq when's. A thread's tasks are read from jobs_tasks,
// whose condition is the task's: left to the planner, it takes jobs_thread_state and reads every job row of each open
// thread for its kind and pull request, past the brief (a second a play on a cold file).
export function placeholders(): Omit<Planned, 'size'>[] {
  const empty = db
    .prepare(
      `select t.* from threads t where t.status = 'open' and not exists (select 1 from jobs j indexed by jobs_tasks
      where j.thread = t.id and j.kind = 'work' and j.pr is null and j.status != 'cancelled') order by t.created, t.id`,
    )
    .all() as Thread[];
  // One org-chart lookup per owner: findAgent copies the chart, and each plan write's loop check reads placeholders twice.
  const engines = new Map<string, string>();
  const engineOf = (owner: string) =>
    engines.get(owner) ?? engines.set(owner, jobs.findAgent(owner)?.engine ?? 'claude').get(owner)!;
  return empty.flatMap((t, i) => {
    const owner = findProject(t.project)?.owner;
    if (!owner) return [];
    const engine = engineOf(owner);
    return [{ id: -1000 - i, agent: owner, title: `${t.name}: ${t.goal}`, engine, thread: t.id, placeholder: true }];
  });
}

// ---- what the claim and the worker read

// A task the claim starts (jobs.ts claim): one after the thread's work was pushed runs on the thread's branch
// (jobs.branch), the thread's first on its own. Its place for the briefing (the worker's inThread).
export function claimed(job: Job) {
  if (!isTask(job)) return undefined;
  const thread = findThread(job.thread);
  if (!thread) return undefined;
  if (thread.branch && !job.branch) {
    db.prepare('update jobs set branch = ? where id = ?').run(thread.branch, job.id);
    job.branch = thread.branch;
  }
  const tasks = turnOf(thread.id).turn,
    at = tasks.findIndex(t => t.id === job.id);
  const before = at > 0 ? tasks[at - 1] : undefined;
  return {
    ...{ id: thread.id, name: thread.name, goal: thread.goal, place: at + 1, of: tasks.length },
    before: before ? { id: before.id, agent: before.agent, title: jobs.nameOf(before) } : null,
  };
}

export { pushed, pullOf } from './threadpush.ts';

// The task after job `id` in its thread's turns, if it's a task and that one starts now: running, or queued with
// nothing to wait for but a seat (jobs.ts readyWork). Its push waits for it (review.ts heldForThread). Undefined for a
// next task that waits for a time, a card or another thread's merge, and for a fix of a review's findings or the
// board's notes (a task drawn from the inbox, reviewinbox.ts accept): its push answers the round, so it goes to review
// at once rather than wait on a later task.
export function nextReady(id: number) {
  const job = db.prepare('select id, kind, pr, thread, branch, stage, round from jobs where id = ?').get(id) as
    (Job & { stage: string | null; round: number | null }) | undefined;
  if (!job || !isTask(job) || answersRound(job)) return undefined;
  const { turn } = turnOf(job.thread),
    at = turn.findIndex(t => t.id === id);
  const next = at < 0 ? undefined : turn.slice(at + 1).find(t => OPEN.includes(t.status));
  const starts = next?.status === 'running' || (next?.status === 'queued' && jobs.readyWork().includes(next.id));
  return starts ? next.id : undefined;
}

// A task that ended on its thread's branch: its waits are met when the thread's work merges, never stranded (jobs.ts
// finish)
export function onThreadBranch(job: Job, branch = jobs.workBranchOf(job)) {
  return isTask(job) && findThread(job.thread)?.branch === branch;
}

// ---- who changes a plan, and hq job's refusals

// Why `agent` may not change the project's plan (plan.ts), with what to do instead; undefined when it may. card: one the
// work waits for, which the proposal carries.
export function refusal(project: Project, agent: string, card?: number) {
  if (agent === project.owner || agent === ceo()) return undefined;
  const after = card === undefined ? '' : ` --after request:${card}`;
  return `${project.name}'s plan is ${project.owner}'s (and the CEO's) to change: propose it to ${project.owner} with hq propose --project ${project.id} "title" <brief-file>${after}`;
}

// hq job from a running job (server.ts): only the project's owner or the CEO adds
// a task to a thread (anyone else proposes it), and no job waits --after a job in another thread (a need, the owner's to
// draw). One --after a task in its own thread needs that task's work: it keeps its turn behind it (inTurn). card: the
// card it waits for (refusal). (--after in its own thread)
export function jobRefusal(agent: string, thread: string | null, after?: number, card?: number) {
  if (!thread) return undefined;
  const project = findProject(thread.split('/')[0]);
  const notYours = project && refusal(project, agent, card);
  if (notYours) return `${thread}'s tasks are drawn by its owner: ${notYours}`;
  const theirs = after ? jobs.threadOf(after) : null;
  if (!theirs || theirs === thread) return undefined;
  return `#${after} is in ${theirs}: a wait between deliverables is a need, drawn by ${thread}'s owner: hq plan need ${thread} ${theirs}`;
}

// ---- in words (hq jobs, HQ's line: jobs.ts jobRows) and for checks that read the queue without the plan

// What holds a queued task in its thread's order, in words (a deliverable's, in the board's word), each thread read once for a list
export function words() {
  const read = reader();
  return (row: Job & { status: string }) => heldWords(read, row);
}
function heldWords(read: ReturnType<typeof reader>, row: Job & { status: string }) {
  if (!isTask(row) || row.status !== 'queued') return [];
  const w = read.waits(row.id, row.thread);
  return [
    ...(w.follows === null ? [] : [`after #${w.follows} in its deliverable`]),
    ...(w.failed === null ? [] : [`task #${w.failed} before it failed`]),
    ...(w.round === null ? [] : [`until #${w.round} on its deliverable's pull request ends`]),
    ...w.needs.map(n => `until ${n.thread} merges`),
  ];
}
// Whether the order holds the job (followthrough.ts's and stalls.ts's ready work)
export function holds(id: number) {
  const row = db.prepare('select id, kind, pr, thread, branch, status from jobs where id = ?').get(id) as
    (Job & { status: string }) | undefined;
  return !!row && words()(row).length > 0;
}
