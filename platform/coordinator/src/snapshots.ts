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

// The kept inputs since then, oldest first.
export function since(from: number): Kept[] {
  const rows = db.prepare('select at, version, input from play_snapshots where at >= ? order by at').all(from) as {
    at: number;
    version: number;
    input: Uint8Array;
  }[];
  return rows.map(r => ({ at: r.at, version: r.version, ...JSON.parse(gunzipSync(r.input).toString()) }));
}
