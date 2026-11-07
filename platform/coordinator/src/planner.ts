// Job precedence, latest starts and the order shared by the claim and the play.
// Estimate, ETA and deadline and their relationships: eta.ts, the shared plan's entry point.
import type { OrderingSnapshot, QueuedJob, Size } from './eta.ts';
import type { Wait } from '../../worker/hq/waits.ts';

// A heartbeat's minute plus the worker's five-minute yield bound.
export const PAUSE_MS = 6 * 60_000;
// Deadline preemption stops on the next heartbeat, without waiting for a tool boundary.
export const DEADLINE_PAUSE_MS = 60_000;
export const ROOM_AFTER_MS = 30_000;
// ownReview: an edge within one job's own review (its stages, resolution and merge hold), which frees no other work.
export type Dependency = { job: number; until: 'done' | 'merged'; lag?: number; ownReview?: true };
// missed: every window the job serves had passed when the pass ran (backward), so its latest start is a missed one's.
// frees: other work waits for it, beyond its own review (backward).
export type Order = {
  id: number;
  orderId?: number;
  created?: number;
  board: number | boolean;
  urgent?: number | boolean;
  followThrough?: number | boolean; // the CEO's hourly check (jobs.ts FOLLOW_THROUGH), first in the lane (compare)
  latestStart: number | null;
  missed?: boolean;
  frees?: boolean;
};
export type Timing = Order & { latestFinish: number | null; duration: number };

// The lane, then work with a window still open, then work whose windows have all passed, then work with none. Overdue
// work that frees other work goes before overdue work that frees nothing. Within each, the earliest latest start goes
// first, then the oldest. A passed window keeps its work ahead of undated work, but no longer ahead of work that can
// still be on time: the further it's missed, the earlier its latest start, so it would otherwise go before every window
// still to come. The CEO's hourly check leads the lane: a few minutes' read of the board's work, it waited behind that
// work past its start alarm (followthrough.ts START_MS).
const tier = (o: Order) => (o.latestStart === null ? 2 : o.missed ? 1 : 0);
export function compare(a: Order, b: Order) {
  if (!!a.board !== !!b.board) return a.board ? -1 : 1;
  if (!!a.followThrough !== !!b.followThrough) return a.followThrough ? -1 : 1;
  if (!!a.urgent !== !!b.urgent) return a.urgent ? -1 : 1;
  if (tier(a) !== tier(b)) return tier(a) - tier(b);
  if (a.missed && b.missed && !!a.frees !== !!b.frees) return a.frees ? -1 : 1;
  const x = a.latestStart ?? Infinity,
    y = b.latestStart ?? Infinity;
  return x === y ? (a.orderId ?? a.id) - (b.orderId ?? b.id) : x < y ? -1 : 1;
}

export const spareOnly = (row: { downtime: number }, order: Order) =>
  !!row.downtime && !order.board && order.latestStart === null;
// A claim beyond its paced concurrency admits only explicit urgency, including that inherited from waiting work.
export const pacedTakes = (order: Order, until: number | undefined) => until === undefined || !!order.urgent;

// A room pause stops work. Deadline pressure also stops reviews and rulings, but never the board's or CEO's follow-through
// check. The check runs its few minutes to its end: paused, it went back behind the work it made room for, in the jam
// it's there to see.
export type Pausable = { kind: string; board: number | boolean; followThrough?: number | boolean };
export const pausable = (run: Pausable, deadline = false) =>
  (run.kind === 'work' || (deadline && (run.kind === 'review' || run.kind === 'consolidate'))) &&
  !run.board &&
  !run.followThrough;

export const deadlinePressure = (order: Order, now: number) =>
  order.latestStart !== null && order.latestStart <= now + PAUSE_MS;

export function victimOrder(a: Order, b: Order) {
  return compare(b, a);
}

// A thread's order (threadorder.ts) adds its edges here: the task before, until done; the threads it needs, until merged.
export function precedence(row: QueuedJob, deployLagMs = 0) {
  const jobs: Dependency[] = [...(row.dependencies ?? [])];
  if (row.follows !== undefined) jobs.push({ job: row.follows, until: 'done' });
  for (const job of row.needs ?? []) jobs.push({ job, until: 'merged' });
  if (typeof row.after === 'number') jobs.push({ job: row.after, until: 'merged' });
  for (const job of row.waitsFor) jobs.push({ job, until: 'merged' });
  for (const wake of row.wakes)
    if ('deployOf' in wake) jobs.push({ job: wake.deployOf, until: 'merged', lag: deployLagMs });
  const readyAt = Math.max(
    row.notBefore,
    ...row.cards.map(c => c.at),
    ...row.wakes.flatMap(w => ('at' in w ? [w.at] : [])),
  );
  const blocked = row.after === 'never' || row.reasons.some(blocks);
  return { jobs, readyAt, blocked };
}
// What holds work until someone acts: a stall, or the board with no time it's expected to answer by, or its pause.
const blocks = (r: Wait) => r.on === 'stalled' || (r.on === 'board' && (!r.at || r.paused));

export const ready = (...rule: Parameters<typeof firstWait>) => firstWait(...rule) === undefined;

// The first thing job `row` waits for before it can start at `now`, or undefined when nothing holds it. Live (the
// claim), a card or a wake not yet met holds it too.
export function firstWait(
  row: QueuedJob,
  now: number,
  completed: (edge: Dependency) => number | null,
  deployLagMs = 0,
  mode: 'live' | 'play' = 'play',
): Wait | undefined {
  const card = row.cards[0],
    wake = row.wakes[0];
  if (mode === 'live' && card) return { on: 'board', request: card.request, at: card.at };
  if (mode === 'live' && wake) return wakeWait(wake);
  const needs = precedence(row, deployLagMs);
  if (needs.blocked)
    return row.reasons.find(blocks) ?? { on: 'stalled', why: 'it starts after a job that is neither open nor ended' };
  if (needs.readyAt > now) return { on: 'time', until: needs.readyAt };
  const edge = needs.jobs.find(e => {
    const ended = completed(e);
    return ended === null || ended + (e.lag ?? 0) > now;
  });
  return edge && { on: 'job', job: edge.job };
}
// A wake not yet met (hq job --when) as what the job waits for: a job's deploy, the next deploy, or a time.
function wakeWait(wake: QueuedJob['wakes'][number]): Wait {
  if ('deployOf' in wake) return { on: 'deploy', job: wake.deployOf };
  if (wake.deploy) return { on: 'deploy' };
  return { on: 'time', until: wake.at };
}

export function remaining(row: QueuedJob, size: Size) {
  return row.status === 'done' ? 0 : Math.max(size.agent_ms - row.spentMs, size.agent_ms / 4);
}

// Terminal runs give merge edges their true endpoint while task-order edges still use the work's own end.
export function dependencyRun(edge: Dependency, terminals: ReadonlyMap<number, number>) {
  return edge.until === 'merged' ? (terminals.get(edge.job) ?? edge.job) : edge.job;
}

export function backward(
  snapshot: OrderingSnapshot,
  sizes: ReadonlyMap<number, Size>,
  terminals: ReadonlyMap<number, number> = new Map(),
) {
  const { rows, releases, followers } = backwardGraph(snapshot, terminals);
  // (each job's latest finish twice: from the windows still open at the pass's now, and from every window, which only
  // orders work that serves no open one: compare's missed.)
  const timings = new Map<number, Timing>(),
    everyWindow = new Map<number, number>(),
    visiting = new Set<number>();
  const visit = (id: number): Timing => {
    if (timings.has(id)) return timings.get(id)!;
    if (visiting.has(id)) throw new Error(`Job precedence has a cycle at #${id}`);
    visiting.add(id);
    const row = rows.get(id)!;
    const own = row.due === null ? Infinity : row.due - snapshot.deployLagMs,
      release = releases.has(id) ? snapshot.now : Infinity;
    let open = Math.min(release, row.due !== null && row.due >= snapshot.now ? own : Infinity),
      any = Math.min(release, own),
      urgent = !!row.urgent,
      frees = false;
    for (const follower of followers.get(id) ?? []) {
      const next = visit(follower.id);
      urgent ||= !!next.urgent;
      frees ||= !follower.ownReview || !!next.frees;
      if (!next.missed) open = Math.min(open, (next.latestStart ?? Infinity) - follower.lag);
      any = Math.min(any, everyWindow.get(follower.id)! - follower.lag);
    }
    const duration = row.status === 'done' || row.kind === 'resolution' ? 0 : remaining(row, sizes.get(id)!) + PAUSE_MS;
    const timing = timingOf(row, { open, any, urgent, frees }, duration);
    visiting.delete(id);
    everyWindow.set(id, any === Infinity ? Infinity : any - duration);
    timings.set(id, timing);
    return timing;
  };
  for (const id of rows.keys()) visit(id);
  return timings;
}

function backwardGraph(snapshot: OrderingSnapshot, terminals: ReadonlyMap<number, number>) {
  const rows = new Map(snapshot.jobs.map(j => [j.id, j]));
  // A pause's release gets an immediate window floor at its merge endpoint, including the review rounds.
  // Open windows still propagate their earlier latest starts through the same dependency graph. Passed ones do not.
  const releases = new Set((snapshot.pauseUntil ?? []).map(id => terminals.get(id) ?? id));
  const followers = new Map<number, { id: number; lag: number; ownReview?: true }[]>();
  for (const row of rows.values())
    for (const edge of precedence(row, snapshot.deployLagMs).jobs) {
      const prior = dependencyRun(edge, terminals);
      followers.set(prior, [
        ...(followers.get(prior) ?? []),
        { id: row.id, lag: edge.lag ?? 0, ownReview: edge.ownReview },
      ]);
    }
  return { rows, releases, followers };
}

function timingOf(
  row: QueuedJob,
  standing: { open: number; any: number; urgent: boolean; frees: boolean },
  duration: number,
): Timing {
  const { open, any, urgent, frees } = standing;
  const finish = open === Infinity ? any : open;
  return {
    id: row.id,
    orderId: row.orderId,
    created: row.created,
    board: row.board,
    ...(urgent && { urgent: true }),
    ...(frees && { frees: true }),
    ...(row.followThrough && { followThrough: true }),
    latestStart: finish === Infinity ? null : finish - duration,
    latestFinish: finish === Infinity ? null : finish,
    duration,
    ...(open === Infinity && any !== Infinity && { missed: true }),
  };
}

// The running job ready work `waiting` pauses, if any (jobs.ts makesRoom, and the play: simulation.ts). Spare downtime
// work is in the way of any work that isn't spare itself, wherever its id puts it.
export function pauseVictim(
  waiting: Order & { downtime?: number },
  running: (Order & Pausable & { downtime: number; engine: string })[],
  now: number,
  engine?: string,
) {
  if (spareOnly({ downtime: waiting.downtime ?? 0 }, waiting)) return undefined;
  if (waiting.board && waiting.created !== undefined && waiting.created + ROOM_AFTER_MS > now) return undefined;
  return running
    .filter(
      v =>
        pausable(v, deadlinePressure(waiting, now)) &&
        (!engine || v.engine === engine) &&
        (compare(waiting, v) < 0 || spareOnly(v, v)) &&
        (waiting.board || (waiting.latestStart !== null && waiting.latestStart <= now + PAUSE_MS) || spareOnly(v, v)),
    )
    .sort(victimOrder)[0];
}
