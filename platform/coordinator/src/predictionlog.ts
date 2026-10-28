// The prediction log: each open work job's predicted start and merge, and each thread's ETA, with the size the play
// used, who gave that size and the play's version, as the forecast (forecast.ts) plays them. A row is written only when
// a prediction moves by MOVE_MS or more from its last row, or the play's version changes, so the log holds each
// prediction's history and little else. What happened is read from HQ's own records (landings.ts), never copied here.
// hq estimate --calibration sets the rows against it.
import { db, inOneStep, onUndo, prepared } from './db.ts';
import * as forecast from './forecast.ts';
import { heldTo } from './predictions.ts';
import type { Forecast } from './forecast.ts';

// job or thread: one of them. start: a job's, while it hasn't started (a thread has none). merged: a job's merge, a
// thread's ETA. held: the time a promise holds to (predictions.heldTo). agent_ms: a job's size, a thread's agent time
// left. sized_by: who gave a job's size ('haiku', 'tool' or an agent).
db.exec(`create table if not exists prediction_log (id integer primary key, at integer not null, job integer,
  thread text, start integer, merged integer, held integer, agent_ms integer, sized_by text,
  version integer not null);
  --.
  drop index if exists prediction_log_job;
  create index if not exists prediction_log_job_at on prediction_log (job, at);
  drop index if exists prediction_log_thread;
  create index if not exists prediction_log_thread_at on prediction_log (thread, at)`);

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

// The last row of each job and thread the plays have had, read from the log the first time it shows up (LAST_ROW).
// null: the log has none.
const last = new Map<string, LogRow | null>();

// The rows the plays logged since the last write.
let unwritten: LogRow[] = [];

forecast.afterEach(record);

// A play's predictions, each kept where it moved from its last row (or has none yet), for the next write.
export function record(f: Forecast) {
  const rows = [...jobRows(f), ...threadRows(f)].filter(row => {
    const before = lastOf(row);
    return !before || moved(before, row);
  });
  unwritten.push(...rows);
  for (const row of rows) last.set(keyOf(row), row);
}

// The rows kept since the last write, written together: every minute and at the server's stop (server.ts), and before
// anything reads the log. Not after each play: its commit waits for any outside reader of hq.db (infra/report.sh), up
// to db.ts's 1.5 s. They leave the kept ones as they're written, so a second write in the same transaction (regroup.ts,
// then a read) doesn't insert them again, and come back if it's rolled back, its failed commit too, for the next.
export function write() {
  if (!unwritten.length) return;
  const rows = unwritten;
  unwritten = [];
  const insert = db.prepare(`insert into prediction_log (at, job, thread, start, merged, held, agent_ms,
    sized_by, version) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  inOneStep(() => {
    onUndo(() => (unwritten = [...rows, ...unwritten]));
    for (const r of rows)
      insert.run(r.at, r.job, r.thread, r.start, r.merged, r.held, r.agent_ms, r.sized_by, r.version);
  });
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

// A job's and a thread's last row: its latest `at`, one seek on prediction_log_job_at or prediction_log_thread_at,
// never a sort of its rows.
export const LAST_ROW = {
  thread: 'select * from prediction_log where thread = ? order by at desc, id desc limit 1',
  job: 'select * from prediction_log where job = ? order by at desc, id desc limit 1',
};

function lastOf(row: LogRow) {
  const key = keyOf(row);
  if (!last.has(key)) {
    const before = row.job === null ? prepared(LAST_ROW.thread).get(row.thread) : prepared(LAST_ROW.job).get(row.job);
    last.set(key, (before as LogRow | undefined) ?? null);
  }
  return last.get(key);
}

// A job's prediction as the log had it at `at`: its latest row by then, or undefined when the log has nothing that old.
// One seek on prediction_log_job_at: hq estimate --calibration reads it per landing and lead.
export function jobAt(job: number, at: number) {
  write();
  return prepared(
    'select merged, held from prediction_log where job = ? and at <= ? order by at desc, id desc limit 1',
  ).get(job, at) as Pick<LogRow, 'merged' | 'held'> | undefined;
}

// A thread's ETA as the log had it at `at`: its latest row by then (merged null: no merge in sight then), or undefined
// when the log has nothing that old (deadlines.ts).
// One seek on prediction_log_thread_at: hq when reads it per window and trial.
export function threadAt(thread: string, at: number) {
  write();
  return db
    .prepare('select merged from prediction_log where thread = ? and at <= ? order by at desc, id desc limit 1')
    .get(thread, at) as { merged: number | null } | undefined;
}
