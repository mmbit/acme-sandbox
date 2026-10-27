// Windowed work's played push-to-merge time, counted once per job from its latest kept input.
import { median } from './arithmetic.ts';
import type { Play } from './backtest.ts';
import type { Listed } from './snapshots.ts';

const MINUTE_MS = 60_000;
const SMALL_MS = 30 * MINUTE_MS;

type Duration = { job: number; small: boolean; milliseconds: number | null };

// Old snapshots cannot supply the run sizes and panel for played rounds, so replay excludes them.
export async function scoreRounds(listed: Listed[], playIt: Play) {
  const available = listed.filter(l => l.planner === 3).sort((a, b) => a.at - b.at);
  const latest = new Map<number, number>();
  for (const [i, { work }] of available.entries())
    for (const job of work) if (job.due !== null && job.planned) latest.set(job.id, i);
  const durations: Duration[] = [];
  for (const i of new Set(latest.values())) {
    const { snapshot, sizes } = available[i].read();
    const usual = new Map(sizes.usual);
    const outlooks = playIt(snapshot, usual);
    for (const [job, index] of latest) {
      if (index !== i) continue;
      const outlook = outlooks.get(job)!;
      const milliseconds =
        outlook.done === null || outlook.merged === null ? null : Math.max(0, outlook.merged - outlook.done);
      durations.push({ job, small: usual.get(job)!.agent_ms <= SMALL_MS, milliseconds });
    }
    await new Promise(setImmediate);
  }
  return {
    snapshots: available.length,
    total_snapshots: listed.length,
    small_up_to_minutes: SMALL_MS / MINUTE_MS,
    groups: [
      summarize(
        'small',
        durations.filter(d => d.small),
      ),
      summarize(
        'large',
        durations.filter(d => !d.small),
      ),
    ],
  };
}

function summarize(size: 'small' | 'large', durations: Duration[]) {
  const merged = durations.flatMap(d => (d.milliseconds === null ? [] : [d.milliseconds]));
  const middle = median(merged);
  return {
    size,
    count: durations.length,
    no_merge: durations.length - merged.length,
    median_minutes: middle === null ? null : Math.round(middle / MINUTE_MS),
    worst_minutes: merged.length ? Math.round(Math.max(...merged) / MINUTE_MS) : null,
  };
}
