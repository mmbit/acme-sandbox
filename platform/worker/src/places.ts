// A seat's run places include claims in flight and slots holding a meeting's reservation.
import { seatRunLimit, type Windows } from './pace.ts';

type Placed = { id: string; engine: string } & Partial<Windows>;

export function seatPlaces(limits: Record<string, number>) {
  const occupied = new Map<string, number>();
  const count = (seat: { id: string }) => occupied.get(seat.id) ?? 0;
  const take = (seat: { id: string }) => occupied.set(seat.id, count(seat) + 1);
  const release = (seat: { id: string }) => occupied.set(seat.id, count(seat) - 1);
  return {
    count,
    take,
    release,
    roomOn: (seat: Placed, bypassStopLimit = false) => {
      const limit = limits[seat.engine] ?? Infinity;
      return count(seat) < (bypassStopLimit ? limit : seatRunLimit(seat, limit));
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
