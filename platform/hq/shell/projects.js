// HQ's projects view: businesses, projects, threads and tasks.
import { esc } from '../util.js';
import * as world from '../world/world.js';
import { loadRoom, loadJob, loadJobLog, loadThread, loadFindings, loadJobFacts } from './data.js'; // (loadJobFacts)
import { loadBoard, keepOrder } from './boardload.js';
import { sfx } from './audio.js';
import { openPhone } from './desk.js';
import { scene, cover } from './stage.js'; // (cover)
import { panelOpen } from './panel.js';
import { flyTo } from './hud.js';
import './projectkeys.js';
import { levelHtml, SKELETON } from './projectlevels.js'; // (SKELETON)
import { rowState } from './threads.js';
import { jobSheet, followSteps, findingsOf, factsOf, stepsKept } from './jobsheet.js'; // (factsOf, stepsKept)
import * as levels from './levels.js';
import { sortable, sortGesture } from './sorting.js';
import { keepCovers, coversIn } from './covers.js'; // (coversIn)
import { morph } from './morph.js';

const $ = s => document.querySelector(s);
const REFRESH_MS = 20000;
// what a tap opens, by its data- attribute
const TAPPABLE = 'business project group thread job up done close card leave turn'.split(' ').map(n => `data-${n}`);

let board = null,
  // while no job can start for memory, the coordinator's line saying so (room.ts), else null
  room = null,
  // where the board is: a business, a project and a thread in it, or a group (recurring, unsorted); jobId: the job open
  // over it (lookedUp: one asked for by a link that the board no longer holds); back: whether it's turned over (its
  // steps show there); notice: what came of a work link's job, if it isn't there (gone, unopened)
  view = { ...levels.HOME, back: false, notice: null, unkept: false },
  lookedUp = null,
  // the job a work link asked for, until the view has moved to its thread (placeOf).
  landing = null,
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
  arriving = Promise.resolve(),
  // how far down each level the board went into another from was scrolled, by its place (levels.placeKey): back up
  // there, it's where it was.
  scrolls = new Map(),
  // the open card's log's following while its job runs, or null once it ends (follow).
  following = null;
export const projectsOpen = () => !$('#projects').hidden;
const modal = () => $('#projects .pj-modal');
// until the board first loads: three of the view’s keys pressed in turn.
const LOADING = `<div class="pj-loading" role="status" aria-label="Gathering the projects…">${'<i></i>'.repeat(3)}</div>`;
const UNKEPT = '<p class="pj-notice pj-unkept" role="status">Couldn’t confirm your new order. Try it again.</p>';

// ---------------------------------------------------------------- in and out
export function initProjects() {
  $('#projects').innerHTML = '<div class="pj-modal"></div>';
  $('#projects').addEventListener('click', tapped);
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
// tapped to open it) and back. at: a job to open (a work link: desk.js openJob), on its own thread, a group (the HUD's
// line), or a business, a project or a thread in it (HQ's search; done: a done thread, refresh() loads it.).
export async function openProjects(at = {}) {
  const was = projectsOpen() && !shutting();
  switched(true);
  supersede();
  if (!was) {
    sfx.open();
    levels.fly(modal(), at.from);
  }
  view = { ...view, jobId: at.job ?? null, group: at.group ?? null, back: false, notice: null };
  // (a work link lands on the job's thread, the job's card in front: at once where the board read before holds it,
  // else once refresh() has it.)
  landing = at.job ?? null;
  if (landing !== null) origin = null;
  land();
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
  else if (landing !== null) modal().innerHTML = SKELETON;
  else if (!board || !was) modal().innerHTML = LOADING;
  await refresh(ready || was ? '' : 'down');
  clearInterval(timer);
  timer = setInterval(refresh, REFRESH_MS);
}
// Once HQ is up, the board's work and its level's covers, read ahead (painting nothing: an open meanwhile paints once,
// from its own read). The first open then paints at once, as a later one does.
export const readAhead = () => refresh('', false);
export async function closeProjects() {
  if (!projectsOpen() || shutting()) return;
  sfx.close();
  const mine = supersede();
  clearInterval(timer);
  $('#projects').classList.add('pj-shut');
  // (the scene stepped on under the view: it draws again as the veil fades, showing the world as it is now)
  cover(false, 'projects');
  await levels.fly(modal(), null, true);
  if (move === mine) switched(false);
}
// The HUD's Projects key: it opens the view, flying out of the key, and a second press closes it
export const toggleProjects = from => (projectsOpen() && !shutting() ? closeProjects() : openProjects({ from }));
const shutting = () => $('#projects').classList.contains('pj-shut');
function switched(on) {
  $('#projects').hidden = !on;
  cover(on, 'projects'); // (the deck dimmed under it draws nothing while it's out: Holo's costs a slow device's frames)
  $('#projects').classList.remove('pj-shut');
  document.body.classList.toggle('projects', on);
  $('#btn-projects').setAttribute('aria-pressed', on);
  if (on) measureInset();
}
// the keys start under the HUD, however many rows its tools wrap to, and scroll under it out of sight
function measureInset() {
  if (projectsOpen())
    $('#projects').style.setProperty('--pj-top', `${Math.round($('#hud').getBoundingClientRect().bottom)}px`);
}
async function refresh(motion = '', paints = true) {
  try {
    [board, { line: room }] = await Promise.all([loadBoard(world.dev), loadRoom(world.dev)]);
    for (const t of projects().flatMap(p => p.threads)) closed.delete(t.id);
    const done = everyProject().flatMap(p => p.done);
    if (done.some(t => t.id === view.thread)) closed.set(view.thread, await loadThread(world.dev, view.thread));
    if (view.jobId && !jobsOnBoard().some(j => j.id === view.jobId) && lookedUp?.id !== view.jobId) {
      lookedUp = await loadJob(world.dev, view.jobId);
      if (!lookedUp) {
        view.notice = 'That job isn’t there any more.';
        view.jobId = landing = null;
      }
    }
    await land(true);
    // (the level about to paint waits on its own covers alone.)
    await keepCovers(board, coversIn(levelHtml(here(), { view, board, opening })));
  } catch {
    if (!board)
      modal().innerHTML = `<div class="pj-board"><p class="pj-notice" role="status">The projects didn’t load. Trying again…</p></div>${LOADING}`;
    return;
  }
  await arriving;
  // (a key pressed to sort keeps its grid until the gesture ends)
  if (paints && projectsOpen() && !sortGesture()) paint(motion);
}

// ---------------------------------------------------------------- the board's work, read
const projects = () => board?.projects ?? [];
// the completed, as projects with only done threads (a list opens them)
const completed = () => (board?.completed ?? []).map(p => ({ ...p, threads: [], done: p.threads }));
const everyProject = () => [...projects(), ...completed()];
const businesses = () => board?.businesses ?? [];
const work = () => ({ projects: projects(), completed: completed(), businesses: businesses(), closed });
const here = () => levels.level(view, work());
// every job with its project and thread (a done thread's the board opened too), and the loose ones (being placed) with
// neither
function jobsOnBoard() {
  const threads = everyProject().flatMap(p =>
    [...p.threads, ...[...closed.values()].filter(t => t.project === p.id)].map(t => [p, t]),
  );
  const placed = threads.flatMap(([p, t]) => t.jobs.map(j => ({ ...j, project: p, projectThread: t })));
  return [...placed, ...(board?.unsorted ?? []), ...(board?.meetings ?? []), ...(lookedUp ? [lookedUp] : [])];
}
const onBoard = id => jobsOnBoard().find(x => x.id === id && x.projectThread);
// A work link's job, once its place is known: the view moves there, the job's card still in front. read: the board's
// work is read, so a job of a done thread has it loaded (as a tap on its tile does), and one in none opens where the view
// is. One whose thread doesn't load opens there too, saying so. A move made while it loads ends the landing (supersede).
async function land(read = false) {
  const id = landing;
  if (id === null || id !== view.jobId) return;
  const thread = read && !onBoard(id) && lookedUp?.id === id && lookedUp.thread;
  const loaded = thread && !closed.has(thread) ? await loadThread(world.dev, thread).catch(() => 'failed') : null;
  if (landing !== id) return;
  if (loaded === 'failed') view.notice = 'This job’s thread didn’t open. Open its link again to try.';
  else if (loaded) closed.set(thread, loaded);
  const place = levels.placeOf(onBoard(landing));
  if (place) view = { ...view, ...place };
  if (place || read) landing = null;
}
// ---------------------------------------------------------------- moving about
// A move to a change of the view: the level's keys leave, and it commits unless a later move came meanwhile
async function go(change, motion = '') {
  const mine = supersede();
  await levels.leave($('#projects .pj-level'), motion);
  if (move !== mine) return;
  if (motion === 'down') scrolls.set(levels.placeKey(view), $('#projects .pj-board')?.scrollTop ?? 0);
  view = { ...view, notice: null, unkept: false, ...change };
  paint(motion);
}
// A new move: the one before it, a done thread's load or failure on its tile, and a work link's landing, end
function supersede() {
  opening = landing = null;
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
  } else if (data.thread) openThread(data.thread, data.in);
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
}
// A tap on the dimmed page round the view closes it, one beside the open job closes that, and one on its card (not on
// a key or a link) turns it over, as the home page's big key does; one on a line of its steps opens that line, as there
function blank(e) {
  const step = e.target.closest('.pj-card .steplog li[data-k]');
  if (e.target === $('#projects')) closeProjects();
  else if (e.target.closest('.pj-pop') && !e.target.closest('.pj-card')) closeJob();
  else if (step && !e.target.closest('a')) step.classList.toggle('open');
  else if (e.target.closest('.pj-card') && !e.target.closest('a, summary, .steplog')) turnJob();
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
  go({ jobId: id, back: false });
}
async function closeJob() {
  const card = $('#projects .pj-card'),
    row = $(`#projects .pj-level .cover[data-job="${view.jobId}"]`); // (its row's, not a link to it)
  sfx.close();
  lookedUp = null;
  const mine = supersede();
  $('#projects .pj-pop')?.classList.add('pj-shut');
  if (card) await levels.fly(card, row?.getBoundingClientRect(), true);
  if (move === mine) go({ jobId: null, back: false });
}
// The open job's card, turned over (where it has a back)
function turnJob() {
  const card = $('#projects .pj-card');
  if (!card?.querySelector('.pj-back') || card.turning) return;
  sfx.flip();
  view.back = !view.back;
  levels.turn(card);
}
// A thread opens over its project (on a list of threads, the one it's in: view.group keeps the list): an open one at
// once, a done one once its jobs are loaded, if the board is still there. A load that fails says so, a tap tries again.
async function openThread(id, project = view.project) {
  if (opening?.id === id && opening.pending) return;
  sfx.open();
  const open = () => go({ project, thread: id, showDone: closed.has(id) }, 'down');
  if (projects().some(p => p.threads.some(t => t.id === id))) return open();
  const mine = supersede();
  opening = { id, project, words: 'Opening…', pending: true };
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
// A grid's new order, kept by the coordinator for every device.
async function sorted(ids) {
  sfx.blip();
  let order;
  try {
    ({ order } = await keepOrder(world.dev, ids));
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

// ---------------------------------------------------------------- drawing
// what the open job's card reads as it shows: a finished review's findings, its record and its steps
const reads = {
  findings: id => loadFindings(world.dev, id),
  facts: id => loadJobFacts(world.dev, id),
  steps: id => loadJobLog(world.dev, id),
};
// the open card's steps followed till its job, as the view has it now, ends.
function follow(sheet, job, kept) {
  const run = job.status === 'running' ? {} : null;
  following = run;
  const now = () => jobsOnBoard().find(x => x.id === job.id);
  followSteps(sheet, job, reads.steps, kept, now).then(() => {
    if (following === run) following = null;
  });
}
function paint(motion = '') {
  const el = $('#projects');
  if (view.business && !businesses().some(e => e.id === view.business)) view.business = null;
  if (view.project && !everyProject().some(p => p.id === view.project)) view.project = view.thread = null;
  const l = here();
  if (view.thread && l.at !== 'thread') view.thread = null;
  const kept = {
    board: el.querySelector('.pj-board')?.scrollTop ?? 0,
    steps: stepsKept(el),
    sums: [...el.querySelectorAll('.pj-eta[open]')].map(d => d.dataset.eta),
    page: !!el.querySelector('.pj-page[open]'),
    focus: levels.focusOf(el, TAPPABLE),
  };
  const sameJob = el.querySelector('.pj-card')?.dataset.jobOpen === String(view.jobId ?? '');
  const job = view.jobId ? jobsOnBoard().find(x => x.id === view.jobId) : null;
  const notice = view.notice ? `<p class="pj-notice" role="status">${view.notice}</p>` : '',
    unkept = view.unkept ? UNKEPT : '';
  const starved = room ? `<p class="pj-notice" role="status">${esc(room)}</p>` : '';
  const level = `<div class="pj-board">${starved}${notice}${unkept}${levelHtml(l, { view, board, opening })}</div>`;
  const listed = findingsOf(job, reads.findings, paint),
    facts = factsOf(job, reads.facts, paint, board);
  const sheetHtml = jobSheet(job, jobsOnBoard(), { back: view.back, findings: listed, facts });
  // (a move draws the level anew; anything else, a refresh say, brings the view up to date in place: rebuilt, it
  // flashed, an open job's veil fading in again. The open job's steps it loaded stay, still followed; another job's
  // card is drawn anew, so the last one's steps, still loading, land in its own log and not in this one's.)
  const log = el.querySelector('.pj-card .steplog');
  if (motion) {
    modal().innerHTML = level;
    el.querySelector('.pj-pop')?.remove();
    el.insertAdjacentHTML('beforeend', sheetHtml);
  } else {
    if (!sameJob) el.querySelector('.pj-pop')?.remove();
    morph(el, `<div class="pj-modal">${level}</div>${sheetHtml}`, n => sameJob && n.matches('.steplog'));
  }
  el.dataset.level = l.at;
  el.querySelector('.pj-board').scrollTop =
    motion === 'up' ? (scrolls.get(levels.placeKey(view)) ?? 0) : motion ? 0 : kept.board;
  el.querySelectorAll('.pj-eta').forEach(d => (d.open = kept.sums.includes(d.dataset.eta)));
  el.querySelector('.pj-page')?.toggleAttribute('open', kept.page);
  const sheet = el.querySelector('.pj-card');
  if (sheet && !sameJob) levels.fly(sheet, origin);
  if (sheet && (sheet.querySelector('.steplog') !== log || (job.status === 'running' && !following)))
    follow(sheet, job, sameJob ? kept.steps : null);
  if (kept.focus) el.querySelectorAll(kept.focus.selector)[kept.focus.index]?.focus({ preventScroll: true });
  levels.moveIn(el, motion);
  arriving = levels.settled(el);
}
