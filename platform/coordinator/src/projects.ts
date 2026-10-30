// The board's projects board: the projects (HQ's projects table, company.ts projects), their threads (lines of work
// with a goal, in HQ's db, which any agent starts) and each project's sentence on where it stands, by its owner. A job
// serves one thread (jobs.thread), and the work it leads to inherits it (jobs.ts threadFrom).
// (its messages say deliverable, the board's word for a thread)
import { db, prepared } from './db.ts';
import { ceo, projects, type Project } from './company.ts';
import { deskLets, loopJobs, OPEN_JOBS, threadOf, WORK_LEAD } from './jobs.ts';
import { shedRefusal } from './pauses.ts';
import { publish } from './events.ts';
import { anyProject, checkThreadName, noProject, taskClash, threadClash } from './names.ts';
import { whereWorkGoes } from './wherework.ts';

// The threads table is in db.ts: the claim reads it.
db.exec(
  'create table if not exists project_notes (id integer primary key, project text not null, text text not null, by text not null, at text not null)',
);

export type ThreadStatus = 'open' | 'done';
export type Thread = {
  id: string;
  project: string;
  name: string;
  goal: string;
  status: ThreadStatus;
  created: string;
  by: number | null;
  done: string | null;
  // its window (windows.ts).
  deadline: number | null;
  aim: number | null;
  deadline_by: string | null;
  // its branch once its first task starts (plan.ts).
  branch: string | null;
  // the job HQ queued its owner to judge it once its work merged (threadjudge.ts).
  judge: number | null;
};

const SENTENCE_MAX = 400;
// A thread's slug, and a project's id (plan.ts).
export const SLUG = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const slugRefusal = (slug: string | undefined) =>
  slug !== undefined && !SLUG.test(slug) ? 'a slug is up to 24 lower-case letters, digits and dashes' : undefined;

export const findProject = (id: string): Project | undefined => projects().list.find(p => p.id === id);
// A thread moved to another project (regroup.ts) keeps answering to its old id, which queued briefs name.
db.exec('create table if not exists thread_aliases (old text primary key, id text not null)');
export function findThread(id: string) {
  const row = prepared(
    'select * from threads where id = coalesce((select id from thread_aliases where old = $id), $id)',
  ).get({ id });
  return row as Thread | undefined;
}
export const isOpen = (id: string) => findThread(id)?.status === 'open';
// A thread or proposal belongs to its project's owner, including a done project's. With no project, it belongs to
// the CEO.
export const ownerOf = (o: { project: string | null }) => (o.project === null ? ceo() : anyProject(o.project)!.owner);
// hq plan thread and --thread new: (newthread.ts newThread) and HQ's one-task threads
// (made.ts): a thread in a project, its slug made from its name unless given. The answer is the thread, or why not.
export function createThread(t: NewThread): Thread | string {
  const checked = checkThread(t);
  if (typeof checked === 'string') return checked;
  const { id, project, name, goal } = checked;
  db.prepare('insert into threads (id, project, name, goal, created, by) values (?, ?, ?, ?, ?, ?)').run(
    id,
    project.id,
    name,
    goal,
    new Date().toISOString(),
    t.by ?? null,
  );
  publish({ type: 'log', agent: project.owner, text: `New deliverable in ${project.name}: ${name}` });
  return findThread(id)!;
}

// The thread createThread would start (its id, project, name and goal as kept), or why it wouldn't. oneTask: HQ's own
// one-task thread, named after its job (made.ts oneTaskThread), which no name it shares refuses.
export type NewThread = {
  project: string;
  name: string;
  goal: string;
  slug?: string;
  by?: number;
  oneTask?: boolean;
};
function checkThread(t: NewThread): { id: string; project: Project; name: string; goal: string } | string {
  const project = findProject(t.project);
  if (!project) return noProject(t.project);
  const [name, goal] = [t.name, t.goal].map(oneLine);
  const named = checkThreadName(name, goal);
  if (named) return named;
  const clash = t.oneTask ? undefined : threadClash(project, name);
  if (clash) return clash;
  const badSlug = slugRefusal(t.slug);
  if (badSlug) return badSlug;
  const id = `${project.id}/${t.slug ?? freeSlug(project.id, name)}`;
  if (findThread(id)) return `${id} is already a deliverable: pick another slug`;
  return { id, project, name, goal };
}

// The name's first three words, then -2, -3 for one taken (a done thread's too: its jobs still name it)
function freeSlug(project: string, name: string) {
  const words = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]+/g, '')
    .split(' ')
    .filter(Boolean);
  const base = words.slice(0, 3).join('-').slice(0, 20).replace(/-+$/, '') || 'thread';
  let slug = base;
  for (let n = 2; findThread(`${project}/${slug}`); n++) slug = `${base}-${n}`;
  return slug;
}

// hq thread list: open threads (all with `all`), each with its owner (ownerOf) and how many open jobs it has
export function listThreads(o: { project?: string; all?: boolean } = {}) {
  const rows = db
    .prepare(
      `select t.id, t.project, t.name, t.goal, t.status, (select count(*) from jobs j where j.thread = t.id
      and j.status in ${OPEN_JOBS}) open
    from threads t where ($project is null or t.project = $project) and ($all = 1 or t.status = 'open')
      and t.project not in (select id from projects where status = 'done') order by t.project, t.created`,
    )
    .all({ project: o.project ?? null, all: o.all ? 1 : 0 }) as (Pick<
    Thread,
    'id' | 'project' | 'name' | 'goal' | 'status'
  > & { open: number })[];
  return rows.map(t => ({ ...t, owner: ownerOf(t) }));
}

// hq project say: the project's sentence, by its owner or the CEO
export function say(project: string, text: string, agent: string): { ok: true; at: string } | string {
  const found = findProject(project);
  if (!found) return noProject(project);
  if (![found.owner, ceo()].includes(agent))
    return `${found.name}'s sentence is ${found.owner}'s to write (or the CEO's)`;
  const sentence = oneLine(text);
  if (!sentence || sentence.length > SENTENCE_MAX) return `a sentence is one line of up to ${SENTENCE_MAX} characters`;
  const at = new Date().toISOString();
  db.prepare('insert into project_notes (project, text, by, at) values (?, ?, ?, ?)').run(
    found.id,
    sentence,
    agent,
    at,
  );
  return { ok: true, at };
}

const oneLine = (text: unknown) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();

export const sentenceOf = (project: string) =>
  db.prepare('select text, by, at from project_notes where project = ? order by id desc limit 1').get(project) as
    { text: string; by: string; at: string } | undefined;

// A claimed work job with the project its agent owns through the job's thread (ownsProject), whose sentence the worker's
// briefing asks it to keep true (closing.ts). The job is claimed already, so a failure here costs it only that step.
export function withOwnedProject<T extends { kind: string; agent: string; thread: string | null } | null>(job: T) {
  let owned;
  try {
    owned = job?.kind === 'work' ? ownedProject(job) : undefined;
  } catch (err) {
    console.error('Claimed job: no project step:', err);
  }
  return owned ? { ...job, ownsProject: owned } : job;
}

function ownedProject(job: { agent: string; thread: string | null }) {
  const project = job.thread ? findProject(findThread(job.thread)?.project ?? '') : undefined;
  return project?.owner === job.agent
    ? { id: project.id, name: project.name, sentence: sentenceOf(project.id)?.text ?? null }
    : undefined;
}

// The thread a job an agent queues serves (hq job --thread): one named (open), or else the queuing job's (createJob's
// from). A thread drawn for it is handled by newthread.ts jobThread.
// Where the company asks for threads, a job with no open one to inherit is refused, with how to draw one or join one,
// but the CEO's own (the desk's), a call's too. A refusal carries its HTTP status.
// A title the thread or its project has is refused (taskClash). newThread.needs: its --needs.
export type JobThreadAsk = {
  thread?: unknown;
  newThread?: { project?: unknown; name?: unknown; goal?: unknown; needs?: unknown };
  agent?: unknown;
  title?: unknown;
};
export type Queuer = { agent: string; job?: number };
export function threadForJob(
  ask: JobThreadAsk,
  queuer: Queuer,
): { thread: string } | { from?: number } | { status: 400 | 409; refusal: string } {
  if (ask.thread != null && ask.newThread != null)
    return { status: 400, refusal: 'name one deliverable, or start one: not both' };
  const titled = (thread: { id?: string; name: string; project: string }) =>
    ask.title == null ? undefined : taskClash(String(ask.title), thread);
  if (ask.thread != null) {
    const id = String(ask.thread);
    // (a moved thread found by its old id: its new one)
    const thread = findThread(id);
    if (thread?.status !== 'open')
      return { status: 409, refusal: `${id} isn't an open deliverable (hq deliverable list)` };
    const clashes = titled(thread);
    return clashes ? { status: 400, refusal: clashes } : { thread: thread.id };
  }
  // (a one-task thread HQ made for the queuer itself, made.ts oneTaskThread, holds that one task: hand-offs must name
  // their own thread rather than inherit its window.)
  const own = queuer.job ? threadOf(queuer.job) : null;
  const inherited = own?.endsWith(`/job-${queuer.job}`) ? null : own;
  const open = inherited ? findThread(inherited) : undefined;
  const clashes = open?.status === 'open' && titled(open);
  if (clashes) return { status: 400, refusal: clashes };
  // (the CEO's own work in no thread is the desk's: listProjectBoard. A call's work for anyone else names its thread, as
  // any hand-off does.)
  const desk = queuer.agent === ceo() && ask.agent === ceo();
  const refused = !desk && !(inherited && isOpen(inherited)) && noThreadRefusal(inherited, own);
  return refused ? { status: 409, refusal: refused } : own === inherited ? { from: queuer.job } : {};
}

// Why a job queued by hand with no thread to inherit, and none named, is refused, with how to draw one for it or join one.
// Undefined where the company doesn't ask for threads (projects.yaml requireThread).
function noThreadRefusal(inherited: string | null, own: string | null) {
  if (!projects().requireThread) return undefined;
  const why = inherited
    ? `its deliverable ${inherited} is done`
    : own
      ? `it's in ${own}, HQ's one-task wrapper, which holds only that task`
      : 'it has no open deliverable to inherit';
  return `name the deliverable this job serves, since ${why}. ${whereWorkGoes()}\n${threadChoices()}`;
}

// hq item link <item> job:<id> --thread <project>/<slug>: one job's work in no open thread (in none, or in one that's
// done) put on an open thread, so a call item's time can go on it: the job and its review loop's jobs (on its lead's
// branch, the lead included) that are in no open thread join it. Whoever links the item may, since it moves no work
// that's on an open thread, unless a pause holds it where it is (the desk's, on work in no thread: regroup.ts moveJob).
// The thread, or why not.
export function placeOn(job: number, id: string): Thread | string {
  // (a moved thread found by its old id: its new one)
  const thread = findThread(id);
  if (thread?.status !== 'open') return `${id} isn't an open deliverable (hq deliverable list)`;
  const had = threadOf(job);
  if (had && isOpen(had)) return `job #${job} is on ${had} already: its time goes there`;
  const { lead } = db.prepare(`select ${WORK_LEAD} lead from jobs j where j.id = ?`).get(job) as { lead: number };
  const loop = { job, lead, branch: `job/${lead}` };
  const moving = `(thread is null or thread not in (select id from threads where status = 'open'))
    and (id in ($job, $lead) or id in ${loopJobs('$branch')})`;
  const on = db
    .prepare(`select distinct thread from jobs where ${moving} and (thread is not null or not ${deskLets('jobs')})`)
    .all(loop) as { thread: string | null }[];
  const held = on.map(r => shedRefusal(r.thread, { project: thread.project, thread: thread.id })).find(Boolean);
  if (held) return held;
  db.prepare(`update jobs set thread = $thread where ${moving}`).run({ thread: thread.id, ...loop });
  return findThread(thread.id)!;
}

// Why a job with its item's time that would be in no thread is refused, wherever the company asks for threads or not:
// the time is a thread's window (windows.ts).
export const untimedRefusal = () =>
  `a window goes on the deliverable of its work, and this job would be in none: name the deliverable it serves, ${threadChoices()}`;

// (deliverables, the board's word for threads.) Drawing one for the work comes first, with the projects to draw it in:
// a list of every open deliverable invited picking the nearest, and work landed on ones it didn't serve (board, call
// 172). Joining one stays as easy for the agent who knows which it serves.
const threadChoices = () => {
  const open = projects().list;
  const where = open.length
    ? `Projects: ${open.map(p => `${p.id} (${p.owner})`).join(', ')}.`
    : 'There are no projects yet.';
  return `--deliverable new:<project> "name" "done when" draws its own with the job, its done when saying what this work delivers: the project's owner or the CEO draws one, anyone else proposes the work (hq propose --project <project>). A step of a feature whose deliverable you know joins it: --deliverable <project>/<slug> (hq deliverable <project>/<slug> shows its done when). ${where}`;
};

// ---- the board's view (projectboard.ts.)
export { getThread, listProjectBoard, needsOf } from './projectboard.ts';
