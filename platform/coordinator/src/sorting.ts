// HQ's own work that starts under a template name or bundles things (a colleague's message no session heard, the board's
// feedback on a product and its return, outside notes on a preview, a review's follow-ups): HQ may make it that way, but
// none of it runs before the owner of its project (else the CEO) has sorted it, in the owner's one sort step (the
// planning job, planning.ts): a title and a code that say what it does, in the right thread, or split into tasks of their
// own (hq job) and dropped. A job waits for that on a 'sorted' wake (wakes.ts, jobs.ts READY), its proposal (sorts.job)
// in the owner's inbox; work that joins it after it was sorted (a later message, more feedback) holds it again. A
// template proposal with no job (sorts.job null: followups.ts) is accepted only under a title of the accepter's.
import { db, inOneStep, planChange } from './db.ts';
import { publish } from './events.ts';
import * as jobs from './jobs.ts';
import { findThread, type JobThreadAsk } from './projects.ts';
import { taskClash } from './names.ts';
import { oneTask, oneTaskName } from './made.ts';
import { claim, codeOf } from './jobcodes.ts';
import { oneLine } from './agreements.ts';
import { levels } from '../../worker/hq/levels.ts';
import { levelsOf } from './levels.ts';

// keep: the job holds something that must run (a product's return to the board): it's sorted under a title, never dropped.
// told: when its owner was told (proposals.ts sweep, within the minute: jobs.ts loads this module through messages.ts,
// before the inbox's own, so it can't tell them itself).
db.exec(`create table if not exists sorts (proposal integer primary key, job integer, keep integer not null default 0, told text);
  create index if not exists sorts_job on sorts (job) where job is not null`);

const TITLE_MAX = 140,
  BRIEF_MAX = 20_000; // (proposals.ts's)
export const NEEDS_TITLE =
  'HQ made this from a template: name the task for what it does (--title "..."). Unrelated parts are tasks of their own: queue them with hq job, then accept or drop this';
export const KEEPS = 'it brings a product back to the board, so it runs: give it its title (hq inbox accept)';

type Sort = { proposal: number; job: number | null; keep: number };
export const of = (proposal: number) =>
  db.prepare('select * from sorts where proposal = ?').get(proposal) as Sort | undefined;
const openFor = (job: number) =>
  (
    db
      .prepare(
        "select s.proposal from sorts s join proposals p on p.id = s.proposal where s.job = ? and p.status = 'open'",
      )
      .get(job) as { proposal: number } | undefined
  )?.proposal;
// Whether the job's owner has named it once: its template title is HQ's to keep up to date until then (owed.ts)
export const named = (job: number) =>
  !!db
    .prepare("select 1 from sorts s join proposals p on p.id = s.proposal where s.job = ? and p.status = 'accepted'")
    .get(job);

// The title of the job an accepted proposal becomes: the accepter's, else the proposal's, but never HQ's template
export function acceptedTitle(p: { title: string }, sort: Sort | undefined, given: unknown) {
  const title = given == null ? (sort ? '' : p.title) : oneLine(String(given));
  if (title && title.length <= TITLE_MAX) return title;
  return { refused: sort ? NEEDS_TITLE : `a task's title is one line of up to ${TITLE_MAX} characters` };
}

// The held jobs' proposals whose owners haven't been told yet, each marked told as it's taken (proposals.ts sweep)
export function untold() {
  const rows = db
    .prepare(
      `select p.id, p.agent, p.title, p.project from sorts s join proposals p on p.id = s.proposal
      where s.told is null and s.job is not null and p.status = 'open' order by p.id`,
    )
    .all() as { id: number; agent: string; title: string; project: string | null }[];
  db.prepare('update sorts set told = ? where told is null').run(new Date().toISOString());
  return rows;
}

// Held jobs that ended before their sort (cancelled with their return, failed): nothing is left to sort, so their
// proposals leave the inbox (proposals.ts sweep)
export function settle() {
  db.prepare(
    `update proposals set status = 'dropped', decided = ?, why = 'its job ended before it was sorted'
    where status = 'open' and id in (select s.proposal from sorts s join jobs j on j.id = s.job
      where j.status in ('done', 'failed', 'cancelled'))`,
  ).run(new Date().toISOString());
}

// A proposal of HQ's from a template (followups.ts): whoever accepts it names the task
export const template = (proposal: number) =>
  db.prepare('insert or ignore into sorts (proposal) values (?)').run(proposal);

// What a held job's proposal says in place of a brief that holds a customer's own details (feedback.ts markOutsideJobs too).
export const PRIVATE_BRIEF = "Its brief holds a customer's own details, so it stays with the job.";

// job, made by `from` (a colleague, or hq) under a template name or holding several things, waits until the owner of
// project sorts it. why: in a line, what HQ made it from. Again for one sorted already: it holds again, as a new proposal.
export function hold(job: number, o: { from: string; project: string | null; why: string; keep?: boolean }) {
  const row = db
    .prepare("select title, prompt, agent, customers from jobs where id = ? and status = 'queued' and session is null")
    .get(job) as { title: string; prompt: string; agent: string; customers: number } | undefined;
  if (!row) return;
  db.prepare(
    `insert into wakes (job, kind, arg, since) values (?, 'sorted', '', ?)
    on conflict (job, kind, arg) do update set met = null`,
  ).run(job, Date.now());
  // (a customer's own details stay with the job: jobs.ts holdsCustomerData)
  const brief = `${o.why} Job #${job}, ${row.agent}'s, waits until you sort it.\n\n${
    row.customers ? PRIVATE_BRIEF : row.prompt
  }`.slice(0, BRIEF_MAX);
  const open = openFor(job);
  // (grown, its owner hears of it again: a planning job that left it open left it only as it stood, as bundles)
  if (open) {
    db.prepare('update proposals set title = ?, brief = ? where id = ?').run(row.title, brief, open);
    return void db.prepare('update sorts set told = null where proposal = ?').run(open);
  }
  const id = Number(
    db
      .prepare('insert into proposals (created, agent, title, brief, for_agent, project) values (?, ?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), o.from, row.title, brief, row.agent, o.project).lastInsertRowid,
  );
  db.prepare('insert into sorts (proposal, job, keep) values (?, ?, ?)').run(id, job, o.keep ? 1 : 0);
  publish({ type: 'log', agent: row.agent, text: `Job #${job} waits for its sort into the plan (proposal #${id})` });
}

// hq inbox accept on a held job: it keeps its brief, agent and thread (hq job move moves it first), gets the accepter's
// title (and code, where it has none or one is given), and may start. The answer is the job, or why not.
export function accept(
  p: { id: number },
  job: number,
  by: string,
  ask: JobThreadAsk & { for?: unknown; code?: unknown },
) {
  const title = oneLine(String(ask.title ?? ''));
  if (!title || title.length > TITLE_MAX) return NEEDS_TITLE;
  if (ask.for != null) return "a held job stays its agent's: queue another's part with hq job";
  const thread = jobs.threadOf(job);
  const to = ask.newThread != null ? 'new' : ask.thread == null ? thread : findThread(String(ask.thread))?.id;
  if (to !== thread)
    return `job #${job} is in ${thread ?? 'no thread'}: move it there first (hq job move ${job} <thread>)`;
  const had = codeOf(job);
  const named = ask.code == null && had ? { code: had } : claim(ask.code, thread);
  if ('refused' in named) return named.refused;
  // HQ's one-task thread for it (made.ts) is named after it again, so no template name stays on the plan's tile; it's
  // exempt from the task's clash with its thread's name, as at its making
  const own = !!thread && thread.endsWith(`/job-${job}`) && oneTask(thread);
  const clash = thread && !own && taskClash(title, findThread(thread)!);
  if (clash) return clash;
  return inOneStep(() => {
    db.prepare('update jobs set title = ?, code = ? where id = ?').run(title, named.code, job);
    if (own) db.prepare('update threads set name = ? where id = ?').run(oneTaskName(title), thread);
    db.prepare("update wakes set met = ? where job = ? and kind = 'sorted'").run(`sorted by ${by}: ${title}`, job);
    db.prepare("update proposals set status = 'accepted', decided = ?, accepted = ? where id = ?").run(
      new Date().toISOString(),
      job,
      p.id,
    );
    const what = `task #${job} sorted${own ? ', and its thread named' : ''}: ${title}`;
    if (thread) planChange({ project: findThread(thread)!.project, thread, what, by });
    return { job, code: named.code, thread, sorted: true };
  });
}

// The owner's planning job's prompt (planning.ts), the one sort step per owner, which reads the whole inbox when it
// starts. It ends with the levels each name shows, in the company's lines (levels.ts), and how its plans look ahead.
// (HQ's own to sort)
// Needed colleague answers.
export const planning = (
  own = levelsOf(),
) => `Proposals, review findings and HQ's own work to sort for the projects you own arrive here: it waits in your inbox, out of the queue, until you decide it.

1. Read the inbox: \`hq inbox\` lists what waits for you, \`hq inbox <id>\` shows one in full.
2. Read the plan it would go in: \`hq plan <project>\` (its threads, their "done when", needs and tasks in order).
3. Decide each one:
   - review findings: read their domains and files, then draw one fix task per discipline with
     \`hq inbox accept findings:<pr> --for <agent> --findings <id,id,...>\`, or
     \`hq job --thread <thread> --findings <id,id,...> <agent> "title" <brief>\`.
     Name every finding the task answers. Its title is the reviewer's for those findings (\`hq inbox findings:<pr>\`
     shows it by each), or yours with --title when they're under more than one. The last fix task's push starts the
     next round. A closed review needs its thread redrawn or the findings dropped.
   - HQ's own work under a template name, or holding several things (a colleague's message, the board's feedback, a
     return to the board, a review's follow-ups): name it for what it does with --title on the accept. A job HQ made
     waits unstarted until \`hq inbox accept <id> --title "..." [--code WORD]\` (in another thread: \`hq job move\` it
     first). Unrelated parts are tasks of their own: queue each (\`hq job\`, with its part of the brief), then accept
     it as the part left, or drop it saying where its parts went, which cancels it.
     A message marked \`--needs-answer\` needs its answer during the caller's run. HQ gives it an independent thread.
     Keep it independent of the caller's completion when sorting or splitting it.
   - part of a thread's "done when": \`hq inbox accept <id> --thread <project>/<slug>\`, then \`hq plan move\` it to its
     place among the thread's tasks if it isn't last;
   - beyond every thread: a thread of its own, \`hq inbox accept <id> --thread new:<project> "name" "done when"\`, with
     what it needs first (\`hq plan need <thread> <thread>\`);
   - another owner's project: drop it saying whose it is, so its proposer proposes it there;
   - not worth doing now: \`hq inbox drop <id> "why"\` (its proposer reads why).
4. Read \`hq plan <project>\` again for each thread you added to: split a task it marks to split into its steps, and
   draw the later part of a thread it marks as a thread of its own.
5. Before you end, read \`hq inbox\` again: what arrived while you worked waits there too. End when nothing waits for
   you. Change only the plans these inbox items require. Write no code.

Each name shows its level: a task whose title isn't its step gets one (\`hq plan title <job> "title"\`), a thread
whose name needs context a new one (\`hq plan rename <thread> "name" ["done when"]\`).
${[levels(own.lines), own.ahead].filter(Boolean).join('\n')}`;
