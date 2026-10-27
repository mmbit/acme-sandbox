// The play's input kept (eta.ts Snapshot and both paces' sizes), so a later play, or a changed one, plays the same queue
// again and is scored against what happened (backtest.ts). One an hour, and one whenever a thread shows up that no kept
// snapshot had, each gzipped JSON, kept KEEP_DAYS days.
import { gunzipSync, gzipSync } from 'node:zlib';
import { db } from './db.ts';
import * as forecast from './forecast.ts';
import type { Size, Snapshot } from './eta.ts';

// threads: the ids of the threads with open work in it (a JSON list), so a new one is known after a restart too
db.exec(`create table if not exists play_snapshots (at integer primary key, version integer not null,
  threads text not null, input blob not null)`);

const HOUR_MS = 60 * 60_000,
  DAY_MS = 24 * HOUR_MS;
export const KEEP_DAYS = 30;

// A kept play's input: the snapshot, and each pace's size per job.
export type Kept = {
  at: number;
  version: number;
  snapshot: Snapshot;
  sizes: { usual: [number, Size][]; slow: [number, Size][] };
};

let lastAt: number | undefined;
let seen: Set<string> | undefined;

forecast.afterEach(keep);

// The play's input, kept when the last one is an hour old or the play has a thread none of the kept ones had. The ones
// past KEEP_DAYS go.
export function keep(f: forecast.Forecast) {
  if (lastAt === undefined || !seen) {
    const rows = db.prepare('select at, threads from play_snapshots').all() as { at: number; threads: string }[];
    lastAt = Math.max(...rows.map(r => r.at), -Infinity);
    seen = new Set(rows.flatMap(r => JSON.parse(r.threads) as string[]));
  }
  const threads = [...f.threads.keys()];
  const fresh = threads.some(t => !seen!.has(t));
  if (!fresh && f.now - lastAt < HOUR_MS) return;
  const input: Omit<Kept, 'at' | 'version'> = {
    snapshot: { ...f.snapshot, jobs: f.snapshot.jobs.map(j => ({ ...j, title: '' })) },
    sizes: { usual: [...f.sizes.usual], slow: [...f.sizes.slow] },
  };
  db.prepare('insert or replace into play_snapshots (at, version, threads, input) values (?, ?, ?, ?)').run(
    f.now,
    f.version,
    JSON.stringify(threads),
    gzipSync(JSON.stringify(input)),
  );
  db.prepare('delete from play_snapshots where at < ?').run(f.now - KEEP_DAYS * DAY_MS);
  lastAt = f.now;
  for (const t of threads) seen.add(t);
}

// A kept row, and the two ways it is read back: parsed into a Kept, or as a Kept's JSON from its stored text, neither
// parsed nor decoded (hq estimate --backtest --save). The stored text is `input` above, so a Kept's JSON is that with
// `at` and `version` put first.
type Row = { at: number; version: number; input: Uint8Array };
const parsed = (r: Row): Kept => ({ at: r.at, version: r.version, ...JSON.parse(gunzipSync(r.input).toString()) });
const jsonOf = (r: Row) =>
  Buffer.concat([Buffer.from(`{"at":${r.at},"version":${r.version},`), gunzipSync(r.input).subarray(1)]);

// A kept input as the backtest picks from them: its time, its planner and its work jobs, and its whole input, parsed
// again for a play or as its JSON for a file.
export type Listed = {
  at: number;
  planner: Snapshot['planner'];
  work: { id: number; due: number | null; planned: boolean }[];
  read: () => Kept;
  json: () => Buffer;
};
export const listedOf = (k: Kept, read = () => k, json = () => Buffer.from(JSON.stringify(k))): Listed => ({
  at: k.at,
  planner: k.snapshot.planner,
  work: k.snapshot.jobs
    .filter(j => j.kind === 'work')
    .map(j => ({ id: j.id, due: j.due, planned: Boolean(j.reviewPlan) })),
  read,
  json,
});

// The kept inputs since then listed, oldest first. Their stored rows are read in one go and kept with the listing, so
// one that keep() prunes while the request runs is still there to play; each is parsed in turn and dropped after its
// listing, so the server answers other requests between a few and holds one parsed input at a time.
export async function listSince(from: number) {
  const rows = db.prepare('select at, version, input from play_snapshots where at >= ? order by at').all(from) as Row[];
  const listed: Listed[] = [];
  const pause = paced();
  for (const row of rows) {
    listed.push(
      listedOf(
        parsed(row),
        () => parsed(row),
        () => jsonOf(row),
      ),
    );
    await pause();
  }
  return listed;
}

// A pause for the server's other requests, each time this turn of its thread has run TURN_MS.
export function paced() {
  let turn = performance.now();
  return async () => {
    if (performance.now() - turn < TURN_MS) return;
    await new Promise(setImmediate);
    turn = performance.now();
  };
}
const TURN_MS = 50;
