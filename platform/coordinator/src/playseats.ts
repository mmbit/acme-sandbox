// Reported seat windows renewed and consumed by simulated runs.
import type { SeatNow, Snapshot, Wait } from './eta.ts';
import { pacedTakes, spareOnly, type Order } from './planner.ts';
import {
  drainLifts,
  nextWindowReset,
  paceChange,
  pacedUntil,
  paceTo,
  pacingLifts,
  reserveElsewhere,
} from '../../worker/src/pace.ts';
const HOUR_MS = 3_600_000;
// (pacing: the board's switch, as the snapshot has it.)
export type Seat = SeatNow & { fiveRate: number | null; weekRate: number | null; pacing: boolean };

export function seatsOf(snapshot: Snapshot) {
  return snapshot.seats.map(row => {
    const rate = snapshot.rates[row.engine];
    const weekRate = typeof rate?.week === 'object' && rate.week !== null ? rate.week[row.id] : rate?.week;
    return { ...row, fiveRate: rate?.five[row.id] ?? null, weekRate: weekRate ?? null, pacing: !!snapshot.pacing };
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

const week = (seat: Seat) => ({ week: seat.week, weekResets: seat.weekResets ?? 0 });

// The seats at one moment of the play, with whether each is paced and until when, as the worker paces it (pace.ts): by
// its week as the play has used it so far, toward the level the worker aims it at with the seats as the play has them
// now (aim). Worked out once a moment, since only the play's advance uses a seat.
export type Moment = ReturnType<typeof at>;
export function at(seats: Seat[], now: number) {
  const aims = new Map(seats.map(s => [s, aim(s, seats, now)]));
  const paced = new Map(seats.map(s => [s, pacedUntil(week(s), aims.get(s), now)]));
  return { seats, now, aims, paced };
}

// The level a seat's pacing aims for, as the worker works it out (pace.ts paceTo): its stop level, or its limit while
// another ready seat of its engine is under its own and keeps the reserve (reserveElsewhere). Read from the seats'
// simulated use, so the reserve passes on as the play fills a seat, as it does in the worker.
function aim(seat: Seat, seats: Seat[], now: number) {
  const windows = seats.map(windowsOf),
    own = windows[seats.indexOf(seat)]!;
  return paceTo(own, seat.pacing, reserveElsewhere(own, windows, now));
}
const windowsOf = (s: Seat) => ({
  ...{ engine: s.engine, state: s.state, util: s.fiveHour, resets: s.fiveHourResets ?? 0 },
  ...{ week: s.week, weekResets: s.weekResets ?? 0, credits: s.credits, drainAt: s.stop },
});

export function available(seat: Seat, now: number) {
  return (
    seat.state === 'ready' &&
    (seat.until === null || seat.until <= now) &&
    seat.fiveHour < seat.stop &&
    seat.week < seat.stop
  );
}

export function drained(seat: Seat, now: number) {
  return (
    seat.fiveHour >= seat.stop ||
    seat.week >= seat.stop ||
    (['draining', 'sleeping'].includes(seat.state) && (seat.until === null || seat.until > now))
  );
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
    if (!picked || compareSeats(seat, picked) < 0) picked = seat;
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

const compareSeats = (a: Seat, b: Seat) =>
  Math.max(a.week, a.fiveHour) - Math.max(b.week, b.fiveHour) || a.id.localeCompare(b.id);

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

export function consume(seat: Seat, ms: number) {
  seat.fiveHour += ((seat.fiveRate ?? 0) * ms) / HOUR_MS;
  seat.week += ((seat.weekRate ?? 0) * ms) / HOUR_MS;
}

// (its pacing may change, and in the week's last day a full seat may stop being full and keep the reserve again)
export function seatEvent(seat: Seat, seats: Seat[], now: number, running: number) {
  if (running && seat.fiveHourResets !== null && seat.fiveHourResets <= now)
    seat.fiveHourResets = nextWindowReset(seat.fiveHourResets, now, false);
  const events = [seat.until, seat.fiveHourResets, seat.weekResets].filter((t): t is number => t !== null && t > now);
  for (const change of [paceChange(week(seat), aim(seat, seats, now), now), drainLifts(windowsOf(seat), now)])
    if (change !== undefined) events.push(change);
  if (running && available(seat, now)) {
    if (seat.fiveRate !== null && seat.fiveRate > 0)
      events.push(Math.max(now + 1, now + ((seat.stop - seat.fiveHour) * HOUR_MS) / (seat.fiveRate * running)));
    if (seat.weekRate !== null && seat.weekRate > 0)
      events.push(Math.max(now + 1, now + ((seat.stop - seat.week) * HOUR_MS) / (seat.weekRate * running)));
  }
  return Math.min(...events);
}
