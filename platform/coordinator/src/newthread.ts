// A thread drawn in its project's plan: by hq plan thread (plan.ts), and for the job that starts it (hq job --thread
// new:, a review's findings: reviewwork.ts), the one way a thread starts but HQ's own one-task ones (made.ts). Only the
// project's owner and the CEO draw one, refused before anything is written; each is logged in plan_changes. Kept apart
// from plan.ts, whose imports run at load, so the claim's modules can reach it.
// One chain is the default: a thread drawn with no needs named waits for the last one in the chain it most likely
// continues (chainedAfter), and running beside it is a later step with a reason (plan.ts unneed).
// (its messages say deliverable, the board's word for a thread)
import { db, planChange } from './db.ts';
import { OPEN_JOBS, OPEN_PRS, pausedWith, threadOf } from './jobs.ts';
import * as redraws from './redraws.ts';
import {
  createThread,
  findProject,
  findThread,
  needsOf,
  threadForJob,
  type JobThreadAsk,
  type Queuer,
  type Thread,
} from './projects.ts';
import { noProject, placeOf, taskClash } from './names.ts';
import { oneTaskSql } from './made.ts';
import { refusal } from './threadorder.ts';
import { SIDE_BY_SIDE } from '../../worker/hq/levels.ts';

// hq plan thread: a new thread in the project, owned by its owner, with the threads it needs: those named, else the one
// it chains after. The answer carries where it is, as the board reads it (names.ts placeOf), and its chain's words.
// task: the title of the task it's drawn for (hq job, hq inbox accept), never the thread's name.
export function newThread(
  t: { project: string; name: unknown; goal: unknown; needs?: unknown; slug?: string; task?: string },
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
  const named = [t.needs ?? []].flat().map(String),
    found = named.map(n => findThread(n));
  const missing = named.find((_, i) => !found[i]);
  if (missing !== undefined) return `there's no deliverable ${missing} to need (hq deliverable list)`;
  const chained = named.length ? {} : chainedAfter(project.id, by.job);
  const needs = chained.after ? [chained.after] : found.map(n => n!.id);
  const made = createThread({
    project: project.id,
    name: String(t.name ?? ''),
    goal: String(t.goal ?? ''),
    slug: t.slug,
    by: by.job,
  });
  if (typeof made === 'string') return made;
  planChange({ project: project.id, thread: made.id, what: `deliverable drawn: ${made.name}`, by: by.agent });
  for (const n of needs) addNeed(made, n, by.agent);
  return { ...made, needs, place: placeOf(made), chain: chainWords(made.id, chained.paused) };
}

// The thread a new one in the project chains after when it names none, in two steps: the thread under way it most
// likely continues (the drawing job's own, else the project's newest), then the newest open one chained from it, one
// drawn but given no work yet too, so draws in a row chain one after another. Under way: open work, or a pull request
// not merged yet. HQ's one-task wrapper for a job of its own is passed over, and so is a paused one, so new work isn't
// held by a pause it was never part of: that one is named (paused) for the drawer to judge.
function chainedAfter(project: string, job: number | undefined): { after?: string; paused?: string } {
  const own = job ? threadOf(job) : null;
  const underWay = `(exists (select 1 from jobs j where j.thread = t.id and j.status in ${OPEN_JOBS})
    or exists (select 1 from prs p where p.branch = t.branch and p.status in ${OPEN_PRS}))`;
  const chainedFrom = `t.id in (with recursive chained(id) as (select $start
    union select n.thread from thread_needs n join chained c on n.needs = c.id) select id from chained)`;
  const lastIn = (pausedToo: boolean) => {
    const newest = (where: string, at: Record<string, string>) => newestOpen(project, where, at, pausedToo);
    const start = (own && newest(`t.id = $own and ${underWay}`, { own })) || newest(underWay, {});
    return start && newest(chainedFrom, { start: start.id });
  };
  const passed = lastIn(true);
  return { after: lastIn(false)?.id, paused: passed?.paused ? passed.id : undefined };
}

// The project's newest open thread where `where` holds (its paused ones left out unless pausedToo), never a one-task
// wrapper, with the pause it's held by
function newestOpen(project: string, where: string, at: Record<string, string>, pausedToo: boolean) {
  const unpaused = pausedToo ? '' : `and ${pausedWith('t.id')} is null`;
  return db
    .prepare(
      redraws.query(`select t.id, ${pausedWith('t.id')} paused from threads t where t.project = $project
        and t.status = 'open' and not ${oneTaskSql('t.id')} ${unpaused} and ${where}
        order by t.created desc, t.rowid desc limit 1`),
    )
    .get({ project, ...at }) as { id: string; paused: string | null } | undefined;
}

// What a drawn thread's needs mean for its work, said where it's drawn (hq plan deliverable, hq job and hq inbox accept
// with --deliverable new:): one deliverable after another, and when and how it may run beside them instead; and a
// paused one its chain passed over.
function chainWords(thread: string, paused: string | undefined): string | undefined {
  const passed = paused
    ? `${paused} is paused and was passed over: if this work changes its files, hq plan need ${thread} ${paused}.`
    : undefined;
  const needs = needsOf(thread);
  if (!needs.length) return passed;
  const after = needs.join(' and ');
  return (
    `It starts once ${after} ${needs.length === 1 ? 'is' : 'are'} done and merged, one after the other, so their ` +
    `work never collides. A step of the same feature goes in ${needs.length === 1 ? 'that deliverable' : 'one of them'} ` +
    `instead (hq job --deliverable, or hq job move for a queued task). Running beside one is a later choice, with ` +
    `why: hq plan unneed ${thread} <deliverable> "why". ${SIDE_BY_SIDE}` +
    (passed ? ` ${passed}` : '')
  );
}

export function addNeed(thread: Thread, needs: string, by: string) {
  db.prepare('insert or ignore into thread_needs (thread, needs) values (?, ?)').run(thread.id, needs);
  planChange({ project: thread.project, thread: thread.id, what: `needs ${needs}`, by });
}

// The thread a job queued by an agent serves: one started for it drawn as above, with its chain's words (a project's
// owner's refusal a 409, as hq job's other refusals of a thread not the agent's: threadorder.ts jobRefusal), else the one
// it names or inherits (projects.ts threadForJob)
export function jobThread(ask: JobThreadAsk, queuer: Queuer): ReturnType<typeof threadForJob> & { chain?: string } {
  if (ask.newThread == null || ask.thread != null) return threadForJob(ask, queuer);
  const project = String(ask.newThread.project ?? '');
  const found = findProject(project);
  const notYours = found && refusal(found, queuer.agent);
  if (notYours) return { status: 409, refusal: notYours };
  const task = ask.title == null ? undefined : String(ask.title);
  const { name, goal, needs } = ask.newThread;
  const drawn = newThread({ project, name, goal, needs, task }, { agent: queuer.agent, job: queuer.job });
  return typeof drawn === 'string' ? { status: 400, refusal: drawn } : { thread: drawn.id, chain: drawn.chain };
}
