// The prediction log: each open work job's predicted start and merge, and each thread's ETA, with the size the play
// used, who gave that size and the play's version, as the forecast (forecast.ts) plays them. A row is written only when
// a prediction moves by MOVE_MS or more from its last row, or the play's version changes, so the log holds each
// prediction's history and little else. What happened is read from HQ's own records (landings.ts), never copied here.
// hq estimate --calibration sets the rows against it.
import { db, inOneStep, prepared } from './db.ts';
import * as forecast from './forecast.ts';
import { heldTo } from './predictions.ts';
import type { Forecast } from './forecast.ts';

// job or thread: one of them. start: a job's, while it hasn't started (a thread has none). merged: a job's merge, a
// thread's ETA. held: the time a promise holds to (predictions.heldTo). agent_ms: a job's size, a thread's agent time
// left. sized_by: who gave a job's size ('haiku', 'tool' or an agent).
db.exec(`create table if not exists prediction_log (id integer primary key, at integer not null, job integer,
  thread text, start integer, merged integer, held integer, agent_ms integer, sized_by text,
  version integer not null);
  create index if not exists prediction_log_job on prediction_log (job);
  create index if not exists prediction_log_thread on prediction_log (thread)`);

export type LogRow = {
  at: number;
  job: number | null;
  thread: string | null;
  start: number | null;
  merged: number | null;
  held: number | null;
  agent_ms: number | null;
  sized_by: string | null;
  version: number;
};

export const MOVE_MS = 5 * 60_000;

// The last row of each job and thread the plays have had, read from the log the first time it shows up: by its index,
// never the whole log. null: the log has none.
const last = new Map<string, LogRow | null>();

forecast.afterEach(record);

// A play's predictions, each written where it moved from its last row (or has none yet).
export function record(f: Forecast) {
  const rows = [...jobRows(f), ...threadRows(f)].filter(row => {
    const before = lastOf(row);
    return !before || moved(before, row);
  });
  if (!rows.length) return;
  const insert = db.prepare(`insert into prediction_log (at, job, thread, start, merged, held, agent_ms,
    sized_by, version) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  inOneStep(() => {
    for (const r of rows)
      insert.run(r.at, r.job, r.thread, r.start, r.merged, r.held, r.agent_ms, r.sized_by, r.version);
  });
  for (const row of rows) last.set(keyOf(row), row);
}

// A job's start counts only while it waits: once running or done its start is a fact, not a prediction.
function jobRows(f: Forecast): LogRow[] {
  const statusOf = new Map(f.snapshot.jobs.map(j => [j.id, j.status]));
  return [...f.usual].flatMap(([job, usual]) => {
    if (job < 0) return [];
    const started = ['running', 'done'].includes(statusOf.get(job) ?? '');
    const slow = f.slow.get(job);
    const size = f.sizes.usual.get(job);
    return {
      ...{ at: f.now, job, thread: null, start: started ? null : usual.start, merged: usual.merged },
      ...{
        held: slow ? heldTo(usual, slow) : null,
        agent_ms: size?.agent_ms ?? null,
      },
      ...{ sized_by: f.sizedBy.get(job) ?? 'tool', version: f.version },
    };
  });
}

const threadRows = (f: Forecast): LogRow[] =>
  [...f.threads.values()].map(t => ({
    ...{ at: f.now, job: null, thread: t.thread, start: null, merged: t.eta, held: t.held, agent_ms: t.left_ms },
    ...{ sized_by: null, version: f.version },
  }));

// A start or merge that appears, goes, or moves MOVE_MS or more is a move. The time a promise holds to goes with them
// (it moves in five-minute steps, so a few seconds' move could cross one).
function moved(before: LogRow, now: LogRow) {
  const apart = (a: number | null, b: number | null) =>
    (a === null) !== (b === null) || (a !== null && b !== null && Math.abs(a - b) >= MOVE_MS);
  return before.version !== now.version || apart(before.start, now.start) || apart(before.merged, now.merged);
}

const keyOf = (row: { job: number | null; thread: string | null }) =>
  row.job === null ? `thread:${row.thread}` : `job:${row.job}`;

function lastOf(row: LogRow) {
  const key = keyOf(row);
  if (!last.has(key)) {
    const before =
      row.job === null
        ? prepared('select * from prediction_log where thread = ? order by id desc limit 1').get(row.thread)
        : prepared('select * from prediction_log where job = ? order by id desc limit 1').get(row.job);
    last.set(key, (before as LogRow | undefined) ?? null);
  }
  return last.get(key);
}

// Every row of these jobs, each job's oldest first (hq estimate --calibration).
export const ofJobs = (jobs: number[]) =>
  db
    .prepare('select * from prediction_log where job in (select value from json_each(?)) order by job, at, id')
    .all(JSON.stringify(jobs)) as LogRow[];

// A thread's ETA as the log had it at `at`: its latest row by then (merged null: no merge in sight then), or undefined
// when the log has nothing that old (deadlines.ts).
export const threadAt = (thread: string, at: number) =>
  db
    .prepare('select merged from prediction_log where thread = ? and at <= ? order by at desc, id desc limit 1')
    .get(thread, at) as { merged: number | null } | undefined;
