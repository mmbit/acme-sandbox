// A seat with multiple run places shares them between ready reviews and ordinary work.
import type { Wait } from './eta.ts';
import type { Seat } from './playseats.ts';
import {
  deadlinePressure,
  pausable,
  pauseVictim,
  spareOnly,
  victimOrder,
  type Order,
  type Pausable,
} from './planner.ts';

type Candidate = { kind: string; board: boolean | number };
export const reviewing = (row: { kind: string }) => row.kind === 'review' || row.kind === 'consolidate';
export const shared = (limit: number) => Number.isFinite(limit) && limit > 1;

// Windows keep the shared order. Undated runs share one review place and the other places for work.
export function claimOrder<T extends Candidate>(
  running: { kind: string }[],
  limit: number,
  base: (a: T, b: T) => number,
  windowed: (row: T) => boolean = () => false,
) {
  if (!shared(limit)) return base;
  const hasReview = running.some(reviewing);
  const preferred = (row: T) => (hasReview ? row.kind === 'work' : reviewing(row));
  return (a: T, b: T) =>
    Number(!!b.board) - Number(!!a.board) ||
    Number(windowed(b)) - Number(windowed(a)) ||
    (windowed(a) ? base(a, b) : Number(preferred(b)) - Number(preferred(a)) || base(a, b));
}

export function needsRoom(
  waiting: Order & { kind: string; downtime: number },
  running: { kind: string }[],
  limit: number,
) {
  return shared(limit) && reviewing(waiting) && !spareOnly(waiting, waiting) && !running.some(reviewing);
}

export const reviewCapped = (waiting: { kind: string }, seat: Seat | Wait) =>
  !('id' in seat) && seat.on === 'queue' && reviewing(waiting);

export function roomVictim(
  waiting: Order & { kind: string; downtime: number },
  running: (Order & Pausable & { downtime: number; engine: string })[],
  now: number,
  room: { limit: number; capped: boolean; needsReview: boolean },
  engine?: string,
) {
  if (deadlinePressure(waiting, now)) return pauseVictim(waiting, running, now, engine);
  if (room.capped && shared(room.limit) && reviewing(waiting))
    return room.needsReview ? victim(running, now) : undefined;
  return pauseVictim(waiting, running, now, engine);
}

function victim<T extends Order & Pausable>(running: T[], now: number) {
  return running.filter(run => pausable(run) && !deadlinePressure(run, now)).sort(victimOrder)[0];
}
