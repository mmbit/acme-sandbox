// How well HQ's estimates held (hq estimate --accuracy): each stored prediction (predictions.ts) set against what
// happened, its agent time and its ETA, the worst misses with what moved; and the matching tried again on the work done
// lately, each job sized from the jobs done before it was queued, beside the simpler ways it could be done.
import { db } from './db.ts';
import { workBranch } from './jobs.ts';
import {
  ORIGIN,
  PRIVATE,
  FEWEST,
  LATEST,
  PICKS,
  pastJobs,
  pastJobsSoon,
  isPrivate,
  picksFor,
  rankedFirst,
  sizeOf,
  wordsOf,
  type PastJob,
} from './matching.ts';
import { mean, median, MINUTE_MS, spread, factor, fractionalMinutes } from './arithmetic.ts';
import * as taskaudit from './taskaudit.ts';
import * as latency from './latency.ts';

const WORST = 5,
  REPLAYED = 200;

export async function report(ask: taskaudit.AuditAsk) {
  const window = taskaudit.readWindow(ask);
  if (typeof window === 'number') return window;
  const { days, since } = window;
  const turn = latency.turns('hq estimate --accuracy');
  const tasks = await taskaudit.report(window, turn);
  await turn('the diagnostic pool', pastJobsSoon());
  const { ways, byThread, bySchedule } = replayed(`${days}/${ask.until ?? 'live'}`, window);
  await turn('the matching diagnostics');
  const kept = db.prepare(KEPT).all(since, window.until) as Kept[];
  return {
    tasks,
    ...{
      days,
      agent_time: agentTime(kept.filter(k => k.origin !== 'carry')),
      carry_checks: agentTime(
        kept.filter(k => k.origin === 'carry'),
        0,
      ),
      eta: etas(kept.filter(k => !k.merged_at || k.merged_at < window.until)),
    },
    ...{ matching: ways, matching_by_thread: byThread, matching_by_schedule: bySchedule },
  };
}

// ---- the stored predictions

type Kept = {
  job: number;
  origin: string;
  agent: string;
  title: string;
  made: string;
  agent_ms: number;
  picks: string;
  basis: string;
  start: number | null;
  done: number | null;
  eta: number | null;
  finished: string;
  started: string | null;
  spent_ms: number;
  merged_at: string | null;
  pr: number | null;
};
// Work that ended done since then, with its prediction, its ended runs and its latest pull request. Each job's runs are
// summed in a subquery: joined to every job's sums, the planner scans them all again per job. The jobs are read through
// db.ts jobs_history, never their rows, which hold the briefs.
const KEPT = `select * from (select p.*, ${ORIGIN} origin, j.agent, j.title, j.finished,
    (select min(started) from runs where job = j.id and ended is not null) started,
    (select sum((julianday(ended) - julianday(started)) * 86400000) from runs where job = j.id and ended is not null)
      spent_ms,
    pr.merged_at, pr.number pr
  from predictions p cross join jobs j indexed by jobs_history on j.id = p.job
  left join prs pr on pr.number = (select max(number) from prs where branch = ${workBranch('j')})
  where j.kind = 'work' and j.status = 'done' and j.finished >= ? and j.finished < ? and p.made <= j.finished
    and not ${PRIVATE}) where started is not null`;

function agentTime(kept: Kept[], floorMs = MINUTE_MS) {
  const misses = kept.map(k => ({ k, by: factor(k.agent_ms, k.spent_ms, floorMs) }));
  const worst = misses.sort((a, b) => Math.abs(b.by) - Math.abs(a.by)).slice(0, WORST);
  return {
    ...spread(
      kept.map(k => [k.agent_ms, k.spent_ms]),
      floorMs,
    ),
    worst: worst.map(({ k }) => ({
      ...named(k),
      predicted_minutes: fractionalMinutes(k.agent_ms),
      actual_minutes: fractionalMinutes(k.spent_ms),
      basis: JSON.parse(k.basis),
      picks: JSON.parse(k.picks),
    })),
  };
}

// An ETA holds or misses by the time its work merged (or ended, with no pull request), and what moved is read from the
// prediction's own steps: a later start, a longer run (waits for a seat on the way included), a longer review, and the
// time the board took on cards the work waited on, which isn't ours.
function etas(all: Kept[]) {
  const kept = all.filter(k => k.eta !== null && (k.pr === null || k.merged_at));
  const misses = kept.map(k => {
    const landed = Date.parse(k.merged_at ?? k.finished);
    return { k, landed, late: landed - k.eta! };
  });
  const middle = median(misses.map(m => Math.abs(m.late)));
  const worst = misses.sort((a, b) => Math.abs(b.late) - Math.abs(a.late)).slice(0, WORST);
  return {
    count: kept.length,
    median_miss_minutes: middle === null ? null : fractionalMinutes(middle),
    late_share: kept.length ? round(misses.filter(m => m.late > 0).length / kept.length) : null,
    worst: worst.map(({ k, landed, late }) => ({
      ...named(k),
      eta: k.eta,
      landed,
      late_minutes: fractionalMinutes(late),
      moved: moved(k, landed),
    })),
  };
}

function moved(k: Kept, landed: number) {
  const started = k.started ? Date.parse(k.started) : null,
    finished = Date.parse(k.finished);
  const span = (from: number | null, to: number | null) => (from === null || to === null ? null : to - from);
  const by = (actual: number | null, predicted: number | null) =>
    actual === null || predicted === null ? null : fractionalMinutes(actual - predicted);
  return {
    start_minutes: by(started, k.start),
    run_minutes: by(span(started, finished), span(k.start, k.done)),
    board_minutes: fractionalMinutes(boardTime(k.job, Date.parse(k.made), landed)),
  };
}

// The time the board's cards held the work: those it waited on (hq job --after request:<id>), those it filed, and its
// pull request's call, each from the later of its filing and the prediction to its answer.
function boardTime(job: number, from: number, to: number) {
  const cards = db
    .prepare(
      `select created, answered from requests where answered is not null and (id in (select request from request_waits
      where job = ?) or job = ? or pr = (select max(number) from prs where branch = (select ${workBranch('j')}
      from jobs j where j.id = ?)))`,
    )
    .all(job, job, job) as { created: string; answered: string }[];
  return cards.reduce((sum, c) => {
    const held = Math.min(Date.parse(c.answered), to) - Math.max(Date.parse(c.created), from);
    return sum + Math.max(0, held);
  }, 0);
}

// ---- the matching, tried again

// A replay takes a second or so of the server's time, and changes little within the hour: kept for half of one.
const KEEP_MS = 30 * MINUTE_MS;
let lastReplay: { key: string; at: number; found: ReturnType<typeof replay> } | null = null;
function replayed(key: string, window: { since: string; until: string }) {
  if (lastReplay?.key !== key || Date.now() - lastReplay.at > KEEP_MS)
    lastReplay = { key, at: Date.now(), found: replay(window.since, window.until) };
  return lastReplay.found;
}

// Each work job done since then, sized from the jobs done before it was queued: the way HQ matches now, the words alone
// over everyone's work (their median), and the agent's latest of the origin alone.
// The jobs done before each one was queued are the first of them all by when they finished, found once per job: every
// way matches against that same list, so matching.ts's work on a pool (its groups, its titles' index) is done once.
function replay(since: string, until: string) {
  // (a copy: the pool is shared)
  const all = pastJobs()
    .filter(j => j.origin !== 'carry' && !isPrivate(j))
    .sort((a, b) => Date.parse(a.finished) - Date.parse(b.finished));
  const tried = all.filter(j => j.finished >= since && j.finished < until).slice(-REPLAYED);
  const countBefore = new Map(
    tried.map(j => {
      const n = all.findIndex(p => p.finished >= j.created);
      return [j, n < 0 ? all.length : n];
    }),
  );
  const before = new Map(tried.map(j => [j, all.slice(0, countBefore.get(j))]));
  const ways: [string, (j: PastJob) => number | null][] = [
    ['agent, kind and words (the mean)', j => sizeOf(picksFor(j, before.get(j)!).picks)?.agent_ms ?? null],
    [
      'words alone (the median)',
      j =>
        median(
          rankedFirst(all, countBefore.get(j)!, wordsOf(j.title))
            .slice(0, PICKS)
            .map(p => p.agent_ms),
        ),
    ],
    ['agent and kind alone (the mean)', j => mean(latestOfOrigin(j, before.get(j)!).map(p => p.agent_ms))],
  ];
  const found = ways.map(([way, size]) => {
    const pairs: [number, number][] = [];
    for (const j of tried) {
      const predicted = size(j);
      if (predicted === null) continue;
      pairs.push([predicted, j.agent_ms]);
    }
    return { way, ...spread(pairs) };
  });
  const byThread = replayByThread(tried, before);
  const bySchedule = replayBySchedule(tried, all, before);
  return { ways: found, byThread, bySchedule };
}
function replayByThread(tried: PastJob[], beforeOf: Map<PastJob, PastJob[]>) {
  // The work done in a thread with FEWEST or more of its jobs done before it was queued: sized the way HQ matches now,
  // and from its thread's done jobs alone (the same matching, within the thread), to see which is the better basis.
  const threaded = tried.flatMap(j => {
    const before = beforeOf.get(j)!;
    const own = j.thread ? before.filter(p => p.thread === j.thread) : [];
    return own.length >= FEWEST ? [{ j, before, own }] : [];
  });
  const pairsOf = (pool: (t: (typeof threaded)[number]) => PastJob[]) =>
    threaded.flatMap(t => {
      const predicted = sizeOf(picksFor(t.j, pool(t)).picks)?.agent_ms;
      return predicted === undefined ? [] : [[predicted, t.j.agent_ms] as [number, number]];
    });
  return {
    jobs: threaded.length,
    usual: spread(pairsOf(t => t.before)),
    thread_first: spread(pairsOf(t => t.own)),
  };
}
// The scheduled jobs done, sized the way HQ matches now (on their entry's runs, matching.ts runsLike) and on the matching
// alone, as before; the rest the same two ways, which only the scheduled jobs'
// slots, no longer words of their titles, can tell apart.
function replayBySchedule(tried: PastJob[], all: PastJob[], beforeOf: Map<PastJob, PastJob[]>) {
  const unscheduled = new Map(all.map(j => [j, { ...j, entry: null, routine: null, slot: null }]));
  const replayed = (jobs: PastJob[]) => {
    const runs: [number, number][] = [],
      matching: [number, number][] = [];
    for (const j of jobs) {
      const before = beforeOf.get(j)!;
      const now = sizeOf(picksFor(j, before).picks);
      const alone = sizeOf(
        picksFor(
          unscheduled.get(j)!,
          before.map(p => unscheduled.get(p)!),
        ).picks,
      );
      if (now) runs.push([now.agent_ms, j.agent_ms]);
      if (alone) matching.push([alone.agent_ms, j.agent_ms]);
    }
    return { jobs: jobs.length, now: spread(runs), matching_alone: spread(matching) };
  };
  return { scheduled: replayed(tried.filter(j => j.entry)), rest: replayed(tried.filter(j => !j.entry)) };
}
const latestOfOrigin = (j: PastJob, before: PastJob[]) =>
  before.filter(p => p.origin === j.origin && p.agent === j.agent).slice(-LATEST);

const named = (k: Kept) => ({ id: k.job, agent: k.agent, title: k.title });
const round = (n: number) => Math.round(n * 100) / 100;
