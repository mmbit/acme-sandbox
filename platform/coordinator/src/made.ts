// The jobs HQ makes itself, each on a one-task thread of its own: the project projects.yaml's `made:` names for its kind
// and app (company.ts), and a repair's in the project its product declares (product.yaml `project:`). The owner's planning
// job (proposals.ts) is in none.
import { db, planChange } from './db.ts';
import { projects, type MadeKind } from './company.ts';
import { manifest } from './manifests.ts';
import { leadOf } from './ordering.ts';
import { createThread } from './projects.ts';
import { anyProject, NAME_MAX } from './names.ts';
import { set as setWindow, type Window } from './windows.ts';
import { codeIn } from './jobcodes.ts';

// The window HQ gives a job it makes: a deadline and aim of its own, or `asap` (urgent: as soon as it can from that
// time), a deadline as far after it as the claim's backward pass plans the job's run, its review rounds and the deploy
// after them (ordering.ts leadOf), so its latest start is then and, started then, it's done on time. Its aim is the
// same: urgent work mustn't give.
export type Due = Window | { asap: number };

// HQ's own job as a one-task thread of its own in the project: named after the job, done when it's merged. The job's
// thread is set to it, with its window if HQ gives it one. Without the project, or with it done, the job stays in none,
// which a job with a window can't: that throws (the company's projects.yaml or product.yaml is missing its project).
export function oneTaskThread(project: string | null | undefined, job: { id: number; title: string }, due?: Due) {
  const named = project ? anyProject(project) : undefined;
  if (!project || named!.status === 'done') {
    const where = project ? `its project ${project} is done` : 'it has no project';
    if (due) throw new Error(`Job #${job.id} (${job.title}) is given a window, but ${where} to keep it in`);
    return null;
  }
  const { id: projectId } = named!;
  const name = job.title.length > NAME_MAX ? `${job.title.slice(0, NAME_MAX - 1)}…` : job.title;
  const made = createThread({
    project: projectId,
    name,
    goal: `Job #${job.id}'s work is done and merged`,
    slug: `job-${job.id}`,
    oneTask: true,
  });
  if (typeof made === 'string') throw new Error(`A one-task thread for job #${job.id}: ${made}`);
  db.prepare('update jobs set thread = ? where id = ?').run(made.id, job.id);
  planChange({ project: projectId, thread: made.id, what: `one-task thread for job #${job.id}`, by: 'hq' });
  if (due && 'asap' in due) {
    const deadline = due.asap + leadOf(job.id, made.id, due.asap);
    setWindow(made, { deadline, aim: deadline }, 'hq');
  } else if (due) setWindow(made, due, 'hq');
  return made.id;
}

// Whether a thread is HQ's one-task thread for a job of its own (as oneTaskThread names it).
export function oneTask(thread: string) {
  const job = Number(thread.match(/\/job-(\d+)$/)?.[1]);
  return !!job && !!db.prepare('select 1 from jobs where id = ? and thread = ?').get(job, thread);
}

// A job HQ made from a template, in the project projects.yaml's made sets for its kind and app (a one-task thread there),
// else in none, with its window if given (oneTaskThread). The answer is the job's id.
export function made(kind: MadeKind, app: string, job: { id: number; title?: string }, due?: Due) {
  oneTaskThread(projects().made[kind]?.[app], titled(job), due);
  return job.id;
}

// A job HQ made about a product (the watch's about a live app: watch.ts), the same way in the project its product.yaml
// declares (`project:`)
export function madeForProduct(app: string, job: { id: number; title?: string }, due?: Due) {
  oneTaskThread(manifest(app)?.project as string | undefined, titled(job), due);
  return job.id;
}

// The code of a standing job of HQ's this kind and app (each run of it: jobcodes.ts), its word in the project made()
// puts it in, as it's made.
export function madeCode(kind: MadeKind, app: string, word: string) {
  const project = projects().made[kind]?.[app],
    named = project ? anyProject(project) : undefined;
  return codeIn(project && named!.status !== 'done' ? { project: named!.id } : null, word);
}

const titled = (job: { id: number; title?: string }) => ({
  id: job.id,
  title: job.title ?? (db.prepare('select title from jobs where id = ?').get(job.id) as { title: string }).title,
});
