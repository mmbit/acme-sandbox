// hq estimate --calibration: both layers' misses over the work done lately. The sizes (the latest each job had, and who
// gave it) against the agent time the job took, by agent, by area, by sizer and by how the job was queued; and the ETAs
// the prediction log (predictionlog.ts) held an hour, six hours and a day before each landing against the landing. Also
// the threads merged in the window, their work, review and waiting time (threadtime.ts).
import { cleanPastJobs, pastJobsSoon, isPrivate, type PastJob } from './matching.ts';
import { latestSizes, storedSizes, type JobSize } from './predictions.ts';
import { landings } from './landings.ts';
import * as predictionlog from './predictionlog.ts';
import { byLead, LEADS, type Sample } from './backtest.ts';
import { spread } from './arithmetic.ts';
import { db } from './db.ts';
import { usualOf, WINDOW_MS as BIAS_WINDOW_MS } from './sizerbias.ts';
import { threadTimes } from './threadtime.ts';
import * as latency from './latency.ts';
import * as taskaudit from './taskaudit.ts';

// Its parts each run in a turn of HQ's thread of their own, so the server answers other requests between them, and one
// that holds it half a second or more is named in the status report's holds (latency.ts turns).
export async function report(ask: taskaudit.AuditAsk, now = Date.now()) {
  const window = taskaudit.readWindow(ask, now);
  if (typeof window === 'number') return window;
  const { days } = window;
  const turn = latency.turns('hq estimate --calibration');
  const tasks = await taskaudit.report(window, turn);
  const since = window.since,
    lookback = new Date(Date.parse(since) - BIAS_WINDOW_MS).toISOString();
  const recent = (await turn('the pool', pastJobsSoon())).filter(
    j => j.finished >= lookback && j.finished < window.until && !isPrivate(j),
  );
  const done = recent.filter(j => j.finished >= since);
  await turn('the window');
  const sizes = await sizeMisses(done, recent, turn);
  const eta = await etaMisses(
    done.map(j => j.id),
    turn,
    Date.parse(window.until),
  );
  return { days, tasks, sizes, eta, threads: await threadTimes(since, turn, window.until) };
}

// ---- layer 1: the sizes

type Sized = { j: PastJob; size: JobSize };

async function sizeMisses(done: PastJob[], recent: PastJob[], turn: latency.Turn) {
  const ids = recent.map(j => j.id);
  const sizes = latestSizes(ids, storedSizes(ids, { persist: false }));
  await turn('the sizes');
  const all = sizedOf(done, sizes);
  const sized = all.filter(s => s.j.origin !== 'carry');
  const queued = queuedHow(sized.map(s => s.j.id));
  await turn('how the jobs were queued');
  const misses = {
    count: sized.length,
    carry_checks: spread(
      all.filter(s => s.j.origin === 'carry').map(s => [s.size.agent_ms, s.j.agent_ms]),
      0,
    ),
    by_agent: grouped(sized, s => s.j.agent),
    by_area: grouped(sized, s => areaOf(s.j)),
    by_sizer: grouped(sized, s => s.size.by),
    by_queue: grouped(sized, s => queued.get(s.j.id)!),
    ...givenSizes(sized, sizedOf(cleanPastJobs(recent), sizes)),
  };
  await turn("the sizes' groups");
  return misses;
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
// (the jobs, done work, read from db.ts's indexes: a row's brief and report are seconds off a cold disk)
export type QueuedHow = 'call' | 'meeting' | 'inbox' | 'hq' | 'agent';
function queuedHow(ids: number[]) {
  const rows = db
    .prepare(
      `select j.id, case
        when j.id in (select id from jobs indexed by jobs_called where call is not null)
          or j.id in (select id from jobs indexed by jobs_carried where item is not null)
          or j.id in (select job from calls where job is not null)
          or j.id in (select job from call_items where job is not null) then 'call'
        when exists (select 1 from meeting_seats s join meetings m on m.id = s.meeting where s.agent = j.queued_by
          and m.started <= j.created and (m.ended is null or m.ended >= j.created)) then 'meeting'
        when j.id in (select accepted from proposals where accepted is not null) then 'inbox'
        when j.queued_by is null then 'hq' else 'agent' end how
      from jobs j indexed by jobs_history where j.kind = 'work' and j.status = 'done'
        and j.id in (select value from json_each(?))`,
    )
    .all(JSON.stringify(ids)) as { id: number; how: QueuedHow }[];
  return new Map(rows.map(r => [r.id, r.how]));
}

// The sizes agents and models gave (any sizer but the tool), as given and as the play counts them (sizerbias.ts), out
// of sample: each at its sizer's bias from the clean jobs that finished in the two weeks before it was given, else every
// sizer's together, else as given.
function givenSizes(sized: Sized[], measured: Sized[]) {
  const pairOf = (s: Sized): [number, number] => [s.size.agent_ms, s.j.agent_ms];
  // (by finish, each one's parsed once)
  const pool = measured
    .filter(m => m.j.origin !== 'carry' && m.size.by !== 'tool' && !m.size.revised && m.j.agent_ms > 0)
    .map(m => ({ by: m.size.by, finished: Date.parse(m.j.finished), pair: pairOf(m) }))
    .sort((a, b) => a.finished - b.finished);
  const everyone = usualIn(pool),
    own = new Map([...Map.groupBy(pool, m => m.by)].map(([by, list]) => [by, usualIn(list)]));
  const given = sized.filter(s => s.size.by !== 'tool');
  const corrected = given.map(s => {
    // (the CEO's revision plays as given)
    if (s.size.revised) return pairOf(s);
    const at = Date.parse(s.size.at);
    const usual = own.get(s.size.by)?.(at - BIAS_WINDOW_MS, at) ?? everyone(at - BIAS_WINDOW_MS, at);
    return [s.size.agent_ms * (usual ?? 1), s.j.agent_ms] as [number, number];
  });
  return { given_sizes: spread(given.map(pairOf)), given_sizes_corrected: spread(corrected) };
}

// The usual bias (sizerbias.ts usualOf) of the pool's jobs that finished from `from` until before `to`, from running
// sums over the pool, which is sorted by finish.
function usualIn(pool: { finished: number; pair: [number, number] }[]) {
  const given = [0],
    took = [0];
  for (const { pair } of pool) {
    given.push(given.at(-1)! + pair[0]);
    took.push(took.at(-1)! + pair[1]);
  }
  // (the first job that finished at `at` or later)
  const index = (at: number) => {
    let low = 0,
      high = pool.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (pool[middle].finished < at) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return (from: number, to: number) => {
    const first = index(from),
      end = index(to);
    return usualOf(end - first, given[end] - given[first], took[end] - took[first]);
  };
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
// by then): a row stands until the next one moves it. One seek each (predictionlog.jobAt), never a job's every row.
async function etaMisses(jobs: number[], turn: latency.Turn, until: number) {
  const landed = landings(jobs);
  await turn('the landings');
  const samples: Sample[] = [];
  for (const { lead, ms } of LEADS)
    for (const [job, at] of landed) {
      if (at >= until) continue;
      const standing = predictionlog.jobAt(job, at - ms);
      if (standing) samples.push({ lead, merged: standing.merged, held: standing.held, landed: at });
    }
  const misses = byLead(samples);
  await turn("the ETAs' log");
  return misses;
}
