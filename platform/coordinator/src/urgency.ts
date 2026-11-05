// Explicit urgency on the existing work levels and their review loops.
import { db, once, planChange, prepared, workBranch } from './db.ts';
import { ceo } from './company.ts';
import { publish } from './events.ts';

export type UrgentLevel = 'milestone' | 'job' | 'task';
// Each level's table, its effective urgency (its own flag or a parent's: the views below) and the query that finds a target
const LEVELS = {
  milestone: {
    table: 'projects',
    view: 'urgent_projects',
    find: 'select id, name, id project, null thread, 0 expedite from projects where id = ?',
  },
  job: {
    table: 'threads',
    view: 'urgent_threads',
    find: `select id, name, project, id thread, 0 expedite from threads
      where id = coalesce((select id from thread_aliases where old = ?1), ?1)`,
  },
  task: {
    table: 'jobs',
    view: 'urgent_tasks',
    find: `select j.id, j.title name, t.project, j.thread, j.expedite from jobs j
      left join threads t on t.id = j.thread where j.id = ?`,
  },
} as const;

// Whether urgent work already on a branch makes its reviews and fixes urgent
const urgentSourceOn = (branchSql: string) => `exists (
  select 1 from jobs source indexed by jobs_work_branch join urgent_work origin on origin.id = source.id
  where ${workBranch('source')} = ${branchSql} and source.kind = 'work' and origin.urgent)`;

// A view on a LEFT JOIN's right side is built whole at each read, so urgent_work joins a job's thread and project
// itself.
once('2026-11-04-urgent-work-own-joins', 'drop view if exists urgent_tasks; drop view if exists urgent_work;');
db.exec(`
  create view if not exists urgent_projects as select id, urgent from projects;
  create view if not exists urgent_threads as
    select t.id, (t.urgent or coalesce(p.urgent, 0)) urgent
    from threads t left join projects p on p.id = t.project;
  create view if not exists urgent_work as
    select j.id, (j.urgent or coalesce(t.urgent, 0) or coalesce(p.urgent, 0)) urgent
    from jobs j left join threads t on t.id = j.thread left join projects p on p.id = t.project;
  create view if not exists urgent_tasks as
    select j.id, (u.urgent or j.expedite or (j.pr is not null and
      ${urgentSourceOn('coalesce(j.branch, (select branch from prs where number = j.pr))')})) urgent
    from jobs j join urgent_work u on u.id = j.id;
`);

export const taskUrgent = (id: number) => urgentAt('urgent_tasks', id);
export const threadUrgent = (id: string) => urgentAt('urgent_threads', id);
export const projectUrgent = (id: string) => urgentAt('urgent_projects', id);
// The branches among these with urgent work on them, in one statement: the claim's plan asks for every queued row's
// branch, and at HQ's size a statement per row is too slow for it.
export function urgentBranches(branches: Iterable<string>): Set<string> {
  const urgent = prepared(`select b.value branch from (select distinct value from json_each(?)) b
    where ${urgentSourceOn('b.value')}`).all(JSON.stringify([...new Set(branches)])) as { branch: string }[];
  return new Set(urgent.map(row => row.branch));
}

// Work whose checks go first wherever they queue for a test machine (runs.ts takeRun, the worker's tests: the heartbeat's
// `first`): urgent work (urgent_tasks: its own flag, its deliverable's or project's, expedited, or a fix or review of
// urgent work's branch), or work on a thread with a window, a time given the board (its own deadline or the one its
// deadline_from line reads, as projects.ts findThread walks it).
export const checksFirstSql = (
  job: string,
) => `(coalesce((select urgent from urgent_tasks where id = ${job}), 0) or exists (
  with recursive line(id, deadline_from) as (
    select t.id, t.deadline_from from jobs fj join threads t on t.id = fj.thread where fj.id = ${job}
    union select t.id, t.deadline_from from threads t join line l on t.id = l.deadline_from)
  select 1 from line l join threads w on w.id = l.id where l.deadline_from is null and w.deadline is not null))`;
export const checksFirst = (id: number) =>
  Boolean((prepared(`select ${checksFirstSql('?1')} first`).get(id) as { first: number }).first);

function urgentAt(table: string, id: string | number) {
  return Boolean(
    (prepared(`select urgent from ${table} where id = ?`).get(id) as { urgent: number } | undefined)?.urgent,
  );
}

export function setUrgent(level: unknown, id: string, urgent: unknown, agent: string, onCall = false) {
  if (agent !== ceo() && !onCall) return 'The CEO or an agent on a live board call records urgent work';
  if (typeof level !== 'string' || !Object.hasOwn(LEVELS, level)) return 'Choose milestone, job or task';
  if (typeof urgent !== 'boolean') return 'urgent must be true or false';
  const { table, view, find } = LEVELS[level as UrgentLevel];
  const target = prepared(find).get(level === 'task' ? Number(id) : id) as Target | undefined;
  if (!target) return `No ${level} has that identifier`;
  db.prepare(`update ${table} set urgent = ? where id = ?`).run(Number(urgent), target.id);
  if (target.project)
    planChange({
      project: target.project,
      thread: target.thread,
      what: `${level} ${target.id}: urgent ${urgent ? 'on' : 'off'}`,
      by: agent,
    });
  const effective = urgentAt(view, target.id);
  publish({ type: 'log', agent, text: `${target.name}: urgent ${urgent ? 'on' : 'off'}` });
  return { level, id: target.id, name: target.name, urgent, effective, expedited: !!target.expedite };
}

type Target = { id: string | number; name: string; project: string | null; thread: string | null; expedite: number };
