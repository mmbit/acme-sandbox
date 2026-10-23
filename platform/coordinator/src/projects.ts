// The board's projects board: the projects (HQ's projects table, company.ts projects), their threads (lines of work
// with a goal, in HQ's db, which any agent starts) and each project's sentence on where it stands, by its owner. A job
// serves one thread (jobs.thread), and the work it leads to inherits it (jobs.ts threadFrom).
import { db, mergePending, prepared } from './db.ts';
import { ceo, projects, type Project } from './company.ts';
import { isOpenJob, jobRows, loopBranch, OPEN_JOBS, threadOf, WORK_LEAD } from './jobs.ts';
import { publish } from './events.ts';
import { anyProject, checkThreadName, noProject, taskClash, threadClash } from './names.ts';
import { doneSince, linesOf, tally } from './tallies.ts';
import { inBoardOrder } from './projectorder.ts';
import { routines } from './schedule.ts';
import { boardJobs, boardProject, boardSentence, boardThread } from './boardnames.ts';
import { withFindings } from './reviewrows.ts';

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
};

const SENTENCE_MAX = 400;
// A thread's slug, and a project's id (plan.ts).
export const SLUG = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const slugRefusal = (slug: string | undefined) =>
  slug !== undefined && !SLUG.test(slug) ? 'a slug is up to 24 lower-case letters, digits and dashes' : undefined;

export const findProject = (id: string): Project | undefined => projects().list.find(p => p.id === id);
// A thread moved to another project (regroup.ts) keeps answering to its old id, which queued briefs name.
db.exec('create table if not exists thread_aliases (old text primary key, id text not null)');
// (its own owner column left out: a thread's owner is its project's, ownerOf.)
export function findThread(id: string) {
  const row = prepared(
    'select * from threads where id = coalesce((select id from thread_aliases where old = $id), $id)',
  ).get({ id }) as (Thread & { owner: string }) | undefined;
  if (!row) return undefined;
  const { owner: _column, ...thread } = row;
  return thread as Thread;
}
export const isOpen = (id: string) => findThread(id)?.status === 'open';
// A thread or proposal belongs to its project's owner, including a done project's. With no project, it belongs to
// the CEO. The thread's own owner column is written but never read.
export const ownerOf = (o: { project: string | null }) => (o.project === null ? ceo() : anyProject(o.project)!.owner);
// hq plan thread and --thread new: (newthread.ts newThread) and HQ's one-task threads
// (made.ts): a thread in a project, its slug made from its name unless given. The answer is the thread, or why not.
export function createThread(t: NewThread): Thread | string {
  const checked = checkThread(t);
  if (typeof checked === 'string') return checked;
  const { id, project, name, goal } = checked;
  db.prepare('insert into threads (id, project, name, owner, goal, created, by) values (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    project.id,
    name,
    project.owner,
    goal,
    new Date().toISOString(),
    t.by ?? null,
  );
  publish({ type: 'log', agent: project.owner, text: `New thread in ${project.name}: ${name}` });
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
  if (findThread(id)) return `${id} is already a thread: pick another slug`;
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
// Where the company asks for threads, a job with no open one to inherit is refused, with the open ones listed, except on
// a live call: the board isn't kept waiting on the line. A call's job with a time still needs a thread (server.ts hq
// job). A refusal carries its HTTP status.
// A title the thread or its project has is refused (taskClash).
export type JobThreadAsk = {
  thread?: unknown;
  newThread?: { project?: unknown; name?: unknown; goal?: unknown };
  agent?: unknown;
  title?: unknown;
};
export type Queuer = { agent: string; job?: number; onCall: boolean };
export function threadForJob(
  ask: JobThreadAsk,
  queuer: Queuer,
): { thread: string } | { from?: number } | { status: 400 | 409; refusal: string } {
  if (ask.thread != null && ask.newThread != null)
    return { status: 400, refusal: 'name one thread, or start one: not both' };
  const titled = (thread: { id?: string; name: string; project: string }) =>
    ask.title == null ? undefined : taskClash(String(ask.title), thread);
  if (ask.thread != null) {
    const id = String(ask.thread);
    // (a moved thread found by its old id: its new one)
    const thread = findThread(id);
    if (thread?.status !== 'open') return { status: 409, refusal: `${id} isn't an open thread (hq thread list)` };
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
  // (the CEO's own work in no thread is the desk's: listProjectBoard.)
  const desk = queuer.agent === ceo() && ask.agent === ceo();
  const refused = !queuer.onCall && !desk && !(inherited && isOpen(inherited)) && noThreadRefusal(inherited, own);
  return refused ? { status: 409, refusal: refused } : own === inherited ? { from: queuer.job } : {};
}

// Why a job queued by hand with no thread to inherit, and none named, is refused, with the open threads to pick from.
// Undefined where the company doesn't ask for threads (projects.yaml requireThread).
function noThreadRefusal(inherited: string | null, own: string | null) {
  if (!projects().requireThread) return undefined;
  const why = inherited
    ? `its thread ${inherited} is done`
    : own
      ? `its thread ${own} is HQ's one-task thread, which holds only that task`
      : 'it has no open thread to inherit';
  return `name the thread this job serves, since ${why}: ${threadChoices()}`;
}

// hq item link <item> job:<id> --thread <project>/<slug>: one job's work in no open thread (in none, or in one that's
// done) put on an open thread, so a call item's time can go on it: the job and its review loop's jobs (on its lead's
// branch, the lead included) that are in no open thread join it. Whoever links the item may, since it moves no work
// that's on an open thread. The thread, or why not.
export function placeOn(job: number, id: string): Thread | string {
  // (a moved thread found by its old id: its new one)
  const thread = findThread(id);
  if (thread?.status !== 'open') return `${id} isn't an open thread (hq thread list)`;
  const had = threadOf(job);
  if (had && isOpen(had)) return `job #${job} is on ${had} already: its time goes there`;
  const { lead } = db.prepare(`select ${WORK_LEAD} lead from jobs j where j.id = ?`).get(job) as { lead: number };
  db.prepare(
    `update jobs set thread = $thread where (thread is null or thread not in (select id from threads where status = 'open'))
    and (id in ($job, $lead) or ${loopBranch('jobs')} = $branch)`,
  ).run({ thread: thread.id, job, lead, branch: `job/${lead}` });
  return findThread(thread.id)!;
}

// Why a job with its item's time that would be in no thread is refused, wherever the company asks for threads or not:
// the time is a thread's window (windows.ts).
export const untimedRefusal = () =>
  `a window goes on the thread of its work, and this job would be in none: name the thread it serves, ${threadChoices()}`;

const threadChoices = () => {
  const open = listThreads();
  const choices = open.length
    ? `Open threads:\n${open.map(t => `  ${t.id}  ${t.name} (${t.owner}), done when ${t.goal}`).join('\n')}`
    : 'There are no open threads yet.';
  return `--thread <project>/<slug>. The project's owner or the CEO may start one with --thread new:<project> "name" "done when". ${choices}`;
};

// ---- the board's view

// GET /api/projects: the businesses the projects are grouped under and the side groups (company.ts projects), then
// projects with their owner's latest sentence and threads. A thread is ongoing while it has work that can still merge
// (open jobs, or done ones whose pull request is still in review: jobs.ts mergePending), or is open with no jobs yet,
// and its jobs come along, finished ones included. The rest are done (closed, or all their work finished) and show
// tallies (getThread has their jobs). Jobs read as GET /api/jobs words
// them (jobs.ts jobRows). A routine's project (schedule.ts keepProjects) carries its schedule (schedule.ts routines), its
// runs its threads. Jobs outside known threads are unsorted: the open ones, then
// the latest finished (recentLoose).
// Unsorted is the CEO's desk: call follow-ups and the CEO's own work, and other work outside the projects for the CEO
// to place.
// Each job has its place in its thread (seq), a thread's owner is its project's, and it lists the threads it needs
// (plan.ts). done threads' owners too:
// completed: the projects done (hq project done, plan.ts), the latest first, each with its done time and threads, for the
// view's ongoing / completed switch; their jobs aren't loose.
// Each thread has its lines (tallies.ts linesOf), and the projects come in the board's order (projectorder.ts).
// A project carries its cover where projects.yaml names one (company.ts covers).
// Its projects', sentences', threads' and jobs' names are the board's (boardnames.ts).
export function listProjectBoard(t = Date.now()) {
  const threads = db.prepare('select * from threads order by created').all() as Thread[];
  const pending = pendingThreads();
  const rows = boardJobs(
    withFindings(
      jobRows(
        `j.thread in (select id from threads where status = 'open') or j.status in ${OPEN_JOBS}
    or j.thread in (select value from json_each($pending))`,
        t,
        { pending: JSON.stringify([...pending]) },
      ),
    ),
  );
  const schedules = routines();
  const jobsOf = (id: string) => rows.filter(j => j.thread === id);
  const ongoing = (th: Thread) => pending.has(th.id) || (th.status === 'open' && !jobsOf(th.id).length);
  const listed = projects().list.map(project => {
    const sentence = sentenceOf(project.id);
    const own = threads.filter(th => th.project === project.id);
    return {
      ...boardProject(project),
      cover: projects().covers[project.id],
      ...(schedules.has(project.id) && { schedule: schedules.get(project.id) }),
      sentence: sentence ? { ...boardSentence(project.id, sentence), since: doneSince(project.id, sentence.at) } : null,
      threads: own.filter(ongoing).map(th => ({
        ...shownThread(th),
        owner: project.owner,
        jobs: jobsOf(th.id),
      })),
      done: own.filter(th => !ongoing(th)).map(th => ({ ...boardThread(th), owner: project.owner, ...tally(th) })),
    };
  });
  const completed = completedProjects(threads),
    placed = new Set([...listed, ...completed].map(p => p.id));
  const known = new Set(threads.filter(th => placed.has(th.project)).map(th => th.id));
  const loose = [...rows.filter(j => isOpenJob(j) && !(j.thread && known.has(j.thread))), ...recentLoose(known, t)];
  return {
    businesses: projects().businesses,
    groups: projects().groups,
    projects: inBoardOrder(listed),
    completed,
    unsorted: loose,
  };
}

// The threads with work that can still merge (jobs.ts mergePending).
// (through the thread's index, which holds each job's state and branch: its rows hold their prompts and outputs.)
const pendingThreads = () =>
  new Set(
    (
      db
        .prepare(
          `select distinct j.thread from jobs j indexed by jobs_thread_state where j.thread is not null and ${mergePending('j')}`,
        )
        .all() as { thread: string }[]
    ).map(row => row.thread),
  );

// The projects done (hq project done), the latest first, each with when and its threads (all done) with their tallies.
const completedProjects = (threads: Thread[]) =>
  (
    db
      .prepare(
        "select id, name, owner, product, business, done from projects where status = 'done' order by done desc, rowid",
      )
      .all() as (Project & { done: string })[]
  ).map(p => ({
    ...boardProject(Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null)) as Project & { done: string }),
    threads: threads
      .filter(th => th.project === p.id)
      .map(th => ({ ...boardThread(th), owner: p.owner, ...tally(th) })),
  }));

// The latest RECENT finished jobs outside known threads, newest first.
const RECENT = 10;
function recentLoose(known: Set<string>, t: number) {
  const kept = db
    .prepare(
      `select id from jobs where status not in ${OPEN_JOBS} and (thread is null or thread not in (select value from
      json_each(?))) order by id desc limit ${RECENT}`,
    )
    .all(JSON.stringify([...known])) as { id: number }[];
  return kept.length ? boardJobs(jobRows(`j.id in (${kept.map(j => j.id).join(', ')})`, t)) : [];
}

// GET /api/projects/thread: one thread as the board's view has it, its jobs included however long it's been done (the
// view opens a done one from its project), or 404.
export function getThread(id: string, t = Date.now()) {
  const thread = findThread(id);
  if (!thread) return 404;
  // (a moved thread found by its old id: its new one)
  const jobs = boardJobs(withFindings(jobRows('j.thread = $thread', t, { thread: thread.id })));
  return { ...boardThread(thread), owner: ownerOf(thread), lines: linesOf(thread.id), jobs };
}

// A thread as the board's view shows it: with the threads it needs and its lines.
const shownThread = (th: Thread) => ({ ...boardThread(th), needs: needsOf(th.id), lines: linesOf(th.id) });

// The threads a thread needs (plan.ts draws them)
export const needsOf = (thread: string) =>
  (prepared('select needs from thread_needs where thread = ? order by needs').all(thread) as { needs: string }[]).map(
    n => n.needs,
  );
