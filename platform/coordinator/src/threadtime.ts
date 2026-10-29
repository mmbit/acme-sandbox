// hq estimate --calibration's threads: the pull requests merged lately, grouped by their thread (one with no thread is
// its own group), with the tasks, agents, pull requests and review rounds each took, and its wall-clock from its first
// task's creation to its last merge split into work, review and waiting, overlapping runs counted once. Also the
// hand-offs between threads: a task queued --after another branch's job waits for that job's review and merge. And
// what the waiting was (threadwaits.ts).
import { db } from './db.ts';
import type { Turn } from './latency.ts';
import { minutes, share } from './arithmetic.ts';
import { covered, type Span } from './playtime.ts';
import { waitingSplit } from './threadwaits.ts';
import { firstMergeAfter, spanOf, type Group, type Job, type Merge } from './threadgroups.ts';

// Its parts each run in a turn of HQ's thread of their own, each ended by calibration.ts's report's `turn`, which names
// a slow one (latency.ts turns).
export async function threadTimes(since: string, turn: Turn) {
  const lately = (db.prepare(MERGED).all(since) as MergeRow[]).map(mergeOf);
  const jobs = await jobsOn(lately, turn);
  const runs = runsOf(jobs.map(j => j.id));
  await turn("the threads' runs");
  const after = afterJobs(jobs);
  const merges = mergesOn([...lately, ...after].map(x => x.branch));
  const groups = grouped(lately, jobs, merges);
  const tasks = groups.flatMap(g => g.tasks);
  const handed = handoffs(tasks, after, merges, runs);
  await turn("the threads' groups and hand-offs");
  const times = {
    ...summed(groups, runs),
    handoffs: handed,
    ...waitingSplit(groups, runs, merges),
  };
  await turn("the threads' sums and waits");
  return times;
}

// ---- the rows, ids first and then each row by its id

const MERGED = "select number, branch, merged_at from prs where merged_at >= ? and status = 'merged'";
type MergeRow = { number: number; branch: string; merged_at: string | null };
const mergeOf = (r: MergeRow): Merge => ({ number: r.number, branch: r.branch, merged: Date.parse(r.merged_at!) });

// The work jobs on the pull requests' branches (a thread's tasks, a fix task) and the jobs of each pull request's
// review loop (its fixes, reviews and rulings), read a slice at a time in the order of their ids, a turn after each.
async function jobsOn(lately: Merge[], turn: Turn) {
  if (!lately.length) return [];
  const ids = db
    .prepare(
      `select id from jobs where kind = 'work' and coalesce(branch, 'job/' || id) in (select value from json_each(?))
      union select id from jobs where pr in (select value from json_each(?))`,
    )
    .all(JSON.stringify(lately.map(p => p.branch)), JSON.stringify(lately.map(p => p.number))) as { id: number }[];
  const sorted = ids.map(r => r.id).sort((a, b) => a - b),
    jobs: Job[] = [];
  for (let i = 0; i < sorted.length; i += SLICE) {
    jobs.push(...jobsById(sorted.slice(i, i + SLICE)));
    await turn(i ? "the threads' jobs, a slice" : "the threads' merges and their jobs' first slice");
  }
  return jobs;
}
// (each read in 50-60 ms off a cold disk on a copy grown to HQ's size)
const SLICE = 1000;

// (this file's jobs read from db.ts jobs_listed, or jobs_report where it has their columns: a row's brief and report are
// seconds off a cold disk)
const jobsById = (ids: number[]) =>
  (
    db
      .prepare(
        `select id, kind, agent, engine, pr, round, created, after, thread, coalesce(branch, 'job/' || id) branch,
        coalesce(seq, id) seq, finished from jobs indexed by jobs_listed where id in (select value from json_each(?))`,
      )
      .all(JSON.stringify(ids)) as (Omit<Job, 'created' | 'finished'> & { created: string; finished: string | null })[]
  ).map(r => ({ ...r, created: Date.parse(r.created), finished: r.finished === null ? null : Date.parse(r.finished) }));

// Each job's ended runs, in order.
function runsOf(ids: number[]) {
  const rows = db
    .prepare(
      `select job, started, ended from runs where job in (select value from json_each(?)) and ended is not null
      order by started`,
    )
    .all(JSON.stringify(ids)) as { job: number; started: string; ended: string }[];
  const runs = new Map<number, Span[]>();
  for (const r of rows)
    runs.set(r.job, [...(runs.get(r.job) ?? []), { start: Date.parse(r.started), end: Date.parse(r.ended) }]);
  return runs;
}

// The work jobs the tasks were queued --after, with when each ended.
function afterJobs(jobs: Job[]) {
  const ids = jobs.flatMap(j => (j.after === null ? [] : [j.after]));
  if (!ids.length) return [];
  return (
    db
      .prepare(
        `select id, finished, coalesce(branch, 'job/' || id) branch from jobs indexed by jobs_report
        where id in (select value from json_each(?)) and kind = 'work' and finished is not null`,
      )
      .all(JSON.stringify(ids)) as { id: number; finished: string; branch: string }[]
  ).map(r => ({ ...r, finished: Date.parse(r.finished) }));
}

// Every merge on these branches, the earliest first: a branch's tasks belong to the first merge after they were queued.
function mergesOn(branches: string[]) {
  const rows = db
    .prepare(
      `select number, branch, merged_at from prs where branch in (select value from json_each(?))
      and status = 'merged'`,
    )
    .all(JSON.stringify([...new Set(branches)])) as MergeRow[];
  const merges = rows.filter(r => r.merged_at !== null).map(mergeOf);
  return Map.groupBy(
    merges.toSorted((a, b) => a.merged - b.merged),
    m => m.branch,
  );
}

// ---- the threads

// Each pull request with its tasks (the work jobs queued on its branch before it merged), its fixes and its reviews,
// then the pull requests by their tasks' thread. One with no task (no job's branch) is left out.
function grouped(lately: Merge[], jobs: Job[], merges: Map<string, Merge[]>) {
  const loops = new Map(
    lately.map(p => [p.number, { pr: p, tasks: [] as Job[], work: [] as Job[], reviews: [] as Job[] }]),
  );
  for (const j of jobs) {
    const task = j.kind === 'work' && j.pr === null;
    const loop = loops.get(task ? (firstMergeAfter(merges, j.branch, j.created)?.number ?? 0) : (j.pr ?? 0));
    if (!loop) continue;
    if (task) loop.tasks.push(j);
    (j.kind === 'work' ? loop.work : loop.reviews).push(j);
  }
  const groups = new Map<string, Group>();
  for (const loop of [...loops.values()].filter(l => l.tasks.length)) {
    const key = loop.tasks.find(t => t.thread !== null)?.thread ?? `#${loop.pr.number}`;
    const group = groups.get(key) ?? { key, prs: [], tasks: [], work: [], reviews: [] };
    group.prs.push(loop.pr);
    group.tasks.push(...loop.tasks);
    group.work.push(...loop.work);
    group.reviews.push(...loop.reviews);
    groups.set(key, group);
  }
  return [...groups.values()];
}

// The threads' counts and their time: work is their work jobs' runs, review their review loops' runs outside those,
// waiting the rest of the time from the first task's creation to the last merge.
function summed(groups: Group[], runs: Map<number, Span[]>) {
  const spansOf = (jobs: Job[]) => jobs.flatMap(j => runs.get(j.id) ?? []);
  const times = groups.map(g => {
    const { start, end } = spanOf(g);
    const work = covered(spansOf(g.work), start, end);
    const review = covered(spansOf([...g.work, ...g.reviews]), start, end) - work;
    return { work, review, waiting: end - start - work - review };
  });
  const ran = groups.flatMap(g => g.reviews.filter(r => runs.has(r.id)));
  const all = (part: keyof (typeof times)[number]) => times.reduce((sum, t) => sum + t[part], 0);
  const elapsed = all('work') + all('review') + all('waiting');
  return {
    count: groups.length,
    one_agent: groups.filter(g => new Set(g.tasks.map(t => t.agent)).size === 1).length,
    tasks: groups.reduce((sum, g) => sum + g.tasks.length, 0),
    pull_requests: groups.reduce((sum, g) => sum + g.prs.length, 0),
    rounds: new Set(ran.map(r => `${r.pr}:${r.round}`)).size,
    review_runs: ran.reduce((sum, r) => sum + runs.get(r.id)!.length, 0),
    work: minutes(times.map(t => t.work)),
    review: minutes(times.map(t => t.review)),
    waiting: minutes(times.map(t => t.waiting)),
    review_share: elapsed ? share(all('review') / elapsed) : null,
    waiting_share: elapsed ? share(all('waiting') / elapsed) : null,
  };
}

// ---- the hand-offs

// For each task queued --after a job on another branch whose work merged: from that job's end to its merge (the
// review the task waited for), and from the merge to the task's first run.
function handoffs(
  tasks: Job[],
  after: { id: number; finished: number; branch: string }[],
  merges: Map<string, Merge[]>,
  runs: Map<number, Span[]>,
) {
  const before = new Map(after.map(a => [a.id, a]));
  const waits = tasks.flatMap(t => {
    const prior = t.after === null ? undefined : before.get(t.after);
    const merge = prior && prior.branch !== t.branch && firstMergeAfter(merges, prior.branch, prior.finished);
    const started = runs.get(t.id)?.[0]?.start;
    if (!merge || started === undefined) return [];
    return [{ review: merge.merged - prior.finished, start: Math.max(0, started - merge.merged) }];
  });
  return {
    count: waits.length,
    review: minutes(waits.map(w => w.review)),
    start: minutes(waits.map(w => w.start)),
  };
}
