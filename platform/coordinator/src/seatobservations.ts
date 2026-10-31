// Seat-window readings retain their observation time when a later report omits usage.
import { db } from './db.ts';
import { fallingBackTo } from './models.ts';
import type { SeatNow, UsageSource } from './eta.ts';

type Window = { used: number | null; reset: number | null; observedAt: number | null; source: UsageSource };
type Reported = {
  id: string;
  updated: number | null;
  util: number | null;
  resets: number | null;
  week: number | null;
  week_resets: number | null;
};
export type ObservationTimes = { fiveHourObservedAt?: number | null; weekObservedAt?: number | null };

export function recordWindowObservations(seat: string, times: ObservationTimes = {}) {
  const row = db
    .prepare('select id, updated, util, resets, week, week_resets from seats where id = ?')
    .get(seat) as Reported;
  const write = db.prepare(`insert into seat_window_observations (seat, quota, at, reported_at, used, resets)
    values (?, ?, ?, ?, ?, ?)`);
  const previous = db.prepare(`select used, resets from seat_window_observations
    where seat = ? and quota = ? and at = ? order by reported_at desc, rowid desc limit 1`);
  for (const [quota, usage, reset, observedAt] of [
    ['five', row.util, row.resets, times.fiveHourObservedAt],
    ['week', row.week, row.week_resets, times.weekObservedAt],
  ] as const) {
    const at = observedAt === undefined ? row.updated : observedAt;
    if (usage !== null && at !== null && Number.isFinite(at) && at <= row.updated!) {
      const prior = previous.get(seat, quota, at) as { used: number; resets: number | null } | undefined;
      if (prior?.used === usage && prior.resets === reset) continue;
      write.run(seat, quota, at, row.updated, usage, reset);
    }
  }
  db.prepare('delete from seat_window_observations where seat = ? and at < ?').run(seat, Date.now() - 14 * 86_400_000);
}

// A seat without a configured stop uses seats.ts STOP_DEFAULT. Credits bypass quota stops in playseats.ts.
// Weekly pacing still applies, as in the worker. Each with the CLI it runs and the agents whose fallback runs on it, as
// claim reads them (jobs.ts claimable).
export function observedSeats(now: number, stopDefault: number): SeatNow[] {
  const rows = db
    .prepare(
      `select s.id, s.engine, coalesce(s.cli, s.engine) cli, s.state, s.until, s.updated, s.util, s.resets, s.week,
      s.week_resets,
      s.credits, l.stop from seats s left join seat_list l on l.id = s.id order by s.id`,
    )
    .all() as {
    id: string;
    engine: string;
    cli: string;
    state: string;
    until: number | null;
    updated: number | null;
    util: number | null;
    resets: number | null;
    week: number | null;
    week_resets: number | null;
    credits: number | null;
    stop: number | null;
  }[];
  return rows.map(s => {
    const windows = observedWindows(s, now);
    return {
      ...{ id: s.id, engine: s.engine, cli: s.cli, fallbacks: fallingBackTo(s.engine, s.cli) },
      ...{ state: s.state, until: s.until },
      fiveHour: windows.fiveHour.used,
      fiveHourResets: windows.fiveHour.reset,
      fiveHourObservedAt: windows.fiveHour.observedAt,
      fiveHourSource: windows.fiveHour.source,
      week: windows.week.used,
      weekResets: windows.week.reset,
      weekObservedAt: windows.week.observedAt,
      weekSource: windows.week.source,
      latestReportedAt: s.updated !== null && s.updated <= now ? s.updated : null,
      stop: (s.stop ?? stopDefault) / 100,
      credits: s.credits === 1,
    };
  });
}

function observedWindows(seat: Reported, now: number) {
  return {
    fiveHour: observation(seat, now, 'five', 'resets'),
    week: observation(seat, now, 'week', 'week_resets'),
  };
}

function observation(seat: Reported, now: number, quota: 'five' | 'week', reset: 'resets' | 'week_resets'): Window {
  const prior = db
    .prepare(
      `select used, resets, at from seat_window_observations
    where seat = ? and quota = ? and at <= ? and reported_at <= ? order by at desc, reported_at desc, rowid desc limit 1`,
    )
    .get(seat.id, quota, now, now) as { used: number; resets: number | null; at: number } | undefined;
  const currentReset = seat.updated !== null && seat.updated <= now ? seat[reset] : (prior?.resets ?? null);
  if (!prior) return { used: null, reset: currentReset, observedAt: null, source: 'unknown' };
  if (
    (prior.resets !== null && prior.resets <= now) ||
    (currentReset !== null && prior.resets !== null && currentReset !== prior.resets)
  ) {
    return { used: null, reset: currentReset, observedAt: prior.at, source: 'unknown' };
  }
  const currentUsage = quota === 'five' ? seat.util : seat.week;
  const reported = currentUsage !== null && prior.at === seat.updated;
  return {
    used: prior.used,
    reset: prior.resets ?? currentReset,
    observedAt: prior.at,
    source: reported ? 'reported' : 'prior',
  };
}

export function lastWindowReadingId() {
  return (db.prepare('select max(rowid) id from seat_window_observations').get() as { id: number | null }).id ?? 0;
}

export function changedWindowReadings(after: number) {
  return db.prepare('select rowid id, seat, at from seat_window_observations where rowid > ?').all(after) as {
    id: number;
    seat: string;
    at: number;
  }[];
}

export function windowReadings(seat: string, quota: 'five' | 'week', after: number, at: number) {
  return db
    .prepare(
      `select at, used, resets from (
        select at, used, resets, row_number() over (partition by at order by reported_at desc, rowid desc) revision
        from seat_window_observations where seat = ? and quota = ? and at > ? and at <= ? and reported_at <= ?
      ) where revision = 1 order by at`,
    )
    .all(seat, quota, after, at, at) as { at: number; used: number; resets: number | null }[];
}
