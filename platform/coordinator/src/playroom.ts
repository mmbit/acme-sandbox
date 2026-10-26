// The play's room (simulation.ts): a full room holds the moment's claims together, a claim may pause running work to
// make room for itself, and what holds a waiting run until it starts (moved out
// of simulation.ts).
import * as memory from './playmemory.ts';
import type { Wait } from './eta.ts';
import { deadlinePressure, DEADLINE_PAUSE_MS, PAUSE_MS } from './planner.ts';
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
  room: memory.Room,
) {
  if (!memory.full(room)) return false;
  const limits = play.snapshot.seatRuns ?? {};
  const choose = capacity.choices(seats, busy, limits);
  for (const run of waiting) {
    if (!(run.row.engine in play.snapshot.slots)) {
      run.nextHold = unreported(run);
      continue;
    }
    const { seat, roomSeat } = choose(run.row, run.order);
    if ('id' in roomSeat) {
      const resource = reviewroom.reviewCapped(run.row, seat) ? roomSeat : 'memory';
      if (roomVictims(play, run, running, seats.now, resource, roomSeat, room).victims.length) return false;
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
  room: memory.Room,
) {
  const { victims, needsReview } = roomVictims(play, waiting, running, now, resource, seat, room);
  if (!victims.length) return false;
  const pauseMs = deadlinePressure(waiting.order, now) ? DEADLINE_PAUSE_MS : PAUSE_MS;
  for (const victim of victims) {
    const run = play.runs.get(victim.id)!;
    run.left = Math.max(0, run.ends - now) + pauseMs;
    run.readyAt = now + pauseMs;
    run.state = 'pausing';
    run.roomFor = { waiter: waiting, seat };
    run.reviewSeat = needsReview && typeof resource !== 'string' ? seat.id : null;
    run.ends = now + pauseMs;
  }
  waiting.readyAt = now + pauseMs;
  return true;
}

function roomVictims(
  play: Play,
  waiting: Run,
  running: Run[],
  now: number,
  resource: 'memory' | 'engine' | capacity.Seat,
  seat: capacity.Seat,
  room: memory.Room,
) {
  const limit = play.snapshot.seatRuns?.[seat.engine] ?? Infinity;
  const needsReview = reviewroom.needsRoom(waiting.standing, reviewOccupants(running, seat.id), limit);
  const candidates = running.filter(r => r.state === 'running');
  const seatFull = running.filter(r => r.seat?.id === seat.id).length >= limit;
  const engineFull =
    running.filter(r => r.row.engine === waiting.row.engine).length >= (play.snapshot.slots[waiting.row.engine] ?? 0);
  const victims = reviewroom.pauseGroup(
    candidates,
    (remaining, selected) => {
      const onSeat = seatFull || typeof resource !== 'string';
      const onEngine = engineFull || resource === 'engine';
      const eligible = selected.length
        ? remaining
        : remaining.filter(r => (onSeat ? r.seat?.id === seat.id : !onEngine || r.row.engine === waiting.row.engine));
      const victim = reviewroom.roomVictim(
        waiting.standing,
        eligible.map(r => r.standing),
        now,
        { limit, capped: typeof resource !== 'string', needsReview },
      );
      return victim && play.runs.get(victim.id);
    },
    selected => fitsAfterPauses(play, waiting, running, seat, room, selected),
  );
  return { victims: victims.map(r => r.standing), needsReview };
}

function fitsAfterPauses(
  play: Play,
  waiting: Run,
  running: Run[],
  seat: capacity.Seat,
  room: memory.Room,
  selected: Run[],
) {
  const pausing = running.filter(r => r.state === 'pausing');
  const reservations = new Map(pausing.map(r => [r.roomFor!.waiter, r.roomFor!.seat]));
  reservations.delete(waiting);
  const released = [...pausing, ...selected];
  const remaining = running.filter(r => !released.includes(r));
  const available = memory.afterPauses(
    room,
    released.map(r => r.row),
  );
  let onEngine = remaining.filter(r => r.row.engine === waiting.row.engine).length;
  let onSeat = remaining.filter(r => r.seat?.id === seat.id).length;
  for (const [waiter, reservedSeat] of reservations) {
    memory.join(available, waiter.row);
    if (waiter.row.engine === waiting.row.engine) onEngine++;
    if (reservedSeat.id === seat.id) onSeat++;
  }
  const engineSlots = play.snapshot.slots[waiting.row.engine] ?? 0;
  const seatRuns = play.snapshot.seatRuns?.[seat.engine] ?? Infinity;
  return memory.canStart(available, waiting.row) && onEngine < engineSlots && onSeat < seatRuns;
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
