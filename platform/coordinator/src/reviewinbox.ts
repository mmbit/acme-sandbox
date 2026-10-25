// Review rulings in the project owner's inbox, and the findings each ordered fix task answers.
import { unassignedFindings } from './inbox.ts';
import { oneLine } from './agreements.ts';
import { db, inOneStep } from './db.ts';
import * as jobs from './jobs.ts';
import * as reviewwork from './reviewwork.ts';
import { threadOfBranch } from './panel.ts';
import * as reviewclosure from './reviewclosure.ts';
import { findThread, type JobThreadAsk } from './projects.ts';

export type Finding = {
  kind?: 'blocking' | 'nonblocking';
  id: number;
  domain: string;
  files: string[];
  issue: string;
  fix?: string;
  task?: string;
};
export type Delivery = {
  ruling?: number;
  pr: number;
  round: number;
  branch: string;
  agent: string;
  decision: 'changes' | 'close';
  summary: string;
  findings: Finding[];
  touchups?: string;
  brief?: string;
};
export type Item = Delivery & { proposal: number; thread: string | null; project: string | null };
type Stored = Omit<Item, 'findings' | 'touchups'> & { findings: string; touchups: string | null };
type Fix = {
  item: Item;
  findings: Finding[];
  pr: number;
  round: number;
  branch: string;
  stage: 'fix';
  replaces: number[];
};

export function deliver(details: Delivery) {
  const previous = get(details.pr);
  if (sameDelivery(previous, details)) return previous!;
  const thread = threadOfBranch(details.branch);
  const project = thread ? findThread(thread)!.project : null;
  const title = `Review ${details.decision} on PR #${details.pr}`;
  const brief = `${describe(details)}${details.brief ? `\n\n${details.brief}` : ''}`;
  let proposal = previous?.proposal;
  if (proposal) {
    db.prepare(
      `update proposals set created = ?, agent = ?, title = ?, brief = ?, thread = ?, project = ?,
      status = 'open', decided = null, accepted = null, why = null where id = ?`,
    ).run(new Date().toISOString(), details.agent, title, brief, thread, project, proposal);
  } else {
    proposal = Number(
      db
        .prepare(
          `insert into proposals (created, agent, title, brief, thread, project)
      values (?, ?, ?, ?, ?, ?)`,
        )
        .run(new Date().toISOString(), details.agent, title, brief, thread, project).lastInsertRowid,
    );
  }
  db.prepare('update proposals set job = ? where id = ?').run(details.ruling ?? null, proposal);
  db.prepare(
    `insert or replace into review_inbox
    (pr, proposal, round, branch, agent, decision, summary, findings, thread, project, touchups) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    details.pr,
    proposal,
    details.round,
    details.branch,
    details.agent,
    details.decision,
    details.summary,
    JSON.stringify(details.findings),
    thread,
    project,
    details.touchups ?? null,
  );
  return { ...details, proposal, thread, project };
}

export const sameDelivery = (previous: Item | undefined, details: Delivery) =>
  !!previous &&
  previous.round === details.round &&
  previous.decision === details.decision &&
  previous.ruling === details.ruling;

export const get = (pr: number): Item | undefined => {
  const row = db
    .prepare(
      'select r.*, q.job ruling, q.brief from review_inbox r join proposals q on q.id = r.proposal where r.pr = ?',
    )
    .get(pr) as (Stored & { brief: string }) | undefined;
  return (
    row && {
      ...row,
      ruling: row.ruling ?? undefined,
      touchups: row.touchups ?? undefined,
      findings: JSON.parse(row.findings) as Finding[],
    }
  );
};
export const FINDINGS = 'findings:';
export const inboxId = (value: unknown): number | string =>
  String(value).startsWith(FINDINGS) ? String(value) : Number(value);
export const externalId = (proposal: number) => {
  const item = db.prepare('select pr from review_inbox where proposal = ?').get(proposal) as { pr: number } | undefined;
  return item ? `${FINDINGS}${item.pr}` : proposal;
};
export const proposalId = (id: number | string) =>
  typeof id === 'number' ? id : get(Number(id.slice(FINDINGS.length)))?.proposal;

export function accept(id: string, by: string, ask: JobThreadAsk & { for?: unknown; findings?: unknown }) {
  const item = get(Number(id.slice(FINDINGS.length)));
  if (!item) return `there's no ${id} (hq inbox)`;
  const refused = reviewwork.authorized(item, by);
  if (refused) return refused;
  if (!ask.for || !jobs.findAgent(String(ask.for))) return 'name the fix task agent with --for <agent>';
  if (item.decision === 'close') return inOneStep(() => reviewclosure.redraw(item, by, ask));
  try {
    return inOneStep(() => {
      const fix = fixFor(item.thread, ask.findings, by, { pr: item.pr, touchups: true });
      if (typeof fix === 'string') return fix;
      if (!fix) return `${id} has no findings left to assign`;
      if (
        item.thread &&
        (ask.newThread != null || (ask.thread != null && findThread(String(ask.thread))?.id !== item.thread))
      )
        return 'review fix tasks belong to the reviewed thread';
      const title = ask.title == null ? reviewed(fix) : taskTitle(ask.title);
      if (!title) return ask.title == null ? UNNAMED : BAD_TITLE;
      const target = reviewwork.target(item, ask, by);
      if ('refusal' in target) return target.refusal;
      const thread = 'thread' in target ? target.thread : null;
      if (!item.thread && thread) {
        const bound = reviewwork.bind(item, thread);
        // (undone whole: the thread target() drew for it, and its plan change and event, go too)
        if (bound) throw new RefusedError(bound);
      }
      const job = jobs.createJob({
        agent: String(ask.for),
        title,
        prompt: instructions(fix),
        thread,
        branch: fix.branch,
        round: fix.round,
        stage: 'fix',
        queuedBy: by,
        plannedBy: by,
        insteadOf: fix.replaces,
      });
      recordTask(job.id, fix);
      return { job: job.id, thread };
    });
  } catch (err) {
    if (err instanceof RefusedError) return err.message;
    throw err;
  }
}
class RefusedError extends Error {}

// The author's fix tasks for a ruling's blocking findings, or its touch-ups' check, accepted as its owner would (hq inbox
// accept findings:<pr> --for <author> --findings <ids>): one per task the consolidator named, in its order, under its
// title. For a company with review.drawWindowedChanges (proposals.ts deliverFindings). A refusal stops delivery.
export function drawnAtOnce(item: Item, owner: string) {
  const { author } = db.prepare('select author from prs where number = ?').get(item.pr) as { author: string };
  const tasks = new Map<string | undefined, number[]>();
  for (const f of item.findings.filter(f => f.kind !== 'nonblocking'))
    tasks.set(f.task, [...(tasks.get(f.task) ?? []), f.id]);
  const drawn = (tasks.size ? [...tasks.values()] : [undefined]).map(findings => {
    const made = accept(`${FINDINGS}${item.pr}`, owner, { for: author, findings });
    if (typeof made === 'string') throw new Error(made);
    return made.job;
  });
  return { jobs: drawn, author };
}

export function fixFor(
  thread: string | null,
  named: unknown,
  by: string,
  options: { pr?: number; touchups?: boolean } = {},
): Fix | string | undefined {
  const { pr, touchups = false } = options;
  const row = reviewwork.current(thread, pr);
  if (!row) return named == null && pr === undefined ? undefined : 'this thread has no current review findings';
  const item = get(row.pr)!;
  if (named == null && !touchups) return unassigned(item.pr, item.round).length ? NAME_FINDINGS : undefined;
  const refused = reviewwork.authorized(item, by);
  if (refused) return refused;
  const canonical = thread ? findThread(thread)?.id : null;
  if (item.thread && canonical !== item.thread) return 'review fix tasks belong to the reviewed thread';
  const required = item.findings.filter(f => f.kind !== 'nonblocking');
  const ids = named == null && !required.length ? [] : readIds(named);
  if (typeof ids === 'string') return ids;
  if (ids.some(id => !item.findings.some(f => f.id === id))) return 'name only findings in this inbox item';
  const prior = tasks(item.pr, item.round).filter(job => job.id > (item.ruling ?? 0));
  const assigned = prior.filter(j => j.status !== 'cancelled' && j.status !== 'failed');
  if (!ids.length && assigned.some(j => !j.findings.length)) return 'a live fix task already checks these touch-ups';
  if (assigned.some(j => j.findings.some(id => ids.includes(id))))
    return 'a live fix task already names one of these findings';
  const replaces = prior
    .filter(j => j.status === 'failed' && (ids.length ? j.findings.some(id => ids.includes(id)) : !j.findings.length))
    .map(j => j.id);
  return {
    item,
    findings: item.findings.filter(f => ids.includes(f.id)),
    pr: item.pr,
    round: item.round,
    branch: item.branch,
    stage: 'fix',
    replaces,
  };
}

export function recordTask(job: number, fix: Fix) {
  const ids = fix.findings.map(f => f.id);
  db.prepare('insert into review_fix_tasks (job, pr, round, findings) values (?, ?, ?, ?)').run(
    job,
    fix.pr,
    fix.round,
    JSON.stringify(ids),
  );
  prioritizeFixes(job);
  const all = new Set(
    tasks(fix.pr, fix.round)
      .filter(j => j.status !== 'cancelled' && j.status !== 'failed')
      .flatMap(j => j.findings),
  );
  if (fix.item.findings.filter(f => f.kind !== 'nonblocking').every(f => all.has(f.id)))
    db.prepare("update proposals set status = 'accepted', decided = ?, accepted = ? where id = ?").run(
      new Date().toISOString(),
      job,
      fix.item.proposal,
    );
}

export const instructions = (fix: Fix) => `Fix the named review findings on PR #${fix.pr}, round ${fix.round}.
${describe({ ...fix.item, findings: fix.findings })}

${fix.item.brief ?? ''}

This task answers ${fix.findings.length ? fix.findings.map(f => `finding #${f.id}`).join(', ') : 'the review touch-ups'}. Other findings in the ruling are context for the other fix tasks.
Report each named finding by number as fixed, disputed (why), or kept (why).`;
export function copyTask(before: number, after: number) {
  db.prepare(
    `insert into review_fix_tasks (job, pr, round, findings)
    select ?, pr, round, findings from review_fix_tasks where job = ?`,
  ).run(after, before);
  prioritizeFixes(after);
}

// Review fixes occupy the existing queued slots before continuations that need their merge.
function prioritizeFixes(job: number) {
  const queued = db
    .prepare(
      `select j.id, coalesce(j.seq, j.id) seq,
    exists (select 1 from review_fix_tasks f where f.job = j.id and f.pr = own.pr and f.round = own.round) fix
    from review_fix_tasks own join jobs task on task.id = own.job join jobs j on j.thread = task.thread
    where own.job = ? and j.status = 'queued' and j.kind = 'work' and j.pr is null
    order by coalesce(j.seq, j.id), j.id`,
    )
    .all(job) as { id: number; seq: number; fix: number }[];
  const ordered = [...queued].sort((a, b) => b.fix - a.fix);
  const set = db.prepare('update jobs set seq = ? where id = ?');
  ordered.forEach((task, i) => set.run(queued[i].seq, task.id));
}

export const context = (job: number) =>
  db.prepare('select pr, round, findings from review_fix_tasks where job = ?').get(job) as
    { pr: number; round: number; findings: string } | undefined;

export function unassigned(pr: number, round: number) {
  const rows = db.prepare(unassignedFindings('$pr', '$round')).all({ pr, round }) as { id: number }[];
  return rows.map(row => row.id);
}

export function tasks(pr: number, round: number) {
  const rows = db
    .prepare(
      `select j.id, j.status, j.agent, f.findings from review_fix_tasks f
    join jobs j on j.id = f.job where f.pr = ? and f.round = ?
    and not (j.status = 'failed' and ${jobs.hasReplacement('j.id')}) order by coalesce(j.seq, j.id), j.id`,
    )
    .all(pr, round) as { id: number; status: string; agent: string; findings: string }[];
  return rows.map(j => ({ ...j, findings: JSON.parse(j.findings) as number[] }));
}

export function reports(pr: number) {
  const item = get(pr);
  if (!item) return undefined;
  const rows = db
    .prepare(
      `select j.id, j.agent, j.result, f.findings from review_fix_tasks f join jobs j on j.id = f.job
    where f.pr = ? and f.round = ? and j.status = 'done' order by coalesce(j.seq, j.id), j.id`,
    )
    .all(pr, item.round) as { id: number; agent: string; result: string | null; findings: string }[];
  return rows
    .map(row => {
      const ids = JSON.parse(row.findings) as number[];
      return `Job #${row.id}, ${row.agent}, ${ids.length ? ids.map(id => `finding #${id}`).join(', ') : 'review touch-ups'}:\n${row.result?.trim() || '(no report)'}`;
    })
    .join('\n\n');
}

const NAME_FINDINGS = 'name the findings this task fixes with --findings <id,id,...>';
const UNNAMED =
  'name the task for what it fixes with --title "...": the reviewer put these findings under more than one task, or none';
const TITLE_MAX = 140;
export const BAD_TITLE = `a task's title is one line of up to ${TITLE_MAX} characters`;

// A task's title as the consolidator or the accepter wrote it (model output: anything but a line is none)
export const taskTitle = (given: unknown) => {
  const line = typeof given === 'string' ? oneLine(given) : '';
  return line && line.length <= TITLE_MAX ? line : undefined;
};
// The fix task's title the consolidator gave: its findings' one task, or for touch-ups alone their check's
function reviewed(fix: Fix) {
  if (!fix.findings.length) return fix.item.touchups;
  const tasks = new Set(fix.findings.map(f => f.task));
  return tasks.size === 1 ? [...tasks][0] : undefined;
}
// The tasks a fix round without thread order goes under (review.ts), as the consolidator named them (model output):
// each blocking finding's, and its touch-ups' check when it made touch-ups
type Ruling = { blocking?: unknown[]; touchups_task?: unknown };
const blockingOf = (v: Ruling) => (Array.isArray(v.blocking) ? (v.blocking as { task?: unknown }[]) : []);
const roundTasks = (v: Ruling, touchedUp: boolean) => [
  ...blockingOf(v).map(e => e?.task),
  ...(touchedUp ? [v.touchups_task] : []),
];
// Why those tasks can't title the round, so its ruling can't be read (review.ts misjudged): one isn't a title
export function untitledRound(v: Ruling, touchedUp: boolean) {
  const bad = roundTasks(v, touchedUp).findIndex(task => !taskTitle(task));
  if (bad < 0) return undefined;
  return `${bad < blockingOf(v).length ? `blocking finding ${bad + 1}'s "task"` : '"touchups_task"'} isn't one: ${BAD_TITLE}`;
}
// The round's title, once its ruling reads: every task it names, together and in full (none for a ruling that names
// no fix: no blocking finding and no touch-ups)
export const roundTitle = (v: Ruling, touchedUp: boolean) =>
  [...new Set(roundTasks(v, touchedUp).map(task => oneLine(task as string)))].join('; ') || undefined;

function readIds(named: unknown): number[] | string {
  const ids = Array.isArray(named) ? named : typeof named === 'string' ? named.split(',').map(Number) : [];
  return !ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)
    ? NAME_FINDINGS
    : ([...new Set(ids)] as number[]);
}

function describe(item: Pick<Delivery, 'pr' | 'decision' | 'summary' | 'findings' | 'touchups'>) {
  const touchups = item.touchups ? `\n\nTouch-ups to check, as the task: ${item.touchups}` : '';
  return `PR #${item.pr}: ${item.decision}. ${item.summary}\n\n${item.findings
    .map(
      f =>
        `#${f.id} [${f.domain}] ${f.files.join(', ')}: ${f.issue}${f.fix ? `\nFix: ${f.fix}` : ''}${f.task ? `\nTask: ${f.task}` : ''}`,
    )
    .join('\n\n')}${touchups}`;
}
