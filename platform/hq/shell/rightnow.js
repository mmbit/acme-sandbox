// An agent's panel: what it's at right now
// Each job it has running, with the project and thread it serves as the projects view names them, its latest words for
// it, its own time and lines. With several, one at a time, its place among them and a step either way (a tap or the
// arrow keys); the one shown stays through the panel's redraws until it ends.
import { esc, mins } from '../util.js';
import * as world from '../world/world.js';
import { sfx } from './audio.js';
import { body, panelOpen, refreshAgent } from './panel.js';
import { refreshOrg } from './main.js';

export function initRightNow() {
  // (before the camera's arrows, input.js, which leave a key taken here alone)
  addEventListener('keydown', stepByKey, true);
  world.on('read', readIn);
}
// the job in hand as the Wire look's panes show it: how long it's been on, and the lines it has added and removed
const onJob = (A, job = A) =>
  A.state === 'working' && job.since
    ? `<small class="on-job">${mins(job.since)} on it · +${job.lines?.add ?? 0} −${job.lines?.del ?? 0} lines</small>`
    : '';
let shownJob = null; // { agent, job }: the running job stepped to
export function rightNow(A) {
  if (reading?.agent === A.id && !((A.heard ?? 0) > reading.asked))
    return reading.failed
      ? '<h3>Right now</h3><p><span class="muted">The desk can’t be checked right now: no answer from the coordinator.</span></p>'
      : '<h3>Right now</h3><p><span class="muted">Checking the desk…</span></p>';
  const jobs = (A.state === 'working' && A.jobs) || [];
  if (!jobs.length) {
    const task = A.task ? esc(A.task) : '<span class="muted">Nothing on the desk right now.</span>';
    return `<h3>Right now</h3><p>${task}</p>${onJob(A)}`;
  }
  const at = shownAt(A.id, jobs),
    job = jobs[at];
  const pager =
    jobs.length < 2
      ? ''
      : `<nav class="pager jobs-pager" aria-label="Running jobs"><button data-step="-1" aria-label="Previous job">‹</button>
    <span aria-live="polite">${at + 1} of ${jobs.length}</span><button data-step="1" aria-label="Next job">›</button></nav>`;
  return `<h3>Right now</h3>${pager}${whereHtml(job)}<p>${esc(job.task)}</p>${onJob(A, { ...job, since: Date.parse(job.since) })}`;
}
// A panel opened anew reads who's at work again before it says (main.js refreshOrg): what the building holds can be old,
// a feed cut off while a tablet slept misses one job ending and the next starting. Until a read is in (that one, or the
// next after it failed), or the feed brings a status of theirs after it was asked, a quiet line instead, and one that
// says so when the read failed (the board's picture #67.)
let reading = null; // { agent, asked, failed }
export function readFresh(agent) {
  if (world.dev) return; // (the mock org runs no jobs)
  const read = (reading = { agent, asked: Date.now(), failed: false });
  refreshOrg().then(came => {
    if (came || reading !== read) return;
    read.failed = true;
    refreshAgent(agent);
  });
}
function readIn() {
  if (!reading) return;
  const { agent } = reading;
  reading = null;
  refreshAgent(agent);
}
// (the first, newest, until the board steps, and again once the one it stepped to ends)
const shownAt = (agent, jobs) =>
  Math.max(0, shownJob?.agent === agent ? jobs.findIndex(j => j.id === shownJob.job) : 0);
const whereHtml = job => (job?.thread ? `<p class="where">${esc(job.project)} · ${esc(job.thread)}</p>` : '');
function stepJob(by) {
  const A = world.agents.get(panelOpen()?.ref),
    jobs = A?.jobs ?? [];
  if (jobs.length < 2) return;
  shownJob = { agent: A.id, job: jobs[(shownAt(A.id, jobs) + by + jobs.length) % jobs.length].id };
  sfx.blip();
  const task = body.querySelector('.task'),
    focused = task.querySelector(':focus')?.dataset.step;
  task.innerHTML = rightNow(A);
  wireSteps();
  if (focused) task.querySelector(`[data-step="${focused}"]`).focus();
}
export const wireSteps = () =>
  body.querySelectorAll('.jobs-pager [data-step]').forEach(b => (b.onclick = () => stepJob(Number(b.dataset.step))));
function stepByKey(e) {
  const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  if (!step || panelOpen()?.kind !== 'agent' || !body.querySelector('.jobs-pager')) return;
  if (e.target.closest?.('input, textarea, select')) return;
  e.preventDefault();
  stepJob(step);
}
