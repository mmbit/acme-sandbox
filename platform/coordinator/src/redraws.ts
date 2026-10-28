// Closed reviews carry merge dependencies across owner decisions, branches and thread boundaries.
// (its messages say deliverable, the board's word for a thread)
import './inbox.ts';
import { PlanCycleError, dependencyGraph, refuseNewLoops } from './plancycles.ts';
import { orderingSnapshot } from './backlog.ts';
import { placeholders } from './threadorder.ts';
import { expand } from './rounds.ts';
import { db, inOneStep, mergePending } from './db.ts';
import { findThread } from './projects.ts';
import { OPEN_JOBS, OPEN_PRS, needsGraph, hasReplacement, waitRelations } from './jobs.ts';

export function close(pr: number, branch: string) {
  db.prepare('insert or ignore into review_redraws (pr, branch) values (?, ?)').run(pr, branch);
}

export function accept(pr: number, job: number) {
  db.prepare('update review_redraws set job = ? where pr = ?').run(job, pr);
}

export function drop(pr: number) {
  db.prepare('update review_redraws set dropped = 1 where pr = ?').run(pr);
}

// Each statement names the relationship once. All predicates below read these relations, without further recursion.
// A job read by id for its status or branch comes from db.ts jobs_state, never its row.
export function query(sql: string, waiter?: string) {
  return `with recursive ${relations(waiter)} ${sql}`;
}

export function relations(waiter?: string) {
  return `${branches()}, ${steps()}, ${walk()}, ${endpoints()}, ${mergedBranches()}, ${holds(waiter)}, ${waitRelations()}`;
}

export function states(origin?: string) {
  if (!origin) return 'select * from redraw_states';
  return `select * from redraw_states where origin = ${origin}
    union all select branch, branch, null, status from review_branches p where branch = ${origin}
      and not exists (select 1 from redraw_states s where s.origin = p.branch)`;
}

export function replacement(job: string) {
  return `select job from redraw_current where prior = ${job}`;
}

export function current(job: string) {
  return `coalesce((${replacement(job)}), ${job})`;
}

export function merged(branch: string) {
  return `exists (select 1 from merged_branches p where p.branch = ${branch})`;
}

export function barriers(job: string) {
  return `select id from redraw_holds where waiter = ${job}`;
}

// Capture membership before a task leaves its thread. Its replacements inherit this hold too.
export function rememberHolds() {
  db.exec(query('insert or ignore into review_holds (branch, job) select origin, waiter from redraw_holds'));
}

// Redraw and review-merge edges in the caller's tasks graph.
export function dependencies() {
  return `select 'thread/' || j.thread, 'job/' || s.job from redraw_states s
        join jobs j on coalesce(j.branch, 'job/' || j.id) = s.origin
        where $ordered and s.job is not null and s.state not in ('merged', 'dropped')
          and j.kind = 'work' and j.thread is not null
      union select 'job/' || j.id, 'job/' || s.job from redraw_states s
        join jobs j on coalesce(j.branch, 'job/' || j.id) = s.origin
        where s.job is not null and s.state not in ('merged', 'dropped')
      union select 'job/' || source.id, 'job/' || fix.id from prs p
        cross join jobs source on coalesce(source.branch, 'job/' || source.id) = p.branch
        join review_fix_tasks f on f.pr = p.number and f.round = p.round
        join tasks fix on fix.id = f.job and fix.branch = p.branch
        where p.status in ${OPEN_PRS} and source.kind = 'work' and source.pr is null and source.status = 'done'
          and not exists (select 1 from review_fix_tasks own where own.job = source.id)
          and fix.status in ${OPEN_JOBS}
      union select 'job/' || j.id, 'job/' || replacement.job from jobs j join redraw_current replacement
        on replacement.prior = j.id where ${hasReplacement('j.id')} and replacement.job != j.id
      union select 'job/' || h.waiter, 'job/' || h.id from redraw_holds h where $ordered`;
}

// A plan write and its dependency check share one transaction, so a newly introduced loop rolls it back.
export function writePlan<T>(change: () => T): T {
  return inOneStep(() => {
    const before = capturePlan();
    const done = change();
    refuseNewLoops(before.graph, capturePlan(before.now).graph);
    return done;
  });
}

// An owner's change to thread order or needs, rolled back if it introduces a dependency cycle.
export function withoutLoop<T>(thread: string, change: () => T): T | string {
  try {
    return writePlan(() => {
      // A moved task can already wait on itself in another thread.
      const waiting = new Set(selfWaitingTasks().map(task => task.id));
      const done = change();
      const currentThread = findThread(thread)!.id;
      const task = selfWaitingTasks(currentThread).find(task => !waiting.has(task.id));
      if (task)
        throw new PlanCycleError(
          `plan cycle: task #${task.id} in ${currentThread} waits on itself. Change its waits, task order or needs`,
        );
      return done;
    });
  } catch (err) {
    if (err instanceof PlanCycleError) return err.message;
    throw err;
  }
}

// Keep dependencies intact for comparison. The live plan cuts retained loops into stalls instead.
function capturePlan(now = Date.now()) {
  const keepLoops = true;
  const queue = orderingSnapshot(now, placeholders(), keepLoops);
  const expanded = expand(queue, new Map(), undefined, keepLoops);
  const threads = db.prepare('select id, rowid from threads').all() as { id: string; rowid: number }[];
  const threadIds = new Map(threads.map(thread => [thread.id, thread.rowid]));
  const identities = new Map(
    queue.jobs.map(task => [task.id, task.placeholder ? `thread/${threadIds.get(task.thread!)!}` : `job/${task.id}`]),
  );
  for (const [id, source] of expanded.sources)
    identities.set(id, JSON.stringify([identities.get(source.owner)!, source.stage]));
  const graph = dependencyGraph(expanded.snapshot.jobs, expanded.terminals, identities);
  return { now, graph };
}

function selfWaitingTasks(thread?: string) {
  const tasks = db
    .prepare(
      `select j.id from jobs j indexed by jobs_merge_pending where (? is null or j.thread = ?)
      and j.kind = 'work' and j.pr is null and ${mergePending('j')}`,
    )
    .all(thread ?? null, thread ?? null) as { id: number }[];
  // (one read of the edges for every task: a walk per task held the server half a minute.)
  const graph = needsGraph();
  return tasks.filter(task => reaches(graph, `job/${task.id}`));
}
// Whether `node` needs itself, at any depth.
function reaches(graph: Map<string, string[]>, node: string) {
  const seen = new Set<string>(),
    next = [...(graph.get(node) ?? [])];
  while (next.length) {
    const id = next.pop()!;
    if (id === node) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    next.push(...(graph.get(id) ?? []));
  }
  return false;
}

function branches() {
  return `review_branches as not materialized (
      select p.number, p.branch, p.status from prs p where p.number = (select max(number) from prs where branch = p.branch)),
    redraw_origins as materialized (
      select r.* from review_redraws r join review_branches p on p.number = r.pr where p.status = 'closed')`;
}

function steps() {
  return `redraw_steps(prior, job, kind, cancelled) as materialized (
      select source.id, r.job, 'redraw', 0 from redraw_origins r cross join jobs source indexed by jobs_work_branch
        on coalesce(source.branch, 'job/' || source.id) = +r.branch and source.kind = 'work'
        where r.job is not null
      union all select r.replaces, r.job, 'lands', j.status = 'cancelled' from job_replacement_links r
        join jobs j indexed by jobs_state on j.id = r.job)`;
}

// Holds inherit every saved-work ancestor. Redraws follow only live takeovers and later accepted redraws.
function walk() {
  return `redraw_walk(kind, origin, job) as (
      select 'redraw', branch, job from redraw_origins
      union select 'hold', branch, job from review_holds
      union select w.kind, w.origin, s.job from redraw_walk w join redraw_steps s on s.prior = w.job
        where (w.kind = 'redraw' and not s.cancelled) or (w.kind = 'hold' and s.kind = 'lands'))`;
}

function endpoints() {
  return `redraw_targets as materialized (
      select w.origin, max(w.job) job from redraw_walk w where w.kind = 'redraw'
        and not exists (select 1 from redraw_steps s where s.prior = w.job and not s.cancelled) group by w.origin),
    redraw_states as materialized (
      select t.origin, coalesce(j.branch, 'job/' || j.id, t.origin) branch, t.job,
        case when p.status = 'closed' and d.dropped then 'dropped' else coalesce(p.status, 'open') end state
      from redraw_targets t left join jobs j indexed by jobs_state on j.id = t.job
      left join review_branches p on p.branch = coalesce(j.branch, 'job/' || j.id, t.origin)
      left join redraw_origins d on d.pr = p.number),
    redraw_current as materialized (
      select w.job prior, max(s.job) job from redraw_walk w join redraw_states s on s.origin = w.origin
      where w.kind = 'redraw' and w.job is not null and s.job is not null group by w.job)`;
}

function mergedBranches() {
  return `merged_branches as materialized (
    select branch from review_branches where status = 'merged'
    union select origin from redraw_states where state = 'merged')`;
}

// Unary + removes the CTE column affinity so SQLite can seek the branch expression index. Waiters are open tasks, read
// from their own index (db.ts jobs_open_tasks): a thread's done jobs aren't read.
function holds(waiter?: string) {
  const open = (job: string) =>
    `${job}.kind = 'work' and ${job}.pr is null and ${job}.status in ('queued', 'running', 'blocked')`;
  return `redraw_sources as materialized (
      select s.origin, s.branch, replacement.id, source.thread source_thread, replacement.thread replacement_thread
      from redraw_states s cross join jobs source indexed by jobs_work_branch
        on coalesce(source.branch, 'job/' || source.id) = +s.origin and source.kind = 'work'
      join jobs replacement on replacement.id = coalesce(s.job, source.id)
      where s.state not in ('merged', 'dropped')),
    redraw_waiters as materialized (
      select s.origin, s.branch, s.id, waiting.id waiter from redraw_sources s
        join jobs waiting indexed by jobs_open_tasks on waiting.thread = s.source_thread and ${open('waiting')}
      union select s.origin, s.branch, s.id, waiting.id from redraw_sources s
        join jobs waiting indexed by jobs_open_tasks on waiting.thread = s.replacement_thread and ${open('waiting')}
      union select s.origin, s.branch, s.id, w.job from redraw_sources s
        join redraw_walk w on w.kind = 'hold' and w.origin = s.origin),
    redraw_holds as materialized (
      select s.origin, waiting.id waiter, s.id from redraw_waiters s
      cross join jobs waiting indexed by jobs_open_tasks on waiting.id = s.waiter
      where ${waiter ? `waiting.id = ${waiter} and` : ''} ${open('waiting')} and waiting.id != s.id
        and not exists (select 1 from review_fix_tasks f join prs p on p.number = f.pr
          where f.job = waiting.id and p.branch = s.branch and waiting.branch = p.branch
            and f.round = p.round and p.status in ${OPEN_PRS}))`;
}
