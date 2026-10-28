// Names that show their level (worker/hq/levels.ts): the levels a plan is drawn in, and no two of them sharing a name.
// (its messages say deliverable, the board's word for a thread)
import { db } from './db.ts';
import { projects, type Project } from './company.ts';
import { oneLine } from './agreements.ts';
import { NO_SHARED_NAME, type Level } from '../../worker/hq/levels.ts';
import { levelsOf } from './levels.ts';
import type { Thread } from './projects.ts';

// (a thread's name, made.ts too)
export const NAME_MAX = 80;
const GOAL_MAX = 200;

// A project open or done, for what names one that may have ended (an artifact's place).
export const anyProject = (id: string): (Project & { status: 'open' | 'done' }) | undefined => {
  const open = projects().list.find(p => p.id === id);
  if (open) return { ...open, status: 'open' };
  // (its business too, as the open list has it: an artifact's place.)
  const done = db
    .prepare("select id, name, owner, product, business from projects where id = ? and status = 'done'")
    .get(id) as Record<string, string | null> | undefined;
  if (!done) return undefined;
  return { ...(Object.fromEntries(Object.entries(done).filter(([, v]) => v !== null)) as Project), status: 'done' };
};
// Why a thread's name and "done when" won't do as they are (one line each, in length), or undefined
export function checkThreadName(name: string, goal: string) {
  if (!name || name.length > NAME_MAX) return `a deliverable needs a name of up to ${NAME_MAX} characters`;
  if (!goal || goal.length > GOAL_MAX)
    return `a deliverable needs its "done when" line (the goal, naming what it makes), up to ${GOAL_MAX} characters`;
}

// Why there's no open project by this id: it's done, or there's none
export const noProject = (id: string) =>
  anyProject(id)?.status === 'done'
    ? `${id} is done: a finished area that comes back is a new project (hq project new)`
    : `there's no project "${id}": ${projectList()}`;

const projectList = () =>
  `the projects are ${
    projects()
      .list.map(p => p.id)
      .join(', ') || 'none yet (hq project new)'
  }`;

// No two levels share a name (worker/hq/levels.ts): a thread's is refused when it's the name of a project or another
// open thread in its product (the business its project is in; a project in none is a product of its own), a project's
// likewise, and a task's when it's its thread's or that thread's project's. Names compare case-blind, punctuation and a
// leading "the" ignored. Only exact clashes: whether a name is clear stays its owner's judgment and the reviewer's.
export function threadClash(project: Project, name: string, self?: string) {
  const key = nameKey(name),
    around = productOf(project);
  const level = around.find(p => nameKey(p.name) === key);
  if (level) return clash(name, `the project ${level.id}`, 'thread');
  const sibling = openThreadsOf(around).find(t => t.id !== self && nameKey(t.name) === key);
  if (sibling) return clash(name, `the open deliverable ${sibling.id}`, 'thread');
}
export function projectClash(project: Project, name: string) {
  const key = nameKey(name),
    around = productOf(project);
  const level = around.find(p => p.id !== project.id && nameKey(p.name) === key);
  if (level) return clash(name, `the project ${level.id}`, 'project');
  const thread = openThreadsOf(around).find(t => nameKey(t.name) === key);
  if (thread) return clash(name, `the open deliverable ${thread.id}`, 'project');
}
// (thread: an open one, or one about to be drawn)
export function taskClash(title: string, thread: { id?: string; name: string; project: string }) {
  const key = nameKey(title),
    project = projects().list.find(p => p.id === thread.project);
  if (key === nameKey(thread.name)) return clash(title, `its deliverable ${thread.id ?? `"${thread.name}"`}`, 'task');
  if (project && key === nameKey(project.name)) return clash(title, `its project ${project.id}`, 'task');
}
const nameKey = (name: string) =>
  oneLine(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the /, '');
// (the level's line, the company's own where it has one)
const clash = (name: string, whose: string, level: Level) =>
  `"${oneLine(name)}" is the name of ${whose}: ${NO_SHARED_NAME} ${levelsOf().lines[level]}`;
// The open projects of the project's product, the project itself among them
const productOf = (project: Project) =>
  projects().list.filter(p => p.id === project.id || (project.business && p.business === project.business));
const openThreadsOf = (around: Project[]) =>
  db
    .prepare("select id, name from threads where status = 'open' and project in (select value from json_each(?))")
    .all(JSON.stringify(around.map(p => p.id))) as Pick<Thread, 'id' | 'name'>[];

// Where a thread is, as the board reads it: its product (the business, by name), its project, and the names of the
// project's other open threads, so a name that needs context, or a second of the same, shows when it's drawn or renamed
export function placeOf(thread: Pick<Thread, 'id' | 'project'>) {
  const project = projects().list.find(p => p.id === thread.project)!;
  const product = projects().businesses.find(b => b.id === project.business);
  return {
    product: product?.name ?? null,
    project: { id: project.id, name: project.name },
    beside: openThreadsOf([project]).filter(t => t.id !== thread.id),
  };
}
