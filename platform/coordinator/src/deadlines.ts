// What a change to the queue (hq job, hq cancel, hq estimate set: moves.ts) or new work played into it (hq when) leaves
// of each agreed deadline: every open thread's window (windows.ts, a time someone gave the board) with its finish before
// and after, and its slack some hours ago as the prediction log has it, against the deadline as it is now. Facts only:
// the board hears of a deadline when its finish passes it or it asks, and a tight or shrinking margin is the agent's to
// plan with (the call's and the intercom's briefings); nothing records what was told: the agent reads that in the calls
// and the intercom.
import { findProject, findThread } from './projects.ts';
import { threadAt } from './predictionlog.ts';
import type { ThreadOutlook } from './forecast.ts';

// The slack's trend: how it stood this many hours ago.
const TREND_HOURS = [6, 24];
const HOUR_MS = 3_600_000;

// finish: merged and deployed with the change (null: no finish in sight). before: without it (null: none in sight;
// left out: the thread had no open work then, or there's no play before). trend: its slack then, the latest each has in
// the log (null: no finish in sight then; a point is left out when the log has nothing that old).
export type Deadline = {
  thread: string;
  project: string;
  name: string;
  deadline: number;
  aim: number | null;
  by: string | null;
  finish: number | null;
  slack_ms: number | null;
  before?: number | null;
  trend: { hours: number; slack_ms: number | null }[];
};

// Every open thread with a window in the play after, the soonest deadline first.
export function agreed(
  later: Map<string, ThreadOutlook>,
  earlier: Map<string, ThreadOutlook> | undefined,
  deployLagMs: number,
  now: number,
): Deadline[] {
  return [...later.values()]
    .flatMap(o => {
      const thread = findThread(o.thread);
      if (o.deadline === null || thread?.status !== 'open') return [];
      const before = earlier && earlier.has(o.thread) ? { before: earlier.get(o.thread)!.finish } : {};
      return [
        {
          ...{ thread: o.thread, project: findProject(thread.project)?.name ?? thread.project, name: thread.name },
          ...{ deadline: o.deadline, aim: o.aim, by: thread.deadline_by, finish: o.finish, slack_ms: o.slack },
          ...before,
          trend: trend(o.thread, o.deadline, deployLagMs, now),
        },
      ];
    })
    .sort((a, b) => a.deadline - b.deadline || a.thread.localeCompare(b.thread));
}

// The thread's slack each TREND_HOURS ago: its ETA then against today's deadline.
function trend(thread: string, deadline: number, deployLagMs: number, now: number) {
  return TREND_HOURS.flatMap(hours => {
    const row = threadAt(thread, now - hours * HOUR_MS);
    if (!row) return [];
    return [{ hours, slack_ms: row.merged === null ? null : deadline - (row.merged + deployLagMs) }];
  });
}
