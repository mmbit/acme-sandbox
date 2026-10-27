// A read of the database whose rows are jobs (`id`), kept between calls. matching.ts's done jobs are one: each new work
// job is sized on them, and so are the minute's sweep, the play (its spot sizes and the sizers' bias) and hq estimate.
// Reading them whole took 0.2 s warm and seconds cold.
// A note is a row of `<name>_changes`: one job whose rows the read takes changed. Triggers write them: on each table the
// read takes columns from, a row added or removed, or one of those columns changed. The pool's `notes` say which jobs a
// row is read into. A note with a null job reads the pool whole again; otherwise only the noted jobs are read again.
// The tables and columns are those SQLite reports the read's statement taking (its authorizer). A table without notes
// is an error. Before every whole read the triggers are made again where their code differs, so a change to the read or
// its notes reaches them before the pool is kept again.
// A pool older than the notes still kept is read whole. A pool read in a step goes once the step is undone. One read in
// any other transaction isn't kept, so a change rolled back never leaves it standing. Callers share the pool: they
// never change it.
// A server's start can read the pool ahead a slice of jobs at a time between its other work (seed), so no call after
// it reads every row at once.
import { constants } from 'node:sqlite';
import { db, inOneStep, inStep, onUndo, prepared } from './db.ts';

// A changed row in its trigger
export type RowAlias = 'new' | 'old';
// For each table the read takes columns from, the jobs a row of it is read into: a select of their ids (null: any job's,
// so the pool is read whole), and for a row just added, if not those.
export type Notes = Record<string, { of: (row: RowAlias) => string; added?: string }>;

// The notes kept: far more than the changes between two reads of a pool (matching.ts's: one at each new job and each
// minute). Past them a pool is read whole, which is right, only slower.
const KEPT_CHANGES = 10_000;

type Change = { id: number; job: number | null };
export function keptPool<T extends { id: number }>(
  name: string,
  sql: () => string,
  read: (only?: number[]) => T[],
  notes: Notes,
) {
  const changes = `${name}_changes`;
  // (autoincrement: a note's number is never given again, even once the notes before it are gone)
  db.exec(`create table if not exists ${changes} (id integer primary key autoincrement, job integer)`);
  const last = () => (prepared(`select max(id) n from ${changes}`).get() as { n: number | null }).n ?? 0;
  // (whether every change after `seen` is still noted)
  const noneLost = (seen: number) =>
    ((prepared(`select min(id) n from ${changes}`).get() as { n: number | null }).n ?? 0) <= seen + 1;
  let kept: { seen: number; pool: T[] } | undefined;
  const keep = (seen: number, pool: T[]) => {
    if (db.isTransaction && !inStep()) return;
    kept = { seen, pool };
    onUndo(() => (kept = undefined));
  };
  const pool = () => {
    const noted = kept
      ? (prepared(`select id, job from ${changes} where id > ? order by id`).all(kept.seen) as Change[])
      : [];
    if (kept && !noted.length) return kept.pool;
    const jobs = new Set(noted.map(c => c.job)),
      partly = kept && !jobs.has(null) && noneLost(kept.seen);
    if (!partly) syncTriggers(name, sql(), notes);
    const seen = noted.at(-1)?.id ?? last(),
      pool = partly
        ? [...kept!.pool.filter(j => !jobs.has(j.id)), ...read([...jobs] as number[])].sort((a, b) => a.id - b.id)
        : read();
    keep(seen, pool);
    return pool;
  };
  // The pool read whole a slice of the jobs `ids` gives at a time, the server's other work going on between slices, and
  // kept unless a newer one was meanwhile. The notes' last mark is taken before the jobs are listed, so a change during
  // the slicing is read again at the next call.
  async function seed(ids: () => number[], slice: number) {
    syncTriggers(name, sql(), notes);
    const seen = last(),
      pool = await inSlices(ids(), slice, read);
    if (!kept || kept.seen < seen) keep(seen, pool);
    return kept?.pool ?? pool;
  }
  return { pool, seed };
}

// The rows of the jobs a slice at a time, yielding to the server's other work after each, in the order of their ids
async function inSlices<T extends { id: number }>(ids: number[], slice: number, read: (only: number[]) => T[]) {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += slice) {
    rows.push(...read(ids.slice(i, i + slice)));
    await new Promise(resolve => setImmediate(resolve));
  }
  return rows.sort((a, b) => a.id - b.id);
}

// The triggers as the read and its notes make them, those that differ made again in one go
function syncTriggers(name: string, sql: string, notes: Notes) {
  const changes = `${name}_changes`,
    taken = columnsRead(sql);
  for (const table of taken.keys())
    if (!notes[table])
      throw new Error(`${name}'s read takes ${table}: its notes must say which jobs a row is read into`);
  for (const table in notes) if (!taken.has(table)) throw new Error(`${name}'s read takes nothing of ${table}, noted`);
  const triggers = new Map<string, string>();
  for (const [table, { of, added }] of Object.entries(notes)) {
    const columns = [...taken.get(table)!];
    const events = {
      added: [`insert on ${table}`, added ?? of('new')],
      changed: [`update ${columns.length ? `of ${columns}` : ''} on ${table}`, `${of('old')} union ${of('new')}`],
      removed: [`delete on ${table}`, of('old')],
    };
    for (const [event, [on, ofJobs]] of Object.entries(events))
      triggers.set(
        `${name}_${table}_${event}`,
        `CREATE TRIGGER ${name}_${table}_${event} after ${on} for each row when exists (${ofJobs}) begin
    insert into ${changes} (job) ${ofJobs};
    delete from ${changes} where id <= (select max(id) from ${changes}) - ${KEPT_CHANGES};
  end`,
      );
  }
  const made = new Map(
    (
      db
        .prepare("select name, sql from sqlite_master where type = 'trigger' and name like ? escape '!'")
        .all(`${name}!_%`) as { name: string; sql: string }[]
    ).map(t => [t.name, t.sql]),
  );
  const stale = [...made].filter(([trigger, code]) => triggers.get(trigger) !== code).map(([trigger]) => trigger),
    missing = [...triggers].filter(([trigger, code]) => made.get(trigger) !== code);
  if (!stale.length && !missing.length) return;
  inOneStep(() => {
    for (const trigger of stale) db.exec(`drop trigger ${trigger}`);
    for (const [, code] of missing) db.exec(code);
  });
}

// The columns of each table a statement takes, as SQLite reports them while preparing it: views and the common table
// expressions it reads through come down to their tables.
function columnsRead(sql: string) {
  const tables = new Set(
    (db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map(t => t.name),
  );
  const taken = new Map<string, Set<string>>();
  db.setAuthorizer((action, table, column) => {
    if (action === constants.SQLITE_READ && table && tables.has(table)) {
      if (!taken.has(table)) taken.set(table, new Set());
      if (column) taken.get(table)!.add(column);
    }
    return constants.SQLITE_OK;
  });
  try {
    db.prepare(sql);
  } finally {
    db.setAuthorizer(null);
  }
  return taken;
}
