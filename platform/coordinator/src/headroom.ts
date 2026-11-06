// Seat headroom and per-seat usage gained per agent-hour, measured between worker readings.
import { db } from './db.ts';
import { recordSeatCost } from './seatcost.ts';
import {
  recordWindowObservations,
  windowReadings,
  lastWindowReadingId,
  changedWindowReadings,
} from './seatobservations.ts';
import { mixRates, type MixRate } from './workmix.ts';
import { pricedInterval, runMilliseconds, type Interval, type Reading } from './seatgains.ts';
import { seatStatuses } from './seatstatus.ts';

const HOUR_MS = 3_600_000,
  DAY_MS = 24 * HOUR_MS,
  WEEK_MS = 7 * DAY_MS;
export const WINDOW_MS = 5 * HOUR_MS;
const iso = (ms: number) => new Date(ms).toISOString();

type SeatRow = {
  id: string;
  engine: string;
  state: string;
  five_hour: number | null;
  five_hour_resets: number | null;
  week: number | null;
  week_resets: number | null;
};
const seatRows = (id?: string) =>
  db
    .prepare(
      `select id, engine, state, util five_hour,
  resets five_hour_resets, week, week_resets from seats ${id === undefined ? '' : 'where id = ?'} order by id`,
    )
    .all(...(id === undefined ? [] : [id])) as SeatRow[];

export function recordSeatReading(seat: string, times: import('./seatobservations.ts').ObservationTimes = {}) {
  recordWindowObservations(seat, times);
  recordSeatCost(seat, times.weekObservedAt);
  db.prepare(
    `insert into seat_readings (seat, minute, at, util, resets, week, week_resets)
    select id, updated / 60000, updated, util, resets, week, week_resets from seats where id = ?
    and (util is not null or week is not null)
    on conflict (seat, minute) do update set at = excluded.at, util = excluded.util,
    resets = excluded.resets, week = excluded.week, week_resets = excluded.week_resets`,
  ).run(seat);
  db.prepare('delete from seat_readings where seat = ? and at < ?').run(seat, Date.now() - 2 * WEEK_MS);
}

export function seatHeadroom(at = Date.now()) {
  const prices = readingRates(at);
  const statuses = seatStatuses(db, at);
  const seats = seatRows().map(seat => ({
    ...seat,
    status: statuses.get(seat.id),
    five_hour_per_hour: prices.get(seat.id)?.five ?? null,
    week_per_hour: prices.get(seat.id)?.week ?? null,
  }));
  const engines = [...new Set(seats.map(s => s.engine))].map(engine => {
    const working = seats.filter(s => s.engine === engine && s.state !== 'closed' && s.state !== 'login');
    const read = working.filter(s => s.week !== null);
    const resets = read.map(s => s.week_resets).filter((r): r is number => r !== null && r > at);
    const left = (s: SeatRow) => (s.week_resets !== null && s.week_resets <= at ? 100 : (1 - s.week!) * 100);
    return {
      engine,
      left_percent: Math.round(read.reduce((n, s) => n + left(s), 0)),
      measured_seats: read.length,
      unmeasured_seats: working.length - read.length,
      next_reset: resets.length ? Math.min(...resets) : null,
    };
  });
  return { seats, engines };
}

export const seatReading = (id: string) => seatRows(id)[0];

export function seatProjection(id: string, at = Date.now()) {
  const seat = seatReading(id);
  const active = db
    .prepare(
      `select j.kind from runs r join jobs j on j.id = r.job
    where r.seat = ? and r.started <= ? and (r.ended is null or r.ended > ?)`,
    )
    .all(id, iso(at), iso(at)) as { kind: string }[];
  const rates = active.length ? readingRates(at, id).get(id) : undefined;
  const exhaustion = (used: number | null, window: 'five' | 'week') => {
    const prices = active.map(run => rates?.mix[run.kind]?.[window] ?? rates?.[window] ?? null);
    if (used === null) return null;
    if (used >= 1) return at;
    if (prices.some(price => price === null)) return null;
    const rate = prices.reduce<number>((sum, price) => sum + price!, 0);
    return rate > 0 ? at + ((1 - used) / rate) * HOUR_MS : null;
  };
  return { week: exhaustion(seat.week, 'week'), five_hour: exhaustion(seat.five_hour, 'five') };
}

export type Measurement = { fiveHours: number; weekHours: number; fiveIntervals: number; weekIntervals: number };
export type FillRates = {
  week: Map<string, number | null>;
  five: Map<string, number | null>;
  measurements: Map<string, Measurement>;
  mix: Map<string, Record<string, MixRate>>;
};
export function fillRates(at = Date.now()): Map<string, FillRates> {
  const seats = seatRows(),
    prices = readingRates(at);
  return new Map(
    [...new Set(seats.map(s => s.engine))].map(engine => {
      const own = seats.filter(s => s.engine === engine);
      return [
        engine,
        {
          week: new Map(own.map(s => [s.id, prices.get(s.id)?.week ?? null])),
          five: new Map(own.map(s => [s.id, prices.get(s.id)?.five ?? null])),
          mix: new Map(own.map(s => [s.id, prices.get(s.id)?.mix ?? {}])),
          measurements: new Map(
            own.flatMap(s => {
              const price = prices.get(s.id);
              return price ? [[s.id, price.measurement] as const] : [];
            }),
          ),
        },
      ];
    }),
  );
}

// ---- usage gained per agent hour

// Each seat's usage gain between two readings, over the run hours between them. Two weeks of readings, one a minute, are
// priced once each (`priced`): an interval is kept once a later reading follows it (a minute's reading is rewritten
// until the minute ends) and every run that overlaps it has ended (an open run ends now, or at its last heartbeat once
// its worker is lost). A read prices only the readings after the kept ones.
type Totals = Measurement & { five: number; week: number };
// (covers: the time from which a seat's kept intervals are all there)
type Kept = { last: Reading; intervals: Interval[]; covers: number };
type Priced = Map<string, Kept>;
const priced: Priced = new Map();
let pricedAt = 0,
  seenRun = 0,
  seenReading = 0;

function readingRates(at: number, seat?: string) {
  forgetMoved();
  // (a read for a time before the last one keeps nothing: a play in turns, its time taken before another read's)
  const current = at >= pricedAt,
    since = at - 2 * WEEK_MS,
    totals = new Map<string, Totals>(),
    mixes = new Map<string, Record<string, MixRate>>();
  pricedAt = Math.max(pricedAt, at);
  for (const id of seat === undefined ? seatRows().map(s => s.id) : [seat]) {
    const intervals = seatIntervals(id, at, since, current);
    mixes.set(id, mixRates(intervals, id));
    for (const interval of intervals) {
      if (!interval.hours) continue;
      const total = totals.get(id) ?? {
        five: 0,
        fiveHours: 0,
        week: 0,
        weekHours: 0,
        fiveIntervals: 0,
        weekIntervals: 0,
      };
      total.five += interval.five;
      total.fiveHours += interval.fiveHours;
      total.week += interval.week;
      total.weekHours += interval.weekHours;
      if (interval.fiveHours > 0) total.fiveIntervals++;
      if (interval.weekHours > 0) total.weekIntervals++;
      totals.set(id, total);
    }
  }
  return measuredRates(totals, mixes);
}

// The server's start (forecast.ts start): the readings priced ahead of the first read, AHEAD_MS of them at a time with a
// turn of the event loop between, so the first play after a restart doesn't price two weeks at once (a third of a second,
// held). The kept intervals come out as one read's. A read meanwhile prices the rest itself, and this stops there.
// Then each seat's work mix is fitted (workmix.ts mixRates), a seat a turn: the first fit reads every interval's kinds,
// all seats' at once in the first play's seats-and-capacity part otherwise (0.35 s at 26,000 jobs and 7 seats with a
// reading a minute; 0.6-1.0 s live, under a deploy's load).
const AHEAD_MS = 6 * HOUR_MS;
export async function priceAhead(now = Date.now()) {
  for (let at = now - 2 * WEEK_MS + AHEAD_MS; at > pricedAt; at = Math.min(at + AHEAD_MS, now)) {
    forgetMoved();
    pricedAt = at;
    for (const { id } of seatRows()) seatIntervals(id, at, at - 2 * WEEK_MS, true);
    if (at === now) return fitAhead(now);
    await new Promise(setImmediate);
  }
}
async function fitAhead(now: number) {
  for (const { id } of seatRows()) {
    await new Promise(setImmediate);
    // (a read since fitted them itself, for its later time)
    if (pricedAt > now) return;
    mixRates(seatIntervals(id, now, now - 2 * WEEK_MS, true), id);
  }
}

// A run or reading written with a time before a seat's kept ones (a test's, or a clock set back) prices that seat again.
// With none kept (the server's start) none can move: the rows written so far are passed by their last id, never read (all
// two weeks' readings, a fifth of a second).
function forgetMoved() {
  if (!priced.size) {
    seenRun = (db.prepare('select max(id) id from runs').get() as { id: number | null }).id ?? 0;
    seenReading = lastWindowReadingId();
    return;
  }
  const runs = db.prepare('select id, seat, started from runs where id > ?').all(seenRun) as RunRow[];
  const readings = changedWindowReadings(seenReading);
  const moved = (seat: string | null, written: number) => {
    for (const quota of ['five', 'week']) {
      const key = `${seat}:${quota}`,
        kept = priced.get(key);
      if (kept && written <= kept.last.at) priced.delete(key);
    }
  };
  for (const run of runs) {
    seenRun = Math.max(seenRun, run.id);
    moved(run.seat, Date.parse(run.started));
  }
  for (const reading of readings) {
    seenReading = Math.max(seenReading, reading.id);
    moved(reading.seat, reading.at);
  }
}

// A seat's priced intervals since `since`: the kept ones, then those after them priced now (and kept, for a current
// read).
function seatIntervals(seat: string, at: number, since: number, current: boolean) {
  return ['five', 'week'].flatMap(quota => windowIntervals(seat, quota as 'five' | 'week', at, since, current));
}

// The kept intervals reach an hour past the window (priced from then, kept until then), so a read for a time a little
// before the last still finds its window's start among them (keptBy) rather than pricing two weeks again (a triage
// projection: a play for a time just before the last read).
const SLACK_MS = HOUR_MS;
function windowIntervals(seat: string, quota: 'five' | 'week', at: number, since: number, current: boolean) {
  const key = `${seat}:${quota}`,
    stored = priced.get(key);
  if (current && stored) {
    while (stored.intervals.length && stored.intervals[0].from < since - SLACK_MS) stored.intervals.shift();
    stored.covers = Math.max(stored.covers, since - SLACK_MS);
  }
  const kept = current ? stored : undefined,
    earlier = current || !stored ? undefined : keptBy(stored, at, since);
  const readings = readingsAfter(seat, quota, pricedAfter(since, current, kept, earlier), at);
  const runs = readings.length ? runsAfter(seat, (kept?.last ?? readings[0]).at, at) : [];
  const millisecondsAt = runMilliseconds(runs, at),
    openSince = Math.min(...runs.flatMap(run => (run.ended === null ? [run.started] : []))),
    intervals = kept?.intervals ?? earlier?.intervals ?? [],
    fresh: Interval[] = [];
  let before = kept?.last,
    beforeMs = before ? millisecondsAt(before.at) : {},
    last = kept?.last,
    keeping = current;
  readings.forEach((reading, i) => {
    const ms = millisecondsAt(reading.at);
    keeping &&= i < readings.length - 1 && reading.at <= openSince;
    if (before) {
      const mix = Object.fromEntries(
        Object.entries(ms).map(([kind, elapsed]) => [kind, (elapsed - (beforeMs[kind] ?? 0)) / HOUR_MS]),
      );
      (keeping ? intervals : fresh).push(pricedInterval(before, reading, mix));
    }
    if (keeping) last = reading;
    [before, beforeMs] = [reading, ms];
  });
  if (current && last) priced.set(key, { last, intervals, covers: stored?.covers ?? since - SLACK_MS });
  return [...intervals, ...fresh].filter(interval => interval.from >= since);
}

// The time a read prices the readings after: the end of a current read's kept intervals, or of an earlier read's borrowed
// ones, or with none the window's start (an hour early for a current read, which keeps that hour too).
function pricedAfter(since: number, current: boolean, kept?: Kept, earlier?: { from: number }) {
  if (kept) return kept.last.at;
  if (earlier) return earlier.from - 1;
  return (current ? since - SLACK_MS : since) - 1;
}

// What a read for an earlier time takes of a seat's kept intervals: those ended and reported by then, and the time of
// the reading the last of them ends on, which its own pricing starts from. None once they no longer reach back to its
// window's start, or none ended by then: it prices on its own.
function keptBy(stored: Kept, at: number, since: number) {
  const { intervals, last } = stored;
  if (stored.covers > since) return undefined;
  const endOf = (i: number) => (i + 1 < intervals.length ? intervals[i + 1].from : last.at);
  let count = 0;
  while (count < intervals.length && endOf(count) <= at && intervals[count].known <= at) count++;
  const from = count ? endOf(count - 1) : (intervals[0]?.from ?? last.at);
  return from <= at ? { from, intervals: intervals.slice(0, count) } : undefined;
}

const readingsAfter = (seat: string, quota: 'five' | 'week', after: number, at: number): Reading[] =>
  windowReadings(seat, quota, after, at).map(reading => ({
    seat,
    at: reading.at,
    reported: reading.reported,
    util: quota === 'five' ? reading.used : null,
    resets: quota === 'five' ? reading.resets : null,
    week: quota === 'week' ? reading.used : null,
    week_resets: quota === 'week' ? reading.resets : null,
  }));

type RunRow = { id: number; seat: string | null; started: string };
const runsAfter = (seat: string, after: number, at: number) =>
  (
    db
      // (runs_ended reads only the runs open or ended since, where the seat's index reads all it ever had)
      .prepare(
        `select r.started, r.ended, j.kind from runs r indexed by runs_ended join jobs j on j.id = r.job
        where (r.ended is null or r.ended > ?) and r.seat = ? and r.started < ?`,
      )
      .all(iso(after), seat, iso(at)) as { started: string; ended: string | null; kind: string }[]
  ).map(run => ({
    kind: run.kind,
    started: Date.parse(run.started),
    ended: run.ended === null ? null : Date.parse(run.ended),
  }));

function measuredRates(totals: Map<string, Totals>, mixes: Map<string, Record<string, MixRate>>) {
  return new Map(
    [...totals].map(([seat, total]) => [
      seat,
      {
        mix: mixes.get(seat) ?? {},
        five: total.fiveHours > 0 ? total.five / total.fiveHours : null,
        measurement: {
          fiveHours: total.fiveHours,
          weekHours: total.weekHours,
          fiveIntervals: total.fiveIntervals,
          weekIntervals: total.weekIntervals,
        },
        week: total.weekHours > 0 ? total.week / total.weekHours : null,
      },
    ]),
  );
}
