// The company's goals: projects the CEO marks (hq project goal). A goal has no measure or date of its own: its bets are
// its threads, their windows its dates and their "done when" its numbers, so nothing is said twice. While a goal is
// open, the CEO's hourly check runs every hour (summary.ts), and its summary reads each goal live from the forecast.
import { db, planChange } from './db.ts';
import { ceo, companyTime } from './company.ts';
import { findProject, findThread, sentenceOf } from './projects.ts';
import { noProject } from './names.ts';
import * as outlooks from './outlooks.ts';
import type { Forecast } from './forecast.ts';

// hq project goal <project> on | off: the CEO's
export function markGoal(id: string, on: boolean, agent: string) {
  if (agent !== ceo()) return 'only the CEO marks a goal';
  const project = findProject(id);
  if (!project) return noProject(id);
  if (isGoal(id) === on) return `${id} is ${on ? 'a goal' : 'no goal'} already`;
  db.prepare('update projects set goal = ? where id = ?').run(on ? new Date().toISOString() : null, id);
  planChange({ project: id, what: on ? 'marked a goal' : 'no longer a goal', by: agent });
  return { id, goal: on };
}

export const isGoal = (id: string) => !!db.prepare('select 1 from projects where id = ? and goal is not null').get(id);

// The open projects marked goals, in the order they were marked
export const openGoals = () =>
  db.prepare("select id, name from projects where goal is not null and status = 'open' order by goal").all() as {
    id: string;
    name: string;
  }[];

// The summary's "Our goals": each goal with its sentence, then each open thread (a bet) with its "done when", its
// window, its ETA (or why it has none) and the task that goes on next with its start, as hq plan reads them.
export function lines(f: Forecast) {
  const goals = openGoals();
  if (!goals.length) return [];
  const threads = outlooks.lines(f);
  return goals.map(goal => {
    const sentence = sentenceOf(goal.id)?.text ?? 'no sentence yet (hq project say)';
    const bets = threads.filter(t => t.project === goal.id).map(betLine);
    const listed = bets.length ? bets : ['no open thread: a goal with no bet in motion'];
    return `${goal.name} (${goal.id}): ${sentence}${listed.map(b => `\n  - ${b}`).join('')}`;
  });
}

function betLine(t: ReturnType<typeof outlooks.lines>[number]) {
  const o = t.outlook;
  const at = (ms: number | null) => (ms === null ? null : companyTime(ms));
  const deadline = o ? o.deadline : (findThread(t.id)?.deadline ?? null);
  const window = deadline ? `window to ${at(deadline)}` : 'no window';
  const eta = !o ? 'no open work' : o.eta !== null ? `ETA ${at(o.eta)}` : `no ETA: ${o.stall}`;
  const next = t.next
    ? `next #${t.next.id} ${t.next.title} (${t.next.agent}, ${t.next.status}${t.next.status === 'queued' && t.next.start ? `, starts ${at(t.next.start)}` : ''})`
    : 'no task drawn';
  return `${t.id} "${t.name}", done when ${t.goal} · ${window} · ${eta} · ${next}`;
}
