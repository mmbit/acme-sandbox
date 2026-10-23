// How well HQ's estimates held (hq estimate --accuracy): each stored prediction (predictions.ts) set against what
// happened, its agent time and its ETA, the worst misses with what moved; and the matching tried again on the work done
// lately, each job sized from the jobs done before it was queued, beside the simpler ways it could be done.
import { db } from './db.ts';
import { workBranch } from './jobs.ts';
import { FEWEST, LATEST, PICKS, pastJobs, picksFor, ranked, sizeOf, wordsOf, type PastJob } from './matching.ts';
import { mean, median } from './arithmetic.ts';

const MINUTE_MS = 60_000,
  DAY_MS = 24 * 60 * MINUTE_MS;
const WORST = 5,
  REPLAYED = 200;

export function report(ask: { days?: unknown }) {
  const days = ask.days === undefined ? 7 : Number(ask.days);
  if (!Number.isInteger(days) || days < 1 || days > 30) return 400;
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const { ways, byThread, bySchedule } = replayed(days, since);
  return {
    ...{ days, agent_time: agentTime(since), eta: etas(since) },
    ...{ matching: ways, matching_by_thread: byThread, matching_by_schedule: bySchedule },
  };
}

// ---- the stored predictions

type Kept = {
  job: number;
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
// Work that ended done since then, with its prediction, its runs and its latest pull request.
const KEPT = `select p.*, j.agent, j.title, j.finished, r.started, r.spent_ms, pr.merged_at, pr.number pr
  from predictions p join jobs j on j.id = p.job
  join (select job, min(started) started, sum((julianday(ended) - julianday(started)) * 86400000) spent_ms from runs
    where ended is not null group by job) r on r.job = j.id
  left join prs pr on pr.number = (select max(number) from prs where branch = ${workBranch('j')})
  where j.status = 'done' and j.finished >= ?`;

function agentTime(since: string) {
  const kept = db.prepare(KEPT).all(since) as Kept[];
  const misses = kept.map(k => ({ k, by: factor(k.agent_ms, k.spent_ms) }));
  const worst = misses.sort((a, b) => Math.abs(b.by) - Math.abs(a.by)).slice(0, WORST);
  return {
    ...spread(kept.map(k => [k.agent_ms, k.spent_ms])),
    worst: worst.map(({ k }) => ({
      ...named(k),
      predicted_minutes: minutes(k.agent_ms),
      actual_minutes: minutes(k.spent_ms),
      basis: JSON.parse(k.basis),
      picks: JSON.parse(k.picks),
    })),
  };
}

// An ETA holds or misses by the time its work merged (or ended, with no pull request), and what moved is read from the
// prediction's own steps: a later start, a longer run (waits for a seat on the way included), a longer review, and the
// time the board took on cards the work waited on, which isn't ours.
function etas(since: string) {
  const kept = (db.prepare(KEPT).all(since) as Kept[]).filter(k => k.eta !== null && (k.pr === null || k.merged_at));
  const misses = kept.map(k => {
    const landed = Date.parse(k.merged_at ?? k.finished);
    return { k, landed, late: landed - k.eta! };
  });
  const middle = median(misses.map(m => Math.abs(m.late)));
  const worst = misses.sort((a, b) => Math.abs(b.late) - Math.abs(a.late)).slice(0, WORST);
  return {
    count: kept.length,
    median_miss_minutes: middle === null ? null : minutes(middle),
    late_share: kept.length ? round(misses.filter(m => m.late > 0).length / kept.length) : null,
    worst: worst.map(({ k, landed, late }) => ({
      ...named(k),
      eta: k.eta,
      landed,
      late_minutes: minutes(late),
      moved: moved(k, landed),
    })),
  };
}

function moved(k: Kept, landed: number) {
  const started = k.started ? Date.parse(k.started) : null,
    finished = Date.parse(k.finished);
  const span = (from: number | null, to: number | null) => (from === null || to === null ? null : to - from);
  const by = (actual: number | null, predicted: number | null) =>
    actual === null || predicted === null ? null : minutes(actual - predicted);
  return {
    start_minutes: by(started, k.start),
    run_minutes: by(span(started, finished), span(k.start, k.done)),
    board_minutes: minutes(boardTime(k.job, Date.parse(k.made), landed)),
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
let lastReplay: { days: number; at: number; found: ReturnType<typeof replay> } | null = null;
function replayed(days: number, since: string) {
  if (lastReplay?.days !== days || Date.now() - lastReplay.at > KEEP_MS)
    lastReplay = { days, at: Date.now(), found: replay(since) };
  return lastReplay.found;
}

// Each work job done since then, sized from the jobs done before it was queued: the way HQ matches now, the words alone
// over everyone's work (their median), and the agent's latest of the origin alone.
function replay(since: string) {
  const all = pastJobs().sort((a, b) => Date.parse(a.finished) - Date.parse(b.finished));
  const tried = all.filter(j => j.finished >= since).slice(-REPLAYED);
  const ways: [string, (j: PastJob, before: PastJob[]) => number | null][] = [
    ['agent, kind and words (the mean)', (j, before) => sizeOf(picksFor(j, before).picks)?.agent_ms ?? null],
    [
      'words alone (the median)',
      (j, before) =>
        median(
          ranked(before, wordsOf(j.title))
            .slice(0, PICKS)
            .map(p => p.agent_ms),
        ),
    ],
    ['agent and kind alone (the mean)', (j, before) => mean(latestOfOrigin(j, before).map(p => p.agent_ms))],
  ];
  const found = ways.map(([way, size]) => {
    const pairs: [number, number][] = [];
    for (const j of tried) {
      const predicted = size(
        j,
        all.filter(p => p.finished < j.created),
      );
      if (predicted === null) continue;
      pairs.push([predicted, j.agent_ms]);
    }
    return { way, ...spread(pairs) };
  });
  const byThread = replayByThread(tried, all);
  const bySchedule = replayBySchedule(tried, all);
  return { ways: found, byThread, bySchedule };
}
function replayByThread(tried: PastJob[], all: PastJob[]) {
  // The work done in a thread with FEWEST or more of its jobs done before it was queued: sized the way HQ matches now,
  // and from its thread's done jobs alone (the same matching, within the thread), to see which is the better basis.
  const threaded = tried.flatMap(j => {
    const before = all.filter(p => p.finished < j.created);
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
function replayBySchedule(tried: PastJob[], all: PastJob[]) {
  const unscheduled = new Map(all.map(j => [j, { ...j, entry: null, routine: null, slot: null }]));
  const replayed = (jobs: PastJob[]) => {
    const runs: [number, number][] = [],
      matching: [number, number][] = [];
    for (const j of jobs) {
      const before = all.filter(p => p.finished < j.created);
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

// ---- measures

// How far predictions [predicted, actual] were off: the median factor either way, the share within twice or half, and
// the sum of the predictions against the sum of what happened (a thread's estimate is a sum). hq estimate --calibration
// measures its groups with it too.
export function spread(pairs: [number, number][]) {
  const by = pairs.map(([predicted, actual]) => Math.abs(factor(predicted, actual)));
  const middle = median(by);
  const sum = (i: 0 | 1) => pairs.reduce((total, pair) => total + pair[i], 0);
  return {
    count: pairs.length,
    median_factor: middle === null ? null : round(Math.exp(middle)),
    within_twice: by.length ? round(by.filter(f => f <= Math.LN2).length / by.length) : null,
    sum_ratio: sum(1) ? round(sum(0) / sum(1)) : null,
  };
}
// (a minute at least: a job of seconds is no miss)
const factor = (predicted: number, actual: number) =>
  Math.log(Math.max(actual, MINUTE_MS) / Math.max(predicted, MINUTE_MS));
const named = (k: Kept) => ({ id: k.job, agent: k.agent, title: k.title });
const minutes = (ms: number) => Math.round(ms / MINUTE_MS);
const round = (n: number) => Math.round(n * 100) / 100;
