// Each needs edge's spell (db.ts need_spells), and the spans one held a task, for hq estimate --calibration's waiting
// (threadwaits.ts): thread_needs keeps only the edges in force, with no time.
import { db, OPEN_PRS } from './db.ts';
import type { Job } from './threadgroups.ts';

type Spell = { from: number; until: number };

// An edge drawn (newthread.ts addNeed): its spell opens
export function needDrawn(thread: string, needs: string) {
  db.prepare('insert into need_spells (thread, needs, drawn) values (?, ?, ?)').run(
    thread,
    needs,
    new Date().toISOString(),
  );
}

// An edge dropped (hq plan unneed): its spell ends, or one drawn before the recording is recorded ending
export function needDropped(thread: string, needs: string) {
  const now = new Date().toISOString();
  const ended = db
    .prepare('update need_spells set dropped = ? where thread = ? and needs = ? and dropped is null')
    .run(now, thread, needs);
  if (!ended.changes)
    db.prepare('insert into need_spells (thread, needs, dropped) values (?, ?, ?)').run(thread, needs, now);
}

// The spans a deliverable it needs held a task, as threadorder.ts needsOpen holds its thread's next task to start: from
// the task's queuing, while an edge to it was in force (one drawn before the recording reads as drawn from the start,
// as the claim reads it now) and the needed deliverable had work still to merge (toMerge), less the spans its order
// held it. Each needed deliverable read once. mergeAfter: a branch's first merge after a time.
export function needSpansReader(mergeAfter: (branch: string, at: number) => number | undefined) {
  const unmerged = new Map<string, Spell[]>();
  const unmergedOf = (thread: string) =>
    unmerged.get(thread) ?? unmerged.set(thread, toMerge(thread, mergeAfter)).get(thread)!;
  return (t: Job, order: Spell[]) => without(needsOver(t, unmergedOf), order);
}

function needsOver(t: Job, unmergedOf: (thread: string) => Spell[]) {
  if (t.thread === null) return [];
  const edges = db
    .prepare(
      `select needs, drawn, dropped from need_spells where thread = $thread
      union all select n.needs, null, null from thread_needs n where n.thread = $thread and not exists
        (select 1 from need_spells s where s.thread = n.thread and s.needs = n.needs and s.dropped is null)`,
    )
    .all({ thread: t.thread }) as { needs: string; drawn: string | null; dropped: string | null }[];
  const time = (at: string | null, none: number) => (at === null ? none : Date.parse(at));
  return edges.flatMap(e => {
    const edge = { from: Math.max(t.created, time(e.drawn, -Infinity)), until: time(e.dropped, Infinity) };
    return unmergedOf(e.needs).flatMap(s => {
      const [from, until] = [Math.max(edge.from, s.from), Math.min(edge.until, s.until)];
      return from < until ? [{ from, until }] : [];
    });
  });
}

// When a deliverable had work still to merge, as needsOpen reads it at each time: before its first task; each task from
// its queuing while it was open (a cancelled one until it was called off), one done until its branch's first merge after
// it (until its end, if its branch's latest pull request was dropped or it has none), and one failed or stopped until the
// deliverable closed (needsOpen: no later task settles it); none once it was closed. History keeps neither a pull
// request's drop nor its stuck spells: a branch's latest pull request reads as it is now, and needsOpen's release of a
// deliverable whose pushed work sits in a stuck pull request isn't rebuilt.
function toMerge(thread: string, mergeAfter: (branch: string, at: number) => number | undefined): Spell[] {
  const closed = db.prepare("select done from threads where id = ? and status = 'done'").get(thread) as
    { done: string | null } | undefined;
  const end = closed?.done ? Date.parse(closed.done) : Infinity;
  // (its cancelled tasks too, which jobs_tasks leaves out)
  const tasks = db
    .prepare(
      `select status, created, finished, coalesce(branch, 'job/' || id) branch from jobs indexed by jobs_thread_state
      where thread = ? and kind = 'work' and pr is null`,
    )
    .all(thread) as { status: string; created: string; finished: string | null; branch: string }[];
  // (its branch's latest pull request, still in review now)
  const inReview = (branch: string) =>
    !!db
      .prepare(
        `select 1 from prs where number = (select max(number) from prs where branch = ?) and status in ${OPEN_PRS}`,
      )
      .get(branch);
  const spells = tasks.map(task => {
    const finished = task.finished === null ? Infinity : Date.parse(task.finished);
    const until =
      task.status === 'done'
        ? (mergeAfter(task.branch, finished) ?? (inReview(task.branch) ? Infinity : finished))
        : task.status === 'cancelled'
          ? finished
          : Infinity;
    return { from: Date.parse(task.created), until };
  });
  const first = Math.min(Infinity, ...spells.map(s => s.from));
  return [{ from: -Infinity, until: first }, ...spells].flatMap(s =>
    s.from < Math.min(s.until, end) ? [{ from: s.from, until: Math.min(s.until, end) }] : [],
  );
}

// The spells less the holds over them
function without(spells: Spell[], cuts: Spell[]) {
  return cuts.reduce(
    (left, c) =>
      left.flatMap(s => [
        ...(s.from < Math.min(s.until, c.from) ? [{ from: s.from, until: Math.min(s.until, c.from) }] : []),
        ...(Math.max(s.from, c.until) < s.until ? [{ from: Math.max(s.from, c.until), until: s.until }] : []),
      ]),
    spells,
  );
}
