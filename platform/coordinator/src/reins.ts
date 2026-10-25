// Each job's share of the coordinator's time. HQ answers every request on one event loop, so a job whose requests (its
// agent's hq calls, and the worker's about its run: heartbeats, reports) take most of it leaves the board and every other
// caller waiting. The jobs together may take half of it (ALL), each an equal part of that with the jobs asking now. A
// job's time fills its level, which drains at its share, each stretch at the share it had then. Past a minute of its
// share (WINDOW_MS) it's told so on its answers, and its next requests wait off the loop, one at a time, until it's back
// under (its run's heartbeat goes in at once, but then only keeps the run's lease: server.ts). The board, calls and HQ's
// own sweeps are never held, and always have the other half.
import { promiseHooks } from 'node:v8';

// A loop half busy still answers a request in about the time of the one before it (half the time it finds the loop
// free), and the board's pages, the calls and the minute's sweeps fit in the other half
const ALL = 0.5;
// The worker sends each run's heartbeat once a minute, so a job's share over a minute holds every beat of its run
const WINDOW_MS = 60_000;

// seen, drained: on the monotonic clock (performance.now), which a change of the server's time (or a test's) leaves alone
type Level = { ms: number; seen: number };
const levels = new Map<number, Level>();
// Every level has drained to this moment
let drained = -Infinity;
const turns = new Map<number, Promise<unknown>>();
const past = new Set<number>();

// Waits while the job is past its share, after its requests held before this one, and gives how long it waited (ms).
// longestMs: the longest this request may wait, its place in line behind those included (what its caller waits for the
// answer leaves room for)
export function admit(job: number, longestMs: number): Promise<number> {
  const asked = performance.now(),
    until = asked + longestMs;
  seen(job, asked);
  const before = turns.get(job);
  if (!before && heldFor(job, asked) === 0) return Promise.resolve(0);
  const turn = (before ?? Promise.resolve()).then(() => waitTurn(job, asked, until));
  turns.set(job, turn);
  void turn.finally(() => {
    if (turns.get(job) !== turn) return;
    settle(performance.now());
    turns.delete(job);
  });
  const late = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - asked), longestMs).unref());
  return Promise.race([turn, late]);
}

async function waitTurn(job: number, asked: number, until: number) {
  let now = performance.now();
  for (let wait = heldFor(job, now); wait > 0 && now < until; wait = heldFor(job, now)) {
    await new Promise(resolve => setTimeout(resolve, Math.min(wait, until - now)));
    now = performance.now();
    seen(job, now);
  }
  return now - asked;
}

// Runs a job's request's work and spends the loop's time it takes from the job's share: work's synchronous part, and each
// part after an await, its own or in what it awaits (an await's wait holds nothing). A promise made while the loop is
// doing a job's work carries the job, and so does the work that runs when it settles.
export function charged<T>(job: number, work: () => T): T {
  const was = doing,
    since = performance.now();
  doing = { job, since };
  try {
    return work();
  } finally {
    doing = was;
    spend(job, performance.now() - since);
  }
}

let doing: { job: number; since: number } | undefined;
const carries = new WeakMap<Promise<unknown>, number>();
promiseHooks.createHook({
  init: promise => void (doing && carries.set(promise, doing.job)),
  before: promise => {
    const job = carries.get(promise);
    doing = job === undefined ? undefined : { job, since: performance.now() };
  },
  after: () => {
    if (doing) spend(doing.job, performance.now() - doing.since);
    doing = undefined;
  },
});

// The loop's time a request of the job took (ms)
export function spend(job: number, ms: number, now = performance.now()) {
  const level = seen(job, now);
  level.ms += ms;
  if (level.ms <= burst(now) || past.has(job)) return;
  past.add(job);
  console.log(`Reins: job #${job} past its share of HQ: ${seconds(level.ms)} s, its share ${seconds(burst(now))} s`);
}

// What the job's answer tells it: how long it was held, and while it's past its share, by how much and what to do
export function words(job: number, heldMs: number, now = performance.now()) {
  const level = levelAt(job, now);
  if (level <= burst(now)) past.delete(job);
  if (level <= burst(now) && heldMs < 1000) return undefined;
  const held = heldMs >= 1000 ? `HQ held this call ${seconds(heldMs)} s. ` : '';
  const jobsNow = active(now);
  return (
    `${held}Job #${job} has taken ${seconds(level)} s of HQ's time lately, its share is ${seconds(burst(now))} s a ` +
    `minute (half of HQ, shared by the ${jobsNow} ${jobsNow === 1 ? 'job' : 'jobs'} asking now). Its calls wait until ` +
    "it's back under: make fewer hq calls, and wait with hq's own waiting commands rather than a loop that asks again"
  );
}

// How long the job waits before its next request goes in (ms): until its level drains to a minute of its share
export function heldFor(job: number, now = performance.now()) {
  return Math.max(0, (levelAt(job, now) - burst(now)) / share(now));
}

function seen(job: number, now: number) {
  settle(now);
  for (const [other, level] of levels) if (!asking(other, level, now) && level.ms === 0) levels.delete(other);
  const level = levels.get(job) ?? { ms: 0, seen: now };
  level.seen = now;
  levels.set(job, level);
  return level;
}

function levelAt(job: number, now: number) {
  settle(now);
  return levels.get(job)?.ms ?? 0;
}

// Drains every level to now, each stretch of time at the share of the jobs asking in it. A stretch ends where a job
// leaves the minute, or where one joins or its held request ends (seen, and a held request's end, settle first).
function settle(now: number) {
  while (drained < now) {
    let until = now;
    for (const [job, level] of levels) {
      const leaves = level.seen + WINDOW_MS;
      if (!turns.has(job) && leaves > drained && leaves < until) until = leaves;
    }
    const each = share(drained);
    for (const level of levels.values()) level.ms = Math.max(0, level.ms - (until - drained) * each);
    drained = until;
  }
}

const share = (now: number) => ALL / Math.max(1, active(now));
const burst = (now: number) => share(now) * WINDOW_MS;

// The jobs asking now: each with a request in the last minute, or one held
const active = (now: number) => [...levels].filter(([job, level]) => asking(job, level, now)).length;
const asking = (job: number, level: Level, now: number) => level.seen + WINDOW_MS > now || turns.has(job);

const seconds = (ms: number) => (ms / 1000).toFixed(1);
