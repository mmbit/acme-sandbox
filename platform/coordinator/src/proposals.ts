// The inbox of new work an agent proposes (hq propose) instead of queueing it. It goes to the owner of the project it names
// (else of the proposer's thread's project; with neither, to the CEO) and waits there, out of the queue, until that owner
// or the CEO accepts it into a thread of the plan, as an ordinary queued job with the proposer's brief, or drops it with a
// line on why. The CEO sees every one (hq inbox --all). The owner hears of it at once in a running session; otherwise HQ
// makes the owner's planning job, one open at a time, which takes everything waiting when it starts. The proposer's job
// hears a drop while it runs, and hq inbox shows the proposer what became of each.
// (its messages say deliverable, the board's word for a thread)
import { windowed } from './inbox.ts';
import * as threadends from './threadends.ts';
import { db, inOneStep } from './db.ts';
import { publish } from './events.ts';
import * as jobs from './jobs.ts';
import * as messages from './messages.ts';
import { ceo } from './company.ts';
import { findProject, findThread, ownerOf, threadForJob, type JobThreadAsk } from './projects.ts';
import { openPlanning, planningJob, planningProject } from './planning.ts';
import * as sorting from './sorting.ts';
import { newThread } from './plan.ts';
import { refusal } from './threadorder.ts';
import { oneLine } from './agreements.ts';
import { OwnerNotificationError } from './ownernotice.ts';
import * as ledger from './ledger.ts';
import * as reviewinbox from './reviewinbox.ts';
import * as reviewwork from './reviewwork.ts';
import * as redraws from './redraws.ts';
import * as reviewclosure from './reviewclosure.ts';
import { claim } from './jobcodes.ts';
import * as sizes from './sizes.ts';
import * as acceptance from './acceptance.ts';

const TITLE_MAX = 140,
  WHY_MAX = 300;
export const BRIEF_MAX = 20_000;

export type Proposal = {
  id: number;
  created: string;
  agent: string;
  job: number | null;
  title: string;
  brief: string;
  for_agent: string | null;
  thread: string | null;
  project: string | null;
  heard_by: number | null;
  heard_at: string | null;
  status: 'open' | 'accepted' | 'dropped';
  decided: string | null;
  accepted: number | null;
  why: string | null;
};

// hq propose: `from`, an agent's job, proposes work for itself or `ask.for`, someone who can take work (mayTake), to the
// owner of `ask.project` (else of the thread it proposes, else of its own job's thread). The answer is the proposal's id
// and whose inbox it's in, or why not.
export function propose(
  from: { agent: string; job: number },
  ask: { title: unknown; brief: unknown; for?: unknown; thread?: unknown; project?: unknown },
  mayTake: (agent: string) => boolean,
) {
  const title = oneLine(String(ask.title ?? '')),
    brief = String(ask.brief ?? '').trim();
  if (!title || title.length > TITLE_MAX) return `a proposal needs a title of up to ${TITLE_MAX} characters`;
  if (!brief || brief.length > BRIEF_MAX) return `a proposal needs its whole brief, up to ${BRIEF_MAX} characters`;
  const forAgent = ask.for == null ? null : String(ask.for);
  if (forAgent !== null && !mayTake(forAgent)) return `${forAgent} isn't a colleague in org.yaml who can take work`;
  // (a moved thread found by its old id: its new one)
  const named = ask.thread == null ? null : findThread(String(ask.thread));
  if (named !== null && named?.status !== 'open')
    return `${ask.thread} isn't an open deliverable (hq deliverable list)`;
  const thread = named?.id ?? null;
  const asked = ask.project == null ? null : String(ask.project);
  if (asked !== null && !findProject(asked)) return `there's no project "${asked}"`;
  const own = from.job ? jobs.threadOf(from.job) : null;
  const project = asked ?? findThread(thread ?? own ?? '')?.project ?? null;
  // (kept only with its owner told: untold)
  return untold(() => {
    const { lastInsertRowid } = db
      .prepare(
        'insert into proposals (created, agent, job, title, brief, for_agent, thread, project) values (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(new Date().toISOString(), from.agent, from.job, title, brief, forAgent, thread, project);
    const id = Number(lastInsertRowid);
    const owner = ownerOf({ project });
    tell(owner, { id, agent: from.agent, title, project }, from);
    publish({ type: 'log', agent: from.agent, text: `Proposed: ${title}` });
    return { id, owner, project };
  });
}

// One item per pull request, delivered with the owner's existing planning notifications. With the company's
// review.drawWindowedChanges draws a "changes" ruling at once when its thread has a window or carries a live call item.
// The PR's author fixes every blocking finding (or checks the touch-ups) in the reviewed thread. The owner
// hears of that task, and may cancel and redraw it; nothing waits on a session or a planning job that may not look at it
export function deliverFindings(details: reviewinbox.Delivery, by?: { agent: string; job: number }) {
  return inOneStep(() => {
    const previous = reviewinbox.get(details.pr);
    const item = reviewinbox.deliver(details);
    if (reviewinbox.sameDelivery(previous, item)) return item;
    const owner = ownerOf(item);
    const reason = item.decision === 'changes' && reviewinbox.drawReason({ branch: item.branch, thread: item.thread! });
    const drawn = reason ? reviewinbox.drawnAtOnce(item, owner) : undefined;
    if (drawn && 'jobs' in drawn) {
      messages.withdraw(item.proposal);
      const tasks = drawn.jobs.map(job => `#${job}`).join(' and ');
      const running = by && messages.runningSession(owner);
      const line = `Review ${reviewinbox.externalId(item.proposal)} from ${item.agent} for ${item.project}: ${reason}, so HQ drew ${tasks} for ${drawn.author} to answer it. To draw it another way, cancel ${drawn.jobs.length > 1 ? 'them' : 'it'} and accept the item again (hq inbox ${reviewinbox.externalId(item.proposal)}).`;
      // held: unread when the session ends, it lapses rather than becoming a job
      if (running) {
        const sent = messages.send(by, owner, line, running.id, item.proposal);
        if (typeof sent === 'number') throw new OwnerNotificationError(sent, owner);
      }
      publish({
        type: 'log',
        agent: drawn.author,
        text: `PR #${item.pr}'s review asked for changes: ${tasks} drawn at once, as ${reason}`,
      });
    } else {
      // (a refused draw waits for its owner like any other item.)
      const refused =
        drawn &&
        `PR #${item.pr}'s review asked for changes, and HQ couldn't draw their fix at once (${drawn.refused}), so ${reviewinbox.externalId(item.proposal)} waits for ${owner} to draw it`;
      if (refused) publish({ type: 'log', agent: item.agent, text: refused });
      tell(
        owner,
        { id: item.proposal, agent: item.agent, title: reviewinbox.titleOf(item), project: item.project },
        by,
      );
    }
    return item;
  });
}

// A bundle of HQ's (followups.ts upstream: what went wrong before review): a new open proposal, or the open one (`into`)
// with the brief that now covers more. Its owner hears of it as of any other proposal, and
// again when it grows: one a planning job left open was that job's to leave only as it stood (sweep). Its accepter names
// the task (sorting.ts template).
export function bundle(p: { agent: string; title: string; brief: string; project: string | null }, into?: number) {
  return inOneStep(() => {
    if (into) {
      db.prepare('update proposals set brief = ? where id = ?').run(p.brief, into);
      tell(ownerOf(p), { id: into, ...p });
      return into;
    }
    const { lastInsertRowid } = db
      .prepare('insert into proposals (created, agent, title, brief, project) values (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), p.agent, p.title, p.brief, p.project);
    const id = Number(lastInsertRowid);
    sorting.template(id); // (its accepter names the task)
    tell(ownerOf(p), { id, ...p });
    return id;
  });
}

export function untold<T>(change: () => T): T | [number, string] {
  try {
    return inOneStep(change);
  } catch (err) {
    if (err instanceof OwnerNotificationError) return [err.status, err.message];
    throw err;
  }
}

// hq project owner (plan.ts setOwner): the project's open proposals go to its new owner, told as a new one is (by: the
// CEO's job, which sends any line), and the old owner's planning job for the project that hasn't started stands down
// when nothing is left for it. Throws OwnerNotificationError, for the owner change to be undone with it.
export function ownerChanged(project: string, by: { agent: string; job: number }) {
  const moved = db
    .prepare(
      `select id, agent, title, project, (select job from planning_jobs where job = heard_by) heard_by from proposals
      where status = 'open' and project = ?`,
    )
    .all(project) as { id: number; agent: string; title: string; project: string; heard_by: number | null }[];
  for (const p of moved) tell(ownerOf(p), p, by);
  for (const job of new Set(moved.map(p => p.heard_by).filter(j => j !== null)))
    if (!db.prepare("select 1 from proposals where status = 'open' and heard_by = ?").get(job))
      ledger.cancelJob(job, `the proposals it was for went to ${project}'s new owner`);
}

// Every minute (server.ts): open proposals left for a planning job that has ended, which reached it after it started
// (heard_at: a new one, or one handed on with its project; or whose job never started), go to their owner again.
// One it had at its start it decided to leave open. Proposals a session holds (tell)
// go on as soon as it stops running (ended, yielded back to the queue, parked on a card), their notice withdrawn.
// Review changes a later round or the merge has left behind close first: nobody has anything left to decide on them
export function sweep() {
  inOneStep(() => {
    for (const item of reviewinbox.reopenUndrawn()) tell(ownerOf(item), item);
  });
  const stale = db
    .prepare(
      `select q.id, r.round, p.round now, p.status from review_inbox r join proposals q on q.id = r.proposal
      join prs p on p.number = r.pr where q.status = 'open' and r.decision = 'changes'
      and (p.round > r.round or p.status = 'merged')`,
    )
    .all() as { id: number; round: number; now: number; status: string }[];
  for (const s of stale) {
    const why = s.status === 'merged' ? 'its pull request merged' : `round ${s.now} has started`;
    db.prepare("update proposals set status = 'dropped', decided = ?, why = ? where id = ?").run(
      new Date().toISOString(),
      `Round ${s.round}'s findings closed by themselves: ${why}`,
      s.id,
    );
    messages.withdraw(s.id);
  }
  const left = db
    .prepare(
      `select p.id, p.agent, p.title, p.project from proposals p join jobs j on j.id = p.heard_by where p.status = 'open'
      and (j.status not in ${jobs.OPEN_JOBS} and (j.started is null or p.heard_at > j.started)
        or j.status != 'running' and j.id not in (select job from planning_jobs)) order by p.id`,
    )
    .all() as { id: number; agent: string; title: string; project: string | null }[];
  for (const p of left) {
    messages.withdraw(p.id);
    tell(ownerOf(p), p);
  }
  sorting.settle(); // (HQ's own work to sort)
  for (const p of sorting.untold()) tell(ownerOf(p), p);
}

// hq inbox: the open proposals waiting for the agent (each project it owns, and for the CEO those no owner has), then
// its own latest with what became of them. all: the CEO's every open proposal, whoever's it is. A planning job (`job`)
// reads its project's alone, and what it holds from before planning jobs had one.
export function list(agent: string, all = false, job?: number) {
  const open = (db.prepare("select * from proposals where status = 'open' order by id").all() as Proposal[]).map(p => ({
    ...p,
    owner: ownerOf(p),
  }));
  const display = <T extends { id: number }>(items: T[]) =>
    items.map(p => {
      const { id, ...fields } = p;
      return { ...fields, id: reviewinbox.externalId(id) };
    });
  if (all && agent === ceo()) return display(open);
  const sorts = job === undefined ? undefined : planningProject(job);
  const mine = open.filter(
    p => p.owner === agent && (sorts === undefined || p.project === sorts || p.heard_by === job),
  );
  const own = (db.prepare('select * from proposals where agent = ? order by id desc limit 20').all(agent) as Proposal[])
    .filter(p => !mine.some(m => m.id === p.id))
    .map(p => ({ ...p, owner: ownerOf(p) }));
  return display([...mine, ...own]);
}

// hq inbox accept: the owner or the CEO (`by`) queues it, in the thread it names (an open one, or new:<project> "name"
// "done when"), else the one proposed, else the proposer's job's when that's in the proposal's project. A thread of a
// plan `by` may change only. The answer is the job, or why not, with an HTTP status for a refusal.
// Its code's word is the accepter's (--code), as hq job's is the queuer's (jobcodes.ts claim). job: the accepter's own,
// whose deliverable one drawn here chains after (newthread.ts chainedAfter).
export function accept(id: number | string, by: string, o: acceptance.Ask, job?: number) {
  const external = typeof id === 'string' ? id : reviewinbox.externalId(id);
  if (typeof external === 'string') return reviewinbox.accept(external, by, o);
  const p = openProposal(external);
  if (typeof p === 'string') return p;
  const theirs = notTheirs(p, by);
  if (theirs) return theirs;
  // (HQ's own from a template: a held job is sorted, a bundle named by its accepter.)
  const sort = sorting.of(p.id);
  if (sort?.job) return sorting.accept(p, sort.job, by, o);
  const size = sizes.readQueuedSize(o);
  if (typeof size === 'string') return size;
  const title = sorting.acceptedTitle(p, sort, o.title);
  if (typeof title !== 'string') return title.refused;
  // the owner assigns it (--for), else it's for whom it was proposed
  if (o.for != null && !jobs.findAgent(String(o.for))) return `${o.for} isn't a colleague in org.yaml`;
  const own = p.job ? jobs.threadOf(p.job) : null;
  const inherited = own && findThread(own)?.project === p.project ? p.job! : undefined;
  const ask = o.thread == null && o.newThread == null && p.thread ? { thread: p.thread } : o;
  const target =
    ask.thread != null
      ? findThread(String(ask.thread))?.project
      : ask.newThread != null
        ? String(ask.newThread.project ?? '')
        : inherited && p.project;
  const project = target ? findProject(target) : undefined;
  const refused = project && refusal(project, by);
  if (refused) return refused;
  const placed = acceptedIn({ title }, ask, { by, job, inherited, code: o.code });
  if (typeof placed === 'string') return placed;
  const { chain, ...thread } = placed;
  const named = claim(o.code, 'thread' in thread ? thread.thread : thread.from ? jobs.threadOf(thread.from) : null);
  if ('refused' in named) return named.refused;
  const agent = o.for != null ? String(o.for) : (p.for_agent ?? p.agent);
  return { ...acceptance.queue(p, by, { code: named.code, agent, title, size, ...thread }), chain };
}

// The thread an accepted proposal is queued in (accept), or why not: one drawn for it in the plan, with its chain's
// words, its word for its code checked first so a refused code draws none (jobcodes.ts claim.), else the one named or
// inherited
function acceptedIn(
  p: { title: string },
  ask: JobThreadAsk,
  o: { by: string; job: number | undefined; inherited: number | undefined; code: unknown },
): (({ thread: string } | { from?: number }) & { chain?: string }) | string {
  if (ask.newThread == null || ask.thread != null) {
    const found = threadForJob({ ...ask, title: p.title }, { agent: o.by, job: o.inherited });
    return 'refusal' in found ? found.refusal : found;
  }
  const project = String(ask.newThread.project ?? '');
  const named = claim(o.code, { project });
  if ('refused' in named) return named.refused;
  // (its --needs, and the accepter's job)
  const drawn = newThread(
    { project, name: ask.newThread.name, goal: ask.newThread.goal, needs: ask.newThread.needs, task: p.title }, // (task)
    { agent: o.by, job: o.job },
  );
  return typeof drawn === 'string' ? drawn : { thread: drawn.id, chain: drawn.chain };
}

// hq inbox drop: its owner or the CEO drops it, why in a line, which the proposer's job hears if it still runs.
export function drop(given: number | string, by: { agent: string; job: number }, why: unknown) {
  const id = reviewinbox.proposalId(given);
  if (id === undefined) return `there's no ${given} (hq inbox)`;
  const p = openProposal(id);
  if (typeof p === 'string') return p;
  const theirs = notTheirs(p, by.agent);
  if (theirs) return theirs;
  const external = reviewinbox.externalId(id);
  const item =
    typeof external === 'string' ? reviewinbox.get(Number(external.slice(reviewinbox.FINDINGS.length)))! : null;
  if (item !== null) {
    if (item.decision === 'changes' && reviewwork.current(item.thread, item.pr))
      return 'draw fix tasks for the blocking findings, or close the pull request before dropping its work';
    const held = reviewclosure.dropRefusal(item.branch);
    if (held) return held;
  }
  const said = oneLine(String(why ?? ''));
  if (!said || said.length > WHY_MAX) return `say why in one line of up to ${WHY_MAX} characters: ${p.agent} reads it`;
  const sort = sorting.of(id); // (a held job goes with it, one that keeps never.)
  if (sort?.keep) return sorting.KEEPS;
  inOneStep(() => {
    if (sort?.job) ledger.cancelJob(sort.job, said);
    db.prepare("update proposals set status = 'dropped', decided = ?, why = ? where id = ?").run(
      new Date().toISOString(),
      said,
      id,
    );
    if (item?.decision === 'close') redraws.drop(item.pr);
    if (item !== null) threadends.settled(item.branch);
  });
  // (a Codex job takes no message mid-run: it would become a job of its own)
  const running = !!p.job && messages.inSession(p.job);
  if (running) messages.send(by, p.agent, `Your proposal #${id} ("${p.title}") was dropped: ${said}`, p.job!);
  return { ok: true as const, told: running };
}

// The summary's lines (summary.ts): each open proposal, by whom, for whom, whose to decide, and since when.
export const waiting = () =>
  (db.prepare("select * from proposals where status = 'open' order by id").all() as Proposal[]).map(
    p =>
      `#${reviewinbox.externalId(p.id)} "${p.title}", from ${p.agent}${p.for_agent ? ` for ${p.for_agent}` : ''}, ${ownerOf(p) === ceo() ? 'yours' : `${ownerOf(p)}'s`} to decide, since ${p.created.slice(0, 16).replace('T', ' ')} UTC`,
  );
function openProposal(id: number): Proposal | string {
  const p = db.prepare('select * from proposals where id = ?').get(id) as Proposal | undefined;
  if (!p) return `there's no proposal #${id} (hq inbox)`;
  if (p.status !== 'open') return `proposal #${id} was ${p.status} already`;
  return p;
}

// Why `by` may not decide the proposal: only its owner or the CEO does
const notTheirs = (p: Proposal, by: string) =>
  [ownerOf(p), ceo()].includes(by) ? undefined : `proposal #${p.id} is ${ownerOf(p)}'s to decide (or the CEO's)`;

// The owner hears of a proposal: through its planning job for the proposal's project (the one open, queued, running or
// blocked, which reads the project's inbox at its start and again before it ends), else in its running Claude session at its next step, else through a
// new planning job. A proposal holding a thread's window (inbox.ts) reaches the running session first. One told to a
// session stays with it while it runs, its notice held there: left open when it stops, the sweep tells the owner again.
// A running planning job for another project is no such session: the proposal goes
// to its own project's planning job, the open one or a new one. Only non-urgent CEO proposals wait for the summary
// (summary.ts). A refused line throws OwnerNotificationError.
export function tell(
  owner: string,
  p: { id: number; agent: string; title: string; project: string | null },
  by?: { agent: string; job: number },
) {
  const heardBy = (job: number | null) =>
    db
      .prepare('update proposals set heard_by = ?, heard_at = ? where id = ?')
      .run(job, job === null ? null : new Date().toISOString(), p.id);
  const urgent = windowed(p.id);
  if (owner === ceo() && !urgent) return heardBy(null);
  const planning = openPlanning(owner, p.project);
  const session = (by || urgent) && messages.runningSession(owner);
  const sorts = session ? planningProject(session.id) : undefined;
  const running = sorts === undefined || sorts === p.project ? session : undefined;
  if (planning && !(urgent && running)) return heardBy(planning.id);
  if (running) {
    const label = reviewinbox.externalId(p.id);
    const line = `${typeof label === 'number' ? 'Proposal #' : 'Review '}${label} from ${p.agent}${p.project ? ` for ${p.project}` : ''}: "${p.title}". Accept it into your plan or drop it (hq inbox ${label}).`;
    if (by) {
      const sent = messages.send(by, owner, line, running.id, p.id);
      if (typeof sent === 'number') throw new OwnerNotificationError(sent, owner);
    } else messages.notice(owner, line, running.id, p.id);
    return heardBy(running.id);
  }
  heardBy(planningJob(owner, p.project));
}
