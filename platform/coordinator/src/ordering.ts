// The live claim's latest starts and eligibility, from the same inputs as the plan.
import { orderingSnapshot } from './backlog.ts';
import { db } from './db.ts';
import { onPublish } from './events.ts';
import * as latency from './latency.ts';
import * as claimobservation from './claimobservation.ts';
import * as jobs from './jobs.ts';
import * as redraws from './redraws.ts';
import { keepSpotSizes, recordFor, sizesFor } from './predictions.ts';
import { expand } from './rounds.ts';
import { backward, compare, precedence, ready, spareOnly, type Timing } from './planner.ts';
import type { QueuedJob } from './eta.ts';
import type { ProspectiveRun } from './reviewplan.ts';
import { placeholders } from './threadorder.ts';

// The plan is kept between reads and played again after a change HQ publishes (as forecast.ts start: an agent's own
// steps change nothing it reads), a new job, or KEEP_MS: a play holds the server most of a second, and every slot's
// worker claims each second. Before start() (tests, scripts) every read plays.
const KEEP_MS = 10_000;
let kept: { at: number; plan: ReturnType<typeof played> } | undefined;
let dropped: { reason: claimobservation.Reason; by: string } = { reason: 'start', by: 'HQ' };
let watching = false;
// (the live server keeps its plans: start(); tests and scripts play every read)
export const live = () => watching;
let newestPlayed: number | undefined;
export function start() {
  if (watching) return;
  watching = true;
  claimobservation.start();
  onPublish((e, by) => {
    if ((e.type === 'log' || e.type === 'status') && by !== 'agent' && kept) {
      kept = undefined;
      dropped = { reason: e.type === 'log' ? 'hq_log' : 'hq_status', by: e.agent ?? 'HQ' };
    }
  });
}
// A kept plan keeps its timings; its waits are read afresh on every read (eligibility).
const read = (plan: ReturnType<typeof played>) => ({ timings: plan.timings, eligible: plan.eligibility() });
export function current(now = Date.now()) {
  if (!watching) return read(played(now));
  const observed = claimobservation.begin();
  let reason: claimobservation.Reason = 'start';
  let plan: ReturnType<typeof played>;
  let playedMs = 0;
  try {
    const { newest } = db.prepare('select coalesce(max(id), 0) newest from jobs').get() as { newest: number };
    if (kept && newestPlayed === newest && Math.abs(now - kept.at) <= KEEP_MS) {
      reason = 'kept';
      plan = kept.plan;
    } else {
      reason = newestPlayed !== undefined && newestPlayed !== newest ? 'new_job' : !kept ? dropped.reason : 'expiry';
      const t0 = performance.now();
      kept = { at: now, plan: played(now) };
      playedMs = performance.now() - t0;
      newestPlayed = newest;
      plan = kept.plan;
    }
  } catch (error) {
    claimobservation.record(observed, reason, true);
    throw error;
  }
  claimobservation.record(observed, reason);
  if (playedMs >= claimobservation.SLOW_PLAY_MS) {
    const why = {
      start: 'the start',
      new_job: 'a new job',
      hq_log: `${dropped.by}'s log`,
      hq_status: `${dropped.by}'s status`,
      expiry: 'its age',
      kept: 'the kept plan',
    }[reason];
    latency.held(`the claim's plan: played ${Math.round(playedMs)} ms (after ${why})`, playedMs);
  }
  return read(plan);
}

// The queue the claim orders: open work, and each open thread with no task yet as one piece of its owner's work
// (threadorder.ts placeholders), as the forecast plays it, so work a timed thread with no task needs takes its latest
// start from that thread's deadline.
const queueAt = (now: number, run?: ProspectiveRun) => orderingSnapshot(now, placeholders(), false, run);

// Route a round before its next run is stored, with that run in both the queue and its remaining review stages.
export function withRound(run: ProspectiveRun, now: number) {
  return latestStarts(queueAt(now, run), now).timings;
}

function played(now: number) {
  const queue = queueAt(now);
  const { timings, jobs: planned } = latestStarts(queue, now);
  // A meeting's seats are dated by their set time and keep their board lane.
  const meetings = db
    .prepare(
      `select j.id, j.not_before from jobs j
    join meeting_seats s on s.job = j.id where j.status = 'queued'`,
    )
    .all() as { id: number; not_before: number }[];
  for (const seat of meetings)
    timings.set(seat.id, {
      id: seat.id,
      board: timings.get(seat.id)!.board,
      latestStart: seat.not_before,
      latestFinish: null,
      duration: 0,
    });
  const rows = new Map(planned.map(j => [j.id, j]));
  return { timings, eligibility: () => eligibility(rows, now, queue.deployLagMs) };
}
// Whether a queued job can start, for one read of the plan (a claim): the ends of the jobs the queue waits on are read
// the first time it asks, all in one statement, so the redraws' relations are played once a claim, not once an edge.
function eligibility(rows: ReadonlyMap<number, QueuedJob>, now: number, deployLagMs: number) {
  type End = { id: number; status: string; finished: string | null; merged: number };
  let ends: Map<number, End> | undefined;
  const endOf = (job: number) => {
    if (!ends) {
      const waitedOn = new Set([...rows.values()].flatMap(row => precedence(row, deployLagMs).jobs.map(e => e.job)));
      const found = db
        .prepare(
          redraws.query(
            `select j.id, j.status, coalesce(j.finished, (select max(ended) from runs where job = j.id)) finished, ${jobs.merged('j')} merged
            from jobs j where j.id in (select value from json_each(?))`,
          ),
        )
        .all(JSON.stringify([...waitedOn])) as End[];
      ends = new Map(found.map(r => [r.id, r]));
    }
    return ends.get(job);
  };
  return (id: number) => {
    const row = rows.get(id);
    if (!row) return true;
    return ready(
      row,
      now,
      edge => {
        const prior = endOf(edge.job);
        // (none: work not queued yet, a thread's placeholder.)
        if (!prior) return null;
        return (edge.until === 'done' ? prior.status === 'done' : prior.merged) ? Date.parse(prior.finished!) : null;
      },
      deployLagMs,
      'live',
    );
  };
}
// How long before its thread's deadline the pass has queued job `id` start: the deploy lag, its review rounds' runs and
// its own, each with the heartbeat's pause (planner.ts backward), played with its thread's jobs due now: their latest
// start comes that long before it. A window ending that long after now has the job's latest start now (made.ts, a
// window as soon as it can).
export function leadOf(id: number, thread: string, now: number) {
  const queue = queueAt(now);
  for (const row of queue.jobs) if (row.thread === thread) row.due = now;
  return now - latestStarts(queue, now).timings.get(id)!.latestStart!;
}
// The backward pass over the queue, at the slow sizes with each job's review rounds as runs.
function latestStarts(queue: ReturnType<typeof orderingSnapshot>, now: number) {
  keepSpotSizes();
  const record = recordFor(now, queue.jobs);
  const sizes = sizesFor(queue, 'slow', record);
  // (a placeholder sized on its thread's name and "done when", as the forecast sizes it: predictions.ts prepared)
  for (const job of queue.jobs)
    if (job.placeholder) {
      const drawn = record.drawn(job);
      sizes.set(job.id, drawn.slow ?? drawn.size);
    }
  const expanded = expand(queue, sizes, 'slow');
  return { timings: backward(expanded.snapshot, expanded.sizes, expanded.terminals), jobs: expanded.snapshot.jobs };
}
export const key = (id: number, board: boolean | number, timings: ReadonlyMap<number, Timing>) =>
  timings.get(id) ?? { id, board, latestStart: null };
// The base order, also HQ's queue rank: planner.compare over each job's key, spare downtime work after the rest.
// The claim shares a multi-run seat through reviewroom.ts.
export function claimOrder(timings: ReadonlyMap<number, Timing>) {
  const of = (j: { id: number; board: boolean | number }) => key(j.id, j.board, timings);
  return (a: { id: number; board: boolean | number; downtime: number }, b: typeof a) =>
    +spareOnly(a, of(a)) - +spareOnly(b, of(b)) || compare(of(a), of(b));
}
