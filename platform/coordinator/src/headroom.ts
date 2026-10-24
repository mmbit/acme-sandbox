// Seat headroom and per-seat usage gained per agent-hour, measured between worker readings.
import { db } from './db.ts';

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
type Reading = {
  seat: string;
  at: number;
  util: number | null;
  resets: number | null;
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

// A minute is the worker's reporting cadence. Two weekly windows keep observations on both sides of a reset.
db.exec(`create table if not exists seat_readings (seat text not null, minute integer not null,
  at integer not null, util real, resets integer, week real, week_resets integer, primary key (seat, minute))`);
db.exec('create index if not exists seat_readings_at on seat_readings (seat, at)');
db.exec(`insert or ignore into seat_readings (seat, minute, at, util, resets, week, week_resets)
  select id, updated / 60000, updated, util, resets, week, week_resets from seats
  where updated is not null and (util is not null or week is not null)`);

export function recordSeatReading(seat: string) {
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
  const seats = seatRows().map(seat => ({
    ...seat,
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
  const active = (db.prepare('select count(*) n from runs where seat = ? and ended is null').get(id) as { n: number })
    .n;
  const rates = active ? readingRates(at, id).get(id) : undefined;
  const exhaustion = (used: number | null, rate: number | null | undefined) =>
    used === null ? null : used >= 1 ? at : rate && active ? at + ((1 - used) / (rate * active)) * HOUR_MS : null;
  return { week: exhaustion(seat.week, rates?.week), five_hour: exhaustion(seat.five_hour, rates?.five) };
}

export type Measurement = { fiveHours: number; weekHours: number; fiveIntervals: number; weekIntervals: number };
export type FillRates = {
  week: Map<string, number | null>;
  five: Map<string, number | null>;
  measurements: Map<string, Measurement>;
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
type Interval = { from: number; hours: number; five: number; fiveHours: number; week: number; weekHours: number };
type Totals = Measurement & { five: number; week: number };
type Priced = Map<string, { last: Reading; intervals: Interval[] }>;
const priced: Priced = new Map();
let pricedAt = 0,
  seenRun = 0,
  seenReading = 0;

function readingRates(at: number, seat?: string) {
  forgetMoved();
  // (a read for a time before the last one prices on its own, leaving the kept intervals as they are)
  const book = at < pricedAt ? new Map() : priced,
    since = at - 2 * WEEK_MS,
    totals = new Map<string, Totals>();
  pricedAt = Math.max(pricedAt, at);
  for (const id of seat === undefined ? seatRows().map(s => s.id) : [seat])
    for (const interval of seatIntervals(book, id, at, since)) {
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
  return measuredRates(totals);
}

// The server's start (forecast.ts start): the readings priced ahead of the first read, AHEAD_MS of them at a time with a
// turn of the event loop between, so the first play after a restart doesn't price two weeks at once (a third of a second,
// held). The kept intervals come out as one read's. A read meanwhile prices the rest itself, and this stops there.
const AHEAD_MS = 6 * HOUR_MS;
export async function priceAhead(now = Date.now()) {
  for (let at = now - 2 * WEEK_MS + AHEAD_MS; at > pricedAt; at = Math.min(at + AHEAD_MS, now)) {
    forgetMoved();
    pricedAt = at;
    for (const { id } of seatRows()) seatIntervals(priced, id, at, at - 2 * WEEK_MS);
    if (at === now) return;
    await new Promise(setImmediate);
  }
}

// A run or reading written with a time before a seat's kept ones (a test's, or a clock set back) prices that seat again.
// With none kept (the server's start) none can move: the rows written so far are passed by their last id, never read (all
// two weeks' readings, a fifth of a second).
function forgetMoved() {
  if (!priced.size) {
    seenRun = (db.prepare('select max(id) id from runs').get() as { id: number | null }).id ?? 0;
    seenReading = (db.prepare('select max(rowid) id from seat_readings').get() as { id: number | null }).id ?? 0;
    return;
  }
  const runs = db.prepare('select id, seat, started from runs where id > ?').all(seenRun) as RunRow[];
  const readings = db.prepare('select rowid id, seat, at from seat_readings where rowid > ?').all(seenReading) as {
    id: number;
    seat: string;
    at: number;
  }[];
  const moved = (seat: string | null, written: number) => {
    const kept = seat === null ? undefined : priced.get(seat);
    if (kept && written < kept.last.at) priced.delete(seat!);
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

// A seat's priced intervals since `since`: the kept ones, then those after them priced now.
function seatIntervals(priced: Priced, seat: string, at: number, since: number) {
  const kept = priced.get(seat);
  while (kept?.intervals.length && kept.intervals[0].from < since) kept.intervals.shift();
  const readings = readingsAfter(seat, kept ? kept.last.at : since - 1, at);
  const runs = readings.length ? runsAfter(seat, (kept?.last ?? readings[0]).at, at) : [];
  const millisecondsAt = runMilliseconds(runs, at),
    openSince = Math.min(...runs.flatMap(run => (run.ended === null ? [run.started] : []))),
    fresh: Interval[] = [];
  let before = kept?.last,
    beforeMs = before ? millisecondsAt(before.at) : 0,
    keeping = true;
  readings.forEach((reading, i) => {
    const ms = millisecondsAt(reading.at);
    keeping &&= i < readings.length - 1 && reading.at <= openSince;
    if (before) {
      const interval = pricedInterval(before, reading, (ms - beforeMs) / HOUR_MS);
      if (keeping) priced.get(seat)!.intervals.push(interval);
      else fresh.push(interval);
    }
    if (keeping) priced.set(seat, { last: reading, intervals: priced.get(seat)?.intervals ?? [] });
    [before, beforeMs] = [reading, ms];
  });
  return [...(priced.get(seat)?.intervals ?? []), ...fresh].filter(interval => interval.from >= since);
}

const readingsAfter = (seat: string, after: number, at: number) =>
  db
    .prepare('select * from seat_readings where seat = ? and at > ? and at <= ? order by at')
    .all(seat, after, at) as Reading[];

type RunRow = { id: number; seat: string | null; started: string };
type Run = { started: number; ended: number | null };
const runsAfter = (seat: string, after: number, at: number) =>
  (
    db
      // (runs_ended reads only the runs open or ended since, where the seat's index reads all it ever had)
      .prepare(
        `select started, ended from runs indexed by runs_ended
        where (ended is null or ended > ?) and seat = ? and started < ?`,
      )
      .all(iso(after), seat, iso(at)) as { started: string; ended: string | null }[]
  ).map(run => ({ started: Date.parse(run.started), ended: run.ended === null ? null : Date.parse(run.ended) }));

// The run time a seat has worked up to each time asked, in ms, the times asked in order: one sweep over its runs' starts
// and ends, an open run's end `at`.
function runMilliseconds(runs: Run[], at: number) {
  const events = runs
    .flatMap(run => [
      { at: run.started, change: 1 },
      { at: run.ended ?? at, change: -1 },
    ])
    .sort((a, b) => a.at - b.at);
  let index = 0,
    active = 0,
    total = 0,
    previous = 0;
  return (to: number) => {
    while (index < events.length && events[index].at <= to) {
      const event = events[index++];
      total += active * (event.at - previous);
      active += event.change;
      previous = event.at;
    }
    total += active * (to - previous);
    previous = to;
    return total;
  };
}

// The usage gained between two readings, per window, counted only where both readings have it and no reset falls between.
function pricedInterval(before: Reading, reading: Reading, hours: number): Interval {
  const gained = (used: 'util' | 'week', reset: 'resets' | 'week_resets') => {
    const gain = reading[used] !== null && before[used] !== null ? reading[used] - before[used] : null;
    const counted =
      gain !== null &&
      gain >= 0 &&
      reading[reset] === before[reset] &&
      !(before[reset] !== null && before[reset] <= reading.at);
    return counted ? [gain, hours] : [0, 0];
  };
  const [five, fiveHours] = gained('util', 'resets'),
    [week, weekHours] = gained('week', 'week_resets');
  return { from: before.at, hours, five, fiveHours, week, weekHours };
}

function measuredRates(totals: Map<string, Totals>) {
  return new Map(
    [...totals].map(([seat, total]) => [
      seat,
      {
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
