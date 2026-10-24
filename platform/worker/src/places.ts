// A seat's run places include claims in flight and slots holding a meeting's reservation.
export function seatPlaces(limits: Record<string, number>) {
  const occupied = new Map<string, number>();
  const count = (seat: { id: string }) => occupied.get(seat.id) ?? 0;
  const take = (seat: { id: string }) => occupied.set(seat.id, count(seat) + 1);
  const release = (seat: { id: string }) => occupied.set(seat.id, count(seat) - 1);
  return {
    count,
    take,
    release,
    roomOn: (seat: { id: string; engine: string }) => count(seat) < (limits[seat.engine] ?? Infinity),
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
