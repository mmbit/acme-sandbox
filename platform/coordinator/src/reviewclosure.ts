// Holds and redirects the dependencies of work closed into its owner's inbox.
// (its messages say deliverable, the board's word for a thread)
import { db, inOneStep, planChange } from './db.ts';
import * as redraws from './redraws.ts';
import * as pauses from './pauses.ts';
import * as jobs from './jobs.ts';
import * as reviewwork from './reviewwork.ts';
import { BAD_TITLE, taskTitle, type Item } from './reviewinbox.ts';
import { findThread, type JobThreadAsk } from './projects.ts';

export function hold(branch: string, pr: number) {
  redraws.close(pr, branch);
  db.prepare(
    `insert or ignore into waits (job, on_job) select id, after from jobs
    where status = 'queued' and after in (${workOnBranch})`,
  ).run(branch);
  db.prepare(
    `insert or ignore into review_holds (branch, job)
    select ?, waiting.id from jobs waiting join jobs source on source.thread = waiting.thread
    where source.id in (${workOnBranch}) and waiting.kind = 'work' and waiting.pr is null
      and waiting.status in ('queued', 'running', 'blocked') and waiting.id != source.id`,
  ).run(branch, branch);
}

export function description(branch: string, pr: number) {
  const dependent = dependents(branch),
    continuations = heldTasks(branch),
    held = paused(branch),
    threads = dependentThreads(branch);
  return (
    `\n\nDependent jobs held until this work is replaced or explicitly dropped: ${dependent.map(job => `#${job.id}`).join(', ') || 'none'}.\n` +
    `Tasks held from this deliverable until this work is replaced or explicitly dropped: ${continuations.map(task => `#${task.job}`).join(', ') || 'none'}.\n` +
    `Dependent deliverables held until this work is replaced or explicitly dropped: ${threads.map(thread => thread.id).join(', ') || 'none'}.\n` +
    `Pauses waiting for this work: ${held.map(pause => pause.target).join(', ') || 'none'}.\n` +
    'It was closed because it should not land, so dropping it is the usual answer: first drop its dependent jobs, remove its deliverable needs with hq plan unneed, and explicitly resume its pauses. ' +
    `Only if it is still wanted in another form, redraw it with hq inbox accept findings:${pr} --for <agent> --deliverable <replacement>: the dependent jobs, deliverables and pauses stay held until the replacement merges.`
  );
}

export function redraw(item: Item, by: string, ask: JobThreadAsk & { for?: unknown }) {
  const refused = inOneStep(
    () => {
      const trial = draw(item, by, ask);
      if (typeof trial === 'string') return trial;
      if (jobs.prerequisites([trial.job], { includeFrom: false, ordered: true }).some(job => job.id === trial.job))
        return 'that redraw creates a cycle through task order, deliverable needs or merge waits: choose another destination or change those dependencies';
    },
    { keep: false },
  );
  if (refused) return refused;
  return draw(item, by, ask);
}

function draw(item: Item, by: string, ask: JobThreadAsk & { for?: unknown }) {
  if (ask.thread == null && ask.newThread == null)
    return 'name the replacement deliverable with --deliverable, or drop the closed findings';
  const latest = db
    .prepare('select status from prs where branch = ? order by number desc limit 1')
    .get(item.branch) as { status: string };
  if (latest.status !== 'closed') return 'this branch has a newer review: use its current findings';
  const proposal = db.prepare('select status from proposals where id = ?').get(item.proposal) as { status: string };
  if (proposal.status !== 'open') return 'this closed review has already been redrawn or dropped';
  // (the accepter's title, else its work's own.)
  const title = ask.title == null ? redrawnTitle(item.branch) : taskTitle(ask.title);
  if (!title) return ask.title == null ? 'name the redrawn work for what it does with --title "..."' : BAD_TITLE;
  const target = reviewwork.target(item, ask, by);
  if ('refusal' in target) return target.refusal;
  const thread = 'thread' in target ? target.thread : null;
  const busy = destinationRefusal(thread, item.branch);
  if (busy) return busy;
  db.prepare('update threads set branch = null where branch = ?').run(item.branch);
  const job = jobs.createJob({
    agent: String(ask.for),
    title,
    thread,
    code: jobs.codeFrom({ pr: item.pr }) ?? undefined, // (the work redrawn keeps its task's code.)
    prompt: `${item.brief}\n\nRedraw this work on the replacement deliverable. Keep the intended outcome and address the named findings.`,
    queuedBy: by,
    plannedBy: by,
  });
  place(job.id, thread);
  redirect(item.branch, job.id, by);
  db.prepare("update proposals set status = 'accepted', decided = ?, accepted = ? where id = ?").run(
    new Date().toISOString(),
    job.id,
    item.proposal,
  );
  redraws.accept(item.pr, job.id);
  recordBarriers(job.id, by);
  return { job: job.id, thread };
}

function recordBarriers(replacement: number, by: string) {
  const held = db
    .prepare(
      redraws.query(`select waiting.id, waiting.thread from jobs waiting
    where ? in (${redraws.barriers('waiting.id')})`),
    )
    .all(replacement) as { id: number; thread: string }[];
  for (const thread of new Set(held.map(task => task.thread)))
    planChange({
      project: thread.split('/')[0],
      thread,
      by,
      what: `tasks ${held
        .filter(task => task.thread === thread)
        .map(task => `#${task.id}`)
        .join(', ')} wait for redraw #${replacement} to merge`,
    });
}

function place(job: number, thread: string | null) {
  const first = db
    .prepare(
      `select min(coalesce(seq, id)) seq from jobs where thread = ? and kind = 'work'
    and pr is null and status = 'queued' and id != ?`,
    )
    .get(thread, job) as { seq: number | null };
  if (first.seq !== null) db.prepare('update jobs set seq = ? where id = ?').run(first.seq - 0.5, job);
}
function destinationRefusal(thread: string | null, branch: string) {
  if (!thread) return;
  const target = findThread(thread)!;
  const active = db
    .prepare(
      `select 1 from jobs j where j.thread = ? and j.kind = 'work'
    and (j.status in ('running', 'blocked') or exists (select 1 from prs p
      where p.branch = coalesce(j.branch, 'job/' || j.id) and p.status in ('open', 'stuck', 'board')))`,
    )
    .get(thread);
  if (active || (target.branch && target.branch !== branch))
    return 'that destination has work running or waiting to merge: finish it first or choose another deliverable';
}

export function redirect(branch: string, job: number, by = 'hq') {
  const source = db.prepare(workOnBranch).all(branch) as { id: number }[];
  jobs.redirectWaits(
    source.map(work => work.id),
    job,
    by,
  );
  pauses.redrawing(branch, job);
}

export function dropRefusal(branch: string) {
  const dependent = dependents(branch),
    held = paused(branch),
    threads = dependentThreads(branch);
  if (dependent.length || held.length || threads.length)
    return `redraw the work, or first drop dependent jobs ${dependent.map(job => `#${job.id}`).join(', ') || '(none)'}, remove dependent deliverable needs ${threads.map(thread => thread.id).join(', ') || '(none)'} with hq plan unneed, and explicitly resume pauses ${held.map(pause => pause.target).join(', ') || '(none)'}`;
}

// An accepted redraw carries the original work's merge requirement, even when its replacement is in another thread.
export function status(branch: string): string | null {
  const resolved = db.prepare(redraws.query(`select state from (${redraws.states('$branch')})`)).get({ branch }) as
    { state: string } | undefined;
  return resolved?.state ?? null;
}

export function originals(branch: string): string[] {
  const ancestors = db
    .prepare(redraws.query(`select distinct origin from (${redraws.states()}) where branch = ?`))
    .all(branch) as {
    origin: string;
  }[];
  return [...new Set([branch, ...ancestors.map(row => row.origin)])];
}

function dependentThreads(branch: string) {
  return db
    .prepare(
      `select distinct t.id from thread_needs n join threads t on t.id = n.thread
    where t.status = 'open' and n.needs in (select thread from jobs where kind = 'work' and coalesce(branch, 'job/' || id) = ?)`,
    )
    .all(branch) as { id: string }[];
}

function dependents(branch: string) {
  return db
    .prepare(
      `select distinct j.id from jobs j where j.status in ('queued', 'running', 'blocked')
    and (j.after in (${workOnBranch}) or exists (select 1 from waits w where w.job = j.id and w.on_job in (${workOnBranch})))`,
    )
    .all(branch, branch) as { id: number }[];
}

const heldTasks = (branch: string) =>
  db.prepare('select job from review_holds where branch = ? order by job').all(branch) as { job: number }[];

function paused(branch: string) {
  const work = new Set((db.prepare(workOnBranch).all(branch) as { id: number }[]).map(job => job.id));
  return pauses.open().filter(pause => pause.until.some(job => work.has(job.id)));
}

const workOnBranch = "select id from jobs where kind = 'work' and coalesce(branch, 'job/' || id) = ?";

// The redrawn work keeps the title of the task that opened its branch
const redrawnTitle = (branch: string) =>
  (
    db
      .prepare(
        `select title from jobs where kind = 'work' and stage is null and coalesce(branch, 'job/' || id) = ?
      order by id limit 1`,
      )
      .get(branch) as { title: string } | undefined
  )?.title;
