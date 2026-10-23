// The projects view's levels drawn: each level's head and its keys, from the board's work as projects.js holds it.
import * as keys from './projectkeys.js';
import * as levels from './levels.js';
import { taskRows } from './tasks.js';
import { businessState, finished, inEtaOrder, running, stateOf } from './threads.js';
import { nameText } from './jobs.js';

// A level's head and keys
export function levelHtml(l, { view, board, opening }) {
  const work = { projects: board.projects ?? [], businesses: board.businesses ?? [], closed: new Map() },
    projectsOf = id => levels.projectsOf(id, work),
    groupRows = key => rowsOf(key, board),
    groupDone = key => doneOf(key, board);
  if (l.at === 'home') return home(board, work, projectsOf, groupRows, groupDone);
  if (l.at === 'group') {
    const group = keys.named(view.group, board.groups?.[view.group]);
    // (Recurring: the routines' projects, as any project's tiles.)
    if (view.group === 'recurring')
      return `${keys.head({ back: 'Projects', title: group.name })}<div class="pj-level pj-grid">${routinesOf(board).map(keys.projectTile).join('') || '<p class="pj-none">Nothing here right now.</p>'}</div>`;
    // (Meetings: a tile each.)
    if (view.group === 'meetings') {
      const seats = board.meetings ?? [];
      return `${keys.head({ back: 'Projects', title: group.name, keys: keys.doneKey(keys.endedMeetings(seats), view.showDone) })}<div class="pj-level pj-grid">${keys.meetingTiles(seats, view.showDone)}</div>`;
    }
    const done = groupDone(view.group),
      rows = [...groupRows(view.group), ...(view.showDone ? done : [])];
    return `${keys.head({ back: 'Projects', title: group.name, keys: keys.doneKey(done.length, view.showDone) })}<div class="pj-level pj-grid">${keys.groupTiles(rows)}</div>`;
  }
  if (l.at === 'business') {
    const own = projectsOf(l.b.id);
    return `${keys.head({ back: 'Projects', title: l.b.name, marks: businessState(own).lit ? keys.litMark(businessState(own).words) : '' })}<div class="pj-level pj-grid pj-sortable">${own.map(keys.projectTile).join('') || '<p class="pj-none">No projects yet.</p>'}</div>`;
  }
  const p = l.p,
    business = work.businesses.find(e => e.id === p.business),
    over = business?.name ?? '';
  if (l.at === 'project') {
    const back = p.schedule ? keys.named('recurring', board.groups?.recurring).name : (business?.name ?? 'Projects');
    // its ongoing threads, or its completed ones; the ongoing by ETA, waiting ones
    // first
    const completed = view.showDone && p.done.length > 0,
      switches = keys.sideKeys(p.done.length, completed) + keys.decisionKey(p.pause);
    const tiles = completed
      ? p.done.map(t => keys.doneThreadTile(t, opening?.project === p.id ? opening : null))
      : inEtaOrder(p).map(t => keys.threadTile(t, p));
    return `${keys.head({ back, over, title: nameText(p, 'name'), marks: keys.projectMarks(p), keys: switches })}
      <div class="pj-level pj-grid">${tiles.join('') || '<p class="pj-none">No ongoing threads.</p>'}</div>`;
  }
  // A completed thread waits on no decision.
  const t = l.t,
    decision = p.threads.includes(t) ? keys.decisionKey(t.pause ?? p.pause) : '';
  return `${keys.head({ back: nameText(p, 'name'), over: nameText(p, 'name'), title: nameText(t, 'name'), marks: keys.threadMarks(t, p), keys: keys.foldKeys(t, view) + decision })}
    <ol class="pj-level pj-tasks">${taskRows(t, p, view)}</ol>`;
}
// Home: a business each, then Recurring and the work outside the projects, each a plain tile. A company without
// businesses has its projects here, but for the routines'.
function home(board, work, projectsOf, groupRows, groupDone) {
  const tiles = work.businesses.length
    ? work.businesses.map(e => keys.businessTile(e, projectsOf(e.id))).join('')
    : work.projects
        .filter(p => !p.schedule)
        .map(keys.projectTile)
        .join('');
  const loose = Object.keys(keys.GROUPS)
    .map(k => {
      const rows = groupRows(k),
        on =
          k === 'recurring'
            ? running(routinesOf(board).flatMap(p => p.threads))
            : rows.filter(r => stateOf(r) === 'working').length;
      return keys.groupTile(k, rows, groupDone(k).length, board.groups?.[k], on);
    })
    .join('');
  return `${keys.head({ title: 'Projects' })}<div class="pj-level pj-home"><div class="pj-grid pj-businesses${work.businesses.length ? '' : ' pj-plain pj-sortable'}">${tiles}</div><div class="pj-grid pj-loose">${loose}</div></div>`;
}
// the routines' projects, each with its schedule
const routinesOf = board => (board.projects ?? []).filter(p => p.schedule);
// A group's rows: the routines' projects, or the open work being placed
const rowsOf = (key, board) => (key === 'recurring' ? routinesOf(board) : (board[key] ?? []).filter(j => !finished(j)));
// and its latest finished runs (the coordinator's few, newest first)
const doneOf = (key, board) => (board[key] ?? []).filter(finished);
