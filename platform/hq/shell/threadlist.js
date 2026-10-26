// The threads across every project, out of HQ's throughput (hud.js): those running and waiting, in two parts (at work
// and waiting), or those finished in the last day as a changelog. A row each, in a task row's look (tasks.js): the
// thread's name, its project, what it's doing or waiting on (what it delivered, for a finished one) and its time; a tap
// opens the thread.
import { esc } from '../util.js';
import { covered, withJobLinks } from './prose.js';
import { nameHtml, nameText } from './jobs.js';
import { face, pulse, waitOf } from './projectkeys.js';
import { ROW_MARKS } from './tasks.js';
import { waitsOf } from './threadtile.js';
import { atWork, etaPlace, planned, taskHtml, threadEta, threadLit, threadNow, threadState, clock } from './threads.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// The two lists, each a group of the view's (hud.js opens them, and the keys at the head of the projects and of each list)
export const LISTS = { running: 'Running and waiting', finished: 'Done in 24 h' };

// board: the projects (open) and those completed, as the coordinator lists them. The running list in two parts, those at
// work and those waiting, each under its name and count; the finished one a single list.
export function threadList(key, board, opening) {
  const projects = board.projects ?? [];
  if (key === 'finished')
    return list(
      finishedThreads(projects, board.completed ?? []).map(x => finishedRow(x, opening)),
      'No thread finished in the last day.',
    );
  const threads = runningThreads(projects);
  if (!threads.length) return list([], 'Nothing running or waiting.');
  const rows = working => threads.filter(x => x.working === working).map(x => runningRow(x, projects));
  return `<div class="pj-level pj-lists">${section('At work', rows(true))}${section('Waiting', rows(false))}</div>`;
}
// A list whole, or a line saying it has none
const list = (rows, none) =>
  `<ol class="pj-level pj-tasks pj-threads">${rows.join('') || `<li class="pj-none">${none}</li>`}</ol>`;
// A part of the running list: its name and count over its rows, and nothing with no rows
const section = (name, rows) =>
  rows.length
    ? `<section><h2 class="pj-list-head">${name} <span>${rows.length}</span></h2><ol class="pj-tasks pj-threads">${rows.join('')}</ol></section>`
    : '';
// The two lists as a pair of keys, each with its count, the one open pressed and inert: at the head of the projects and
// of each list
export function listKeys(board, open = '') {
  const projects = board.projects ?? [],
    counts = {
      running: runningThreads(projects).length,
      finished: finishedThreads(projects, board.completed ?? []).length,
    };
  return Object.entries(LISTS)
    .map(
      ([key, name]) =>
        `<button class="pj-key"${open === key ? '' : ` data-group="${key}"`}${open ? ` aria-pressed="${open === key}"` : ''}>${name} · ${counts[key]}</button>`,
    )
    .join('');
}

// The running and waiting threads, each as its project's page orders them (threads.js etaPlace): the board's first, then
// those waiting on something else, then by when they're done; working, with a task at work (even where it waits on the
// board too).
function runningThreads(projects) {
  return projects
    .flatMap(p => p.threads.map(t => ({ t, p, s: threadState(t) })))
    .filter(x => ['you', 'working', 'next', 'waits'].includes(x.s))
    .map(x => [etaPlace(x.t, x.p), { ...x, working: threadNow(x.t).running.length > 0 }])
    .sort(([a], [b]) => a[0] - b[0] || a[1] - b[1])
    .map(([, x]) => x);
}
// (lit as on its project's page, threads.js threadLit: a decision or a card on the desk phone, whatever its jobs' states)
const LOOK = { working: 'working', next: 'planned', waits: 'after' };
const MARK = { working: '', next: '', waits: 'after' };
function runningRow({ t, p, s }, projects) {
  const { running, next } = threadNow(t),
    threadOf = id => projects.flatMap(x => x.threads).find(x => x.id === id),
    waits = waitsOf(t, p, threadOf)[0],
    eta = threadEta(t);
  const doing = running.length
    ? `${pulse(1)}${taskHtml(running[0], t)}${running.length > 1 ? ` and ${running.length - 1} more` : ''}`
    : waits
      ? withJobLinks(waits.words)
      : next
        ? `Next: ${taskHtml(next, t)} · ${planned(next).start ?? waitOf(next.lead ?? next).html}`
        : '';
  const who = atWork([t])[0] ?? next?.agent ?? t.owner,
    when = eta?.time ?? '';
  const lit = threadLit(t, p),
    look = running.length ? `working${lit ? ' lit' : ''}` : lit ? 'board lit' : LOOK[s];
  return row(t, p, { look: `pj-task ${look}`, who, mark: lit ? 'board' : MARK[s], says: doing, when });
}

// The threads finished in the last day, the latest first, the completed projects' too (all their threads are done)
function finishedThreads(projects, completed) {
  const since = Date.now() - DAY_MS,
    done = [...projects.map(p => [p, p.done]), ...completed.map(p => [p, p.threads])];
  return done
    .flatMap(([p, threads]) => threads.map(t => ({ t, p, at: Date.parse(t.finished) })))
    .filter(x => x.at >= since)
    .sort((a, b) => b.at - a.at);
}
// A finished thread's row: what it delivered (its done-when) and when it finished
function finishedRow({ t, p, at }, opening) {
  const said =
    opening?.id === t.id
      ? opening.words
      : t.goal
        ? nameText(t, 'goal')
        : `${t.done} of ${t.jobs} ${t.jobs === 1 ? 'job' : 'jobs'} done`;
  return row(t, p, {
    look: 'pj-task done',
    who: t.owner,
    mark: 'done',
    says: esc(said),
    when: `Done ${clock(at)}`,
  });
}

// A thread's row: its face with its state's mark, its name, under it its project and what it says, and its time
const row = (t, p, { look, who, mark, says, when }) =>
  `<li>${covered(
    look,
    `data-thread="${esc(t.id)}" data-in="${esc(p.id)}"`,
    `${nameText(t, 'name')}, ${nameText(p, 'name')}${when ? `, ${when}` : ''}`,
    `<span class="pj-task-who">${face(who)}${ROW_MARKS[mark] ?? ''}</span>
    <span class="pj-task-text"><b>${nameHtml(t, 'name')}</b><small><span class="pj-in">${esc(nameText(p, 'name'))}</span>${says ? ` · ${says}` : ''}</small></span>
    <span class="pj-task-side">${when ? `<span class="pj-when">${esc(when)}</span>` : ''}</span>`,
  )}</li>`;
