// Seat-week meter gains apportioned by overlapping run time, retained beyond meter history.
import { db, inOneStep } from './db.ts';

db.exec(`create table if not exists seat_cost_intervals (
  seat text not null, start integer not null, end integer not null, week real not null,
  primary key (seat, end));
create table if not exists seat_cost_jobs (
  seat text not null, end integer not null, job integer not null, week real not null, milliseconds real not null,
  primary key (seat, end, job));
create index if not exists seat_cost_jobs_job on seat_cost_jobs(job)`);

type Reading = { at: number; used: number; resets: number | null };
export function recordSeatCost(seat: string, at?: number | null) {
  if (at === null) return;
  at ??= (db.prepare('select updated from seats where id = ?').get(seat) as { updated: number }).updated;
  const before = db
    .prepare(
      `select distinct at from seat_window_observations
    where seat = ? and quota = 'week' and at <= ? order by at desc limit 2`,
    )
    .all(seat, at) as { at: number }[];
  const after = db
    .prepare(
      `select min(at) at from seat_window_observations
    where seat = ? and quota = 'week' and at > ?`,
    )
    .get(seat, at) as { at: number | null };
  const reading = (instant: number) =>
    db
      .prepare(
        `select at, used, resets from seat_window_observations
    where seat = ? and quota = 'week' and at = ? order by reported_at desc, rowid desc limit 1`,
      )
      .get(seat, instant) as Reading;
  if (before.length === 2) priceInterval(seat, reading(before[1].at), reading(before[0].at));
  if (after.at !== null && before.length) priceInterval(seat, reading(before[0].at), reading(after.at));
}

function priceInterval(seat: string, start: Reading, end: Reading) {
  const gain = end.used - start.used;
  if (gain < 0 || start.resets === null || end.resets !== start.resets || start.resets <= end.at) {
    inOneStep(() => {
      db.prepare('delete from seat_cost_jobs where seat = ? and end = ?').run(seat, end.at);
      db.prepare('delete from seat_cost_intervals where seat = ? and end = ?').run(seat, end.at);
    });
    return;
  }
  const runs = db
    .prepare(
      `select job, started, ended from runs where seat = ? and started < ?
    and (ended is null or ended > ?)`,
    )
    .all(seat, new Date(end.at).toISOString(), new Date(start.at).toISOString()) as {
    job: number;
    started: string;
    ended: string | null;
  }[];
  const milliseconds = new Map<number, number>();
  for (const run of runs) {
    const elapsed = Math.max(
      0,
      Math.min(end.at, run.ended ? Date.parse(run.ended) : end.at) - Math.max(start.at, Date.parse(run.started)),
    );
    milliseconds.set(run.job, (milliseconds.get(run.job) ?? 0) + elapsed);
  }
  const total = [...milliseconds.values()].reduce((sum, elapsed) => sum + elapsed, 0);
  writeInterval(seat, start, end, gain, milliseconds, total);
}

function writeInterval(
  seat: string,
  start: Reading,
  end: Reading,
  gain: number,
  milliseconds: Map<number, number>,
  total: number,
) {
  inOneStep(() => {
    db.prepare(
      `insert into seat_cost_intervals values (?, ?, ?, ?)
      on conflict(seat, end) do update set start = excluded.start, week = excluded.week`,
    ).run(seat, start.at, end.at, gain);
    db.prepare('delete from seat_cost_jobs where seat = ? and end = ?').run(seat, end.at);
    if (!total) return;
    for (const [job, elapsed] of milliseconds)
      db.prepare('insert into seat_cost_jobs values (?, ?, ?, ?, ?)').run(
        seat,
        end.at,
        job,
        (gain * elapsed) / total,
        elapsed,
      );
  });
}
