// Each owner's planning job: the one open takes the proposals and review findings that arrive for the owner
// (proposals.ts tell), and reads the whole inbox when it starts. Split from proposals.ts.
import { db } from './db.ts';
import * as jobs from './jobs.ts';
import * as sorting from './sorting.ts'; // (the prompt)

// The owner's planning job still open (queued, running or blocked), whatever became of the proposals it was made for
export const openPlanning = (owner: string) =>
  db
    .prepare(
      `select j.id, j.status from planning_jobs p join jobs j on j.id = p.job where p.agent = ? and j.status in ${jobs.OPEN_JOBS}
      order by j.id desc`,
    )
    .get(owner) as { id: number; status: string } | undefined;

// Planning jobs coordinate projects without producing a project deliverable, so they have no thread.
export function planningJob(owner: string) {
  const title = 'Sort new proposals into the plan';
  const { id } = jobs.createJob({ agent: owner, title, prompt: sorting.planning(), thread: null });
  db.prepare('insert into planning_jobs (job, agent) values (?, ?)').run(id, owner);
  return id;
}
