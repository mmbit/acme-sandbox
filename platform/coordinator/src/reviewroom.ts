// A seat with multiple run places shares them between ready reviews and ordinary work.
import type { Wait } from './eta.ts';
import type { Seat } from './playseats.ts';
import { pausable, pauseVictim, spareOnly, victimOrder, type Order, type Pausable } from './planner.ts';

type Candidate = { kind: string; board: boolean | number };
export const reviewing = (row: { kind: string }) => row.kind === 'review' || row.kind === 'consolidate';
export const shared = (limit: number) => Number.isFinite(limit) && limit > 1;

// One review place, the other places for work. Either borrows places when the other has nothing ready.
export function claimOrder<T extends Candidate>(
  running: { kind: string }[],
  limit: number,
  base: (a: T, b: T) => number,
) {
  if (!shared(limit)) return base;
  const hasReview = running.some(reviewing);
  const preferred = (row: T) => (hasReview ? row.kind === 'work' : reviewing(row));
  return (a: T, b: T) =>
    Number(!!b.board) - Number(!!a.board) || Number(preferred(b)) - Number(preferred(a)) || base(a, b);
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
  if (room.capped && shared(room.limit) && reviewing(waiting)) return room.needsReview ? victim(running) : undefined;
  return pauseVictim(waiting, running, now, engine);
}

function victim<T extends Order & Pausable>(running: T[]) {
  return running.filter(pausable).sort(victimOrder)[0];
}
