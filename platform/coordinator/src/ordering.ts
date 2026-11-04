// The live claim's latest starts and eligibility, from the same inputs as the plan.
import { orderingInParts } from './backlog.ts';
import { db, scrubbed } from './db.ts';
import { onPublish } from './events.ts';
import * as latency from './latency.ts';
import * as claimobservation from './claimobservation.ts';
import * as jobs from './jobs.ts';
import { taskUrgent } from './urgency.ts';
import * as redraws from './redraws.ts';
import { recordFor, sizesFor } from './predictions.ts';
import { expand } from './rounds.ts';
import { backward, compare, precedence, ready, spareOnly, type Timing } from './planner.ts';
import type { OrderingSnapshot, QueuedJob } from './eta.ts';
import { placeholders } from './threadorder.ts';

// The plan is kept between reads and played again after a change HQ publishes (as forecast.ts start: an agent's own
// steps change nothing it reads), a new job, or KEEP_MS: a play holds the server most of a second, and every slot's
// worker claims each second. Before start() (tests, scripts) every read plays.
const KEEP_MS = 10_000;
// A plan with what it was played on: the newest job and HQ's changes so far (invalidations), so that a change published
// while it plays in turns, or in a route's step on it, leaves it unused (holds).
type Plan = ReturnType<typeof played>;
type Kept = { at: number; plan: Plan; newest: number; invalidations: number };
let kept: Kept | undefined;
// (the newest job the last kept plan was played on, for why the next one plays: new_job)
let newestPlayed: number | undefined;
let dropped: { reason: claimobservation.Reason; by: string } = { reason: 'start', by: 'HQ' };
let watching = false;
// (the live server keeps its plans: start(); tests and scripts play every read)
export const live = () => watching;
let invalidations = 0;
export function start() {
  if (watching) return;
  watching = true;
  claimobservation.start();
  onPublish((e, by) => {
    if ((e.type === 'log' || e.type === 'status') && by !== 'agent') {
      invalidations++;
      if (!kept) return;
      kept = undefined;
      dropped = { reason: e.type === 'log' ? 'hq_log' : 'hq_status', by: e.agent ?? 'HQ' };
    }
  });
}
const newestJob = () => (db.prepare('select coalesce(max(id), 0) newest from jobs').get() as { newest: number }).newest;
// Whether a plan still holds: no job queued and no change published since its play began
const holds = (played: Kept, newest: number) => played.newest === newest && played.invalidations === invalidations;
// Why the plan plays again, or 'kept'
function freshness(now: number, newest: number): claimobservation.Reason {
  if (kept && holds(kept, newest) && Math.abs(now - kept.at) <= KEEP_MS) return 'kept';
  return newestPlayed !== undefined && newestPlayed !== newest ? 'new_job' : !kept ? dropped.reason : 'expiry';
}
const why = (reason: claimobservation.Reason) =>
  ({
    start: 'the start',
    new_job: 'a new job',
    hq_log: `${dropped.by}'s log`,
    hq_status: `${dropped.by}'s status`,
    expiry: 'its age',
    kept: 'the kept plan',
  })[reason];
// A kept plan keeps its timings; its waits are read afresh on every read (eligibility).
const read = (plan: Plan) => ({ timings: plan.timings, eligible: plan.eligibility() });
export function current(now = Date.now()) {
  if (!watching) return read(played(now));
  const observed = claimobservation.begin();
  let reason: claimobservation.Reason = 'start';
  let plan: Plan;
  let playedMs = 0;
  try {
    const newest = newestJob();
    // (the plan its route played for its step, while it holds: withPlan.)
    const onStep = stepOn && holds(stepOn, newest) ? stepOn : undefined;
    reason = onStep ? 'kept' : freshness(now, newest);
    if (reason === 'kept') plan = (onStep ?? kept!).plan;
    else {
      const t0 = performance.now();
      kept = { at: now, plan: played(now), newest, invalidations };
      playedMs = performance.now() - t0;
      [plan, newestPlayed] = [kept.plan, newest];
    }
  } catch (error) {
    claimobservation.record(observed, reason, true);
    throw error;
  }
  claimobservation.record(observed, reason);
  if (playedMs >= claimobservation.SLOW_PLAY_MS)
    latency.held(`the claim's plan: played ${Math.round(playedMs)} ms (after ${why(reason)})`, playedMs);
  return read(plan);
}

// The claim's plan in turns of HQ's thread (latency.ts inTurns), so a claim or a heartbeat holds HQ no longer than the
// plan's longest part: the route plays it, then makes its step on it (withPlan), so one claim's choice is made on one
// plan. One play at a time: a route asking meanwhile waits for the one in its turns. A plan a job queued or a change
// published overtook while it played (eligibility reads each job's waits as they were) plays again in turns, once: a
// second overtaking leaves it to the step, which plays it whole (current), as a step whose own work publishes a change
// does. So HQ's changes can cost a claim the hold it had before the turns, never an endless wait for a play. Before
// start(), nothing to await: the step plays its own (current).
const PLAYS = 2;
let playing: Promise<Kept> | undefined;
async function fresh(): Promise<Kept | undefined> {
  if (!watching) return undefined;
  for (let plays = 0; plays < PLAYS; plays++) {
    const now = Date.now(),
      newest = newestJob();
    if (freshness(now, newest) === 'kept') return kept;
    const played = await (playing ??= playInTurns(now, newest).finally(() => (playing = undefined)));
    if (holds(played, newestJob())) return played;
  }
  return undefined;
}
async function playInTurns(now: number, newest: number) {
  const reason = freshness(now, newest),
    [observed, began] = [claimobservation.begin(), invalidations];
  try {
    const plan = await latency.inTurns(playedInParts(now), latency.turns(`the claim's plan (after ${why(reason)})`));
    const played = { at: now, plan, newest, invalidations: began };
    if (holds(played, newestJob())) [kept, newestPlayed] = [played, newest];
    claimobservation.record(observed, reason);
    return played;
  } catch (error) {
    claimobservation.record(observed, reason, true);
    throw error;
  }
}
// The plan played (fresh), then a route's synchronous step on it: every read of the plan in that step is it while it
// holds, and a job queued or a change published in the step (a run given up on, jobs.ts requeueAbandoned; a wake met)
// plays it again. A save's scrub under way (db.ts scrubSaved) is waited for after the play's last turn, as the step reads
// what an agent is given, and the plan played again after it.
let stepOn: Kept | undefined;
export async function withPlan<T>(step: () => T) {
  let played = await latency.exclude(fresh());
  while (await latency.exclude(scrubbed())) played = await latency.exclude(fresh());
  stepOn = played;
  try {
    return step();
  } finally {
    stepOn = undefined;
  }
}

// The queue the claim orders: open work, and each open thread with no task yet as one piece of its owner's work
// (threadorder.ts placeholders), as the forecast plays it, so work a timed thread with no task needs takes its latest
// start from that thread's deadline. In parts (backlog.ts orderingInParts) for the claim's play in turns, whole for the
// lead.
const queueInParts = (now: number) => orderingInParts(now, placeholders(), false);
const queueAt = (now: number) => latency.whole(queueInParts(now));

const played = (now: number) => latency.whole(playedInParts(now));
// (in parts: the queue's read, then the backward pass.)
function* playedInParts(now: number) {
  const queue = yield* queueInParts(now);
  const { timings, jobs: planned } = latestStarts(queue, now);
  // A meeting's seats are dated by their set time and keep their board lane: those in the queue read (a seat queued
  // since is a new job, played again: fresh.)
  const seats = queue.jobs.filter(job => job.kind === 'meeting' && job.status === 'queued');
  for (const seat of seats)
    timings.set(seat.id, {
      id: seat.id,
      board: timings.get(seat.id)!.board,
      urgent: timings.get(seat.id)!.urgent,
      latestStart: seat.notBefore,
      latestFinish: null,
      duration: 0,
    });
  yield 'latest starts';
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
function latestStarts(queue: OrderingSnapshot, now: number) {
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
  timings.get(id) ?? { id, board, urgent: taskUrgent(id), latestStart: null };
// The base order, also HQ's queue rank: planner.compare over each job's key, spare downtime work after the rest.
// The claim shares a multi-run seat through reviewroom.ts.
export function claimOrder(timings: ReadonlyMap<number, Timing>) {
  const of = (j: { id: number; board: boolean | number }) => key(j.id, j.board, timings);
  return (a: { id: number; board: boolean | number; downtime: number }, b: typeof a) =>
    +spareOnly(a, of(a)) - +spareOnly(b, of(b)) || compare(of(a), of(b));
}
