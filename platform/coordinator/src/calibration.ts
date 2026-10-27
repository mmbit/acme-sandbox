// hq estimate --calibration: both layers' misses over the work done lately. The sizes (the latest each job had, and who
// gave it) against the agent time the job took, by agent, by area, by sizer and by how the job was queued; and the ETAs
// the prediction log (predictionlog.ts) held an hour, six hours and a day before each landing against the landing. Also
// the threads merged in the window, their work, review and waiting time (threadtime.ts).
import { cleanPastJobs, pastJobs, type PastJob } from './matching.ts';
import { latestSizes, type JobSize } from './predictions.ts';
import { landings } from './landings.ts';
import * as predictionlog from './predictionlog.ts';
import { byLead, LEADS, type Sample } from './backtest.ts';
import { spread } from './accuracy.ts';
import { db } from './db.ts';
import { biasOf, WINDOW_MS as BIAS_WINDOW_MS } from './sizerbias.ts';
import { threadTimes } from './threadtime.ts';

const DAY_MS = 24 * 60 * 60_000;

export function report(ask: { days?: unknown }, now = Date.now()) {
  const days = ask.days === undefined ? 7 : Number(ask.days);
  if (!Number.isInteger(days) || days < 1 || days > 30) return 400;
  const since = new Date(now - days * DAY_MS).toISOString(),
    lookback = new Date(now - days * DAY_MS - BIAS_WINDOW_MS).toISOString();
  const recent = pastJobs().filter(j => j.finished >= lookback);
  const done = recent.filter(j => j.finished >= since);
  return {
    days,
    sizes: sizeMisses(done, recent),
    eta: etaMisses(done.map(j => j.id)),
    threads: threadTimes(since),
  };
}

// ---- layer 1: the sizes

type Sized = { j: PastJob; size: JobSize };

function sizeMisses(done: PastJob[], recent: PastJob[]) {
  const sizes = latestSizes();
  const sized = sizedOf(done, sizes);
  const queued = queuedHow(sized.map(s => s.j.id));
  return {
    count: sized.length,
    by_agent: grouped(sized, s => s.j.agent),
    by_area: grouped(sized, s => areaOf(s.j)),
    by_sizer: grouped(sized, s => s.size.by),
    by_queue: grouped(sized, s => queued.get(s.j.id)!),
    ...givenSizes(sized, sizedOf(cleanPastJobs(recent), sizes)),
  };
}

// The jobs with a size given before they ended.
const sizedOf = (jobs: PastJob[], sizes: Map<number, JobSize>) =>
  jobs.flatMap(j => {
    const size = sizes.get(j.id);
    return size && size.at <= j.finished ? [{ j, size }] : [];
  });

function grouped(sized: Sized[], keyOf: (s: Sized) => string) {
  const groups = new Map<string, [number, number][]>();
  for (const s of sized) groups.set(keyOf(s), [...(groups.get(keyOf(s)) ?? []), [s.size.agent_ms, s.j.agent_ms]]);
  return [...groups]
    .map(([key, pairs]) => ({ key, ...spread(pairs) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

// How each job came to be queued, the first that holds: a board call's (its follow-up, or work carrying a call's item),
// a meeting's (queued by an agent seated in a meeting live then: db.ts sittingIn), an accepted proposal's (the inbox),
// HQ's own (no agent queued it), else an agent's hq job.
export type QueuedHow = 'call' | 'meeting' | 'inbox' | 'hq' | 'agent';
function queuedHow(ids: number[]) {
  const rows = db
    .prepare(
      `select j.id, case
        when j.call is not null or j.item is not null or j.id in (select job from calls where job is not null)
          or j.id in (select job from call_items where job is not null) then 'call'
        when exists (select 1 from meeting_seats s join meetings m on m.id = s.meeting where s.agent = j.queued_by
          and m.started <= j.created and (m.ended is null or m.ended >= j.created)) then 'meeting'
        when j.id in (select accepted from proposals where accepted is not null) then 'inbox'
        when j.queued_by is null then 'hq' else 'agent' end how
      from jobs j where j.id in (select value from json_each(?))`,
    )
    .all(JSON.stringify(ids)) as { id: number; how: QueuedHow }[];
  return new Map(rows.map(r => [r.id, r.how]));
}

// The sizes agents and models gave (any sizer but the tool), as given and as the play counts them (sizerbias.ts), out
// of sample: each at its sizer's bias from the clean jobs that finished in the two weeks before it was given, else every
// sizer's together, else as given.
function givenSizes(sized: Sized[], measured: Sized[]) {
  const pairOf = (s: Sized): [number, number] => [s.size.agent_ms, s.j.agent_ms];
  // (each one's finish parsed once)
  const pool = measured
    .filter(m => m.size.by !== 'tool' && !m.size.revised && m.j.agent_ms > 0)
    .map(m => ({ ...m, finished: Date.parse(m.j.finished) }));
  const given = sized.filter(s => s.size.by !== 'tool');
  const corrected = given.map(s => {
    // (the CEO's revision plays as given)
    if (s.size.revised) return pairOf(s);
    const at = Date.parse(s.size.at);
    const before = pool.filter(m => m.finished < at && m.finished >= at - BIAS_WINDOW_MS);
    const own = before.filter(m => m.size.by === s.size.by).map(pairOf);
    const bias = biasOf(own, true) ?? biasOf(before.map(pairOf), false);
    return [s.size.agent_ms * (bias?.usual ?? 1), s.j.agent_ms] as [number, number];
  });
  return { given_sizes: spread(given.map(pairOf)), given_sizes_corrected: spread(corrected) };
}

// The folder (its first two levels: platform/coordinator, products/acme) the job's pull request changed most files
// in, the first by name of equals; work with no pull request is its own area.
export function areaOf(j: Pick<PastJob, 'pr' | 'files'>) {
  if (j.pr === null) return '(no pull request)';
  const counts = new Map<string, number>();
  for (const file of JSON.parse(j.files) as string[]) {
    const folder = file.split('/').slice(0, 2).join('/');
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  const [area] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? ['(no files)'];
  return area;
}

// ---- layer 2: the ETAs

// For each job that landed and each lead, the log's row standing that long before the landing (the last one written
// by then): a row stands until the next one moves it.
function etaMisses(jobs: number[]) {
  const landed = landings(jobs);
  // (each job's own rows, in order)
  const rows = Map.groupBy(predictionlog.ofJobs([...landed.keys()]), r => r.job);
  const samples: Sample[] = [];
  for (const { lead, ms } of LEADS)
    for (const [job, at] of landed) {
      const standing = rows.get(job)?.findLast(r => r.at <= at - ms);
      if (standing) samples.push({ lead, merged: standing.merged, held: standing.held, landed: at });
    }
  return byLead(samples);
}
