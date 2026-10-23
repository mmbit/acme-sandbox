// Job precedence, latest starts and the order shared by the claim and the play.
import type { OrderingSnapshot, QueuedJob, Size } from './eta.ts';

// A heartbeat's minute plus the worker's five-minute yield bound.
export const PAUSE_MS = 6 * 60_000;
export const ROOM_AFTER_MS = 30_000;
export type Dependency = { job: number; until: 'done' | 'merged'; lag?: number };
export type Order = {
  id: number;
  orderId?: number;
  created?: number;
  board: number | boolean;
  latestStart: number | null;
};
export type Timing = Order & { latestFinish: number | null; duration: number };

export function compare(a: Order, b: Order) {
  if (!!a.board !== !!b.board) return a.board ? -1 : 1;
  const x = a.latestStart ?? Infinity,
    y = b.latestStart ?? Infinity;
  return x === y ? (a.orderId ?? a.id) - (b.orderId ?? b.id) : x < y ? -1 : 1;
}

export const spareOnly = (row: { downtime: number }, order: Order) =>
  !!row.downtime && !order.board && order.latestStart === null;
// What a paced seat takes (the worker's pacedUntil, its weekly reset: jobs.ts claim): the board's word, and work that has
// to start before the week turns over to keep its window. Undated work, spare downtime work with it, waits for the reset.
export const pacedTakes = (order: Order, until: number | undefined) =>
  until === undefined || !!order.board || (order.latestStart !== null && order.latestStart < until);

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
  const blocked =
    row.after === 'never' || row.reasons.some(r => r.on === 'stalled' || (r.on === 'board' && (!r.at || r.paused)));
  return { jobs, readyAt, blocked };
}

export function ready(
  row: QueuedJob,
  now: number,
  completed: (edge: Dependency) => number | null,
  deployLagMs = 0,
  mode: 'live' | 'play' = 'play',
) {
  const needs = precedence(row, deployLagMs);
  if (mode === 'live' && (row.cards.length || row.wakes.length)) return false;
  return readyAfter(needs, now, completed);
}

export function readyAfter(
  needs: ReturnType<typeof precedence>,
  now: number,
  completed: (edge: Dependency) => number | null,
) {
  if (needs.blocked || needs.readyAt > now) return false;
  for (const edge of needs.jobs) {
    const ended = completed(edge);
    if (ended === null || ended + (edge.lag ?? 0) > now) return false;
  }
  return true;
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
  const rows = new Map(snapshot.jobs.map(j => [j.id, j]));
  const followers = new Map<number, { id: number; lag: number }[]>();
  for (const row of rows.values())
    for (const edge of precedence(row, snapshot.deployLagMs).jobs) {
      const prior = dependencyRun(edge, terminals);
      followers.set(prior, [...(followers.get(prior) ?? []), { id: row.id, lag: edge.lag ?? 0 }]);
    }
  const timings = new Map<number, Timing>(),
    visiting = new Set<number>();
  const visit = (id: number): Timing => {
    if (timings.has(id)) return timings.get(id)!;
    if (visiting.has(id)) throw new Error(`Job precedence has a cycle at #${id}`);
    visiting.add(id);
    const row = rows.get(id)!;
    let finish = row.due === null ? Infinity : row.due - snapshot.deployLagMs;
    for (const follower of followers.get(id) ?? [])
      finish = Math.min(finish, (visit(follower.id).latestStart ?? Infinity) - follower.lag);
    const duration = row.status === 'done' || row.kind === 'resolution' ? 0 : remaining(row, sizes.get(id)!) + PAUSE_MS;
    const timing = {
      id,
      orderId: row.orderId,
      created: row.created,
      board: row.board,
      latestStart: finish === Infinity ? null : finish - duration,
      latestFinish: finish === Infinity ? null : finish,
      duration,
    };
    visiting.delete(id);
    timings.set(id, timing);
    return timing;
  };
  for (const id of rows.keys()) visit(id);
  return timings;
}

// The running job ready work `waiting` pauses, if any (jobs.ts makesRoom, and the play: simulation.ts). Spare downtime
// work is in the way of any work that isn't spare itself, wherever its id puts it.
export function pauseVictim(
  waiting: Order & { downtime?: number },
  running: (Order & { kind: string; downtime: number; engine: string })[],
  now: number,
  engine?: string,
) {
  if (spareOnly({ downtime: waiting.downtime ?? 0 }, waiting)) return undefined;
  if (waiting.board && waiting.created !== undefined && waiting.created + ROOM_AFTER_MS > now) return undefined;
  return running
    .filter(
      v =>
        v.kind === 'work' &&
        !v.board &&
        (!engine || v.engine === engine) &&
        (compare(waiting, v) < 0 || spareOnly(v, v)) &&
        (waiting.board || (waiting.latestStart !== null && waiting.latestStart <= now + PAUSE_MS) || spareOnly(v, v)),
    )
    .sort(victimOrder)[0];
}
