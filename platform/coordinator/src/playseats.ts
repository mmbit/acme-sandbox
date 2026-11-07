// Reported seat windows renewed and consumed by simulated runs.
import type { MixRate } from './workmix.ts';
import type { QueuedJob, SeatNow, Snapshot, Wait } from './eta.ts';
import { spareOnly, type Order } from './planner.ts';
import {
  CLAUDE_RECHECK_MS,
  drainLifts,
  stopWindows,
  pausesAtStop as stopPauses,
  compareSeatPace,
  drainLevel,
  seatRunLimit,
  nextWindowReset,
  paceChange,
  pacedUntil,
  pacedRest,
  pacedRuns,
  pacedRunsRise,
  paceTo,
  reserveElsewhere,
} from '../../worker/src/pace.ts';
const HOUR_MS = 3_600_000;
// (pacing: the board's switch, as the snapshot has it.)
export type Seat = SeatNow & {
  recheckAt: number | null;
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
      recheckAt: null as number | null,
      fiveRate: rate?.five[row.id] ?? null,
      weekRate: weekRate ?? null,
      pacing: !!snapshot.pacing,
      mix: snapshot.seatMix?.[row.id] ?? {},
    };
  });
}

// All peers' windows and wakeups must be current before a recovery read shares their reserve.
export function reset(seats: Seat[], now: number) {
  for (const seat of seats) resetWindows(seat, now);
  for (const seat of seats) awaitRecheck(seat, now, seats);
}

function resetWindows(seat: Seat, now: number) {
  if (seat.fiveHourResets !== null && seat.fiveHourResets <= now) {
    // A renewed window releases its hold without waiting for another recovery read.
    if (seat.fiveHour !== 0) seat.recheckAt = null;
    seat.fiveHour = 0;
  }
  if (seat.weekResets !== null && seat.weekResets <= now) {
    seat.recheckAt = null;
    seat.week = 0;
    seat.weekResets = nextWindowReset(seat.weekResets, now, true);
  }
  if (['sleeping', 'draining'].includes(seat.state) && seat.until !== null && seat.until <= now) seat.state = 'ready';
}

// The seats at one moment of the play, with whether each is paced and until when, as the worker paces it (pace.ts): by
// its week as the play has used it so far, toward the level the worker aims it at with the seats as the play has them
// now (aim), and how many ordinary runs it takes at a time (pace.ts pacedRuns). Worked out once a moment, since only
// the play's advance uses a seat.
export type Moment = ReturnType<typeof at>;
export function at(seats: Seat[], now: number) {
  const windows = seats.map(windowsOf);
  const aims = seats.map((s, i) => aim(s, windows, i, now));
  const paced = new Map(seats.map((s, i) => [s, pacedUntil(windows[i]!, aims[i], now)]));
  const paceRuns = new Map(
    seats.map((s, i) => [s, pacedRuns(windows[i]!, aims[i], s.weekRate, now, restOf(s))?.runs] as const),
  );
  return { seats, now, paced, paceRuns };
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
  drainAt: s.stopConfigured === false ? undefined : s.stop,
});

// The runs a seat takes at a time this moment: urgent work past its pacing, as the worker's places.ts.
export function runLimit(seat: Seat, limits: Record<string, number>, moment: Moment, urgent: boolean) {
  const limit = limits[seat.engine] ?? Infinity;
  const paced = urgent ? limit : Math.min(limit, moment.paceRuns.get(seat) ?? Infinity);
  return seatRunLimit(windowsOf(seat), paced, moment.now);
}

// A run of `ranMs` leaves the seat now, which rests after it as the worker's does (pace.ts pacedRest).
export function rest(seat: Seat, ranMs: number, now: number, seats: Seat[]) {
  const windows = seats.map(windowsOf);
  const to = aim(seat, windows, seats.indexOf(seat), now);
  seat.paceRest = pacedRest(windows[seats.indexOf(seat)]!, to, seat.weekRate, ranMs, restOf(seat), now) ?? null;
}
const restOf = (seat: Seat) => seat.paceRest ?? undefined;

export function available(seat: Seat, now: number, seats = [seat]) {
  return (
    seat.state === 'ready' &&
    (seat.recheckAt === null || seat.recheckAt <= now) &&
    (seat.until === null || seat.until <= now) &&
    (seat.credits || (knownWindows(seat) && !quotaHolds(seat, seats, now).length))
  );
}

function knownWindows(seat: Seat) {
  return !(seat.fiveHour === null && seat.fiveHourResets !== null) && !(seat.week === null && seat.weekResets !== null);
}

export function holding(seat: Seat, now: number, seats = [seat]) {
  const holds: { quota: 'fiveHour' | 'week' | 'reported'; until: number | null }[] = [];
  if (seat.recheckAt !== null && seat.recheckAt > now) holds.push({ quota: 'reported', until: seat.recheckAt });
  for (const [, reset, weekly] of quotaHolds(seat, seats, now))
    holds.push({ quota: weekly ? 'week' : 'fiveHour', until: reset || null });
  if (['draining', 'sleeping'].includes(seat.state) && (seat.until === null || seat.until > now))
    holds.push({ quota: 'reported', until: seat.until });
  return holds.sort((a, b) => (b.until ?? Infinity) - (a.until ?? Infinity))[0] ?? null;
}

function quotaHolds(seat: Seat, seats: Seat[], now: number) {
  const own = windowsOf(seat);
  const windows = seats.map(s => (s === seat ? own : windowsOf(s)));
  return stopWindows(own, windows, now);
}

export const pausesAtStop = (seat: Seat) => stopPauses(windowsOf(seat));

// Each recovery read asks the shared stop policy again, including any reserve a peer can now keep.
function awaitRecheck(seat: Seat, now: number, seats: Seat[]) {
  if ((seat.cli ?? seat.engine) !== 'claude') return;
  if (seat.recheckAt !== null && seat.recheckAt > now) return;
  seat.recheckAt = quotaHolds(seat, seats, now).length ? now + CLAUDE_RECHECK_MS : null;
}

export function binding(seat: Seat, now: number, seats = [seat]) {
  return holding(seat, now, seats)?.quota ?? null;
}

export function drained(seat: Seat, now: number, seats = [seat]) {
  return binding(seat, now, seats) !== null;
}

// What a seat's claim reads of a job (jobs.ts claimable).
type Claimed = Pick<QueuedJob, 'id' | 'agent' | 'engine' | 'for_seat' | 'cli' | 'fallsBack' | 'downtime'>;

export function choose(
  row: Claimed,
  order: Order,
  moment: Moment,
  busy: Map<string, number>,
  limits: Record<string, number>,
  others: boolean,
): Seat | Wait {
  const { seats, now } = moment;
  let picked: Seat | undefined;
  let eligible = false;
  const spare = spareOnly(row, order) && others;
  for (const seat of seats) {
    if (!takes(seat, row, order, moment)) continue;
    eligible = true;
    if (spare || (busy.get(seat.id) ?? 0) >= runLimit(seat, limits, moment, !!order.urgent)) continue;
    if (!picked || compareSeats(seat, picked, now) < 0) picked = seat;
  }
  if (picked) return picked;
  // (downtime work behind other work, on an open seat, waits in the queue too)
  if (eligible) return { on: 'queue', engine: row.engine, minutes: 0 };
  const primary = seats.filter(s => fits(s, row));
  const own = primary.some(s => available(s, now, seats))
    ? primary
    : seats.filter(s => fits(s, row) || fallsBackOnto(s, row));
  const returns = own
    .flatMap(seat => {
      const until = holding(seat, now, seats)?.until;
      return until && until > now ? [{ until, reason: 'unavailable' as const }] : [];
    })
    .sort((a, b) => a.until - b.until);
  if (returns.length) return { on: 'seats', engine: row.engine, from: now, ...returns[0] };
  return {
    on: 'stalled',
    why: own.length ? `The ${row.engine} seats have no reported return` : `No ${row.engine} seat has reported`,
  };
}

// These seats decide reserve sharing and fallback availability for the claim.
export function takes(seat: Seat, row: Claimed, order: Order, moment: Moment, seats = moment.seats) {
  const ownOut = () => !seats.some(s => fits(s, row) && available(s, moment.now, seats));
  return (fits(seat, row) || (fallsBackOnto(seat, row) && ownOut())) && available(seat, moment.now, seats);
}

// A seat of its own: of its engine, the one it's pinned to if it is, running the CLI it must run on, as claim's.
const fits = (seat: Seat, row: Claimed) =>
  seat.engine === row.engine &&
  (!row.for_seat || row.for_seat === seat.id) &&
  (!row.cli || row.cli === (seat.cli ?? seat.engine));
// A seat its agent's fallback runs on. Claim gives it work there only while none of its own is available.
const fallsBackOnto = (seat: Seat, row: Claimed) => !!row.fallsBack && !!seat.fallbacks?.includes(row.agent);

const compareSeats = (a: Seat, b: Seat, now: number) =>
  compareSeatPace(windowsOf(a), windowsOf(b), now) || a.id.localeCompare(b.id);

// A full room holds its occupancy for the rest of the moment, as the seats' occupancy holds between two claims that
// start. Claims with the same engine, seat binding, paced seats open to them and spare standing (with others waiting)
// therefore see the same seats (between claims, and spare standing). The binding is its pin, its CLI and the agent whose
// fallback may take it.
export function choices(moment: Moment, busy: Map<string, number>, limits: Record<string, number>) {
  type Pick = { seat: Seat | Wait; roomSeat: Seat | Wait };
  const cached = new Map<string, Map<string, Map<number, Pick>>>();
  const empty = new Map<string, number>();
  return (row: Claimed, order: Order, others = false) => {
    // Work no seat takes, not even its fallback's, is stuck whatever comes back. Its wait names it for the CEO's summary
    // (threats.ts). With no seat reported at all, choose says so.
    if (moment.seats.length && !moment.seats.some(s => fits(s, row) || fallsBackOnto(s, row))) {
      const stuck = { on: 'stalled' as const, why: `No ${row.engine} seat takes it`, job: row.id };
      return { seat: stuck, roomSeat: stuck };
    }
    let engine = cached.get(row.engine);
    if (!engine) cached.set(row.engine, (engine = new Map()));
    const binding = JSON.stringify([row.for_seat, row.cli ?? null, row.fallsBack ? row.agent : null]);
    let bound = engine.get(binding);
    if (!bound) engine.set(binding, (bound = new Map()));
    const key = 2 * Number(!!order.urgent) + Number(spareOnly(row, order) && others);
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
  const events = [seat.until, seat.fiveHourResets, seat.weekResets, seat.recheckAt, restOf(seat) ?? null].filter(
    (t): t is number => t !== null && t > now,
  );
  const rates =
    typeof running === 'number'
      ? [{ five: seat.fiveRate, week: seat.weekRate, count: running }]
      : running.map(row => ({ ...burnRates(seat, row), count: 1 }));
  const spend = (window: 'five' | 'week') => rates.reduce((sum, price) => sum + (price[window] ?? 0) * price.count, 0);
  const to = aim(seat, windows, index, now);
  for (const change of [
    paceChange(windows[index]!, to, now),
    pacedRunsRise(windows[index]!, to, seat.weekRate, spend('week'), now, restOf(seat)),
    drainLifts(windows[index]!, now),
  ])
    if (change !== undefined) events.push(change);
  if (count && available(seat, now, seats) && !seat.credits) {
    for (const [used, window, weekly] of [
      [seat.fiveHour, 'five', false],
      [seat.week, 'week', true],
    ] as const) {
      const rate = spend(window);
      const stop = drainLevel(windows[index]!, weekly, now);
      if (used !== null && used < stop && rate > 0)
        events.push(Math.max(now + 1, now + ((stop - used) * HOUR_MS) / rate));
    }
  }
  return Math.min(...events);
}
