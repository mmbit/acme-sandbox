// Job outlooks and elapsed time from a completed queue simulation.
import type { Outlook, QueuedJob } from './eta.ts';
import type { Play, Run } from './simulation.ts';
import { dependencyRun, precedence } from './planner.ts';
import { elapsedTime } from './playtime.ts';

export function outlook(play: Play, row: QueuedJob, horizonDays: number): Outlook {
  const run = play.runs.get(row.id)!;
  const terminal = play.runs.get(play.terminals.get(row.id) ?? row.id)!;
  const chain = ancestors(play, terminal);
  const waits = chain.flatMap(r => [...r.waits, ...(r.held ? [r.held.by] : [])]);
  for (const edge of precedence(row).jobs) waits.push({ on: 'job', job: edge.job });
  const merged = terminal.state === 'done' ? terminal.done : null;
  if (merged === null && !waits.some(w => w.on === 'stalled')) waits.push({ on: 'horizon', days: horizonDays });
  const cards = [...new Map(chain.flatMap(r => r.row.cards).map(c => [c.request, c])).values()];
  return {
    time: elapsedTime(
      play.snapshot.now,
      merged,
      play.snapshot.deployLagMs,
      run.active,
      (play.stages.get(row.id) ?? []).flatMap(id => play.runs.get(id)!.active),
    ),
    capacityConditions: play.conditions,
    unpricedSeats: play.seats.filter(s => s.fiveRate === null || s.weekRate === null).map(s => s.id),
    start: run.start,
    done: run.done,
    merged,
    left_ms: run.remainingMs,
    waits,
    cards,
  };
}

function ancestors(play: Play, run: Run) {
  const seen = new Set<number>(),
    chain: Run[] = [];
  const walk = (r: Run) => {
    if (seen.has(r.row.id)) return;
    seen.add(r.row.id);
    chain.push(r);
    for (const edge of precedence(r.row).jobs) {
      const prior = play.runs.get(dependencyRun(edge, play.terminals));
      if (prior) walk(prior);
    }
  };
  walk(run);
  return chain;
}
