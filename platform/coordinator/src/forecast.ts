// HQ's one forecast: the queue's play (eta.ts) on the stored sizes, both paces on one snapshot, kept as last played. It
// plays again a few seconds after each change the coordinator publishes (a job queued, started or ended, a pull request
// ruled, a card asked or answered: one play for a burst of them) and every minute (server.ts), and everything that shows
// a time reads it: the projects view, hq projects and hq thread, the CEO's summary (summary.ts). Per job, its outlook; per
// thread, its two numbers (the agent time its open work has left, and its ETA, its last open job merged), what it waits
// on, and the chain of jobs that sets its ETA with the cause at each link. Never a sum of hours read as a time.
import * as latency from './latency.ts';
import * as predictions from './predictions.ts';
import { heldTo } from './predictions.ts';
import { onPublish } from './events.ts';
import {
  play as playQueue,
  PLAY_VERSION,
  type Outlook,
  type QueuedJob,
  type Size,
  type Snapshot,
  type Wait,
} from './eta.ts';

// A job's wait on another names that job's thread, so a thread's waits say which other thread holds it.
export type ThreadWait = Wait & { thread?: string | null };
// One link of the chain that sets a thread's ETA: a job, where it is, when it starts and merges in the play, and what
// holds it besides the job before it in the chain.
export type Link = {
  job: number;
  agent: string;
  title: string;
  thread: string | null;
  status: string;
  pr: number | null;
  start: number | null;
  merged: number | null;
  causes: Wait[];
};
export type ThreadOutlook = {
  thread: string;
  // its open work jobs, oldest first, and its review runs and checks queued or running
  jobs: number[];
  runs: number[];
  // the agent time its open work has left: its work jobs' (the play's left_ms) and its review runs' and checks'
  left_ms: number;
  // its last open job merged; null while one of them doesn't merge in the play (stalled, or past its horizon)
  eta: number | null;
  finish: number | null;
  deadline: number | null;
  aim: number | null;
  slack: number | null;
  // the time a promise holds to: the slow play's (predictions.heldTo)
  held: number | null;
  // what its jobs wait on, together: the board's cards, the seats, jobs in other threads (named with their thread)
  waits: ThreadWait[];
  cards: { request: number; at: number }[];
  // the chain of jobs that sets its ETA, the last one first
  chain: Link[];
  // the job that goes on next: a running one, else the first to start in the play
  next: number | null;
};
export type Forecast = {
  now: number;
  version: number;
  snapshot: Snapshot;
  sizes: { usual: Map<number, Size>; slow: Map<number, Size> };
  // who gave each work job's size ('tool' for its stored prediction: predictions.ts latestSizes).
  sizedBy: Map<number, string>;
  usual: Map<number, Outlook>;
  slow: Map<number, Outlook>;
  threads: Map<string, ThreadOutlook>;
};

// After a change, the play waits this long for the rest of a burst (a finish publishes several events) before it plays:
// a play holds the server for a moment, so it plays at most once in this time however busy the feed is.
const SETTLE_MS = 10_000;
// The chain is followed this far back.
const CHAIN_MAX = 12;

let latest: Forecast | undefined;
// (whether a change HQ published since the last play waits for its play)
let stale = true;
// (whether published changes play it again: the server's start)
let watching = false;
let pending: NodeJS.Timeout | undefined;
const played: ((f: Forecast) => void)[] = [];

// The queue played now at both paces, kept nowhere: it neither becomes the latest forecast nor is logged.
export function play(now = Date.now()): Forecast {
  const plays = predictions.played(now);
  return {
    now,
    version: PLAY_VERSION,
    ...plays,
    threads: threadOutlooks(plays.snapshot, plays.usual, plays.slow, plays.sizes.usual),
  };
}

// The queue read now and played at the usual pace, the one a thread's ETA and finish come from, as it is and as each
// change gives it (`changed`): one read for every play, kept nowhere. What hq window does to the plan (moves.ts change).
export function trial(now = Date.now()) {
  const { snapshot, sizes, sizedBy } = predictions.prepared(now, [], ['usual']);
  return (changed: (queue: Snapshot) => Snapshot = queue => queue): Forecast => {
    const queue = changed(snapshot),
      usual = playQueue(queue, sizes.usual, { pace: 'usual' });
    const slow = new Map<number, Outlook>();
    return {
      now,
      version: PLAY_VERSION,
      snapshot: queue,
      sizes,
      sizedBy,
      usual,
      slow,
      threads: threadOutlooks(queue, usual, slow, sizes.usual),
    };
  };
}

// The queue played now, kept as the latest forecast. Whatever follows every play (afterEach) is told.
export function refresh(now = Date.now()): Forecast {
  const t0 = performance.now();
  const forecast = play(now);
  [latest, stale] = [forecast, false];
  const t1 = performance.now(),
    afters: number[] = [];
  for (const after of played) {
    const ta = performance.now();
    try {
      after(forecast);
    } catch (err) {
      console.error('After the forecast:', err);
    }
    afters.push(Math.round(performance.now() - ta));
  }
  // (a slow play's parts, in the status report's holds: latency.ts held)
  if (performance.now() - t0 >= 500)
    latency.held(
      `the play's parts: played ${Math.round(t1 - t0)} ms (${forecast.snapshot.jobs.length} jobs), after each ${afters.join('/')} ms`,
      performance.now() - t0,
    );
  return forecast;
}

// The latest forecast. While the server watches, it's shown as last played: it plays again a moment after each change
// and every minute (server.ts), never on a request, which would hold HQ for the play's time. Without a play yet, or
// with nothing watching for changes (a test, a one-off), it plays now.
export function current(now = Date.now()) {
  if (!latest || !watching) return refresh(now);
  return latest;
}

// The latest forecast if there is one, never played for the asking: HQ's job rows read their planned starts from it
// (jobs.ts jobRows).
export const lastPlayed = () => latest;

// What runs after every play (the prediction log: predictionlog.ts), registered once at start.
export const afterEach = (after: (f: Forecast) => void) => void played.push(after);

// The server's start: every change HQ publishes plays the queue again SETTLE_MS later, once for a burst, unless a play
// came in between (hq job plays its own: moves.ts). An agent's own steps and status change nothing the play reads: a
// running job's would play the queue every SETTLE_MS. Work sized on the spot keeps its size for the hour
// (predictions.ts keepSpotSizes).
export function start() {
  if (watching) return;
  watching = true;
  predictions.keepSpotSizes();
  onPublish((e, by) => {
    if ((e.type === 'log' || e.type === 'status') && by !== 'agent') playSoon();
  });
}

// Published changes and new sizes (sizer.ts) share one settled play per burst: a play holds the server.
// Nothing to do while nothing watches: current() plays on every read then.
export function playSoon() {
  if (!watching) return;
  stale = true;
  pending ??= setTimeout(() => {
    pending = undefined;
    if (!stale) return;
    try {
      refresh();
    } catch (err) {
      console.error('Could not play the queue:', err);
    }
  }, SETTLE_MS);
  pending.unref();
}

// ---- threads

// Every thread with open work, from the plays: its jobs' numbers added up and the chain that sets its ETA.
export function threadOutlooks(
  snapshot: Snapshot,
  usual: Map<number, Outlook>,
  slow: Map<number, Outlook>,
  sizes: Map<number, Size>,
) {
  const byId = new Map(snapshot.jobs.map(j => [j.id, j]));
  const groups = new Map<string, QueuedJob[]>();
  for (const job of snapshot.jobs)
    if (job.thread && (job.id > 0 || job.placeholder)) groups.set(job.thread, [...(groups.get(job.thread) ?? []), job]);
  const threads = new Map<string, ThreadOutlook>();
  for (const [thread, all] of groups) {
    const work = all.filter(j => j.kind === 'work' && usual.has(j.id));
    if (!work.length) continue;
    const runs = all.filter(j => j.kind !== 'work');
    const seen = work.map(j => ({ job: j, usual: usual.get(j.id)!, slow: slow.get(j.id) }));
    const stalled = seen.some(s => s.usual.merged === null);
    const eta = stalled ? null : Math.max(...seen.map(s => s.usual.merged!));
    const held = stalled ? null : Math.max(...seen.map(s => (s.slow ? heldTo(s.usual, s.slow) : s.usual.merged)!));
    const runLeft = runs.reduce((sum, r) => sum + Math.max((sizes.get(r.id)?.agent_ms ?? 0) - r.spentMs, 0), 0);
    const last = seen.reduce((a, b) => (later(b.usual, a.usual) ? b : a));
    const window = snapshot.windows?.[thread],
      finish = eta === null ? null : eta + snapshot.deployLagMs;
    threads.set(thread, {
      thread,
      jobs: work.map(j => j.id),
      runs: runs.map(r => r.id),
      left_ms: Math.round(seen.reduce((sum, s) => sum + s.usual.left_ms, 0) + runLeft),
      eta,
      finish,
      deadline: window?.deadline ?? null,
      aim: window?.aim ?? null,
      slack: finish === null || window?.deadline == null ? null : window.deadline - finish,
      held,
      waits: threadWaits(thread, seen, byId),
      cards: [...new Map(seen.flatMap(s => s.usual.cards).map(c => [c.request, c])).values()].sort(
        (a, b) => a.request - b.request,
      ),
      chain: chainOf(last.job, usual, byId),
      next: nextOf(seen),
    });
  }
  return threads;
}

// Where a thread stands against its window: it misses (its planned finish past the deadline, or none in sight), gives
// (its finish past its aim, inside the deadline) or holds; null without a window.
export type Standing = 'misses' | 'gives' | 'holds';
export function standing(t: Pick<ThreadOutlook, 'finish' | 'deadline' | 'aim'>): Standing | null {
  if (t.deadline === null) return null;
  if (t.finish === null || t.finish > t.deadline) return 'misses';
  return t.aim !== null && t.finish > t.aim ? 'gives' : 'holds';
}

// The one that merges later: one that doesn't merge at all is the latest.
const later = (a: Outlook, b: Outlook) =>
  a.merged === null
    ? b.merged !== null || (a.start ?? Infinity) > (b.start ?? Infinity)
    : b.merged !== null && a.merged > b.merged;

// Its jobs' waits together, each once: a wait on another of its own jobs is the thread's own work, not a wait.
function threadWaits(thread: string, seen: { usual: Outlook }[], byId: Map<number, QueuedJob>) {
  const waits = new Map<string, ThreadWait>();
  for (const { usual } of seen)
    for (const w of usual.waits) {
      if (w.on === 'job' && byId.get(w.job)?.thread === thread) continue;
      const named: ThreadWait = w.on === 'job' ? { ...w, thread: byId.get(w.job)?.thread ?? null } : w;
      // (a wait behind other work grows by the minute: one per engine, its longest)
      const key = w.on === 'queue' ? `queue:${w.engine}` : JSON.stringify(named);
      const had = waits.get(key);
      if (!had || (w.on === 'queue' && had.on === 'queue' && w.minutes > had.minutes)) waits.set(key, named);
    }
  return [...waits.values()];
}

// From the job that sets the ETA back through the job it waits for that lets it go last, to the first one waiting on
// nothing but itself; each link with its causes (what held it besides that job).
function chainOf(last: QueuedJob, usual: Map<number, Outlook>, byId: Map<number, QueuedJob>) {
  const chain: Link[] = [];
  const seen = new Set<number>();
  for (let job: QueuedJob | undefined = last; job && chain.length < CHAIN_MAX && !seen.has(job.id);) {
    seen.add(job.id);
    const o: Outlook = usual.get(job.id)!;
    chain.push({
      ...{ job: job.id, agent: job.agent, title: job.title, thread: job.thread ?? null, status: job.status },
      ...{ pr: job.review?.pr ?? job.pr, start: o.start, merged: o.merged },
      causes: o.waits.filter(w => w.on !== 'job'),
    });
    const priors: number[] = o.waits.flatMap(w => (w.on === 'job' && usual.has(w.job) ? [w.job] : []));
    const prior: number | undefined = priors.sort((a, b) => (later(usual.get(a)!, usual.get(b)!) ? -1 : 1))[0];
    job = prior === undefined ? undefined : byId.get(prior);
  }
  return chain;
}

// A running job first (the one started first), else the one the play starts first.
function nextOf(seen: { job: QueuedJob; usual: Outlook }[]) {
  const running = seen.filter(s => s.job.status === 'running');
  const waiting = seen.filter(s => s.job.status !== 'running' && s.job.status !== 'done');
  const pick = (running.length ? running : waiting).sort(
    (a, b) => (a.usual.start ?? Infinity) - (b.usual.start ?? Infinity) || a.job.id - b.job.id,
  )[0];
  return pick?.job.id ?? null;
}
