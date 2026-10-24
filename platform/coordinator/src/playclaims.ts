// Ready runs indexed by seat and admission class for one step of the queue's play.
import type { QueuedJob } from './eta.ts';
import { compare, spareOnly, type Timing } from './planner.ts';
import * as capacity from './playseats.ts';
import * as reviewroom from './reviewroom.ts';

type Claim = { row: QueuedJob; order: Timing };
type Group<T> = { runs: T[]; next: number; spare: boolean };
type Queue<T> = {
  runs: T[];
  pending: Set<T>;
  next: number;
  groups: Map<string, Group<T>[]>;
  base: (a: QueuedJob, b: QueuedJob) => number;
  orders: ReadonlyMap<number, Timing>;
};

export function queue<T extends Claim>(runs: T[], orders: ReadonlyMap<number, Timing>): Queue<T> {
  const base = (a: QueuedJob, b: QueuedJob) => {
    const x = orders.get(a.id)!,
      y = orders.get(b.id)!;
    return Number(spareOnly(a, x)) - Number(spareOnly(b, y)) || compare(x, y);
  };
  return { runs, pending: new Set(runs), next: 0, groups: new Map(), base, orders };
}

export function take<T extends Claim>(
  queue: Queue<T>,
  seats: capacity.Moment,
  limits: Record<string, number>,
  busy: Map<string, number>,
  occupants: (seat: string) => { kind: string }[],
) {
  while (!queue.pending.has(queue.runs[queue.next])) queue.next++;
  let picked = queue.runs[queue.next];
  const available = capacity.choose(picked.row, picked.order, seats, busy, limits, false);
  const seat =
    !('id' in available) && available.on === 'queue'
      ? capacity.choose(picked.row, picked.order, seats, new Map(), limits, false)
      : available;
  if ('id' in seat && reviewroom.shared(limits[seat.engine] ?? Infinity)) {
    const order = reviewroom.claimOrder(
      occupants(seat.id),
      limits[seat.engine],
      queue.base,
      row => queue.orders.get(row.id)!.latestStart !== null,
    );
    const spare = spareOnly(picked.row, picked.order);
    for (const group of groupsOn(queue, seat, seats.now, limits)) {
      if (group.spare && !spare) continue;
      while (group.next < group.runs.length && !queue.pending.has(group.runs[group.next])) group.next++;
      const candidate = group.runs[group.next];
      if (candidate && order(candidate.row, picked.row) < 0) picked = candidate;
    }
  }
  queue.pending.delete(picked);
  return picked;
}

function groupsOn<T extends Claim>(queue: Queue<T>, seat: capacity.Seat, now: number, limits: Record<string, number>) {
  const cached = queue.groups.get(seat.id);
  if (cached) return cached;
  const groups = new Map<string, Group<T>>();
  const alone = capacity.at([seat], now);
  if (!capacity.available(seat, now)) return [];
  for (const run of queue.runs) {
    if (!queue.pending.has(run)) continue;
    if ((limits[seat.engine] ?? Infinity) <= 0 || !capacity.takes(seat, run.row, run.order, alone)) continue;
    const spare = spareOnly(run.row, run.order);
    const key = `${Number(!!run.row.board)}:${run.row.kind}:${Number(spare)}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { runs: [], next: 0, spare }));
    group.runs.push(run);
  }
  const indexed = [...groups.values()];
  queue.groups.set(seat.id, indexed);
  return indexed;
}
