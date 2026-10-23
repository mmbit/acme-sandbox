// Each run of a job from its start to its end, so a job's agent time leaves out its waits (for a seat, a card, a
// deploy): a claim starts one and a finish ends it (jobs.ts).
import { db } from './db.ts';

db.exec(`create table if not exists runs (id integer primary key, job integer not null, seat text, started text not null,
  ended text, ended_as text)`);
db.exec('create index if not exists runs_job on runs (job)');
db.exec('create index if not exists runs_seat_started on runs (seat, started)');
// (the runs of the last day or week, which the queue's play reads each time: backlog.ts, headroom.ts)
db.exec('create index if not exists runs_ended on runs (ended)');

// How a run ended: the worker's outcome as its job finished (jobs.ts finish), lost with its worker, or rebuilt from the
// records from before this table.
// (snagged)
export type RunEnd =
  'done' | 'failed' | 'limited' | 'parked' | 'interrupted' | 'yielded' | 'lost' | 'rebuilt' | 'snagged';

const iso = (ms: number) => new Date(ms).toISOString();

export function runStarted(job: number, seat: string) {
  runEnded(job, 'lost');
  db.prepare('insert into runs (job, seat, started) values (?, ?, ?)').run(job, seat, iso(Date.now()));
}

export function runEnded(job: number, endedAs: RunEnd) {
  db.prepare('update runs set ended = ?, ended_as = ? where job = ? and ended is null').run(
    iso(Date.now()),
    endedAs,
    job,
  );
}

// Runs whose worker went quiet end at its last heartbeat, not when the coordinator notices.
export const runsLost = (quietSince: number) =>
  db
    .prepare(
      `update runs set ended_as = 'lost', ended = strftime('%Y-%m-%dT%H:%M:%fZ', (select heartbeat from jobs
      where jobs.id = runs.job) / 1000.0, 'unixepoch') where ended is null and job in (select id from jobs
      where status = 'running' and heartbeat < ?)`,
    )
    .run(quietSince);
