// Memory set aside for jobs still starting and slots holding a meeting seat.
// Jobs started in the last minute reserve JOB_MB until they reach their full size. A meeting seat mostly waits on
// hq meeting listen (~300 MB measured), so each hold reserves SEAT_MB. A free slot may claim while FREE_MB remains
// after these reservations and the candidate's allowance (worker.ts room).
export const FREE_MB = 1500,
  JOB_MB = 700,
  SEAT_MB = 400,
  STARTING_MS = 60_000;

// The worker's reservations: each claim's start, and the slots holding a meeting's seat (the claim's `held`: the
// coordinator's meetingseats.ts) with the seat each claims on. A hold keeps a seat's room until its seat starts or HQ
// lets it go, so the slots that gather a meeting can all start it.
export function reservations<Seat>(now = Date.now) {
  const starts: number[] = [];
  const holding = new Map<string, Seat>();
  const starting = (at = now()) => starts.filter(start => at - start < STARTING_MS).length;
  const reservedMb = (n = starting()) => n * JOB_MB + holding.size * SEAT_MB;
  // What's free of the available MB, less the reservations when young (else the room as it stands)
  const freeMb = (availableMb: number, young = true) => availableMb - (young ? reservedMb() : 0);
  const claimMb = (availableMb: number, young = true) => Math.max(0, Math.floor(freeMb(availableMb, young) - FREE_MB));
  return {
    holding,
    startupReservations: () =>
      starts.filter(start => now() - start < STARTING_MS).map(start => ({ until: start + STARTING_MS, mb: JOB_MB })),
    starting,
    reservedMb,
    freeMb,
    claimMb,
    // Each new claim first needs JOB_MB, then converts to a held seat's SEAT_MB.
    gathering: (availableMb: number) => {
      const free = claimMb(availableMb);
      return free < JOB_MB ? 0 : 1 + Math.floor((free - JOB_MB) / SEAT_MB);
    },
    starts: (availableMb: number, young = true) => Math.floor(claimMb(availableMb, young) / JOB_MB),
    room: (availableMb: number, young = true) => claimMb(availableMb, young) >= JOB_MB,
    // A claim takes its room before it's asked (its start, given back if it finds nothing), so idle slots can't all
    // start at once.
    take() {
      const t = now();
      starts.push(t);
      return t;
    },
    giveBack: (t: number) => starts.splice(starts.indexOf(t), 1),
    // a claim that found a job keeps its start; the oldest go once there are many
    started() {
      if (starts.length > 50) starts.splice(0, 25);
    },
    // A claim's answer to a slot: held for a meeting, the room the claim took (its start at t) moves into the hold, and
    // the slot asks again soon; anything else ends a hold it had.
    keepsHold(slot: string, seat: Seat, t: number, answer: { held?: unknown } | null) {
      if (!answer?.held) {
        holding.delete(slot);
        return false;
      }
      holding.set(slot, seat);
      starts.splice(starts.indexOf(t), 1);
      return true;
    },
  };
}
