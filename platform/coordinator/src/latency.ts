// How fast HQ answers: each /api request's time, and how late the event loop runs (one slow synchronous step holds up
// every request behind it), kept for the last hours for infra/report.sh.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { db } from './db.ts';

const KEPT_MS = 3 * 3600_000;
const FLUSH_MS = 60_000;

db.exec('create table if not exists route_times (at integer not null, route text not null, ms real not null)');
db.exec('create index if not exists route_times_at on route_times (at)');
// worst_at: when the minute's longest stall ended, to the second, so the report can line it up with what ran then.
db.exec(
  'create table if not exists loop_delays (at integer primary key, p50 real not null, p99 real not null, max real not null, worst_at integer)',
);
// What held the server half a second or more, by name, kept with the rest: the log goes with each deploy, and the
// report runs right after one.
db.exec('create table if not exists slow_holds (at integer not null, ms integer not null, name text not null)');
export function held(name: string, ms: number) {
  console.error(`held the server ${Math.round(ms)} ms: ${name}`);
  if (onStall) recent.push({ name, ms });
  try {
    db.prepare('insert into slow_holds (at, ms, name) values (?, ?, ?)').run(
      Date.now(),
      Math.round(ms),
      name.slice(0, 300),
    );
  } catch (err) {
    console.error('Latency: the hold was not written:', err);
  }
}

// A stall: the loop STALL_MS or more late, with the hold that explains it, among those held since the last tick. That's
// the shortest one at least most of the stall long: a request that also waited (a long poll) took longer than it held.
// A stall no hold explains (the machine short of CPU) names nothing.
export const STALL_MS = 2_000;
export type Hold = { name: string; ms: number };
let recent: Hold[] = [];
let onStall: ((hold: Hold, late: number) => void) | undefined;
export const stalledBy = (late: number, holds: Hold[]) =>
  late < STALL_MS ? undefined : holds.filter(h => h.ms >= late * 0.8).sort((a, b) => a.ms - b.ms)[0];

// The requests timed since the last flush: written a minute's worth at a time, so timing them costs no write each
let timed: { at: number; route: string; ms: number }[] = [];
// (each reading of the loop's delay includes its own RESOLUTION_MS: flush() takes it off)
const RESOLUTION_MS = 10;
const loop = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
// The histogram keeps no times: a light timer of its own notes when its maximum last rose, so the time and the maximum
// come from the same readings
const TICK_MS = 50;
let maxSeenNs = 0;
let maxRoseAt = 0;
let lastTick = 0;

function tick() {
  const now = performance.now(),
    hold = stalledBy(now - lastTick - TICK_MS, recent);
  if (hold) {
    try {
      onStall!(hold, now - lastTick - TICK_MS);
    } catch (err) {
      console.error('Latency: the stall was not passed on:', err);
    }
  }
  [lastTick, recent] = [now, []];
  noteMax();
}

function noteMax() {
  if (loop.max <= maxSeenNs) return;
  maxSeenNs = loop.max;
  maxRoseAt = Date.now();
}

// A request's time, from its handler's start until its answer is sent or the connection drops, by the first three
// segments of its path (ids and long text left out) and only once it was let in and found: the text of a path nobody
// signed in for stays out of the database and the report. The live feed is left out: it stays open as long as HQ does.
export function time(req: IncomingMessage, res: ServerResponse, path: string) {
  if (!path.startsWith('/api/') || path === '/api/events') return;
  const start = performance.now(),
    route = `${req.method} ${path.split('/').slice(0, 4).join('/').replace(/\d+/g, 'n').slice(0, 60)}`;
  res.once('close', () => {
    if ([401, 403, 404].includes(res.statusCode)) return;
    timed.push({ at: Date.now(), route, ms: performance.now() - start });
  });
}

// Both timers are unref'd: they never keep the process, or a test file that calls start(), running. stalled hears each
// stall a hold explains.
export function start(stalled?: (hold: Hold, late: number) => void) {
  loop.enable();
  [onStall, lastTick] = [stalled, performance.now()];
  setInterval(tick, TICK_MS).unref();
  setInterval(() => {
    try {
      flush();
    } catch (err) {
      console.error('Latency: the minute was not written:', err);
    }
  }, FLUSH_MS).unref();
}

// The minute's requests and the loop's delays, and what's older than KEPT_MS goes
export function flush() {
  const now = Date.now(),
    requests = timed,
    nsToMs = (ns: number) => Math.max(0, ns / 1e6 - RESOLUTION_MS);
  timed = [];
  noteMax();
  const insert = db.prepare('insert into route_times (at, route, ms) values (?, ?, ?)');
  db.exec('begin');
  try {
    for (const { at, route, ms } of requests) insert.run(at, route, ms);
    if (loop.count)
      db.prepare('insert or replace into loop_delays (at, p50, p99, max, worst_at) values (?, ?, ?, ?, ?)').run(
        now,
        nsToMs(loop.percentile(50)),
        nsToMs(loop.percentile(99)),
        nsToMs(loop.max),
        maxRoseAt || null,
      );
    db.prepare('delete from route_times where at < ?').run(now - KEPT_MS);
    db.prepare('delete from loop_delays where at < ?').run(now - KEPT_MS);
    db.prepare('delete from slow_holds where at < ?').run(now - KEPT_MS);
    db.exec('commit');
  } catch (err) {
    db.exec('rollback');
    throw err;
  }
  loop.reset();
  maxSeenNs = 0;
  maxRoseAt = 0;
}
