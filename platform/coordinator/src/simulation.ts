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
import { expandRows, sized, type Expansion } from './rounds.ts';
import * as capacity from './playseats.ts';
import * as playclaims from './playclaims.ts';
import * as reviewroom from './reviewroom.ts';
import {
  activeReservations,
  hold,
  holdFullRoom,
  makeRoom,
  releaseHold,
  reviewOccupants,
  unreported,
} from './playroom.ts';
import type { Span } from './playtime.ts';
import { outlook } from './playoutlook.ts';
import * as events from './playevents.ts';
import * as memory from './playmemory.ts';
import * as ledger from './playledger.ts';

export const DAY_MS = 86_400_000;
// How far ahead the play goes (hq when searches no further).
export const HORIZON_DAYS = 8;
export type Run = {
  row: QueuedJob;
  stage: string | null;
  // (its place among the play's runs: the order the play goes through them in)
  index: number;
  needs: ReturnType<typeof precedence>;
  // the run each of its needs' edges waits for (none outside the play), with the edge's lag; how many of them, in order,
  // are done and past their lag (they stay so: ready); and the ones whose done and lag can still give a moment to come
  // (a lag, or done after the play's start: playevents.ts nextEvent)
  priors: { run: Run | undefined; lag: number }[];
  priorsMet: number;
  timedPriors: { run: Run; lag: number }[];
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
  // The waiters a pause made room for, each with its reserved seat, until it starts. Only waiters a seat still takes
  // hold later claims on every engine (playroom.ts activeReservations, the claim's freedFor).
  roomFor: Map<Run, capacity.Seat>;
  resolutions: Set<Run>;
  // the runs that may claim a seat, in their order: none whose needs are blocked, which never starts (ready)
  claimants: Set<Run>;
  timings: ReadonlyMap<number, Timing>;
  seats: capacity.Seat[];
  terminals: Map<number, number>;
  stages: Map<number, number[]>;
  account?: ledger.Account;
  conditions: string[];
};

// The order the play runs work in: each row's latest start (planner.ts backward), with the rows, their review stages
// expanded, at the planning sizes. With the snapshot's own planning sizes it is the same for both paces' plays.
export type PlayOrder = ReturnType<typeof playOrder>;
export function playOrder(snapshot: Snapshot, sizes: ReadonlyMap<number, Size>) {
  const expansion = expandRows(snapshot),
    planning = sized(expansion, new Map(snapshot.planningSizes ?? sizes), 'slow');
  return {
    timings: backward(expansion.snapshot, planning, expansion.terminals),
    rows: expansion.snapshot.jobs,
    expansion,
  };
}

export function playPlan(
  snapshot: Snapshot,
  sizes: ReadonlyMap<number, Size>,
  pace: 'usual' | 'slow',
  order?: PlayOrder,
) {
  return simulate(snapshot, sizes, pace, undefined, order).outlooks;
}

export function startPlan(snapshot: Snapshot, sizes: ReadonlyMap<number, Size>) {
  return simulate(snapshot, sizes, 'usual').starts;
}

export function inspectPlan(snapshot: Snapshot, sizes: ReadonlyMap<number, Size>, pace: 'usual' | 'slow') {
  return simulate(snapshot, sizes, pace, ledger.create(snapshot));
}

function simulate(
  snapshot: Snapshot,
  sizes: ReadonlyMap<number, Size>,
  pace: 'usual' | 'slow',
  account?: ledger.Account,
  order?: PlayOrder,
) {
  const play = preparedPlay(snapshot, sizes, pace, account, order);
  for (let now = snapshot.now; now < snapshot.now + HORIZON_DAYS * DAY_MS;) {
    events.finish(play, now);
    resolve(play, now);
    for (const seat of play.seats) {
      if (account) ledger.reset(account, seat, now);
      capacity.reset(seat, now);
      if (account) ledger.release(account, seat, now);
    }
    events.drain(play, now);
    start(play, now);
    const next = events.nextEvent(play, now);
    if (!Number.isFinite(next)) break;
    events.advance(play, now, next);
    now = next;
  }
  const outlooks = new Map(
    snapshot.jobs.filter(row => row.kind === 'work').map(row => [row.id, outlook(play, row, HORIZON_DAYS)]),
  );
  return {
    outlooks,
    starts: new Map([...play.runs].map(([id, run]) => [id, run.start])),
    seats: account?.seats ?? [],
    resources: ledger.resources(snapshot),
    review_queue: account ? ledger.reviewQueue(play) : [],
  };
}

function preparedPlay(
  snapshot: Snapshot,
  sizes: ReadonlyMap<number, Size>,
  pace: 'usual' | 'slow',
  account?: ledger.Account,
  order?: PlayOrder,
) {
  for (const row of snapshot.jobs) if (!sizes.has(row.id)) throw new Error(`The play has no size for job #${row.id}`);
  // (its rows as its order expanded them: the same for both paces)
  const { timings, expansion } = order ?? playOrder(snapshot, sizes);
  const expanded = { ...expansion, sizes: sized(expansion, sizes, pace) };
  const runs = runsOf(snapshot, expanded, timings);
  const unfinished = [...runs.values()].filter(run => run.state !== 'done');
  const play: Play = {
    snapshot: expanded.snapshot,
    runs,
    timings,
    unfinished: new Set(unfinished),
    started: unfinished.filter(run => run.state === 'running'),
    roomFor: new Map(),
    resolutions: new Set(unfinished.filter(run => run.row.kind === 'resolution')),
    claimants: new Set(
      unfinished
        .filter(run => run.row.kind !== 'resolution' && !run.needs.blocked)
        .sort((a, b) => compare(a.order, b.order)),
    ),
    seats: capacity.seatsOf(snapshot),
    terminals: expanded.terminals,
    stages: expanded.stages,
    account,
    conditions: ledger.conditions(snapshot),
  };
  for (const run of runs.values())
    if (run.state === 'running') run.seat = play.seats.find(s => s.id === run.row.seat) ?? null;
  return play;
}

function runsOf(
  snapshot: Snapshot,
  expanded: Expansion<Snapshot> & { sizes: Map<number, Size> },
  timings: ReadonlyMap<number, Timing>,
) {
  const runs = new Map(
    expanded.snapshot.jobs.map(row => [
      row.id,
      runOf(
        row,
        expanded.sizes.get(row.id)!,
        timings.get(row.id)!,
        snapshot.now,
        snapshot.deployLagMs,
        expanded.sources.get(row.id)?.stage,
      ),
    ]),
  );
  let index = 0;
  for (const run of runs.values()) {
    run.index = index++;
    run.priors = run.needs.jobs.map(edge => ({
      run: runs.get(dependencyRun(edge, expanded.terminals)),
      lag: edge.lag ?? 0,
    }));
    // (a prior is done at or before the moment it's read, so without a lag only one done after the start gives one)
    run.timedPriors = run.priors.filter(
      (p): p is { run: Run; lag: number } => !!p.run && (p.lag > 0 || (p.run.done ?? -Infinity) > snapshot.now),
    );
  }
  return runs;
}

function runOf(row: QueuedJob, size: Size, order: Timing, now: number, deployLagMs: number, stage?: string): Run {
  const needs = precedence(row, deployLagMs),
    left = remaining(row, size),
    state = row.status === 'running' ? 'running' : row.status === 'done' ? 'done' : 'waiting';
  return {
    row,
    stage: stage ?? row.step ?? null,
    index: 0,
    needs,
    priors: [],
    priorsMet: 0,
    timedPriors: [],
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

function resolve(play: Play, now: number) {
  for (const run of play.resolutions)
    if (ready(run, now)) {
      run.state = 'done';
      play.unfinished.delete(run);
      play.resolutions.delete(run);
      run.done = now;
    }
}

// (planner.ts readyAfter, on the runs its edges wait for). A play's moments only go forward, so a prior met stays met
function ready(run: Run, now: number) {
  if (run.readyAt > now || run.needs.blocked || run.needs.readyAt > now) return false;
  for (; run.priorsMet < run.priors.length; run.priorsMet++) {
    const { run: prior, lag } = run.priors[run.priorsMet];
    if (prior?.state !== 'done' || prior.done === null || prior.done + lag > now) return false;
  }
  return true;
}

function start(play: Play, now: number) {
  const waiting: Run[] = [];
  for (const r of play.claimants) if (r.state === 'waiting' && ready(r, now)) waiting.push(r);
  // Started claims join this list. Runs paused by makeRoom stay in it until they stop.
  const running = [...play.started];
  const seats = capacity.at(play.seats, now);
  const reservations = activeReservations(play, seats);
  if (play.account) ledger.pacing(play.account, seats);
  const claims = playclaims.queue(
    [...waiting.filter(r => !spareOnly(r.row, r.order)), ...waiting.filter(r => spareOnly(r.row, r.order))],
    play.timings,
  );
  const busy = new Map<string, number>(),
    limits = play.snapshot.seatRuns ?? {};
  for (const r of running) if (r.seat) busy.set(r.seat.id, (busy.get(r.seat.id) ?? 0) + 1);
  const use = inUse(play, running, waiting, now);
  // (the seats' choices hold until a claim starts and fills one)
  let choose = capacity.choices(seats, busy, limits);
  while (claims.pending.size) {
    if (holdFullRoom(play, claims.pending, running, seats, busy, use.room, reservations)) break;
    const run = playclaims.take(claims, seats, limits, choose, seat => reviewOccupants(running, seat));
    if (!(run.row.engine in play.snapshot.slots)) {
      hold(run, now, unreported(run));
      continue;
    }
    if (holdReserved(run, reservations, claims, now)) continue;
    const engineFull = (use.onEngine.get(run.row.engine) ?? 0) >= (play.snapshot.slots[run.row.engine] ?? 0);
    const memoryFull = !memory.canStart(use.room, run.row);
    // (another ordinary claim on its engine still waits: the run itself is one while it's ordinary)
    const others = (use.waitingOn.get(run.row.engine) ?? 0) > Number(!spareOnly(run.row, run.order));
    const { seat, roomSeat } = choose(run.row, run.order, others);
    if ((engineFull || memoryFull || (!('id' in seat) && seat.on === 'queue')) && 'id' in roomSeat) {
      const pressure = memoryFull ? 'memory' : engineFull ? 'engine' : roomSeat;
      const resource = reviewroom.reviewCapped(run.row, seat) ? roomSeat : pressure;
      const pausing = makeRoom(play, run, running, now, resource, roomSeat, use.room, reservations);
      hold(run, now, { on: 'queue', engine: run.row.engine, minutes: 0, ...(pausing ? { pausing: true } : {}) });
      continue;
    }
    if (!('id' in seat)) {
      hold(run, now, seat);
      continue;
    }
    begin(play, run, seat, now, running, busy);
    reservations.delete(run);
    took(use, run);
    choose = capacity.choices(seats, busy, limits);
  }
}

function holdReserved(
  run: Run,
  reservations: Map<Run, capacity.Seat>,
  claims: ReturnType<typeof playclaims.queue<Run>>,
  now: number,
) {
  const behindReserved = [...reservations.keys()].some(waiter => claims.base(waiter.row, run.row) < 0);
  if (!behindReserved) return false;
  hold(run, now, run.queueWait);
  return true;
}

// The moment's room in use, and per engine its running runs and its ordinary claims still waiting: counted once, then
// kept as claims start (took), not counted again for every claim.
function inUse(play: Play, running: Run[], waiting: Run[], now: number) {
  const use = {
    room: memory.room(
      play.snapshot,
      running.map(r => r.row),
      now,
    ),
    onEngine: new Map<string, number>(),
    waitingOn: new Map<string, number>(),
  };
  for (const r of running) add(use.onEngine, r.row.engine, 1);
  for (const r of waiting) if (!spareOnly(r.row, r.order)) add(use.waitingOn, r.row.engine, 1);
  return use;
}

function took(use: ReturnType<typeof inUse>, run: Run) {
  memory.join(use.room, run.row);
  add(use.onEngine, run.row.engine, 1);
  if (!spareOnly(run.row, run.order)) add(use.waitingOn, run.row.engine, -1);
}

const add = (counts: Map<string, number>, key: string, by: number) => counts.set(key, (counts.get(key) ?? 0) + by);

function begin(play: Play, run: Run, seat: capacity.Seat, now: number, running: Run[], busy: Map<string, number>) {
  if (play.account) ledger.resume(play.account, run, seat, now);
  releaseHold(run, now);
  play.roomFor.delete(run);
  Object.assign(run, { state: 'running', start: run.start ?? now, ends: now + run.left, seat });
  running.push(run);
  play.started.splice(play.started.findLastIndex(r => r.index < run.index) + 1, 0, run);
  busy.set(seat.id, (busy.get(seat.id) ?? 0) + 1);
}
