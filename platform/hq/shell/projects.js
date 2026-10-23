// HQ's projects view: businesses, projects, threads and tasks.
import { esc } from '../util.js';
import * as world from '../world/world.js';
import { loadProjects, loadRoom, loadJob, loadJobLog, loadThread, sortProjects, loadFindings } from './data.js';
import { sfx } from './audio.js';
import { openPhone } from './desk.js';
import { scene } from './stage.js';
import { panelOpen } from './panel.js';
import { flyTo } from './hud.js';
import './projectkeys.js';
import { levelHtml } from './projectlevels.js';
import { rowState } from './threads.js';
import { jobSheet, followSteps } from './jobsheet.js';
import * as levels from './levels.js';
import { sortable, sorting, sortGesture } from './sorting.js';
import { sides } from './sides.js';
import { keepCovers } from './covers.js';

const $ = s => document.querySelector(s);
const REFRESH_MS = 20000;
const TAPPABLE = [
  'data-business',
  'data-project',
  'data-group',
  'data-thread',
  'data-job',
  'data-up',
  'data-done',
  'data-close',
  'data-card',
  'data-leave',
  'data-turn',
  'data-side',
];

let board = null,
  // while no job can start for memory, the coordinator's line saying so (room.ts), else null
  room = null,
  // where the board is: a business, a project and a thread in it, or a group (recurring, unsorted); jobId: the job open
  // over it (lookedUp: one asked for by a link that the board no longer holds); steps: whether the open job's steps
  // show; back: whether it's turned over
  view = {
    business: null,
    project: null,
    thread: null,
    group: null,
    jobId: null,
    showDone: false,
    steps: false,
    back: false,
    gone: false,
    unkept: false,
  },
  lookedUp = null,
  // the done threads the board opened, each with its jobs, by id
  closed = new Map(),
  // the latest move about the view, a token: one that a later move, closing or opening the view supersedes (supersede)
  // commits nothing, after its exit or its thread's load
  move = null,
  // the done thread whose jobs are loading, or whose load failed, on its project's tile: { id, project, words, pending }.
  // The next move ends it.
  opening = null,
  // where the job opened last came from (its row's place), for its card to fly out of
  origin = null,
  timer = null,
  // the level's keys coming in (levels.moveIn) and the view flying out, which a refresh waits for rather than cutting
  // them short.
  arriving = Promise.resolve();
export const projectsOpen = () => !$('#projects').hidden;
const modal = () => $('#projects .pj-modal');
// until the board first loads: three of the view’s keys pressed in turn.
const LOADING = `<div class="pj-loading" role="status" aria-label="Gathering the projects…">${'<i></i>'.repeat(3)}</div>`;
const UNKEPT = '<p class="pj-notice pj-unkept" role="status">Couldn’t confirm your new order. Try it again.</p>';

// ---------------------------------------------------------------- in and out
export function initProjects() {
  // (a level's sides beside the view, outside it)
  $('#projects').innerHTML = `<div class="pj-modal"></div>${sides('pj-sides')}`;
  $('#projects .pj-sides').hidden = true; // (until paint shows a level's: none while the projects load)
  $('#projects').addEventListener('click', tapped);
  $('#projects').addEventListener('toggle', toggled, true);
  levels.swipes($('#projects'), {
    mayDrag: () => !view.jobId && here().beside.length > 1 && !sorting(),
    onSwipe: step,
  });
  sortable($('#projects'), { onSorted: sorted });
  new ResizeObserver(measureInset).observe($('#hud'));
  // (before desk.js closes a device on the same Escape; an agent's card or panel out over the view closes first)
  addEventListener(
    'keydown',
    e => {
      if (e.key !== 'Escape' || !projectsOpen() || $('#tool').matches(':not([hidden])') || panelOpen()) return;
      if (scene.carded?.()) scene.focus({ kind: 'home' });
      else if (view.jobId) closeJob();
      else up();
    },
    { capture: true },
  );
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && projectsOpen()) refresh();
  });
}
// The view is one big key over the dimmed page, as the home page's keys come out big: it flies out of from (the element
// tapped to open it) and back. at: a job to open (a link to its report), a group (the HUD's line), or a business, a
// project or a thread in it (HQ's search; done: a done thread, refresh() loads it.).
export async function openProjects(at = {}) {
  const was = projectsOpen() && !shutting();
  switched(true);
  supersede();
  if (!was) {
    sfx.open();
    levels.fly(modal(), at.from);
  }
  view = { ...view, jobId: at.job ?? null, group: at.group ?? null, steps: false, back: false, gone: false };
  if (at.group) view = { ...view, business: null, project: null, thread: null };
  if (at.business || at.project)
    view = {
      ...view,
      business: at.business ?? null,
      project: at.project ?? null,
      thread: at.thread ?? null,
      showDone: !!at.done,
    };
  // (the board's work read before, where it holds this place, shows at once, its keys dropping in, and the read brings
  // it up to date in place: the keys never drop in twice.)
  const ready = Boolean(board) && levels.holds(view, work());
  if (ready) paint(was ? '' : 'down');
  else if (!board || !was) modal().innerHTML = LOADING;
  await refresh(ready || was ? '' : 'down');
  clearInterval(timer);
  timer = setInterval(refresh, REFRESH_MS);
}
export async function closeProjects() {
  if (!projectsOpen() || shutting()) return;
  sfx.close();
  const mine = supersede();
  clearInterval(timer);
  $('#projects').classList.add('pj-shut');
  await levels.fly(modal(), null, true);
  if (move === mine) switched(false);
}
const shutting = () => $('#projects').classList.contains('pj-shut');
function switched(on) {
  $('#projects').hidden = !on;
  $('#projects').classList.remove('pj-shut');
  document.body.classList.toggle('projects', on);
  if (on) measureInset();
}
// the keys start under the HUD, however many rows its tools wrap to, and scroll under it out of sight
function measureInset() {
  if (projectsOpen())
    $('#projects').style.setProperty('--pj-top', `${Math.round($('#hud').getBoundingClientRect().bottom)}px`);
}
async function refresh(motion = '') {
  try {
    [board, { line: room }] = await Promise.all([loadProjects(world.dev), loadRoom(world.dev)]);
    for (const t of projects().flatMap(p => p.threads)) closed.delete(t.id);
    const done = projects().flatMap(p => p.done);
    if (done.some(t => t.id === view.thread)) closed.set(view.thread, await loadThread(world.dev, view.thread));
    if (view.jobId && !jobsOnBoard().some(j => j.id === view.jobId) && lookedUp?.id !== view.jobId) {
      lookedUp = await loadJob(world.dev, view.jobId);
      if (!lookedUp) {
        view.gone = true;
        view.jobId = null;
      }
    }
    await keepCovers(board);
  } catch {
    if (!board)
      modal().innerHTML = `<div class="pj-board"><p class="pj-notice" role="status">The projects didn’t load. Trying again…</p></div>${LOADING}`;
    return;
  }
  await arriving;
  // (a key pressed to sort keeps its grid until the gesture ends)
  if (projectsOpen() && !sortGesture()) paint(motion);
}

// ---------------------------------------------------------------- the board's work, read
const projects = () => board?.projects ?? [];
const businesses = () => board?.businesses ?? [];
const work = () => ({ projects: projects(), businesses: businesses(), closed });
const here = () => levels.level(view, work());
// every job with its project and thread (a done thread's the board opened too), and the loose ones (being placed) with
// neither
function jobsOnBoard() {
  const threads = projects().flatMap(p =>
    [...p.threads, ...[...closed.values()].filter(t => t.project === p.id)].map(t => [p, t]),
  );
  const placed = threads.flatMap(([p, t]) => t.jobs.map(j => ({ ...j, project: p, projectThread: t })));
  return [...placed, ...(board?.unsorted ?? []), ...(board?.meetings ?? []), ...(lookedUp ? [lookedUp] : [])];
}
// ---------------------------------------------------------------- moving about
// A move to a change of the view: the level's keys leave, and it commits unless a later move came meanwhile
async function go(change, motion = '') {
  const mine = supersede();
  await levels.leave($('#projects .pj-level'), motion);
  if (move !== mine) return;
  view = { ...view, gone: false, unkept: false, ...change };
  paint(motion);
}
// A new move: the one before it, and a done thread's load or failure on its tile, end
function supersede() {
  opening = null;
  return (move = {});
}
function tapped(e) {
  const el = e.target.closest(TAPPABLE.map(name => `[${name}]`).join(','));
  if (!el) return blank(e);
  const data = el.dataset;
  if (data.business) {
    sfx.open();
    go({ ...levels.intoBusiness(data.business), group: null, showDone: false }, 'down');
  } else if (data.project) {
    sfx.open();
    go({ project: data.project, thread: null, showDone: false }, 'down');
  } else if (data.thread) openThread(data.thread);
  else if (data.group) {
    sfx.open();
    go({ group: data.group, business: null, project: null, thread: null, showDone: false }, 'down');
  } else if (data.job) openJob(Number(data.job), el);
  else if ('up' in data) up();
  else if ('done' in data) {
    // A project's switch names its side.
    const showDone = data.done ? data.done === 'completed' : !view.showDone;
    if (showDone === view.showDone) return;
    sfx.blip();
    go({ showDone });
  } else if ('close' in data) closeJob();
  else if (data.card) {
    sfx.blip();
    openPhone(Number(data.card));
  } else if ('leave' in data) closeProjects();
  else if ('turn' in data) turnJob();
  else if (data.side) step(Number(data.side));
}
// A tap on the dimmed page round the view closes it, one beside the open job closes that, and one on its card (not on
// a key or a link) turns it over, as the home page's big key does.
function blank(e) {
  if (e.target === $('#projects')) closeProjects();
  else if (e.target.closest('.pj-pop') && !e.target.closest('.pj-card')) closeJob();
  else if (e.target.closest('.pj-card') && !e.target.closest('a, summary, .pj-log')) turnJob();
}
// A task opens: one at work as its agent's card, the very one the home page shows (a look's own big key, out of the
// task's row over the view, or the agent's panel); any other as its own card, flown out of its row.
function openJob(id, row) {
  const j = jobsOnBoard().find(x => x.id === id);
  if (j && rowState(j) === 'working' && world.agents.has(j.agent)) {
    if (!scene.cards) return flyTo(j.agent);
    sfx.press();
    return scene.focus({ kind: 'agent', id: j.agent }, { from: row });
  }
  sfx.press();
  origin = row.getBoundingClientRect();
  go({ jobId: id, steps: false, back: false });
}
async function closeJob() {
  const card = $('#projects .pj-card'),
    row = $(`#projects .pj-level .cover[data-job="${view.jobId}"]`); // (its row's, not a link to it)
  sfx.close();
  lookedUp = null;
  const mine = supersede();
  $('#projects .pj-pop')?.classList.add('pj-shut');
  if (card) await levels.fly(card, row?.getBoundingClientRect(), true);
  if (move === mine) go({ jobId: null, steps: false, back: false });
}
// The open job's card, turned over (where it has a back)
function turnJob() {
  const card = $('#projects .pj-card');
  if (!card?.querySelector('.pj-back') || card.turning) return;
  sfx.flip();
  view.back = !view.back;
  levels.turn(card);
}
// A thread opens over its project: an open one at once, a done one once its jobs are loaded, if the board is still at
// that project then. A load that fails says so on its tile, where a tap tries again.
async function openThread(id) {
  if (opening?.id === id && opening.pending) return;
  sfx.open();
  const open = () => go({ thread: id, showDone: closed.has(id) }, 'down');
  if (projects().some(p => p.threads.some(t => t.id === id))) return open();
  const mine = supersede();
  opening = { id, project: view.project, words: 'Opening…', pending: true };
  paint();
  try {
    const thread = await loadThread(world.dev, id);
    if (move !== mine) return;
    closed.set(id, thread);
    open();
  } catch {
    if (move !== mine) return;
    opening = { ...opening, words: 'Didn’t open. Tap to try again.', pending: false };
    paint();
  }
}
function up() {
  const change = levels.upFrom(here(), work());
  if (!change) return closeProjects();
  sfx.close();
  go(change, 'up');
}
function step(by) {
  const change = levels.besideOf(here(), by);
  if (!change) return;
  sfx.swipe();
  go(change, by > 0 ? 'from-right' : 'from-left');
}
// A grid's new order, kept by the coordinator for every device.
async function sorted(ids) {
  sfx.blip();
  let order;
  try {
    ({ order } = await sortProjects(world.dev, ids));
  } catch {
    view.unkept = true;
    $('#projects .pj-unkept')?.remove();
    $('#projects .pj-board').insertAdjacentHTML('afterbegin', UNKEPT);
    return refresh();
  }
  board.projects = projects().toSorted((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  view.unkept = false;
  $('#projects .pj-unkept')?.remove();
}

// ---------------------------------------------------------------- the open job's steps
// read while they show
function toggled(e) {
  const d = e.target;
  if (!d.matches?.('.pj-steps')) return;
  view.steps = d.open;
  const j = jobsOnBoard().find(x => x.id === view.jobId);
  if (d.open && j) followSteps(d, j, id => loadJobLog(world.dev, id));
}

// ---------------------------------------------------------------- the open review's findings
// loaded as its sheet opens, then painted on it: null while they load, 'failed' when they didn't.
let found = { job: null, list: null };
function findingsOf(j) {
  if (!j?.findings) return (found = { job: null, list: null }).list;
  if (found.job === j.id) return found.list;
  found = { job: j.id, list: null };
  loadFindings(world.dev, j.id)
    .then(r => r.findings)
    .catch(() => 'failed')
    .then(list => {
      if (found.job !== j.id) return;
      found.list = list;
      paint();
    });
  return null;
}

// ---------------------------------------------------------------- drawing
function paint(motion = '') {
  const el = $('#projects');
  if (view.business && !businesses().some(e => e.id === view.business)) view.business = null;
  if (view.project && !projects().some(p => p.id === view.project)) view.project = view.thread = null;
  const l = here();
  if (view.thread && l.at !== 'thread') view.thread = null;
  const kept = {
    board: el.querySelector('.pj-board')?.scrollTop ?? 0,
    job: el.querySelector('.pj-card-faces')?.scrollTop ?? 0,
    sums: [...el.querySelectorAll('.pj-eta[open]')].map(d => d.dataset.eta),
    focus: levels.focusOf(el, TAPPABLE),
  };
  const sameJob = el.querySelector('.pj-card')?.dataset.jobOpen === String(view.jobId ?? '');
  const job = view.jobId ? jobsOnBoard().find(x => x.id === view.jobId) : null;
  const gone = view.gone ? '<p class="pj-notice" role="status">That job isn’t there any more.</p>' : '',
    unkept = view.unkept ? UNKEPT : '';
  const starved = room ? `<p class="pj-notice" role="status">${esc(room)}</p>` : '';
  modal().innerHTML = `<div class="pj-board">${starved}${gone}${unkept}${levelHtml(l, { view, board, opening })}</div>`;
  el.querySelector('.pj-pop')?.remove();
  const listed = findingsOf(job);
  el.insertAdjacentHTML(
    'beforeend',
    jobSheet(job, jobsOnBoard(), { steps: view.steps, back: view.back, findings: listed }),
  );
  el.dataset.level = l.at;
  // (the level's sides while a swipe would step, as the swipe's mayDrag)
  el.querySelector('.pj-sides').hidden = Boolean(view.jobId) || l.beside.length < 2;
  if (!motion) el.querySelector('.pj-board').scrollTop = kept.board;
  el.querySelectorAll('.pj-eta').forEach(d => (d.open = kept.sums.includes(d.dataset.eta)));
  const sheet = el.querySelector('.pj-card');
  if (sheet && sameJob) sheet.querySelector('.pj-card-faces').scrollTop = kept.job;
  if (sheet && !sameJob) levels.fly(sheet, origin);
  if (sheet && view.steps) toggled({ target: sheet.querySelector('.pj-steps') ?? {} });
  if (kept.focus) el.querySelectorAll(kept.focus.selector)[kept.focus.index]?.focus({ preventScroll: true });
  levels.moveIn(el, motion);
  arriving = levels.settled(el);
}
