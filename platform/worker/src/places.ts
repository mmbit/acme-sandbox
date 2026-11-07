// A seat's run places include claims in flight and slots holding a meeting's reservation.
import { seatRunLimit, type Windows } from './pace.ts';

type Placed = { id: string; engine: string } & Partial<Windows>;

export function seatPlaces(
  limits: Record<string, number>,
  paceRuns: (seat: Placed) => number | undefined = () => undefined,
) {
  const occupied = new Map<string, number>();
  const count = (seat: { id: string }) => occupied.get(seat.id) ?? 0;
  const take = (seat: { id: string }) => occupied.set(seat.id, count(seat) + 1);
  const release = (seat: { id: string }) => occupied.set(seat.id, count(seat) - 1);
  // The runs a seat takes at a time: its engine's limit, its pace's and its stop's (pace.ts seatRunLimit).
  // pastStop: the board's work, which runs past a seat's stop level and its pacing. pastPace: work pacing doesn't hold
  // (urgent, or a pick that weighs pacing itself). held: a meeting's reservation, which owns its place even if the
  // pacing rate shrank while it gathered.
  const limitOn = (seat: Placed, { pastStop = false, pastPace = false, held = false } = {}, now = Date.now()) => {
    const limit = limits[seat.engine] ?? Infinity;
    return pastStop
      ? limit
      : seatRunLimit(seat, pastPace || held ? limit : Math.min(limit, paceRuns(seat) ?? Infinity), now);
  };
  return {
    count,
    take,
    release,
    limitOn,
    roomOn: (seat: Placed, room: { pastStop?: boolean; pastPace?: boolean; held?: boolean } = {}) => {
      const admissionLimit = limitOn(seat, room);
      return room.held ? admissionLimit > 0 : count(seat) < admissionLimit;
    },
    async hold<T>(seat: { id: string }, held: boolean, kept: () => boolean, work: () => Promise<T>) {
      if (!held) take(seat);
      try {
        return await work();
      } finally {
        if (!kept()) release(seat);
      }
    },
  };
}
