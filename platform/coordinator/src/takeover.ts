// A failed job's work taken over by a job that replaces it (jobs.ts replacements). hq followthrough requeue: the CEO's
// follow-through check hands a failed job's work on what the board agreed back to the agent whose call it is. hq stop
// --for: a job queued already takes a stopped job's place, on the terms hq job --lands sets (savedwork.ts landing).
// (its messages say deliverable, the board's word for a thread)
import { db, planChange } from './db.ts';
import * as jobs from './jobs.ts';
import * as engineOnly from './engineonly.ts';
import { agreements, oneLine } from './agreements.ts';
import { checkUnderWay, LONG_LINE, SAID_MAX } from './followthrough.ts';
import { ceo } from './company.ts';
import { publish } from './events.ts';
import { writePlan } from './redraws.ts';
import { jobRefusal } from './threadorder.ts';
import { itemsOf, landing, savedWorkLine, type Item } from './savedwork.ts';

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
  const { carried, on, agent } = taker;
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
  return { ok: true, id, agent };
}

// hq stop <job> "why" [--for <job>]: stops a job still running or paused (jobs.ts stopJob). A deliverable's task stopped
// that its agent has queued again takes its place as the stop is recorded, so the tasks drawn after it wait for the redo
// rather than for a task that won't run again: the job --for names (also on a task stopped or failed already), else the
// one job of its agent's queued, under way or done there since it started (placeFor). Several are left to --for, which the answer names.
// Placing one changes the deliverable's plan, so only its project's owner or the CEO does (threadorder.ts jobRefusal);
// a refusal undoes the stop with it.
export function stopFor(id: number, replacement: number | undefined, by: string, why: string) {
  try {
    return writePlan(() => {
      const was = db.prepare('select status, stopping, thread from jobs where id = ?').get(id) as
        { status: string; stopping: string | null; thread: string | null } | undefined;
      const going = !!was && ['running', 'queued'].includes(was.status);
      const stopped =
        replacement === undefined || (going && !was.stopping)
          ? jobs.stopJob(id, by, why)
          : { ok: true as const, running: was?.status === 'running' };
      if (typeof stopped === 'string') throw new RefusedError(stopped);
      if (replacement !== undefined) {
        const placed = jobRefusal(by, jobs.threadOf(replacement)) ?? takesPlace(id, replacement, by);
        if (typeof placed === 'string') throw new RefusedError(placed);
        return { ...stopped, ...placed, ended: !going };
      }
      const offer = placeFor(id);
      if (!offer) return stopped;
      const redo = onlyRedo(offer);
      if (redo !== undefined && !jobRefusal(by, offer.deliverable)) {
        const placed = takesPlace(id, redo, by);
        if (typeof placed === 'object') return { ...stopped, ...placed };
      }
      return { ...stopped, ...offer };
    });
  } catch (err) {
    if (err instanceof RefusedError) return err.message;
    throw err;
  }
}
class RefusedError extends Error {}

// hq job: a job queued where its agent's task in that deliverable was stopped with nothing in its place takes that
// task's place, the stop's other order (stopFor), when it's the one job of theirs queued there since the task started
// (placeFor). Otherwise the answer names the agent's tasks there that stopped or failed with nothing in their place, for
// hq stop --for.
export function placeQueued(id: number, by: string) {
  const job = db.prepare('select agent, thread from jobs where id = ?').get(id) as {
    agent: string;
    thread: string | null;
  };
  const left = unplaced(job.thread, job.agent);
  const stopped = left.filter(t => t.status === 'stopped' || t.stopping !== null);
  const redoes = stopped.filter(t => onlyRedo(placeFor(t.id)) === id);
  if (redoes.length === 1 && typeof takesPlace(redoes[0].id, id, by) === 'object')
    return { takesPlaceOf: redoes[0].id };
  return left.length ? { unplaced: left.map(t => t.id) } : {};
}

// A job queued already does the stopped (or failed) job's work again and takes its place, as one queued with --lands
// would (landing): it stands in for it (jobs.ts standsIn), carries its code and the engine rule it ran under where it
// has none of its own (as createJob gives one queued with --lands: codeFrom, onlyFor), and its brief gains the saved
// work's branch. Only work of the same agent in the same deliverable, placed by whoever may land the stopped job's work.
// A continuation under way or done already (an urgent one starts within minutes) takes its place too, when it was
// queued since the stopped job started: its brief was read and its engine chosen, so it keeps both.
function takesPlace(stopped: number, replacement: number, by: string) {
  const next = db
    .prepare(
      `select j.id, j.agent, j.thread, j.engine_only, j.started is not null as started from jobs j
      join jobs s on s.id = ? where j.id = ? and j.kind = 'work' and j.pr is null
      and (j.status = 'queued' and j.session is null or ${STARTED_WORK('j', 'coalesce(s.started, s.created)')})`,
    )
    .get(stopped, replacement) as
    { id: number; agent: string; thread: string | null; engine_only: string | null; started: number } | undefined;
  if (!next || next.id === stopped)
    return `#${replacement} isn't work queued, or under way since #${stopped} started: --for names the job that does #${stopped}'s work again`;
  const source = landing(stopped, next.agent, by);
  if (typeof source === 'string') return source;
  const thread = jobs.threadOf(stopped);
  if (thread !== next.thread)
    return `#${replacement} is in ${next.thread ?? 'no deliverable'}, #${stopped} in ${thread ?? 'none'}: the job taking its place is in its deliverable`;
  jobs.standsIn(replacement, [stopped]);
  const was = db.prepare('select code, engine_only from jobs where id = ?').get(stopped) as {
    code: string | null;
    engine_only: string | null;
  };
  db.prepare('update jobs set code = coalesce(code, ?) where id = ?').run(was.code, replacement);
  const rule = next.engine_only || next.started ? undefined : engineOnly.byId(was.engine_only);
  if (rule) engineOnly.pin(replacement, rule);
  // (one under way read its brief already)
  if (!next.started)
    db.prepare('update jobs set prompt = prompt || ? where id = ?').run(
      savedWorkLine(stopped, source.branch),
      replacement,
    );
  if (thread)
    planChange({ project: thread.split('/')[0], thread, what: `task #${replacement} takes #${stopped}'s place`, by });
  publish({ type: 'log', agent: by, text: `#${replacement} takes the place of #${stopped} (${next.agent})` });
  return { ok: true as const, replacement };
}
// A deliverable's task stopped (or being stopped) or failed, with nothing in its place, holds the tasks drawn before it
// ended (threadorder.ts failed): its deliverable, and its agent's work queued, under way or done there since it started
// that may take its place.
function placeFor(stopped: number) {
  const job = db
    .prepare(
      `select id, agent, thread, coalesce(started, created) since from jobs j
      where id = ? and kind = 'work' and pr is null and thread is not null and not ${jobs.hasReplacement('j.id')}`,
    )
    .get(stopped) as { id: number; agent: string; thread: string; since: string } | undefined;
  if (!job) return undefined;
  const queued = db
    .prepare(
      `select id from jobs j where thread = $thread and agent = $agent and kind = 'work' and pr is null
      and (status = 'queued' and session is null or ${STARTED_WORK('j', '$since')})
      and instead_of is null and id != $id and created >= $since order by id`,
    )
    .all({ thread: job.thread, agent: job.agent, id: job.id, since: job.since }) as { id: number }[];
  return { deliverable: job.thread, queued: queued.map(q => q.id) };
}
// Work (`j`, an SQL table alias) under way or done, queued since the stopped task started (`since`, an SQL time), which
// may continue its work: urgent, it started before anyone could put it in that task's place
const STARTED_WORK = (j: string, since: string) =>
  `(${j}.status in ('running', 'blocked', 'done') and ${j}.started is not null and ${j}.created >= ${since})`;
// The one job of its agent's queued, under way or done there since the task started, which takes its place without --for
const onlyRedo = (offer: ReturnType<typeof placeFor>) => (offer?.queued.length === 1 ? offer.queued[0] : undefined);
// The agent's tasks in a deliverable that stopped or failed (or are being stopped) with nothing in their place.
function unplaced(thread: string | null, agent: string) {
  if (!thread) return [];
  return db
    .prepare(
      `select id, status, stopping from jobs j where thread = ? and agent = ? and kind = 'work' and pr is null
      and (status in ('failed', 'stopped') or (stopping is not null and status in ${jobs.OPEN_JOBS}))
      and not ${jobs.hasReplacement('j.id')} and not ${jobs.failedAside('j')} order by id`,
    )
    .all(thread, agent) as { id: number; status: string; stopping: string | null }[];
}

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
  return { carried, on, agent: agents[0] };
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
