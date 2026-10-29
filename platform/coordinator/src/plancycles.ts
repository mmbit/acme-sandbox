// Cyclic precedence is refused by plan writes and cut into an explicit stall by the live plan.
// (its messages say deliverable, the board's word for a thread)
import type { QueuedJob } from './eta.ts';
import { precedence, dependencyRun } from './planner.ts';

export class PlanCycleError extends Error {}

type Edge = { from: QueuedJob; to: number; prior: number };

export function unloop(rows: QueuedJob[], terminals: ReadonlyMap<number, number> = new Map()) {
  const byId = new Map(rows.map(row => [row.id, row]));
  for (;;) {
    const loop = findLoop(rows, byId, terminals);
    if (!loop) return;
    const why = `plan cycle: ${[...loop.map(edge => label(edge.from)), label(byId.get(loop[0].from.id)!)].join(' → ')}. Change its waits, task order or needs`;
    const edge =
      loop.find(edge => edge.from.follows === edge.prior || edge.from.needs?.includes(edge.prior)) ?? loop.at(-1)!;
    cut(edge.from, edge.prior);
    edge.from.reasons.push({
      on: 'stalled',
      why: `it and ${edge.to > 0 ? `#${edge.to}` : label(byId.get(edge.to)!)} wait for each other (${why})`,
    });
  }
}

export type DependencyGraph = Map<string, { task: QueuedJob; needs: Set<string> }>;

export function dependencyGraph(
  rows: QueuedJob[],
  terminals: ReadonlyMap<number, number>,
  identities: ReadonlyMap<number, string>,
): DependencyGraph {
  return new Map(
    rows.map(task => {
      const needs = precedence(task).jobs.map(edge => identities.get(dependencyRun(edge, terminals)));
      return [identities.get(task.id)!, { task, needs: new Set(needs.filter(id => id !== undefined)) }];
    }),
  );
}

// Every new cycle contains an added edge whose destination can reach its source after the write.
export function refuseNewLoops(before: DependencyGraph, after: DependencyGraph) {
  for (const [id, row] of after) {
    for (const prior of row.needs) {
      if (before.get(id)?.needs.has(prior)) continue;
      const path = pathTo(after, prior, id, new Set());
      if (!path) continue;
      const loop = [id, ...path].map(key => label(after.get(key)!.task)).join(' → ');
      throw new PlanCycleError(`plan cycle: ${loop}. Change its waits, task order or needs`);
    }
  }
}

// Whether the graph has any loop: a write that leaves none made none (redraws.ts writePlan).
export function hasLoop(graph: DependencyGraph) {
  const done = new Set<string>(),
    active = new Set<string>();
  const visit = (id: string): boolean => {
    if (active.has(id)) return true;
    if (done.has(id)) return false;
    active.add(id);
    for (const prior of graph.get(id)?.needs ?? []) if (visit(prior)) return true;
    active.delete(id);
    done.add(id);
    return false;
  };
  return [...graph.keys()].some(visit);
}

function pathTo(graph: DependencyGraph, from: string, to: string, visited: Set<string>): string[] | undefined {
  if (from === to) return [to];
  if (visited.has(from)) return;
  visited.add(from);
  for (const prior of graph.get(from)!.needs) {
    const path = pathTo(graph, prior, to, visited);
    if (path) return [from, ...path];
  }
}

function findLoop(rows: QueuedJob[], byId: Map<number, QueuedJob>, terminals: ReadonlyMap<number, number>) {
  const done = new Set<number>(),
    active = new Map<number, number>(),
    path: Edge[] = [];
  const visit = (row: QueuedJob): Edge[] | undefined => {
    active.set(row.id, path.length);
    for (const dependency of precedence(row).jobs) {
      const to = dependencyRun(dependency, terminals),
        next = byId.get(to);
      if (!next || done.has(to)) continue;
      const edge = { from: row, to, prior: dependency.job },
        at = active.get(to);
      if (at !== undefined) return [...path.slice(at), edge];
      path.push(edge);
      const loop = visit(next);
      if (loop) return loop;
      path.pop();
    }
    active.delete(row.id);
    done.add(row.id);
    return undefined;
  };
  for (const row of rows) {
    if (done.has(row.id)) continue;
    const loop = visit(row);
    if (loop) return loop;
  }
}

const label = (row: QueuedJob) =>
  row.id > 0 ? `#${row.id}${row.thread ? ` (${row.thread})` : ''}` : (row.thread ?? `planned ${row.kind}`);

function cut(row: QueuedJob, prior: number) {
  if (row.follows === prior) delete row.follows;
  if (row.needs) row.needs = row.needs.filter(id => id !== prior);
  if (row.after === prior) row.after = 'released';
  row.waitsFor = row.waitsFor.filter(id => id !== prior);
  row.wakes = row.wakes.filter(wake => !('deployOf' in wake) || wake.deployOf !== prior);
  if (row.dependencies) row.dependencies = row.dependencies.filter(edge => edge.job !== prior);
}
