// A failed job's work taken over by a job that replaces it (jobs.ts replacements). hq followthrough requeue: the CEO's
// follow-through check hands a failed job's work on what the board agreed back to the agent whose call it is. hq job
// --lands: a job lands saved work or retries a thread task that failed without saving work.
import { execFileSync } from 'node:child_process';
import { db } from './db.ts';
import * as jobs from './jobs.ts';
import * as memory from './memory.ts';
import { agreements, oneLine } from './agreements.ts';
import { checkUnderWay, LONG_LINE, SAID_MAX } from './followthrough.ts';
import { ceo, roles } from './company.ts';

const WORK_MIRROR_DIR = process.env.WORK_MIRROR_DIR!;

//
type Failed = {
  id: number;
  agent: string;
  title: string;
  step: string | null; // (its name, with title: nameOf.)
  round: number | null;
  call: number | null;
  item: number | null;
  branch: string | null;
  pr: number | null;
};
type Item = { id: number; call: number; status: string; why: string | null };

// The new job works for the call (jobs.call and the item it carried) and replaces the failed job (jobs.ts replacements):
// it takes over the items that job and any it replaced were handed (and its thread, with the thread's deadline), and so
// finishes the failure. The
// check works for no call itself: it never reads one, and the new job reads it as the call's follow-up would. Work on
// calls of more than one agent, or on more calls than one job works for, isn't requeued in one: each call's agent gets a
// job of its own (hq job).
export function requeue(checkJob: number, failed: number, said: string) {
  if (!checkUnderWay(checkJob)) return "only HQ's follow-through check requeues agreed work, before its verdict";
  const line = oneLine(said);
  if (!line) return 'say in one line what was off, for the job taking it over: hq followthrough requeue <job> "..."';
  if (line.length > SAID_MAX) return LONG_LINE;
  const job = db
    .prepare(
      `select id, agent, title, step, round, call, item, branch, pr from jobs
      where id = ? and kind = 'work' and status = 'failed'`,
    )
    .get(failed) as Failed | undefined;
  if (!job) return `job #${failed} isn't work that failed: only a failed job's work is requeued`;
  const taken = jobs.replacementOf(failed);
  if (taken) return `job #${taken} has taken over #${failed}'s work already`;
  const items = itemsOf(failed);
  const standing = new Set(agreements().map(a => a.id));
  if (!items.some(i => standing.has(i.id)))
    return `job #${failed} carries nothing the board agreed that still stands (hq followthrough lists what does)`;
  const ended = items.find(i => i.status === 'dropped' || i.status === 'replaced');
  if (ended)
    return `job #${failed}'s item #${ended.id} was ${ended.status}: queue its remaining work separately with hq job`;
  const taker = takerOf(job, items);
  if (typeof taker === 'string') return taker;
  const { carried, on, calls, agent } = taker;
  const { id } = jobs.createJob({
    agent,
    title: job.title,
    step: 'Taking over',
    call: on,
    item: carried.id,
    insteadOf: failed,
    from: failed,
    queuedBy: ceo(),
    prompt: brief(job, { line, on, carried: carried.id, agent }),
  });
  if (calls.some(memory.customerCall)) jobs.handedCustomerData(id);
  return { ok: true, id, agent };
}

// hq job --lands <job>: the failed or stopped job's commits stay on the mirror's refs/outgoing/<branch> (worker git.ts push), and the
// job landing them replaces it, carrying its call and item. Its agent is the failed job's own, who worked for
// that call already; only that agent, whoever queued the failed job, the CEO or the process role queues it. Work with a
// pull request goes on there (review.ts decide), unless a thread task saved nothing of its own. The answer supplies
// its original brief, the saved branch if any, and whether the new job holds a customer's details.
export function landing(failed: number, agent: string, by: string) {
  const job = db
    .prepare(
      `select agent, queued_by, coalesce(branch, 'job/' || id) branch, call, prompt, thread, pr, started, finished from jobs
      where id = ? and kind = 'work' and status in ('failed', 'stopped')`,
    )
    .get(failed) as LandingJob | undefined;
  if (!job)
    return `job #${failed} isn't failed or stopped work: --lands names a failed or stopped job whose saved work this one lands`;
  const pr = db
    .prepare(`select number, status in ${jobs.OPEN_PRS} as open from prs where branch = ? order by number desc limit 1`)
    .get(job.branch) as { number: number; open: number } | undefined;
  const empty = pr && job.pr === null && job.thread !== null && pr.open === 1 && emptyThreadTask(job, pr.number);
  if (pr && !empty)
    return `job #${failed}'s branch has pull request #${pr.number}: its saved work goes on there, not with --lands. Only a thread task that saved nothing can be requeued in its place`;
  const taken = jobs.replacementOf(failed);
  if (taken) return `job #${taken} has taken over #${failed}'s work already`;
  const ended = itemsOf(failed).find(i => i.status === 'dropped' || i.status === 'replaced');
  if (ended)
    return `job #${failed}'s item #${ended.id} was ${ended.status}: queue its remaining work separately with hq job`;
  if (agent !== job.agent)
    return `job #${failed} is ${job.agent}'s, and so is the job landing its work: it carries their call and item`;
  if (![job.agent, job.queued_by, ceo(), roles().process].includes(by))
    return `only ${job.agent}, whoever queued #${failed}, the CEO or the process role lands its work`;
  const customers = jobs.holdsCustomerData(failed) || (job.call != null && memory.customerCall(job.call));
  return { branch: empty ? null : job.branch, customers, prompt: job.prompt };
}

type LandingJob = {
  agent: string;
  queued_by: string | null;
  branch: string;
  call: number | null;
  prompt: string;
  thread: string | null;
  pr: number | null;
  started: string | null;
  finished: string;
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
  const commits = execFileSync(
    'git',
    [
      '-c',
      `safe.directory=${WORK_MIRROR_DIR}`,
      '--git-dir',
      WORK_MIRROR_DIR,
      'log',
      '--first-parent',
      '--format=%ct',
      `refs/heads/${job.branch}`,
      `refs/outgoing/${job.branch}`,
      ...(head ? ['--not', head.sha] : []),
    ],
    { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const started = Math.floor(Date.parse(job.started) / 1000),
    finished = Math.floor(Date.parse(job.finished) / 1000);
  return !commits
    .split('\n')
    .filter(Boolean)
    .some(at => Number(at) >= started && Number(at) <= finished);
}

// The items the failed job, or a failed job it replaced, carried or was handed.
const itemsOf = (failed: number) =>
  db
    .prepare(
      `select id, call, status, why from call_items where job in (${jobs.lineageTo('?1')})
      or id in (select item from jobs where id in (${jobs.lineageTo('?1')})) order by id`,
    )
    .all(failed) as Item[];

function takerOf(job: Failed, items: Item[]) {
  const carried = items.find(i => i.id === job.item) ?? items[0];
  const on = job.call ?? carried.call;
  const calls = [...new Set([on, ...items.map(i => i.call)])];
  const agents = [
    ...new Set(calls.map(c => (db.prepare('select agent from calls where id = ?').get(c) as { agent: string }).agent)),
  ];
  // the new job works for a call it's handed out on (jobs.call) or carries an item of (ledger.ts mine): every call here
  if (agents.length > 1 || calls.some(c => c !== on && c !== carried.call))
    return `job #${job.id}'s work is on calls ${calls.map(c => `#${c}`).join(', ')}${agents.length > 1 ? ` of ${agents.join(' and ')}` : ''}, more than one job works for: queue each call's agent a job (hq job) with what you found`;
  if (!jobs.findAgent(agents[0]))
    return `call #${on}'s agent ${agents[0]} isn't on the staff: queue the item's owner a job (hq job) with what you found`;
  return { carried, on, calls, agent: agents[0] };
}

function brief(job: Failed, to: { line: string; on: number; carried: number; agent: string }) {
  const ask = job.agent === to.agent ? '' : `; ask ${job.agent} with hq say`;
  const pullRequest = job.pr ? `pull request #${job.pr}` : 'pull request, if any';
  return (
    `Job #${job.id} (${job.agent}: ${jobs.nameOf(job)}) failed, and its work is on what the board agreed on your call #${to.on}. ` +
    `The CEO's hourly follow-through check found: ${to.line}\n\nYou take that work over, as the call's follow-up would. ` +
    `Read what the board agreed (\`hq items ${to.on}\`, \`hq call ${to.on}\`) and what #${job.id} left (its branch ` +
    `${job.branch ?? `job/${job.id}`} and ${pullRequest}${ask}), then do the rest or hand it on (\`hq job\`: what you queue carries ` +
    `item #${to.carried}). This job finishes #${job.id}'s failure by ending done.`
  );
}
