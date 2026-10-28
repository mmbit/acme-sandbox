// HQ stood still behind one step (latency.ts stalledBy): every request waited, the board's HQ too. The process role
// (org.yaml's roles) gets a job to make it quick. A cause is the step's name without its numbers ("the play's parts:
// played 634 ms" is the same step each minute), and every request is one cause: a request's hold is its time from start
// to answer, so one that only waited out another's stall holds as long. While a stall job is queued, every new stall, of
// any cause, is added to its brief, and its agent judges which are worth the work; once it has started, its causes hold
// the alarm until its work is deployed (or never will be: wakes.ts deployed). It is downtime work: a stall of a few
// seconds waits for the seats' spare room rather than taking it from the work they're for. Its title is a template's,
// so it waits for its sort into the project it's for (sorting.ts), like HQ's other template work.
import { db, inOneStep, setting, remember } from './db.ts';
import * as sorting from './sorting.ts';
import { createJob } from './jobs.ts';
import { roles } from './company.ts';
import { deployed } from './wakes.ts';
import type { Hold } from './latency.ts';

const QUEUED = 'stalljob:queued';
const causeOf = (name: string) => (/^[A-Z]+ \//.test(name) ? 'requests' : name.replace(/\d+/g, 'n'));

// (one step: the job, its prediction, the cause's job number and its hold for sorting written with one disk sync.)
export const stalled = (hold: Hold, late: number, now = Date.now()) => inOneStep(() => queueFor(hold, late, now));
function queueFor(hold: Hold, late: number, now: number) {
  const cause = causeOf(hold.name),
    key = `stalljob:${cause}`,
    open = Number(setting(key)) || 0,
    s = (late / 1000).toFixed(1),
    stall = `\n- At ${new Date(now).toISOString()}: ${s} s behind ${hold.name}.`;
  if (open && addTo(open, stall)) return;
  if (open && !deployed(String(open))) return;
  const queued = Number(setting(QUEUED)) || 0;
  if (queued && addTo(queued, stall)) {
    remember(key, String(queued));
    return;
  }
  const { id } = createJob({
    agent: roles().process,
    downtime: true,
    title: `HQ stood still ${s} s behind ${hold.name}: make it quick`,
    prompt: `HQ's coordinator stood still for ${s} s: a step, ${hold.name}, held its event loop that long, so every request waited behind it, the board's HQ included (the status report's holds, latency.ts).

Find what makes a step slow and make it quick: the same work done once instead of once per item, less read, or work that isn't the request's moved off it. Measure the step before and after on data of HQ's size, and say both times in your report. A request's hold is its time from start to answer, so one that only waited out another step's stall is named too: the requests below are one cause until you find otherwise. Until you start, every new stall is added below, whatever step held: judge which are worth the work (a step that keeps coming back, or holds long) and which were one-offs (a machine short of CPU, the first minutes after a deploy), make the ones worth it quick in this one change, and say in your report why you left the rest. The same causes stalling again before your work is deployed queue no second job.

The stalls:${stall}`,
  });
  remember(key, String(id));
  remember(QUEUED, String(id));
  sorting.hold(id, { from: 'hq', project: null, why: `HQ stood still behind ${hold.name}.` });
}

// A stall added to its cause's job, if that job hasn't started yet
const addTo = (job: number, stall: string) =>
  db
    .prepare(`update jobs set prompt = prompt || ? where id = ? and status = 'queued' and session is null`)
    .run(stall, job).changes > 0;
