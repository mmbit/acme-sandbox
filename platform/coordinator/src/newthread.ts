// A thread drawn in its project's plan: by hq plan thread (plan.ts), and for the job that starts it (hq job --thread
// new:, a review's findings: reviewwork.ts), the one way a thread starts but HQ's own one-task ones (made.ts). Only the
// project's owner and the CEO draw one, refused before anything is written; each is logged in plan_changes. Kept apart
// from plan.ts, whose imports run at load, so the claim's modules can reach it.
import { db, planChange } from './db.ts';
import {
  createThread,
  findProject,
  findThread,
  threadForJob,
  type JobThreadAsk,
  type Queuer,
  type Thread,
} from './projects.ts';
import { noProject, placeOf, taskClash } from './names.ts';
import { refusal } from './threadorder.ts';

// hq plan thread: a new thread in the project, owned by its owner, with the threads it needs. The answer carries where it
// is, as the board reads it (names.ts placeOf).
// task: the title of the task it's drawn for (hq job, hq inbox accept), never the thread's name.
export function newThread(
  t: { project: string; name: unknown; goal: unknown; needs?: unknown[]; slug?: string; task?: string },
  by: { agent: string; job?: number },
) {
  const project = findProject(t.project);
  if (!project) return noProject(t.project);
  const refused = refusal(project, by.agent);
  if (refused) return refused;
  const titled =
    t.task === undefined ? undefined : taskClash(t.task, { name: String(t.name ?? ''), project: project.id });
  if (titled) return titled;
  // (a moved thread found by its old id: its new one, projects.ts findThread)
  const named = (t.needs ?? []).map(String),
    found = named.map(n => findThread(n));
  const missing = named.find((_, i) => !found[i]);
  if (missing !== undefined) return `there's no thread ${missing} to need (hq thread list)`;
  const needs = found.map(n => n!.id);
  const made = createThread({
    project: project.id,
    name: String(t.name ?? ''),
    goal: String(t.goal ?? ''),
    slug: t.slug,
    by: by.job,
  });
  if (typeof made === 'string') return made;
  planChange({ project: project.id, thread: made.id, what: `thread drawn: ${made.name}`, by: by.agent });
  for (const n of needs) addNeed(made, n, by.agent);
  return { ...made, needs, place: placeOf(made) };
}

export function addNeed(thread: Thread, needs: string, by: string) {
  db.prepare('insert or ignore into thread_needs (thread, needs) values (?, ?)').run(thread.id, needs);
  planChange({ project: thread.project, thread: thread.id, what: `needs ${needs}`, by });
}

// The thread a job queued by an agent serves: one started for it drawn as above (a project's owner's refusal a 409, as
// hq job's other refusals of a thread not the agent's: threadorder.ts jobRefusal), else the one it names or inherits
// (projects.ts threadForJob)
export function jobThread(ask: JobThreadAsk, queuer: Queuer): ReturnType<typeof threadForJob> {
  if (ask.newThread == null || ask.thread != null) return threadForJob(ask, queuer);
  const project = String(ask.newThread.project ?? '');
  const found = findProject(project);
  const notYours = found && refusal(found, queuer.agent);
  if (notYours) return { status: 409, refusal: notYours };
  const task = ask.title == null ? undefined : String(ask.title);
  const { name, goal } = ask.newThread;
  const drawn = newThread({ project, name, goal, task }, { agent: queuer.agent, job: queuer.job });
  return typeof drawn === 'string' ? { status: 400, refusal: drawn } : { thread: drawn.id };
}
