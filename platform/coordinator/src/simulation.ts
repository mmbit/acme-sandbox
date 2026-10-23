// The forward plan: measured runs share slots, memory and seat windows in latest-start order.
import type { QueuedJob, Size, Snapshot, Wait } from './eta.ts';
import {
  backward,
  compare,
  dependencyRun,
  PAUSE_MS,
  ROOM_AFTER_MS,
  precedence,
  readyAfter,
  remaining,
  spareOnly,
  type Dependency,
  type Timing,
} from './planner.ts';
import { expand } from './rounds.ts';
import * as capacity from './playseats.ts';
import * as playclaims from './playclaims.ts';
import * as reviewroom from './reviewroom.ts';
import type { Span } from './playtime.ts';
import { outlook } from './playoutlook.ts';

const DAY_MS = 86_400_000;
// How far ahead the play goes (hq when searches no further).
export const HORIZON_DAYS = 8;
export type Run = {
  row: QueuedJob;
  needs: ReturnType<typeof precedence>;
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
  claimants: Set<Run>;
  timings: ReadonlyMap<number, Timing>;
  completed: (edge: Dependency) => number | null;
  seats: capacity.Seat[];
  terminals: Map<number, number>;
  stages: Map<number, number[]>;
};

// The order the play runs work in: each row's latest start (planner.ts backward), with the rows, their review stages
// expanded, at the planning sizes.
export function playOrder(snapshot: Snapshot, sizes: ReadonlyMap<number, Size>) {
  const pass = expand(snapshot, new Map(snapshot.planningSizes ?? sizes), 'slow');
  return { timings: backward(pass.snapshot, pass.sizes, pass.terminals), rows: pass.snapshot.jobs };
}

export function playPlan(snapshot: Snapshot, sizes: ReadonlyMap<number, Size>, pace: 'usual' | 'slow') {
  return simulate(snapshot, sizes, pace);
}

function simulate(snapshot: Snapshot, sizes: ReadonlyMap<number, Size>, pace: 'usual' | 'slow') {
  for (const row of snapshot.jobs) if (!sizes.has(row.id)) throw new Error(`The play has no size for job #${row.id}`);
  const expanded = expand(snapshot, sizes, pace);
  const { timings } = playOrder(snapshot, sizes);
  const runs = new Map(
    expanded.snapshot.jobs.map(row => [
      row.id,
      runOf(row, expanded.sizes.get(row.id)!, timings.get(row.id)!, snapshot.now, snapshot.deployLagMs),
    ]),
  );
  const play = {
    snapshot: expanded.snapshot,
    runs,
    timings,
    completed: (edge: Dependency) => {
      const prior = runs.get(dependencyRun(edge, expanded.terminals));
      return prior?.state === 'done' ? prior.done : null;
    },
    unfinished: new Set([...runs.values()].filter(run => run.state !== 'done')),
    claimants: new Set(
      [...runs.values()]
        .filter(run => run.state !== 'done' && run.row.kind !== 'resolution')
        .sort((a, b) => compare(a.order, b.order)),
    ),
    seats: capacity.seatsOf(snapshot),
    terminals: expanded.terminals,
    stages: expanded.stages,
  };
  for (const run of runs.values())
    if (run.state === 'running') run.seat = play.seats.find(s => s.id === run.row.seat) ?? null;
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
  const left = remaining(row, size),
    state = row.status === 'running' ? 'running' : row.status === 'done' ? 'done' : 'waiting';
  return {
    row,
    needs: precedence(row, deployLagMs),
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
  for (const run of play.unfinished) {
    if (run.state !== 'running') continue;
    if (run.seat) capacity.consume(run.seat, next - now);
    const last = run.active.at(-1);
    if (last?.end === now) last.end = next;
    else run.active.push({ start: now, end: next });
  }
}

function finish(play: Play, now: number) {
  for (const run of play.unfinished)
    if ((run.state === 'running' || run.state === 'pausing') && run.ends <= now) {
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
  for (const run of play.unfinished)
    if (run.row.kind === 'resolution' && run.state === 'waiting' && ready(play, run, now)) {
      run.state = 'done';
      play.unfinished.delete(run);
      run.done = now;
    }
}

function drain(play: Play, now: number) {
  for (const run of play.unfinished) {
    if (run.state !== 'running' || run.seat?.engine !== 'claude' || !capacity.drained(run.seat, now)) continue;
    run.left = Math.max(0, run.ends - now);
    run.state = 'waiting';
    run.seat = null;
  }
}

function ready(play: Play, run: Run, now: number) {
  return run.readyAt <= now && readyAfter(run.needs, now, play.completed);
}

function start(play: Play, now: number) {
  const waiting = [...play.claimants].filter(r => r.state === 'waiting' && ready(play, r, now));
  // Started claims join this list. Runs paused by makeRoom stay in it until they stop.
  const running = [...play.unfinished].filter(r => r.state === 'running' || r.state === 'pausing');
  const seats = capacity.at(play.seats, now);
  const claims = playclaims.queue(
    [...waiting.filter(r => !spareOnly(r.row, r.order)), ...waiting.filter(r => spareOnly(r.row, r.order))],
    play.timings,
  );
  const busy = new Map<string, number>();
  for (const r of running) if (r.seat) busy.set(r.seat.id, (busy.get(r.seat.id) ?? 0) + 1);
  while (claims.pending.size) {
    if (holdFullRoom(play, claims.pending, running, seats, busy)) break;
    const run = playclaims.take(claims, seats, play.snapshot.seatRuns ?? {}, busy, seat =>
      reviewOccupants(running, seat),
    );
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
    const seat = capacity.choose(run.row, run.order, seats, busy, play.snapshot.seatRuns ?? {}, others);
    const roomSeat =
      'id' in seat ? seat : capacity.choose(run.row, run.order, seats, new Map(), play.snapshot.seatRuns ?? {}, others);
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
    busy.set(seat.id, (busy.get(seat.id) ?? 0) + 1);
  }
}

// A full room cannot start another run during this moment. If no claim can pause work either, their order has no
// effect. Hold them together, using empty seats only to distinguish queue waits from unavailable seats.
function holdFullRoom(
  play: Play,
  waiting: Set<Run>,
  running: Run[],
  seats: capacity.Moment,
  busy: Map<string, number>,
) {
  if (running.length < (play.snapshot.room ?? Infinity)) return false;
  const limits = play.snapshot.seatRuns ?? {};
  const choose = capacity.choices(seats, busy, limits);
  const unpausable = new Map<string, Run>();
  for (const run of waiting) {
    if (!(run.row.engine in play.snapshot.slots)) {
      run.nextHold = unreported(run);
      continue;
    }
    const { seat, roomSeat } = choose(run.row, run.order);
    if ('id' in roomSeat) {
      const resource = reviewroom.reviewCapped(run.row, seat) ? roomSeat : 'memory';
      const sharedReview = typeof resource !== 'string' && reviewroom.shared(limits[roomSeat.engine] ?? Infinity);
      const key = typeof resource === 'string' ? resource : `${resource.id}:${sharedReview}`;
      const earlier = unpausable.get(key);
      // A lower-order non-board claim cannot pause work that an earlier one could not. Shared reviews have the
      // same victim rule on a seat. Spare claims and the board's initial pause delay do not establish that bound.
      if (!earlier || compare(earlier.order, run.order) > 0) {
        if (roomVictim(play, run, running, seats.now, resource, roomSeat).victim) return false;
        if (!run.order.board && !spareOnly(run.row, run.order)) unpausable.set(key, run);
      }
      run.nextHold = run.queueWait;
    } else run.nextHold = roomSeat;
  }
  for (const run of waiting) hold(run, seats.now, run.nextHold!);
  return true;
}

const unreported = (run: Run): Wait => ({
  on: 'stalled',
  why: `The worker has not reported ${run.row.engine} capacity`,
});

const reviewOccupants = (running: Run[], seat: string) =>
  running
    .filter(run => run.seat?.id === seat || run.reviewSeat === seat)
    .map(run => ({ kind: run.reviewSeat === seat ? 'review' : run.row.kind }));

function makeRoom(
  play: Play,
  waiting: Run,
  running: Run[],
  now: number,
  resource: 'memory' | 'engine' | capacity.Seat,
  seat: capacity.Seat,
) {
  const { victim, needsReview } = roomVictim(play, waiting, running, now, resource, seat);
  if (!victim) return false;
  const run = play.runs.get(victim.id)!;
  // Room stays occupied until the worker can stop at a step boundary.
  run.left = Math.max(0, run.ends - now) + PAUSE_MS;
  run.readyAt = now + PAUSE_MS;
  run.state = 'pausing';
  run.reviewSeat = needsReview && typeof resource !== 'string' ? seat.id : null;
  run.ends = now + PAUSE_MS;
  waiting.readyAt = now + PAUSE_MS;
  return true;
}

function roomVictim(
  play: Play,
  waiting: Run,
  running: Run[],
  now: number,
  resource: 'memory' | 'engine' | capacity.Seat,
  seat: capacity.Seat,
) {
  const candidates = running
    .filter(r => r.state === 'running' && (typeof resource === 'string' || r.seat?.id === resource.id))
    .filter(r => resource === 'memory' || r.row.engine === waiting.row.engine)
    .map(r => r.standing);
  const limit = play.snapshot.seatRuns?.[seat.engine] ?? Infinity;
  const needsReview = reviewroom.needsRoom(waiting.standing, reviewOccupants(running, seat.id), limit);
  const victim = reviewroom.roomVictim(
    waiting.standing,
    candidates,
    now,
    { limit, capped: typeof resource !== 'string', needsReview },
    resource === 'memory' ? undefined : waiting.row.engine,
  );
  return { victim, needsReview };
}

function hold(run: Run, now: number, by: Wait) {
  if (run.held) run.held.by = by;
  else run.held = { since: now, by };
}
function releaseHold(run: Run, now: number) {
  if (!run.held) return;
  const { since, by } = run.held;
  run.waits.push(by.on === 'queue' ? { ...by, minutes: Math.round((now - since) / 60_000) } : by);
  run.held = null;
}

function nextEvent(play: Play, now: number) {
  let next = Infinity;
  const event = (at: number) => {
    if (at > now && at < next) next = at;
  };
  const busy = new Map<capacity.Seat, number>();
  for (const run of play.unfinished) {
    if (run.state === 'running') {
      if (run.ends === now) return now;
      if (run.seat) busy.set(run.seat, (busy.get(run.seat) ?? 0) + 1);
    }
    if (run.state === 'running' || run.state === 'pausing') event(run.ends);
    if (run.state !== 'waiting') continue;
    const { needs } = run;
    event(needs.readyAt);
    event(run.readyAt);
    if (run.row.board) event(run.row.created + ROOM_AFTER_MS);
    if (run.order.latestStart !== null) event(run.order.latestStart - PAUSE_MS);
    for (const edge of needs.jobs) {
      const prior = play.runs.get(dependencyRun(edge, play.terminals));
      if (prior?.done !== null && prior?.done !== undefined) event(prior.done + (edge.lag ?? 0));
    }
  }
  for (const seat of play.seats) event(capacity.seatEvent(seat, play.seats, now, busy.get(seat) ?? 0));
  return next;
}
