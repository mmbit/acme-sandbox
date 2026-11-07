// A failed or stopped job's saved work: the job that lands it (hq job --lands), HQ's own landing of a failed push's, and
// the deliverable's judge held while it's off its branch. (jobs.ts imports it, so it stays apart from takeover.ts,
// whose imports would load before jobs.ts's SQL builders.)
// (its messages say deliverable, the board's word for a thread)
import { execFileSync } from 'node:child_process';
import { db } from './db.ts';
import * as jobs from './jobs.ts';
import { ceo, roles } from './company.ts';

const WORK_MIRROR_DIR = process.env.WORK_MIRROR_DIR!;

export type Item = { id: number; call: number; status: string; why: string | null };

// hq job --lands <job>: the failed or stopped job's commits stay on the mirror's refs/outgoing/<branch> (worker git.ts push), and the
// job landing them replaces it, carrying its call and item. Its agent is the failed job's own, who worked for
// that call already; only that agent, whoever queued the failed job, the CEO or the process role queues it. Work with a
// pull request goes on there (review.ts decide), unless a thread task saved nothing of its own. The answer supplies
// its original brief and the saved branch if any. A job being stopped (hq stop, still running or paused) is landed as
// it ends: a job that stops itself queues its redo before its run is over, and a deliverable's task order holds the
// landing until it has ended (threadorder.ts follows).
export function landing(failed: number, agent: string, by: string) {
  const job = db
    .prepare(
      `select agent, queued_by, coalesce(branch, 'job/' || id) branch, prompt, thread, pr, started, finished from jobs
      where id = ? and kind = 'work' and (status in ('failed', 'stopped') or (stopping is not null and status in ${jobs.OPEN_JOBS}))`,
    )
    .get(failed) as LandingJob | undefined;
  if (!job) {
    const running = db.prepare("select 1 from jobs where id = ? and kind = 'work' and status = 'running'").get(failed);
    return running
      ? `job #${failed} is still running: stop it first (hq stop ${failed} "why"), and the job landing its work takes its place as it ends`
      : `job #${failed} isn't failed or stopped work: --lands names a failed or stopped job whose saved work this one lands`;
  }
  const pr = db
    .prepare(`select number, status in ${jobs.OPEN_PRS} as open from prs where branch = ? order by number desc limit 1`)
    .get(job.branch) as { number: number; open: number } | undefined;
  const empty = pr && job.pr === null && job.thread !== null && pr.open === 1 && emptyThreadTask(job, pr.number);
  if (pr && !empty)
    return `job #${failed}'s branch has pull request #${pr.number}: its saved work goes on there, not with --lands. Only a deliverable's task that saved nothing can be requeued in its place`;
  const taken = jobs.replacementOf(failed);
  if (taken) return `job #${taken} has taken over #${failed}'s work already`;
  const ended = itemsOf(failed).find(i => i.status === 'dropped' || i.status === 'replaced');
  if (ended)
    return `job #${failed}'s item #${ended.id} was ${ended.status}: queue its remaining work separately with hq job`;
  if (agent !== job.agent)
    return `job #${failed} is ${job.agent}'s, and so is the job landing its work: it carries their call and item`;
  if (![job.agent, job.queued_by, ceo(), roles().process].includes(by))
    return `only ${job.agent}, whoever queued #${failed}, the CEO or the process role lands its work`;
  return { branch: empty ? null : job.branch, prompt: job.prompt };
}
// The line a landing's brief gains when the work it lands was saved on a branch of its own
export const savedWorkLine = (failed: number, branch: string | null) =>
  branch ? `\n\nThis job takes over the saved work of #${failed}: \`git fetch origin refs/outgoing/${branch}\`.` : '';

// A failed job whose push never reached its branch (GitHub refused it, or the worker's checks before it) keeps its
// commits only on the mirror's refs/outgoing/<branch>. HQ queues the landing itself as the run ends (jobs.ts handOn):
// its agent's, in its place, so what waits on it waits for the landing (jobs.ts standsIn, wakes.ts prOf). HQ lands a
// job's work once: a landing of HQ's that fails the same way stays failed with nothing in its place, which the CEO's
// summary lists (threats.ts failed). The answer: the landing's id, or undefined when HQ queued none.
export function landSaved(failed: number, branch: string, result: string | undefined) {
  if (!savedOffBranch(branch)) return undefined;
  const job = db.prepare('select agent, title, thread from jobs where id = ?').get(failed) as {
    agent: string;
    title: string;
    thread: string | null;
  };
  const landedOnce = db
    .prepare(`select 1 from jobs where id in (${jobs.lineageTo('?')}) and step = ?`)
    .get(failed, LANDS);
  const source = landedOnce ? 'HQ landed its work once already' : landing(failed, job.agent, job.agent);
  if (typeof source === 'string') return notLanded(failed, source);
  try {
    return jobs.createJob({
      agent: job.agent,
      title: job.title,
      step: LANDS,
      thread: job.thread,
      insteadOf: failed,
      prompt: `${source.prompt}${savedWorkLine(failed, source.branch)}${pushFailed(failed, result)}`,
    }).id;
  } catch (err) {
    if (!(err instanceof jobs.NoSeat)) throw err;
    return notLanded(failed, err.message);
  }
}
const LANDS = 'Landing saved work';
const notLanded = (failed: number, why: string) => {
  console.log(`#${failed}: saved work off its branch, not landed by HQ: ${why}`);
  return undefined;
};
// Why the landing runs: its push's error is the end of the failed job's report, quoted as data (an agent's words come
// before it), unless the report holds a customer's own details, which stay with that job.
const pushFailed = (failed: number, result = '') =>
  `\n\nIts run ended, but its push didn't reach its branch, so HQ queued this job to land that work: fix what kept ` +
  `it off and finish as the brief asks. ` +
  (jobs.holdsCustomerData(failed)
    ? `Its report holds a customer's own details, so it stays with #${failed}: the push's error is at its end.`
    : `The end of its report, with the push's error, as a JSON string: ${JSON.stringify(result.slice(-1_500))}`);

// Whether a failed task of the deliverable, with nothing in its place, keeps work off its branch: its judge waits until
// that work is on a branch (threadends.ts runEnded).
export function heldOffBranch(thread: string) {
  const failedTasks = db
    .prepare("select id, branch from jobs where thread = ? and kind = 'work' and status = 'failed'")
    .all(thread) as { id: number; branch: string | null }[];
  return failedTasks.some(task => jobs.replacementOf(task.id) === null && savedOffBranch(jobs.workBranchOf(task)));
}

// Whether the mirror's refs/outgoing/<branch> (worker git.ts push: written before every push) holds commits its branch
// doesn't. None there, or one the branch has, is nothing saved off it. Any git failure but its "no" stops the call.
function savedOffBranch(branch: string) {
  const saved = ifYes(() => mirror('rev-parse', '--verify', '-q', `refs/outgoing/${branch}^{commit}`));
  if (saved === undefined) return false;
  const head = ifYes(() => mirror('rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`));
  return head === undefined || !isAncestor(saved.trim(), head.trim());
}
const isAncestor = (commit: string, head: string) =>
  ifYes(() => mirror('merge-base', '--is-ancestor', commit, head)) !== undefined;
// A git call's output when git answers yes, undefined when it answers no (exit 1: no such ref, not an ancestor)
function ifYes(call: () => string) {
  try {
    return call();
  } catch (err) {
    if ((err as { status?: number | null }).status === 1) return undefined;
    throw err;
  }
}

type LandingJob = {
  agent: string;
  queued_by: string | null;
  branch: string;
  prompt: string;
  thread: string | null;
  pr: number | null;
  started: string | null;
  finished: string | null; // (null: still being stopped)
};

// A task that never started saved nothing. The pull request's last push before it started is where earlier tasks'
// work ends (none: the task started on the branch before any push). First-parent commit times identify work saved
// during this task, while later tasks and main's merged-in commits stay outside it. Git records commit times to the
// second. A branch with an open pull request has both refs in the mirror (the worker's push), and git fails on one
// that's missing, which stops the request.
function emptyThreadTask(job: LandingJob, pr: number) {
  if (!job.started) return true;
  const head = db
    .prepare('select sha from pushes where pr = ? and at <= ? order by at desc limit 1')
    .get(pr, job.started) as { sha: string } | undefined;
  const commits = mirror(
    'log',
    '--first-parent',
    '--format=%ct',
    `refs/heads/${job.branch}`,
    `refs/outgoing/${job.branch}`,
    ...(head ? ['--not', head.sha] : []),
  );
  const started = Math.floor(Date.parse(job.started) / 1000),
    finished = Math.floor((job.finished ? Date.parse(job.finished) : Date.now()) / 1000);
  return !commits
    .split('\n')
    .filter(Boolean)
    .some(at => Number(at) >= started && Number(at) <= finished);
}

// A git call on the work mirror: its output
const mirror = (...args: string[]) =>
  execFileSync('git', ['-c', `safe.directory=${WORK_MIRROR_DIR}`, '--git-dir', WORK_MIRROR_DIR, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

// The items the failed job, or a failed job it replaced, carried or was handed.
export const itemsOf = (failed: number) =>
  db
    .prepare(
      `select id, call, status, why from call_items where job in (${jobs.lineageTo('?1')})
      or id in (select item from jobs where id in (${jobs.lineageTo('?1')})) order by id`,
    )
    .all(failed) as Item[];
