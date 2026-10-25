// A project's plan: its threads, the threads each needs, and their tasks in order (../docs/projects.md).
// Only the project's owner and the CEO change it (hq plan, hq project new | owner | rename | business, the CEO's); anyone else
// proposes (hq propose, proposals.ts). Names show their level and no two levels share one (names.ts threadClash;
// hq plan rename | title, hq project rename | done). Every change is logged in plan_changes (db.ts planChange). While the company's
// planning setting is off (projects.yaml `planning:`), the claim, the worker and the review panel don't read any of it.
import { db, planChange } from './db.ts';
import * as redraws from './redraws.ts';
import { publish } from './events.ts';
import { oneTask } from './made.ts';
import { ceo, projects, type Project } from './company.ts';
import { findProject, findThread, listThreads, needsOf, SLUG, slugRefusal, type Thread } from './projects.ts';
import { addNeed, newThread } from './newthread.ts';
import { checkThreadName, noProject, placeOf, projectClash, taskClash, threadClash } from './names.ts';
import { newId } from './regroup.ts';
import { DESK, OPEN_JOBS, nameOf, type Named } from './jobs.ts';
// (who may change a plan: threadorder.ts, which the claim's refusals read too.)
import { refusal, inNeedsOrder } from './threadorder.ts';
import * as ledger from './ledger.ts';
import { ownerChanged, untold } from './proposals.ts';
import { oneLine } from './agreements.ts';
import { outlookOf } from './outlooks.ts';
import type { Forecast } from './forecast.ts';
import { levelsOf, splitMarks } from './levels.ts';
import { PREFIX } from './jobcodes.ts';

const NAME_MAX = 80,
  TITLE_MAX = 140,
  WHY_MAX = 300;

// hq plan thread (newthread.ts, with hq job --thread new:).
export { newThread };

// hq plan rename: an open thread's name, maybe its "done when", maybe its slug. A new slug makes it <project>/<slug>,
// everything naming it following and its old id resolving, as hq thread move does (regroup.ts newId). The thread with
// its place, or why not.
export function rename(id: string, to: { name: unknown; goal?: unknown; slug?: unknown }, agent: string) {
  const own = ownThread(id, agent);
  if (typeof own === 'string') return own;
  const { thread, project } = own;
  if (thread.status !== 'open') return `${thread.id} is done: only an open thread is renamed`;
  const [name, goal] = [to.name, to.goal ?? thread.goal].map(line);
  const wrong = checkThreadName(name, goal);
  if (wrong) return wrong;
  const clash = threadClash(project, name, thread.id);
  if (clash) return clash;
  const slug = to.slug == null ? undefined : String(to.slug);
  const badSlug = slugRefusal(slug);
  if (badSlug) return badSlug;
  const moved = slug === undefined ? thread.id : `${project.id}/${slug}`;
  // (its own old id may come back: regroup.ts newId drops that alias)
  if (findThread(moved) && findThread(moved)!.id !== thread.id)
    return `${moved} is already a thread (or was one): pick another slug`;
  if (name === thread.name && goal === thread.goal && moved === thread.id) return `${thread.id} is named that already`;
  if (moved !== thread.id) newId(thread.id, moved, project.id);
  db.prepare('update threads set name = ?, goal = ? where id = ?').run(name, goal, moved);
  const said = [
    name !== thread.name && `name ${thread.name} → ${name}`,
    goal !== thread.goal && `done when ${goal}`,
    moved !== thread.id && `id ${thread.id} → ${moved}`,
  ];
  planChange({
    project: project.id,
    thread: moved,
    what: `thread renamed: ${said.filter(Boolean).join('; ')}`,
    by: agent,
  });
  const renamed = findThread(moved)!;
  return { ...renamed, was: thread.id, place: placeOf(renamed) };
}

// hq plan title: a task still to start gets a new title, never its thread's or its project's
export function title(job: number, to: unknown, agent: string) {
  const own = ownTask(job, agent);
  if (typeof own === 'string') return own;
  const said = line(to);
  if (!said || said.length > TITLE_MAX) return `a task's title is one line of up to ${TITLE_MAX} characters`;
  const clash = taskClash(said, own.thread);
  if (clash) return clash;
  db.prepare('update jobs set title = ? where id = ?').run(said, job);
  planChange({ project: own.project.id, thread: own.thread.id, what: `task #${job} titled: ${said}`, by: agent });
  return { ok: true as const };
}

// hq project rename: the CEO's, the name only (a project under a new id is a new one, its threads moved there)
export function renameProject(id: string, to: unknown, agent: string) {
  if (agent !== ceo()) return 'only the CEO renames a project: a new id is hq project new, then hq thread move';
  const project = findProject(id);
  if (!project) return noProject(id);
  const name = line(to);
  if (!name || name.length > NAME_MAX) return `a project needs a name of one line, up to ${NAME_MAX} characters`;
  if (name === project.name) return `${id} is named that already`;
  const clash = projectClash(project, name);
  if (clash) return clash;
  db.prepare('update projects set name = ? where id = ?').run(name, id);
  planChange({ project: id, what: `project renamed: ${project.name} → ${name}`, by: agent });
  return findProject(id)!;
}

// hq project done (projectdone.ts: the schedule ends a routine's project by its rules too).
export { projectDone } from './projectdone.ts';

// hq plan need | unneed: a thread waits for another's merge, or no longer. A loop is refused at any depth, across projects.
export function need(id: string, needs: string, agent: string) {
  const own = ownThread(id, agent);
  if (typeof own === 'string') return own;
  const needed = findThread(needs);
  if (!needed) return `there's no thread ${needs} (hq thread list)`;
  const [from, to] = [own.thread.id, needed.id];
  if (from === to) return "a thread can't need itself";
  if (needsOf(from).includes(to)) return `${from} needs ${to} already`;
  if (reaches(to, from)) return `${to} needs ${from} already (or through others): that would be a loop`;
  const added = redraws.withoutLoop(from, () => addNeed(own.thread, to, agent));
  if (typeof added === 'string') return added;
  return { ok: true as const };
}
export function unneed(id: string, needs: string, agent: string) {
  const own = ownThread(id, agent);
  if (typeof own === 'string') return own;
  const needed = findThread(needs);
  if (!needed) return `there's no thread ${needs} (hq thread list)`;
  const [from, to] = [own.thread.id, needed.id];
  if (!db.prepare('delete from thread_needs where thread = ? and needs = ?').run(from, to).changes)
    return `${from} doesn't need ${to}`;
  planChange({ project: own.project.id, thread: from, what: `no longer needs ${to}`, by: agent });
  return { ok: true as const };
}
// hq plan move: the task to `place` (1: next) among its thread's tasks still to start. They keep the places they had
// between them, so a task added later still comes last.
export function move(job: number, place: number, agent: string) {
  const own = ownTask(job, agent);
  if (typeof own === 'string') return own;
  const tasks = queuedTasks(own.thread.id);
  if (!Number.isInteger(place) || place < 1 || place > tasks.length)
    return `${own.thread.id} has ${tasks.length} task${tasks.length === 1 ? '' : 's'} to start: a place is 1 to ${tasks.length}`;
  const ids = tasks.map(t => t.id).filter(id => id !== job);
  ids.splice(place - 1, 0, job);
  const set = db.prepare('update jobs set seq = ? where id = ?');
  const reorder = () => ids.forEach((id, i) => set.run(tasks[i].seq, id));
  const refused = redraws.withoutLoop(own.thread.id, reorder);
  if (typeof refused === 'string') return refused;
  planChange({
    project: own.project.id,
    thread: own.thread.id,
    what: `task #${job} moved to place ${place}`,
    by: agent,
  });
  return { ok: true as const, order: ids };
}

// hq plan drop: a task that never started leaves the plan (cancelled, why on its agent's feed)
export function drop(job: number, why: unknown, agent: string) {
  const own = ownTask(job, agent);
  if (typeof own === 'string') return own;
  const said = line(why);
  if (!said || said.length > WHY_MAX) return `say why in one line of up to ${WHY_MAX} characters`;
  // (as the CEO would cancel it: never a job HQ made itself, nor one carrying the board's answer)
  const refused = ledger.cancelRefusal(job, ceo());
  if (refused) return refused;
  if (!ledger.cancelJob(job, `dropped from the plan by ${agent}: ${said}`, ceo()))
    return `job #${job} has run already or HQ made it: only a task an agent queued that never started drops`;
  planChange({ project: own.project.id, thread: own.thread.id, what: `task #${job} dropped: ${said}`, by: agent });
  return { ok: true as const };
}

// hq plan done: a thread whose goal is met with nothing to merge. One with a branch ends by merging it.
export function done(id: string, agent: string) {
  const own = ownThread(id, agent);
  if (typeof own === 'string') return own;
  if (own.thread.status === 'done') return `${id} is done already`;
  if (own.thread.branch) return `${id} has its branch ${own.thread.branch}: it's done when that merges`;
  // (a moved thread found by its old id: its new one)
  db.prepare("update threads set status = 'done', done = ? where id = ?").run(new Date().toISOString(), own.thread.id);
  planChange({ project: own.project.id, thread: own.thread.id, what: 'thread done', by: agent });
  return { ok: true as const };
}

// hq project new | owner: the CEO makes a project and names its owner, a colleague in org.yaml (mayOwn)
export function newProject(
  p: { id: unknown; name: unknown; owner: unknown; business?: unknown; code?: unknown },
  agent: string,
  mayOwn: (agent: string) => boolean,
) {
  if (agent !== ceo()) return 'only the CEO makes projects: ask the CEO (hq propose, or in a meeting)';
  const [id, name, owner] = [p.id, p.name, p.owner].map(v => String(v ?? '').trim());
  const business = p.business == null ? null : String(p.business);
  if (!SLUG.test(id)) return 'a project id is up to 24 lower-case letters, digits and dashes';
  if (id === DESK) return `${id} names the work in no thread (hq project pause): pick another`;
  if (!name || name.length > NAME_MAX || /\n/.test(name))
    return `a project needs a name of one line, up to ${NAME_MAX} characters`;
  if (db.prepare('select 1 from projects where id = ?').get(id)) return `${id} is a project already (or was one)`;
  if (!mayOwn(owner)) return `${owner} isn't a colleague in org.yaml who can own a project`;
  const code = String(p.code ?? '')
      .trim()
      .toUpperCase(),
    badCode = codeRefusal(code);
  if (badCode) return badCode;
  if (business !== null && !projects().businesses.some(b => b.id === business))
    return `there's no business "${business}" (company/projects.yaml businesses)`;
  const clash = projectClash({ id, name, owner, ...(business !== null && { business }) }, name);
  if (clash) return clash;
  db.prepare('insert into projects (id, name, owner, business, created, by, code) values (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    name,
    owner,
    business,
    new Date().toISOString(),
    agent,
    code,
  );
  planChange({ project: id, what: `project made: ${name}, owned by ${owner}`, by: agent });
  return findProject(id)!;
}
// A project's prefix for its tasks' codes (jobcodes.ts): two or three capitals, reserved for this project.
// Given as the CEO makes the project, or once to one made before prefixes (hq project code), never changed: the codes
// given carry it.
function codeRefusal(code: string) {
  if (!PREFIX.test(code))
    return `a project needs its code: --code and two or three capitals (SH, GM), the prefix of its tasks' codes`;
  const holder = db.prepare('select id from projects where code = ?').get(code) as { id: string } | undefined;
  if (holder) return `${code} is project ${holder.id}'s code: pick another`;
  if (projects().groups.unsorted?.code === code) return `${code} is reserved for work without a project: pick another`;
}
export function setCode(id: string, given: unknown, agent: string) {
  if (agent !== ceo()) return 'only the CEO gives a project its code';
  const project = db.prepare('select code from projects where id = ?').get(id) as { code: string | null } | undefined;
  if (!project) return `there's no project "${id}"`;
  if (project.code) return `${id}'s code is ${project.code}, for good: its tasks' codes carry it`;
  const code = String(given ?? '')
      .trim()
      .toUpperCase(),
    refused = codeRefusal(code);
  if (refused) return refused;
  db.prepare('update projects set code = ? where id = ?').run(code, id);
  planChange({ project: id, what: `its tasks' codes ${code}-…`, by: agent });
  return { id, code };
}
// (by: the CEO's job, which tells the new owner of the project's open proposals: proposals.ts ownerChanged)
export function setOwner(
  id: string,
  owner: string,
  by: { agent: string; job: number },
  mayOwn: (agent: string) => boolean,
) {
  if (by.agent !== ceo()) return "only the CEO names a project's owner";
  const project = findProject(id);
  if (!project) return `there's no project "${id}"`;
  if (!mayOwn(owner)) return `${owner} isn't a colleague in org.yaml who can own a project`;
  if (project.owner === owner) return `${owner} owns ${id} already`;
  return untold(() => {
    db.prepare('update projects set owner = ? where id = ?').run(owner, id);
    planChange({ project: id, what: `owner ${project.owner} → ${owner}`, by: by.agent });
    ownerChanged(id, by);
    return { ok: true as const };
  });
}
// hq project business: the CEO puts a project in one of projects.yaml's businesses (its product), moves it to another,
// or takes it out of any (none). Its id, code and threads stay; a name its new product has already is refused, as for
// a rename (names.ts projectClash), and so is one of its open threads' (threadClash; HQ's one-task threads aside, as when
// they're made). The project, or why not.
export function setBusiness(id: string, given: unknown, agent: string) {
  if (agent !== ceo()) return 'only the CEO moves a project into a business';
  const project = findProject(id);
  if (!project) return noProject(id);
  const to = String(given ?? '').trim(),
    businesses = projects().businesses;
  const business = to === 'none' ? null : businesses.find(b => b.id === to);
  if (business === undefined)
    return `there's no business "${to}": the businesses are ${businesses.map(b => b.id).join(', ') || 'none yet (company/projects.yaml businesses)'}, or none`;
  if ((project.business ?? null) === (business?.id ?? null))
    return business ? `${id} is in ${business.id} already` : `${id} is in no business already`;
  const moved = { ...project, business: business?.id };
  const clash =
    projectClash(moved, project.name) ??
    listThreads({ project: id })
      .filter(t => !oneTask(t.id))
      .map(t => threadClash(moved, t.name, t.id))
      .find(Boolean);
  if (clash) return clash;
  db.prepare('update projects set business = ? where id = ?').run(business?.id ?? null, id);
  planChange({ project: id, what: `business ${project.business ?? 'none'} → ${business?.id ?? 'none'}`, by: agent });
  publish({
    type: 'log',
    agent,
    text: business ? `${project.name} moved to ${business.name}` : `${project.name} is in no business now`,
  });
  return findProject(id)!;
}

// hq plan <project>: its open threads, those another needs first, each with its "done when", window, needs, planned finish,
// tasks in order and done count, its product's other projects and its levels' marks
export function planOf(id: string, f: Forecast) {
  const project = findProject(id);
  if (!project) return undefined;
  const business = projects().businesses.find(b => b.id === project.business);
  const product = business && {
    name: business.name,
    others: projects()
      .list.filter(p => p.business === business.id && p.id !== project.id)
      .map(p => ({ id: p.id, name: p.name })),
  };
  const threads = db
    .prepare("select * from threads where project = ? and status = 'open' order by created")
    .all(id) as Thread[];
  const tasks = db.prepare(`select id, agent, title, step, round, status, started from jobs where thread = ?
    and kind = 'work' and pr is null and status in ${OPEN_JOBS} order by status = 'queued', coalesce(seq, id), id`);
  const doneCount = db.prepare(
    "select count(*) n from jobs where thread = ? and kind = 'work' and pr is null and status = 'done'",
  );
  const { ahead, split } = levelsOf();
  return {
    ...project,
    planning: projects().planning,
    ...{ product: product ?? null, ahead, split },
    threads: inNeedsOrder(threads).map(t => {
      const outlook = outlookOf(t.id, f);
      const rows = tasks.all(t.id) as (Named & { id: number; agent: string; status: string; started: string | null })[];
      return {
        ...{ id: t.id, name: t.name, goal: t.goal, deadline: t.deadline, aim: t.aim, branch: t.branch },
        ...{ needs: needsOf(t.id), eta: outlook?.eta ?? null, stall: outlook?.stall ?? null },
        ...splitMarks(
          rows.map(j => ({
            ...{ id: j.id, agent: j.agent, title: nameOf(j), status: j.status, started: j.started },
            size_ms: f.sizes.usual.get(j.id)?.agent_ms ?? null,
          })),
          split,
        ),
        done: (doneCount.get(t.id) as { n: number }).n,
      };
    }),
  };
}

// One line of what was given (nothing for none)
const line = (text: unknown) => oneLine(String(text ?? ''));

// Whether `from` needs `to`, directly or through other threads
const reaches = (from: string, to: string) =>
  !!db
    .prepare(
      `with recursive r(id) as (select needs from thread_needs where thread = ?
      union select n.needs from thread_needs n join r on n.thread = r.id) select 1 from r where id = ?`,
    )
    .get(from, to);

// A thread's tasks still to start (queued work jobs, its review rounds and their fixes aside) in order
const queuedTasks = (thread: string) =>
  db
    .prepare(
      `select id, coalesce(seq, id) seq from jobs where thread = ? and kind = 'work' and pr is null and status = 'queued' and started is null
      order by coalesce(seq, id), id`,
    )
    .all(thread) as { id: number; seq: number }[];

// The task (a queued work job in a thread) and its thread, if `agent` may change it, or why not
function ownTask(job: number, agent: string) {
  const row = db.prepare('select thread, status, kind, pr, started from jobs where id = ?').get(job) as
    { thread: string | null; status: string; kind: string; pr: number | null; started: string | null } | undefined;
  if (!row) return `there's no job #${job}`;
  if (!row.thread || row.kind !== 'work' || row.pr !== null) return `job #${job} isn't a task in a thread`;
  if (row.status !== 'queued' || row.started !== null)
    return `job #${job} is ${row.status}: only a task still to start moves or drops`;
  return ownThread(row.thread, agent);
}

// The thread and its project, if `agent` may change it, or why not
function ownThread(id: string, agent: string): { thread: Thread; project: Project } | string {
  const thread = findThread(id);
  if (!thread) return `there's no thread ${id} (hq thread list)`;
  const project = findProject(thread.project);
  if (!project) return `${thread.id} is in ${thread.project}, which is done`;
  return refusal(project, agent) ?? { thread, project };
}
