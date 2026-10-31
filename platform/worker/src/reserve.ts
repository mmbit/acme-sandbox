// Memory set aside for jobs still starting and slots holding a meeting seat.
// Jobs started in the last minute reserve JOB_MB until they reach their full size. A meeting seat mostly waits on
// hq meeting listen (~300 MB measured), so each hold reserves SEAT_MB. A free slot may claim while FREE_MB remains
// after these reservations and the candidate's allowance (worker.ts room).
export const FREE_MB = 1500,
  JOB_MB = 700,
  SEAT_MB = 400,
  STARTING_MS = 60_000;

export type ReservationInputs = {
  starting: { until: number; mb: number }[] | null;
  heldSlots: number;
  heldMb: number;
  freeReserveMb: number;
  defaultRunMb: number;
};

// The worker's reservations: each claim's start, and the slots holding a meeting's seat (the claim's `held`: the
// coordinator's meetingseats.ts) with the seat each claims on. A hold keeps a seat's room until its seat starts or HQ
// lets it go, so the slots that gather a meeting can all start it.
export function reservations<Seat>(now = Date.now, observed?: (starting: { until: number; mb: number }[]) => void) {
  const starts: number[] = [];
  const holding = new Map<string, Seat>();
  const starting = (at = now()) => countStarts(starts, at, observed);
  const reservedMb = (n = starting()) => n * JOB_MB + holding.size * SEAT_MB;
  const capacity = (availableMb: number, young = true) =>
    reservationCapacity(availableMb, currentInputs(starts, holding.size, young, now, observed), young);
  const claimMb = (availableMb: number, young = true) => capacity(availableMb, young).claimMb;
  return {
    holding,
    startupReservations: () => startupEntries(starts, now()),
    starting,
    reservedMb,
    freeMb: (availableMb: number, young = true) => capacity(availableMb, young).freeMb,
    claimMb,
    // Each new claim first needs JOB_MB, then converts to a held seat's SEAT_MB.
    gathering: (availableMb: number) => {
      const free = claimMb(availableMb);
      return free < JOB_MB ? 0 : 1 + Math.floor((free - JOB_MB) / SEAT_MB);
    },
    starts: (availableMb: number, young = true) => Math.floor(claimMb(availableMb, young) / JOB_MB),
    room: (availableMb: number, young = true) => capacity(availableMb, young).room,
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

export function reservationCapacity(availableMb: number, reserves: ReservationInputs, young = true) {
  const reservedMb = young ? reserves.starting!.reduce((sum, entry) => sum + entry.mb, 0) + reserves.heldMb : 0;
  const freeMb = availableMb - reservedMb;
  const claimMb = Math.max(0, Math.floor(freeMb - reserves.freeReserveMb));
  return { freeMb, claimMb, room: claimMb >= reserves.defaultRunMb };
}

export function reservationInputs(starting: ReservationInputs['starting'], heldSlots: number): ReservationInputs {
  return { starting, heldSlots, heldMb: heldSlots * SEAT_MB, freeReserveMb: FREE_MB, defaultRunMb: JOB_MB };
}

function countStarts(starts: number[], at: number, observed?: (starting: { until: number; mb: number }[]) => void) {
  const entries = startupEntries(starts, at);
  observed?.(entries);
  return entries.length;
}

const startupEntries = (starts: number[], at: number) =>
  starts.filter(start => at - start < STARTING_MS).map(start => ({ until: start + STARTING_MS, mb: JOB_MB }));

function currentInputs(
  starts: number[],
  heldSlots: number,
  young: boolean,
  now: () => number,
  observed?: (starting: { until: number; mb: number }[]) => void,
): ReservationInputs {
  const starting = young ? startupEntries(starts, now()) : null;
  if (starting) observed?.(starting);
  return reservationInputs(starting, heldSlots);
}
