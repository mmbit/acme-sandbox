// The play's room (simulation.ts): a full room holds the moment's claims together, a claim may pause running work to
// make room for itself, and what holds a waiting run until it starts (moved out
// of simulation.ts).
import * as memory from './playmemory.ts';
import type { Wait } from './eta.ts';
import { compare, deadlinePressure, DEADLINE_PAUSE_MS, PAUSE_MS, spareOnly } from './planner.ts';
import * as capacity from './playseats.ts';
import * as reviewroom from './reviewroom.ts';
import type { Play, Run } from './simulation.ts';

// A full room cannot start another run during this moment. If no claim can pause work either, their order has no
// effect. Hold them together, using empty seats only to distinguish queue waits from unavailable seats.
export function holdFullRoom(
  play: Play,
  waiting: Set<Run>,
  running: Run[],
  seats: capacity.Moment,
  busy: Map<string, number>,
) {
  if (
    !memory.full(
      play.snapshot,
      running.map(run => run.row),
      seats.now,
    )
  )
    return false;
  const limits = play.snapshot.seatRuns ?? {};
  const choose = capacity.choices(seats, busy, limits);
  // (by its resource, then its deadline pressure: a seat's shared reviews are the seat's own, so it needs no key of its
  // own)
  const unpausable = new Map<'memory' | capacity.Seat, (Run | undefined)[]>();
  for (const run of waiting) {
    if (!(run.row.engine in play.snapshot.slots)) {
      run.nextHold = unreported(run);
      continue;
    }
    const { seat, roomSeat } = choose(run.row, run.order);
    if ('id' in roomSeat) {
      const resource = reviewroom.reviewCapped(run.row, seat) ? roomSeat : 'memory';
      const pressure = Number(deadlinePressure(run.order, seats.now));
      let bound = unpausable.get(resource);
      if (!bound) unpausable.set(resource, (bound = []));
      const earlier = bound[pressure];
      // A lower-order non-board claim cannot pause work that an earlier one could not. Shared reviews have the
      // same victim rule on a seat. Spare claims and the board's initial pause delay do not establish that bound.
      if (!earlier || compare(earlier.order, run.order) > 0) {
        if (roomVictim(play, run, running, seats.now, resource, roomSeat).victim) return false;
        if (!run.order.board && !spareOnly(run.row, run.order)) bound[pressure] = run;
      }
      run.nextHold = run.queueWait;
    } else run.nextHold = roomSeat;
  }
  for (const run of waiting) hold(run, seats.now, run.nextHold!);
  return true;
}

export const unreported = (run: Run): Wait => ({
  on: 'stalled',
  why: `The worker has not reported ${run.row.engine} capacity`,
});

export const reviewOccupants = (running: Run[], seat: string) =>
  running
    .filter(run => run.seat?.id === seat || run.reviewSeat === seat)
    .map(run => ({ kind: run.reviewSeat === seat ? 'review' : run.row.kind }));

export function makeRoom(
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
  const pauseMs = deadlinePressure(waiting.order, now) ? DEADLINE_PAUSE_MS : PAUSE_MS;
  run.left = Math.max(0, run.ends - now) + pauseMs;
  run.readyAt = now + pauseMs;
  run.state = 'pausing';
  run.reviewSeat = needsReview && typeof resource !== 'string' ? seat.id : null;
  run.ends = now + pauseMs;
  waiting.readyAt = now + pauseMs;
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

export function hold(run: Run, now: number, by: Wait) {
  if (run.held) run.held.by = by;
  else run.held = { since: now, by };
}
export function releaseHold(run: Run, now: number) {
  if (!run.held) return;
  const { since, by } = run.held;
  run.waits.push(by.on === 'queue' ? { ...by, minutes: Math.round((now - since) / 60_000) } : by);
  run.held = null;
}
