// hq estimate --calibration's threads, what their waiting was: each minute of a thread's span (its first task queued to
// its last merge) that none of its jobs ran, by what held it then, from each job's exact times (queued, its runs, what
// it waited for and when that let go), never snapshots:
// - line: a job of the thread was ready and waiting for a start, the machine's line (the worker's memory admission, its
//   slots, the seats), review steps and choosing the panel inside it (line_review: only review steps were waiting);
// - order: a task waited for the task before it in its thread (threadorder.ts), or for an --after on its own branch;
// - after: a job waited for another branch's job and its review and merge (--after, hq waits);
// - card_or_time: a card it waited for (--after request:, or parked on one), or a time or an event (--when);
// - fix_drawn: nothing was queued, and the thread's next job was a fix on its pull request (its owner drawing it);
// - other: nothing was queued otherwise (a push held for its thread, the merge itself, a task not drawn yet).
// A minute two of these held counts once, for the first in that order: a thread with a job ready waits for the machine.
// Also the side-by-side question: the tasks held by order or by another job, and of them those whose pull request shares
// no file with the holder's (apart: nothing says one needed the other's work). One on the holder's own pull request
// can't be told apart by files (one_pr).
import { db } from './db.ts';
import { MINUTE_MS, minutes, share } from './arithmetic.ts';
import { metAt, sortedSpans, type WakeRow } from './wakes.ts';
import type { Span } from './playtime.ts';
import { firstMergeAfter, spanOf, type Group, type Job, type Merge } from './threadgroups.ts';

const PARTS = ['line', 'line_review', 'order', 'after', 'card_or_time', 'fix_drawn', 'other'] as const;
type Part = (typeof PARTS)[number];
type HoldPart = 'order' | 'after' | 'card_or_time';
// What held a job from `from` until `until` (Infinity: until it started), and the job it waited for
type Hold = { part: HoldPart; from: number; until: number; on?: number };

export function waitingSplit(groups: Group[], runs: Map<number, Span[]>, merges: Map<string, Merge[]>) {
  const jobs = groups.flatMap(g => [...g.work, ...g.reviews]);
  const holds = holdsOf(jobs, groups, merges, runs);
  const totals = new Map<Part, number>(PARTS.map(p => [p, 0]));
  const held: { task: Job; on: number; ms: number }[] = [];
  for (const g of groups) {
    const each = threadWaits(g, runs, holds);
    for (const [part, ms] of each.parts) totals.set(part, totals.get(part)! + ms);
    held.push(...each.held);
  }
  const all = [...totals.values()].reduce((sum, ms) => sum + ms, 0);
  const waiting_split = Object.fromEntries(
    PARTS.map(p => [
      p,
      { minutes: Math.round(totals.get(p)! / MINUTE_MS), share: all ? share(totals.get(p)! / all) : null },
    ]),
  ) as Record<Part, { minutes: number; share: number | null }>;
  return { waiting_split, side_by_side: sideBySide(held, groups, merges) };
}

// ---- each thread's waiting, segment by segment

function threadWaits(g: Group, runs: Map<number, Span[]>, holds: Map<number, Hold[]>) {
  const jobs = [...g.work, ...g.reviews];
  const { start, end } = spanOf(g);
  const queued = jobs.map(j => ({ j, spans: queuedSpans(j, runs.get(j.id) ?? []) }));
  const ran = jobs.flatMap(j => runs.get(j.id) ?? []);
  const cuts = [
    start,
    end,
    ...ran.flatMap(s => [s.start, s.end]),
    ...queued.flatMap(q => q.spans.flatMap(s => [s.start, s.end])),
  ];
  for (const hs of jobs.map(j => holds.get(j.id) ?? [])) cuts.push(...hs.flatMap(h => [h.from, h.until]));
  const edges = [...new Set(cuts.filter(t => t >= start && t <= end && Number.isFinite(t)))].sort((a, b) => a - b);
  const parts = new Map<Part, number>();
  const held = new Map<string, { task: Job; on: number; ms: number }>();
  for (let i = 1; i < edges.length; i++) {
    const [from, to] = [edges[i - 1]!, edges[i]!];
    const waiting = queued.filter(q => q.spans.some(s => s.start <= from && s.end >= to));
    const states = waiting.map(q => ({ j: q.j, hold: binding(holds.get(q.j.id) ?? [], from, to) }));
    // (a task held while the job it waits for runs is the side-by-side case, so these count while the thread runs too)
    for (const { j, hold } of states)
      if (hold?.on !== undefined && hold.part !== 'card_or_time' && g.tasks.includes(j)) {
        const key = `${j.id}:${hold.on}`;
        const was = held.get(key) ?? { task: j, on: hold.on, ms: 0 };
        held.set(key, { ...was, ms: was.ms + to - from });
      }
    if (ran.some(s => s.start <= from && s.end >= to)) continue;
    const part = partOf(states, jobs, to);
    parts.set(part, (parts.get(part) ?? 0) + to - from);
  }
  return { parts, held: [...held.values()] };
}

// When a job was queued: from its creation to its first run, and between its runs
function queuedSpans(j: Job, runs: Span[]) {
  const spans: Span[] = [];
  let from = j.created;
  for (const run of runs) {
    if (run.start > from) spans.push({ start: from, end: run.start });
    from = Math.max(from, run.end);
  }
  return spans;
}

// The hold that kept a job waiting through a segment: of those over it, the one let go last; none, it was ready
const binding = (holds: Hold[], from: number, to: number) =>
  holds.filter(h => h.from <= from && h.until >= to).sort((a, b) => b.until - a.until)[0];

function partOf(states: { j: Job; hold: Hold | undefined }[], jobs: Job[], to: number): Part {
  const ready = states.filter(s => !s.hold);
  if (ready.some(s => s.j.kind === 'work')) return 'line';
  if (ready.length) return 'line_review';
  for (const part of ['order', 'after', 'card_or_time'] as const)
    if (states.some(s => s.hold?.part === part)) return part;
  const next = jobs.filter(j => j.created >= to).sort((a, b) => a.created - b.created)[0];
  return next?.kind === 'work' && next.pr !== null ? 'fix_drawn' : 'other';
}

// ---- what each job waited for, and when it let go

function holdsOf(jobs: Job[], groups: Group[], merges: Map<string, Merge[]>, runs: Map<number, Span[]>) {
  const holds = new Map<number, Hold[]>(jobs.map(j => [j.id, []]));
  const add = (job: number, hold: Hold) => holds.get(job)?.push(hold);
  const byId = new Map(jobs.map(j => [j.id, j]));
  const ids = JSON.stringify([...byId.keys()]);
  const wakes = wakesOf(ids);
  // A thread's tasks take their turns as threadorder.ts inTurn has them, the tasks started ahead of those not started
  // (even queued again): a task before it in its thread holds a task until it ends, but not while it waits for its time
  // still to come (the turn puts it behind the tasks that can start), and not once the task itself has started; a task
  // that started first holds a later one from that start; neither holds a task while it waits for its own time
  const timeOf = new Map<number, number>();
  for (const w of wakes.filter(w => w.kind === 'at')) timeOf.set(w.job, Math.max(timeOf.get(w.job) ?? 0, w.until));
  const startOf = (j: Job) => runs.get(j.id)?.[0]?.start ?? Infinity;
  for (const g of groups)
    for (const t of g.tasks)
      for (const other of g.tasks.filter(p => p !== t && t.thread !== null && p.thread === t.thread)) {
        const ahead = before(other, t);
        if (!ahead && !(startOf(other) < startOf(t))) continue;
        const from = Math.max(t.created, timeOf.get(t.id) ?? 0, ahead ? (timeOf.get(other.id) ?? 0) : startOf(other));
        // (a task before it holds it only until the task starts itself first)
        const until = ahead && startOf(t) < startOf(other) ? startOf(t) : (other.finished ?? Infinity);
        if (from < until) add(t.id, { part: 'order', from, until, on: other.id });
      }
  for (const w of waitedOn(ids)) {
    const j = byId.get(w.job)!,
      own = w.branch === j.branch;
    const merge = own || w.finished === null ? undefined : mergeAfter(merges, w.branch, w.finished);
    const until = own ? (w.finished ?? Infinity) : (merge ?? w.finished ?? Infinity);
    add(w.job, { part: own ? 'order' : 'after', from: j.created, until, on: w.on });
  }
  for (const c of cardsOf(ids))
    add(c.job, { part: 'card_or_time', from: c.from ?? byId.get(c.job)!.created, until: c.until });
  for (const w of wakes) add(w.job, { part: 'card_or_time', from: w.from ?? byId.get(w.job)!.created, until: w.until });
  return holds;
}

const before = (a: Job, b: Job) => a.seq < b.seq || (a.seq === b.seq && a.id < b.id);

// The jobs each waited for (its --after and its hq waits), with their branch and end
function waitedOn(ids: string) {
  const rows = db
    .prepare(
      `with waited(job, on_job) as (select id, after from jobs where id in (select value from json_each($ids))
        and after is not null union select job, on_job from waits where job in (select value from json_each($ids)))
      select w.job, w.on_job "on", coalesce(o.branch, 'job/' || o.id) branch, o.finished
      from waited w join jobs o on o.id = w.on_job`,
    )
    .all({ ids }) as { job: number; on: number; branch: string; finished: string | null }[];
  return rows.map(r => ({ ...r, finished: r.finished === null ? null : Date.parse(r.finished) }));
}

// A branch's first merge after a time, read for a branch the threads' merges don't hold (an --after's, a wait's)
function mergeAfter(merges: Map<string, Merge[]>, branch: string, at: number) {
  const known = firstMergeAfter(merges, branch, at);
  if (known) return known.merged;
  const row = db
    .prepare("select min(merged_at) merged from prs where branch = ? and status = 'merged' and merged_at >= ?")
    .get(branch, new Date(at).toISOString()) as { merged: string | null };
  return row.merged === null ? undefined : Date.parse(row.merged);
}

// The cards each job waited for (--after request:) from its creation, and the one it was parked on from the card's
// own, each until it was answered or closed (every close writes `answered`)
function cardsOf(ids: string) {
  const rows = db
    .prepare(
      `select w.job, null "from", r.answered until from request_waits w join requests r
        on r.id = w.request where w.job in (select value from json_each($ids))
      union all select j.id, r.created, r.answered from jobs j join requests r on r.id = j.request
        where j.id in (select value from json_each($ids))`,
    )
    .all({ ids }) as { job: number; from: string | null; until: string | null }[];
  return rows.map(r => ({
    job: r.job,
    from: r.from === null ? null : Date.parse(r.from),
    until: r.until === null ? Infinity : Date.parse(r.until),
  }));
}

// The times and events each waited for, each until wakes.ts met it (until the job started where no record dates that),
// a sort once for each proposal the job waited for (from: null, from its queuing)
function wakesOf(ids: string) {
  const rows = db
    .prepare('select job, kind, arg, since from wakes where job in (select value from json_each(?))')
    .all(ids) as WakeRow[];
  return rows.flatMap(w =>
    w.kind === 'sorted'
      ? sortedSpans(w.job).map(s => ({ job: w.job, kind: w.kind, from: s.from, until: s.until ?? Infinity }))
      : [{ job: w.job, kind: w.kind, from: null, until: metAt(w) ?? Infinity }],
  );
}

// ---- the side-by-side question

function sideBySide(held: { task: Job; on: number; ms: number }[], groups: Group[], merges: Map<string, Merge[]>) {
  const prOf = (branch: string, at: number) => firstMergeAfter(merges, branch, at)?.number;
  const inThreads = new Map(groups.flatMap(g => [...g.work, ...g.reviews]).map(j => [j.id, j]));
  const others = otherPrs(held.map(h => h.on).filter(on => !inThreads.has(on)));
  const holderPr = (on: number) => {
    const j = inThreads.get(on);
    return j ? prOf(j.branch, j.finished ?? j.created) : (others.get(on) ?? undefined);
  };
  const files = filesOf();
  const cases = held.map(h => {
    const [mine, theirs] = [prOf(h.task.branch, h.task.created), holderPr(h.on)];
    if (mine === undefined || theirs === undefined || !files(mine).length || !files(theirs).length)
      return { ...h, kind: mine !== undefined && mine === theirs ? ('one_pr' as const) : ('unknown' as const) };
    if (mine === theirs) return { ...h, kind: 'one_pr' as const };
    const shared = files(mine).some(f => files(theirs).includes(f));
    return { ...h, kind: shared ? ('shared_files' as const) : ('apart' as const) };
  });
  const tally = (list: typeof cases) => ({
    count: new Set(list.map(c => c.task.id)).size,
    ...minutes(list.map(c => c.ms)),
  });
  return {
    held: tally(cases),
    apart: tally(cases.filter(c => c.kind === 'apart')),
    shared_files: tally(cases.filter(c => c.kind === 'shared_files')),
    one_pr: tally(cases.filter(c => c.kind === 'one_pr')),
    unknown: tally(cases.filter(c => c.kind === 'unknown')),
  };
}

// The pull request each job outside the threads merged its work in (an --after's, a wait's on another branch)
function otherPrs(ids: number[]) {
  const rows = db
    .prepare(
      `select o.id, (select min(p.number) from prs p where p.branch = coalesce(o.branch, 'job/' || o.id)
        and p.status = 'merged' and p.merged_at >= o.finished) pr
      from jobs o where o.id in (select value from json_each(?))`,
    )
    .all(JSON.stringify(ids)) as { id: number; pr: number | null }[];
  return new Map(rows.map(r => [r.id, r.pr]));
}

// Each pull request's files, read once
function filesOf() {
  const read = new Map<number, string[]>();
  return (pr: number) => {
    if (!read.has(pr)) {
      const row = db.prepare('select files from prs where number = ?').get(pr) as { files: string } | undefined;
      read.set(pr, JSON.parse(row?.files ?? '[]') as string[]);
    }
    return read.get(pr)!;
  };
}
