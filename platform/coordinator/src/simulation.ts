// The forward plan: measured runs share slots, memory and seat windows in latest-start order.
import type { QueuedJob, Size, Snapshot, Wait } from './eta.ts';
import {
  backward,
  compare,
  dependencyRun,
  PAUSE_MS,
  ROOM_AFTER_MS,
  precedence,
  remaining,
  spareOnly,
  type Timing,
} from './planner.ts';
import { expand } from './rounds.ts';
import * as capacity from './playseats.ts';
import * as playclaims from './playclaims.ts';
import * as reviewroom from './reviewroom.ts';
import { hold, holdFullRoom, makeRoom, releaseHold, reviewOccupants, unreported } from './playroom.ts';
import type { Span } from './playtime.ts';
import { outlook } from './playoutlook.ts';

export const DAY_MS = 86_400_000;
// How far ahead the play goes (hq when searches no further).
export const HORIZON_DAYS = 8;
export type Run = {
  row: QueuedJob;
  // (its place among the play's runs: the order the play goes through them in)
  index: number;
  needs: ReturnType<typeof precedence>;
  // the run each of its needs' edges waits for (none outside the play), with the edge's lag
  priors: { run: Run | undefined; lag: number }[];
  // the moments that may start it while it waits that never move (its needs' readyAt, the board's room delay, its
  // latest start's pause), in order, and the first of them still to come
  fixed: number[];
  fixedAt: number;
  order: Timing;
  // (its order with what the pause rules read of it, planner.ts pauseVictim)
  standing: Timing & { kind: string; downtime: number; engine: string; followThrough?: boolean };
  state: 'waiting' | 'running' | 'pausing' | 'done';
  readyAt: number;
  start: number | null;
  done: number | null;
  ends: number;
  left: number;
  remainingMs: number;
  seat: capacity.Seat | null;
  waits: Wait[];
  active: Span[];
  held: { since: number; by: Wait } | null;
  reviewSeat: string | null;
  queueWait: Wait;
  nextHold: Wait | null;
};
export type Play = {
  snapshot: Snapshot;
  runs: Map<number, Run>;
  unfinished: Set<Run>;
  // the running and pausing runs, in the runs' order, and the resolutions still to resolve: a moment goes through these,
  // not every unfinished run
  started: Run[];
  resolutions: Set<Run>;
  claimants: Set<Run>;
  timings: ReadonlyMap<number, Timing>;
  seats: capacity.Seat[];
  terminals: Map<number, number>;
  stages: Map<number, number[]>;
};

// The order the play runs work in: each row's latest start (planner.ts backward), with the rows, their review stages
// expanded, at the planning sizes. With the snapshot's own planning sizes it is the same for both paces' plays.
export type PlayOrder = ReturnType<typeof playOrder>;
export function playOrder(snapshot: Snapshot, sizes: ReadonlyMap<number, Size>) {
  const pass = expand(snapshot, new Map(snapshot.planningSizes ?? sizes), 'slow');
  return { timings: backward(pass.snapshot, pass.sizes, pass.terminals), rows: pass.snapshot.jobs };
}

// order: the snapshot's playOrder, when its caller has it already.
export function playPlan(
  snapshot: Snapshot,
  sizes: ReadonlyMap<number, Size>,
  pace: 'usual' | 'slow',
  order?: PlayOrder,
) {
  return simulate(snapshot, sizes, pace, order);
}

function simulate(snapshot: Snapshot, sizes: ReadonlyMap<number, Size>, pace: 'usual' | 'slow', order?: PlayOrder) {
  for (const row of snapshot.jobs) if (!sizes.has(row.id)) throw new Error(`The play has no size for job #${row.id}`);
  const expanded = expand(snapshot, sizes, pace);
  const { timings } = order ?? playOrder(snapshot, sizes);
  const runs = new Map(
    expanded.snapshot.jobs.map(row => [
      row.id,
      runOf(row, expanded.sizes.get(row.id)!, timings.get(row.id)!, snapshot.now, snapshot.deployLagMs),
    ]),
  );
  let index = 0;
  for (const run of runs.values()) {
    run.index = index++;
    run.priors = run.needs.jobs.map(edge => ({
      run: runs.get(dependencyRun(edge, expanded.terminals)),
      lag: edge.lag ?? 0,
    }));
  }
  const unfinished = [...runs.values()].filter(run => run.state !== 'done');
  const play = {
    snapshot: expanded.snapshot,
    runs,
    timings,
    unfinished: new Set(unfinished),
    started: unfinished.filter(run => run.state === 'running'),
    resolutions: new Set(unfinished.filter(run => run.row.kind === 'resolution')),
    claimants: new Set(
      unfinished.filter(run => run.row.kind !== 'resolution').sort((a, b) => compare(a.order, b.order)),
    ),
    seats: capacity.seatsOf(snapshot),
    terminals: expanded.terminals,
    stages: expanded.stages,
  };
  for (const run of play.started) run.seat = play.seats.find(s => s.id === run.row.seat) ?? null;
  for (let now = snapshot.now; now < snapshot.now + HORIZON_DAYS * DAY_MS;) {
    finish(play, now);
    resolve(play, now);
    for (const seat of play.seats) capacity.reset(seat, now);
    drain(play, now);
    start(play, now);
    const next = nextEvent(play, now);
    if (!Number.isFinite(next)) break;
    advance(play, now, next);
    now = next;
  }
  return new Map(
    snapshot.jobs.filter(row => row.kind === 'work').map(row => [row.id, outlook(play, row, HORIZON_DAYS)]),
  );
}

function runOf(row: QueuedJob, size: Size, order: Timing, now: number, deployLagMs: number): Run {
  const needs = precedence(row, deployLagMs),
    left = remaining(row, size),
    state = row.status === 'running' ? 'running' : row.status === 'done' ? 'done' : 'waiting';
  return {
    row,
    index: 0,
    needs,
    priors: [],
    fixed: [
      needs.readyAt,
      ...(row.board ? [row.created + ROOM_AFTER_MS] : []),
      ...(order.latestStart !== null ? [order.latestStart - PAUSE_MS] : []),
    ]
      .filter(Number.isFinite)
      .sort((a, b) => a - b),
    fixedAt: 0,
    order,
    standing: {
      ...order,
      kind: row.kind,
      downtime: row.downtime,
      engine: row.engine,
      followThrough: row.followThrough,
    },
    state,
    readyAt: row.notBefore,
    start: state === 'running' ? now : null,
    done: state === 'done' ? row.finished : null,
    ends: now + left,
    left,
    remainingMs: left,
    seat: null,
    waits: [...row.reasons, ...row.cards.map(c => ({ on: 'board' as const, request: c.request, at: c.at }))],
    active: [],
    held: null,
    reviewSeat: null,
    queueWait: { on: 'queue', engine: row.engine, minutes: 0 },
    nextHold: null,
  };
}

function advance(play: Play, now: number, next: number) {
  for (const run of play.started) {
    if (run.state !== 'running') continue;
    if (run.seat) capacity.consume(run.seat, next - now);
    const last = run.active.at(-1);
    if (last?.end === now) last.end = next;
    else run.active.push({ start: now, end: next });
  }
}

function finish(play: Play, now: number) {
  for (const run of play.started.filter(r => r.ends <= now)) {
    play.started.splice(play.started.indexOf(run), 1);
    if (run.state === 'pausing') {
      run.state = 'waiting';
      run.seat = null;
      run.reviewSeat = null;
      continue;
    }
    run.state = 'done';
    play.unfinished.delete(run);
    play.claimants.delete(run);
    run.done = run.ends;
    run.seat = null;
  }
}

function resolve(play: Play, now: number) {
  for (const run of play.resolutions)
    if (ready(run, now)) {
      run.state = 'done';
      play.unfinished.delete(run);
      play.resolutions.delete(run);
      run.done = now;
    }
}

function drain(play: Play, now: number) {
  for (const run of [...play.started]) {
    if (run.state !== 'running' || run.seat?.engine !== 'claude' || !capacity.drained(run.seat, now)) continue;
    play.started.splice(play.started.indexOf(run), 1);
    run.left = Math.max(0, run.ends - now);
    run.state = 'waiting';
    run.seat = null;
  }
}

// (planner.ts readyAfter, on the runs its edges wait for)
function ready(run: Run, now: number) {
  if (run.readyAt > now || run.needs.blocked || run.needs.readyAt > now) return false;
  for (const { run: prior, lag } of run.priors)
    if (prior?.state !== 'done' || prior.done === null || prior.done + lag > now) return false;
  return true;
}

function start(play: Play, now: number) {
  const waiting = [...play.claimants].filter(r => r.state === 'waiting' && ready(r, now));
  // Started claims join this list. Runs paused by makeRoom stay in it until they stop.
  const running = [...play.started];
  const seats = capacity.at(play.seats, now);
  const claims = playclaims.queue(
    [...waiting.filter(r => !spareOnly(r.row, r.order)), ...waiting.filter(r => spareOnly(r.row, r.order))],
    play.timings,
  );
  const busy = new Map<string, number>(),
    limits = play.snapshot.seatRuns ?? {};
  for (const r of running) if (r.seat) busy.set(r.seat.id, (busy.get(r.seat.id) ?? 0) + 1);
  // (the seats' choices hold until a claim starts and fills one)
  let choose = capacity.choices(seats, busy, limits);
  while (claims.pending.size) {
    if (holdFullRoom(play, claims.pending, running, seats, busy)) break;
    const run = playclaims.take(claims, seats, limits, choose, seat => reviewOccupants(running, seat));
    if (!(run.row.engine in play.snapshot.slots)) {
      hold(run, now, unreported(run));
      continue;
    }
    const engineFull =
      running.filter(r => r.row.engine === run.row.engine).length >= (play.snapshot.slots[run.row.engine] ?? 0);
    const memoryFull = running.length >= (play.snapshot.room ?? Infinity);
    const others = waiting.some(
      r => r !== run && r.state === 'waiting' && !spareOnly(r.row, r.order) && r.row.engine === run.row.engine,
    );
    const { seat, roomSeat } = choose(run.row, run.order, others);
    if ((engineFull || memoryFull || (!('id' in seat) && seat.on === 'queue')) && 'id' in roomSeat) {
      const pressure = memoryFull ? 'memory' : engineFull ? 'engine' : roomSeat;
      const resource = reviewroom.reviewCapped(run.row, seat) ? roomSeat : pressure;
      const pausing = makeRoom(play, run, running, now, resource, roomSeat);
      hold(run, now, { on: 'queue', engine: run.row.engine, minutes: 0, ...(pausing ? { pausing: true } : {}) });
      continue;
    }
    if (!('id' in seat)) {
      hold(run, now, seat);
      continue;
    }
    releaseHold(run, now);
    Object.assign(run, { state: 'running', start: run.start ?? now, ends: now + run.left, seat });
    running.push(run);
    play.started.splice(play.started.findLastIndex(r => r.index < run.index) + 1, 0, run);
    busy.set(seat.id, (busy.get(seat.id) ?? 0) + 1);
    choose = capacity.choices(seats, busy, limits);
  }
}

function nextEvent(play: Play, now: number) {
  let next = Infinity;
  const event = (at: number) => {
    if (at > now && at < next) next = at;
  };
  const busy = new Map<capacity.Seat, number>();
  for (const run of play.started) {
    if (run.state === 'running') {
      if (run.ends === now) return now;
      if (run.seat) busy.set(run.seat, (busy.get(run.seat) ?? 0) + 1);
    }
    event(run.ends);
  }
  for (const run of play.unfinished) {
    if (run.state !== 'waiting') continue;
    event(run.readyAt);
    while (run.fixedAt < run.fixed.length && run.fixed[run.fixedAt] <= now) run.fixedAt++;
    if (run.fixedAt < run.fixed.length) event(run.fixed[run.fixedAt]);
    for (const { run: prior, lag } of run.priors) if (prior && prior.done !== null) event(prior.done + lag);
  }
  for (const seat of play.seats) event(capacity.seatEvent(seat, play.seats, now, busy.get(seat) ?? 0));
  return next;
}
