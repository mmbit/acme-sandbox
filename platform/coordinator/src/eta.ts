// The shared plan played forward on reported capacity and measured runs.
// Estimate: a task's working duration in agent time, judged by an agent from comparable past work.
// Queue waits stay out. The work, shared review and fix splits show the whole effort. The plan adds shared
// review and fix rounds once per deliverable, separately from its tasks' work estimates.
// ETA: a deliverable's calculated time from its tasks' estimates, order and dependencies, the seats, pacing
// and queue. Here eta is its last merge. Finish is that ETA plus deployment, when the deliverable is live.
// Deadline: a deliverable's target set by judgment, from the board's time or what waits on it. It also feeds
// the scheduler's order (planner.ts): deadline work goes first, so setting one can pull its ETA earlier
// and push other deliverables later. The plan calculates an ETA, never a deadline.
// The ETA and live finish should land before the deadline. A forecast that misses is a slip to judge:
// find why and what to change. A forecast never moves the deadline by itself: only a judgment does, the board's for
// a time it gave.
// A window is a deliverable's deadline with its aim, set with hq window.
// An aim is the earlier desired finish within a deliverable's window, not its deadline or its current ETA.
import { inspectPlan, playPlan, type PlayOrder } from './simulation.ts';
import type { Snapshot, Size } from './playtypes.ts';
export type * from './playtypes.ts';
export { startPlan } from './simulation.ts';
export const PLAY_VERSION = 4;
// order: the snapshot's playOrder, played once for both paces (predictions.ts played).
export function play(
  snapshot: Snapshot,
  sizes: ReadonlyMap<number, Size>,
  options: { pace?: 'usual' | 'slow'; order?: PlayOrder } = {},
) {
  return playPlan(snapshot, sizes, options.pace ?? 'usual', options.order);
}

export function inspect(
  snapshot: Snapshot,
  sizes: ReadonlyMap<number, Size>,
  options: { pace?: 'usual' | 'slow' } = {},
) {
  return inspectPlan(snapshot, sizes, options.pace ?? 'usual');
}
