// Reported seat windows renewed and consumed by simulated runs.
import type { MixRate } from './workmix.ts';
import type { SeatNow, Snapshot, Wait } from './eta.ts';
import { pacedTakes, spareOnly, type Order } from './planner.ts';
import {
  drainLifts,
  windowUsed,
  nextWindowReset,
  paceChange,
  pacedUntil,
  paceTo,
  pacingLifts,
  reserveElsewhere,
} from '../../worker/src/pace.ts';
const HOUR_MS = 3_600_000;
// (pacing: the board's switch, as the snapshot has it.)
export type Seat = SeatNow & {
  fiveRate: number | null;
  weekRate: number | null;
  pacing: boolean;
  mix: Record<string, MixRate>;
};

export function seatsOf(snapshot: Snapshot) {
  return snapshot.seats.map(row => {
    const rate = snapshot.rates[row.engine];
    const weekRate = typeof rate?.week === 'object' && rate.week !== null ? rate.week[row.id] : rate?.week;
    return {
      ...row,
      fiveRate: rate?.five[row.id] ?? null,
      weekRate: weekRate ?? null,
      pacing: !!snapshot.pacing,
      mix: snapshot.seatMix?.[row.id] ?? {},
    };
  });
}

export function reset(seat: Seat, now: number) {
  if (seat.fiveHourResets !== null && seat.fiveHourResets <= now) {
    seat.fiveHour = 0;
  }
  if (seat.weekResets !== null && seat.weekResets <= now) {
    seat.week = 0;
    seat.weekResets = nextWindowReset(seat.weekResets, now, true);
  }
  if (['sleeping', 'draining'].includes(seat.state) && seat.until !== null && seat.until <= now) seat.state = 'ready';
}

const week = (seat: Seat) => ({ week: seat.week ?? undefined, weekResets: seat.weekResets ?? 0 });

// The seats at one moment of the play, with whether each is paced and until when, as the worker paces it (pace.ts): by
// its week as the play has used it so far, toward the level the worker aims it at with the seats as the play has them
// now (aim). Worked out once a moment, since only the play's advance uses a seat.
export type Moment = ReturnType<typeof at>;
export function at(seats: Seat[], now: number) {
  const windows = seats.map(windowsOf);
  const aims = new Map(seats.map((s, i) => [s, aim(s, windows, i, now)]));
  const paced = new Map(seats.map(s => [s, pacedUntil(week(s), aims.get(s), now)]));
  return { seats, now, aims, paced };
}

// The level a seat's pacing aims for, as the worker works it out (pace.ts paceTo): its stop level, or its limit while
// another ready seat of its engine is under its own and keeps the reserve (reserveElsewhere). Read from the seats'
// simulated use (their windows, read once for all of them), so the reserve passes
// on as the play fills a seat, as it does in the worker.
function aim(seat: Seat, windows: Windows[], index: number, now: number) {
  const own = windows[index]!;
  return paceTo(own, seat.pacing, reserveElsewhere(own, windows, now));
}
type Windows = ReturnType<typeof windowsOf>;
export const windowsOf = (s: Seat) => ({
  engine: s.engine,
  state: s.state,
  util: s.fiveHour ?? undefined,
  resets: s.fiveHourResets ?? 0,
  week: s.week ?? undefined,
  weekResets: s.weekResets ?? 0,
  credits: s.credits,
  drainAt: s.stop,
});

export function available(seat: Seat, now: number) {
  return (
    seat.state === 'ready' &&
    (seat.until === null || seat.until <= now) &&
    (seat.credits ||
      (knownWindows(seat) &&
        (seat.fiveHour === null || seat.fiveHour < seat.stop) &&
        (seat.week === null || seat.week < seat.stop)))
  );
}

function knownWindows(seat: Seat) {
  return !(seat.fiveHour === null && seat.fiveHourResets !== null) && !(seat.week === null && seat.weekResets !== null);
}

export function holding(seat: Seat, now: number) {
  const holds: { quota: 'fiveHour' | 'week' | 'reported'; until: number | null }[] = [];
  if (!seat.credits) {
    if (seat.week !== null && seat.week >= seat.stop) holds.push({ quota: 'week', until: seat.weekResets });
    if (seat.fiveHour !== null && seat.fiveHour >= seat.stop)
      holds.push({ quota: 'fiveHour', until: seat.fiveHourResets });
  }
  if (['draining', 'sleeping'].includes(seat.state) && (seat.until === null || seat.until > now))
    holds.push({ quota: 'reported', until: seat.until });
  return holds.sort((a, b) => (b.until ?? Infinity) - (a.until ?? Infinity))[0] ?? null;
}

export function binding(seat: Seat, now: number) {
  return holding(seat, now)?.quota ?? null;
}

export function drained(seat: Seat, now: number) {
  return binding(seat, now) !== null;
}

export function choose(
  row: { engine: string; for_seat: string | null; downtime: number },
  order: Order,
  moment: Moment,
  busy: Map<string, number>,
  limits: Record<string, number>,
  others: boolean,
): Seat | Wait {
  const { seats, now } = moment;
  // (a paced seat takes what the claim's pacedTakes lets through)
  let picked: Seat | undefined;
  let eligible = false;
  const spare = spareOnly(row, order) && others;
  for (const seat of seats) {
    if (!takes(seat, row, order, moment)) continue;
    eligible = true;
    if (spare || (busy.get(seat.id) ?? 0) >= (limits[seat.engine] ?? Infinity)) continue;
    if (!picked || compareSeats(seat, picked, now) < 0) picked = seat;
  }
  if (picked) return picked;
  // (downtime work behind other work, on an open seat, waits in the queue too)
  if (eligible) return { on: 'queue', engine: row.engine, minutes: 0 };
  // (an open seat that doesn't take it is paced, so it aims somewhere: it may take it once its pacing lifts)
  const own = seats.filter(s => s.engine === row.engine && (!row.for_seat || s.id === row.for_seat));
  const returns = own
    .flatMap(s =>
      available(s, now) ? [pacingLifts(week(s), moment.aims.get(s)!, now)] : [s.until, s.fiveHourResets, s.weekResets],
    )
    .filter((t): t is number => t !== null && t > now);
  if (returns.length) return { on: 'seats', engine: row.engine, until: Math.min(...returns) };
  return {
    on: 'stalled',
    why: own.length ? `The ${row.engine} seats have no reported return` : `No ${row.engine} seat has reported`,
  };
}

export function takes(seat: Seat, row: { engine: string; for_seat: string | null }, order: Order, moment: Moment) {
  return (
    seat.engine === row.engine &&
    (!row.for_seat || row.for_seat === seat.id) &&
    available(seat, moment.now) &&
    pacedTakes(order, moment.paced.get(seat))
  );
}

const compareSeats = (a: Seat, b: Seat, now: number) =>
  (windowUsed(windowsOf(a), now) ?? 1) - (windowUsed(windowsOf(b), now) ?? 1) || a.id.localeCompare(b.id);

// A full room holds its occupancy for the rest of the moment, as the seats' occupancy holds between two claims that
// start. Claims with the same engine, seat binding, paced seats open to them and spare standing (with others waiting)
// therefore see the same seats (between claims, and spare standing).
export function choices(moment: Moment, busy: Map<string, number>, limits: Record<string, number>) {
  type Pick = { seat: Seat | Wait; roomSeat: Seat | Wait };
  const cached = new Map<string, Map<string | null, Map<number, Pick>>>();
  const paced = [...new Set(moment.paced.values())].filter((until): until is number => until !== undefined);
  const empty = new Map<string, number>();
  return (row: { engine: string; for_seat: string | null; downtime: number }, order: Order, others = false) => {
    let engine = cached.get(row.engine);
    if (!engine) cached.set(row.engine, (engine = new Map()));
    let bound = engine.get(row.for_seat);
    if (!bound) engine.set(row.for_seat, (bound = new Map()));
    // Pacing thresholds are nested. The count identifies the same set of seats for every claim.
    let admitted = 0;
    for (const until of paced) admitted += Number(pacedTakes(order, until));
    const key = 2 * admitted + Number(spareOnly(row, order) && others);
    let picked = bound.get(key);
    if (!picked) {
      const seat = choose(row, order, moment, busy, limits, others);
      const roomSeat = 'id' in seat ? seat : choose(row, order, moment, empty, limits, others);
      bound.set(key, (picked = { seat, roomSeat }));
    }
    return picked;
  };
}

export function burnRates(seat: Seat, row?: { kind: string }) {
  const mix = row ? seat.mix[row.kind] : undefined;
  const five = mix?.five ?? seat.fiveRate,
    week = mix?.week ?? seat.weekRate;
  const source =
    mix?.five !== undefined && mix.five !== null && mix.week !== null
      ? ('mix' as const)
      : five === null || week === null
        ? ('unmeasured' as const)
        : ('aggregate' as const);
  return { five, week, source };
}

export function consume(seat: Seat, ms: number, row?: { kind: string }) {
  const rates = burnRates(seat, row);
  if (seat.fiveHour !== null && rates.five !== null) seat.fiveHour += (rates.five * ms) / HOUR_MS;
  if (seat.week !== null && rates.week !== null) seat.week += (rates.week * ms) / HOUR_MS;
}

// Pacing changes and window resets compete with the running work's priced exhaustion. windows: the seats' (windowsOf),
// read once for a moment's seats. A seat's renewed five hours here renews its own.
export function seatEvent(
  seat: Seat,
  seats: Seat[],
  now: number,
  running: number | { kind: string }[],
  windows = seats.map(windowsOf),
) {
  const count = typeof running === 'number' ? running : running.length;
  const index = seats.indexOf(seat);
  if (count && seat.fiveHourResets !== null && seat.fiveHourResets <= now) {
    seat.fiveHourResets = nextWindowReset(seat.fiveHourResets, now, false);
    windows[index] = windowsOf(seat);
  }
  const events = [seat.until, seat.fiveHourResets, seat.weekResets].filter((t): t is number => t !== null && t > now);
  for (const change of [paceChange(week(seat), aim(seat, windows, index, now), now), drainLifts(windows[index]!, now)])
    if (change !== undefined) events.push(change);
  if (count && available(seat, now) && !seat.credits) {
    const rates =
      typeof running === 'number'
        ? [{ five: seat.fiveRate, week: seat.weekRate, count: running }]
        : running.map(row => ({ ...burnRates(seat, row), count: 1 }));
    for (const [used, window] of [
      [seat.fiveHour, 'five'],
      [seat.week, 'week'],
    ] as const) {
      const rate = rates.reduce((sum, price) => sum + (price[window] ?? 0) * price.count, 0);
      if (used !== null && rate > 0) events.push(Math.max(now + 1, now + ((seat.stop - used) * HOUR_MS) / rate));
    }
  }
  return Math.min(...events);
}
