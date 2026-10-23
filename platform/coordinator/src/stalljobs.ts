// HQ stood still behind one step (latency.ts stalledBy): every request waited, the board's HQ too. The process role
// (org.yaml's roles) gets a job to make that step quick: one job per cause, not one per stall. A cause is the step's
// name without its numbers ("the play's parts: played 634 ms" is the same step each minute), and every request is one
// cause: a request's hold is its time from start to answer, so one that only waited out another's stall holds as long.
// While a cause's job is queued, a new stall is added to its brief; once it has started, it holds the alarm until its
// work is deployed (or never will be: wakes.ts deployed).
import { db, setting, remember } from './db.ts';
import { createJob } from './jobs.ts';
import { roles } from './company.ts';
import { deployed } from './wakes.ts';
import type { Hold } from './latency.ts';

const causeOf = (name: string) => (/^[A-Z]+ \//.test(name) ? 'requests' : name.replace(/\d+/g, 'n'));

export function stalled(hold: Hold, late: number, now = Date.now()) {
  const cause = causeOf(hold.name),
    key = `stalljob:${cause}`,
    open = Number(setting(key)) || 0,
    s = (late / 1000).toFixed(1),
    stall = `\n- At ${new Date(now).toISOString()}: ${s} s behind ${hold.name}.`;
  if (open && addTo(open, stall)) return;
  if (open && !deployed(String(open))) return;
  const { id } = createJob({
    agent: roles().process,
    title: `HQ stood still ${s} s behind ${hold.name}: make it quick`,
    prompt: `HQ's coordinator stood still for ${s} s: one step, ${hold.name}, held its event loop that long, so every request waited behind it, the board's HQ included (the status report's holds, latency.ts).

Find what makes that step slow and make it quick: the same work done once instead of once per item, less read, or work that isn't the request's moved off it. Measure the step before and after on data of HQ's size, and say both times in your report. ${
      cause === 'requests'
        ? "A request's hold is its time from start to answer, so one that only waited out another step's stall is named too: the requests below are one cause until you find otherwise. "
        : ''
    }The same cause stalling again before your work is deployed queues no second job: until you start, each stall is added below.

The stalls:${stall}`,
  });
  remember(key, String(id));
}

// A stall added to its cause's job, if that job hasn't started yet
const addTo = (job: number, stall: string) =>
  db
    .prepare(`update jobs set prompt = prompt || ? where id = ? and status = 'queued' and session is null`)
    .run(stall, job).changes > 0;
