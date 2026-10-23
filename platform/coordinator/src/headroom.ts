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

export type FillRates = { week: Map<string, number | null>; five: Map<string, number | null> };
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
        },
      ];
    }),
  );
}

function readingRates(at: number, seat?: string) {
  const readings = readHistory(at, seat);
  const runs = runHistory(at, seat);
  return historyRates(at, readings, runs);
}

function readHistory(at: number, seat?: string) {
  return db
    .prepare(
      `select * from seat_readings where ${seat === undefined ? '' : 'seat = ? and '}at >= ? and at <= ? order by seat, at`,
    )
    .all(...(seat === undefined ? [] : [seat]), at - 2 * WEEK_MS, at) as Reading[];
}

type Run = { seat: string; started: string; ended: string | null };
function runHistory(at: number, seat?: string) {
  return db
    .prepare(
      `select seat, started, ended from runs
    where ${seat === undefined ? '' : 'seat = ? and '}started < ? and (ended is null or ended > ?)`,
    )
    .all(...(seat === undefined ? [] : [seat]), iso(at), iso(at - 2 * WEEK_MS)) as Run[];
}

function historyRates(at: number, readings: Reading[], runs: Run[]) {
  const events = new Map<string, { at: number; change: number }[]>();
  for (const run of runs) {
    let own = events.get(run.seat);
    if (!own) events.set(run.seat, (own = []));
    own.push(
      { at: Date.parse(run.started), change: 1 },
      { at: run.ended === null ? at : Date.parse(run.ended), change: -1 },
    );
  }
  const hoursAt = new Map([...events].map(([seat, own]) => [seat, runHours(own)]));
  const previous = new Map<string, Reading & { hours: number }>(),
    totals = new Map<string, { five: number; fiveHours: number; week: number; weekHours: number }>();
  for (const reading of readings) {
    const before = previous.get(reading.seat);
    const elapsed = hoursAt.get(reading.seat)?.(reading.at) ?? 0;
    previous.set(reading.seat, { ...reading, hours: elapsed });
    if (!before) continue;
    const hours = elapsed - before.hours;
    if (!hours) continue;
    const total = totals.get(reading.seat) ?? { five: 0, fiveHours: 0, week: 0, weekHours: 0 };
    for (const [used, reset, amount, duration] of [
      ['util', 'resets', 'five', 'fiveHours'],
      ['week', 'week_resets', 'week', 'weekHours'],
    ] as const) {
      const gain = reading[used] !== null && before[used] !== null ? reading[used]! - before[used]! : null;
      if (
        gain === null ||
        gain < 0 ||
        reading[reset] !== before[reset] ||
        (before[reset] !== null && before[reset]! <= reading.at)
      )
        continue;
      total[amount] += gain;
      total[duration] += hours;
    }
    totals.set(reading.seat, total);
  }
  return measuredRates(totals);
}

function runHours(events: { at: number; change: number }[]) {
  events.sort((a, b) => a.at - b.at);
  let index = 0,
    active = 0,
    total = 0,
    previous = events[0].at;
  return (at: number) => {
    while (index < events.length && events[index].at <= at) {
      const event = events[index++];
      total += active * (event.at - previous);
      active += event.change;
      previous = event.at;
    }
    total += active * (at - previous);
    previous = at;
    return total / HOUR_MS;
  };
}

function measuredRates(totals: Map<string, { five: number; fiveHours: number; week: number; weekHours: number }>) {
  return new Map(
    [...totals].map(([seat, total]) => [
      seat,
      {
        five: total.fiveHours > 0 ? total.five / total.fiveHours : null,
        week: total.weekHours > 0 ? total.week / total.weekHours : null,
      },
    ]),
  );
}
