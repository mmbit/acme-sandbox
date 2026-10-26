// Each owner's planning job for a project: the one open takes the proposals and review findings that arrive for the
// project (proposals.ts tell), and reads its inbox when it starts. Split from proposals.ts.
import { db } from './db.ts';
import * as jobs from './jobs.ts';
import * as sorting from './sorting.ts'; // (the prompt)
import { oneTaskThread } from './made.ts';

// The owner's planning job for the project (null: no project's, the CEO's) still open (queued, running or blocked),
// whatever became of the proposals it was made for.
export const openPlanning = (owner: string, project: string | null) =>
  db
    .prepare(
      `select j.id, j.status from planning_jobs p join jobs j on j.id = p.job where p.agent = ? and p.project is ?
      and j.status in ${jobs.OPEN_JOBS} order by j.id desc`,
    )
    .get(owner, project) as { id: number; status: string } | undefined;

// The project a planning job sorts for (null: no project's), or undefined for any other job
export const planningProject = (job: number) =>
  (db.prepare('select project from planning_jobs where job = ?').get(job) as { project: string | null } | undefined)
    ?.project;

// An owner's planning job goes in the project it sorts for, a one-task thread there that ends with the job
// (threadends.ts endedEmpty); one for no project's proposals is the CEO's, in none.
export function planningJob(owner: string, project: string | null) {
  const title = 'Sort new proposals into the plan';
  const { id } = jobs.createJob({ agent: owner, title, prompt: sorting.planning(project), thread: null });
  db.prepare('insert into planning_jobs (job, agent, project) values (?, ?, ?)').run(id, owner, project);
  oneTaskThread(project, { id, title });
  return id;
}
