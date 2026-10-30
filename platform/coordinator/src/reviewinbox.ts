// Review rulings in the project owner's inbox, and the findings each ordered fix task answers.
// (its messages say deliverable, the board's word for a thread)
import { unassignedFindings, holdsFindings } from './inbox.ts';
import { BAD_TITLE, taskTitle, untitledRound, roundTitle } from './tasktitles.ts';
import { db, inOneStep } from './db.ts';
import * as jobs from './jobs.ts';
import * as messages from './messages.ts';
import * as reviewwork from './reviewwork.ts';
import { threadOfBranch } from './panel.ts';
import * as reviewclosure from './reviewclosure.ts';
import { findThread, type JobThreadAsk } from './projects.ts';
import { reviewSettings } from './company.ts';

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
  const title = titleOf(details);
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

export const titleOf = ({ decision, pr }: Pick<Delivery, 'decision' | 'pr'>) => `Review ${decision} on PR #${pr}`;

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
        return 'review fix tasks belong to the reviewed deliverable';
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

// Why the author gets the fix at once, or undefined when its owner draws it (review.ts, proposals.ts)
export function drawReason(work: { branch: string; thread: string }) {
  if (!reviewSettings().drawWindowedChanges) return undefined;
  const thread = findThread(work.thread)!;
  if (thread.status === 'open' && thread.deadline !== null) return 'its deliverable has a window';
  return jobs.itemWorkBranches().has(work.branch) ? 'its work carries a live board call item' : undefined;
}
// A draw refusal needs a corrected ruling, not another delivery attempt
export class DrawRefused extends Error {}

// One author job answers the whole ruling. Separate pushes would each hold the branch for their tests.
export function drawnAtOnce(item: Item, owner: string) {
  const { author } = db.prepare('select author from prs where number = ?').get(item.pr) as { author: string };
  const blocking = item.findings.filter(f => f.kind !== 'nonblocking');
  const made = accept(`${FINDINGS}${item.pr}`, owner, {
    for: author,
    findings: blocking.length ? blocking.map(f => f.id) : undefined,
  });
  if (typeof made === 'string') throw new DrawRefused(made);
  return { jobs: [made.job], author };
}

// The ended fix tasks a new draw on their findings takes over from, as their replacement. A cancelled task isn't one:
// someone ended it on purpose, so a new draw is new work rather than its stand-in.
const REPLACEABLE = ['failed', 'stopped'];

export function fixFor(
  thread: string | null,
  named: unknown,
  by: string,
  options: { pr?: number; touchups?: boolean } = {},
): Fix | string | undefined {
  const { pr, touchups = false } = options;
  const row = reviewwork.current(thread, pr);
  if (!row) return named == null && pr === undefined ? undefined : 'this deliverable has no current review findings';
  const item = get(row.pr)!;
  if (named == null && !touchups) return unassigned(item.pr, item.round).length ? NAME_FINDINGS : undefined;
  const refused = reviewwork.authorized(item, by);
  if (refused) return refused;
  const canonical = thread ? findThread(thread)?.id : null;
  if (item.thread && canonical !== item.thread) return 'review fix tasks belong to the reviewed deliverable';
  const required = item.findings.filter(f => f.kind !== 'nonblocking');
  const ids = named == null && !required.length ? [] : readIds(named);
  if (typeof ids === 'string') return ids;
  if (ids.some(id => !item.findings.some(f => f.id === id))) return 'name only findings in this inbox item';
  const prior = tasks(item.pr, item.round).filter(job => job.id > (item.ruling ?? 0));
  const assigned = prior.filter(j => holdsFindings(j.status));
  if (!ids.length && assigned.some(j => !j.findings.length)) return 'a live fix task already checks these touch-ups';
  if (assigned.some(j => j.findings.some(id => ids.includes(id))))
    return 'a live fix task already names one of these findings';
  const replaces = prior
    .filter(
      j =>
        REPLACEABLE.includes(j.status) && (ids.length ? j.findings.some(id => ids.includes(id)) : !j.findings.length),
    )
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
  acceptDrawn(job, fix.item);
}

// Assignment can go away after acceptance. Only the current ruled round reopens for its owner's next sort.
export function reopenUndrawn() {
  const rows = db
    .prepare(
      `select item.pr, q.id, q.agent, q.title, q.project from review_inbox item join proposals q on q.id = item.proposal
    join prs p on p.number = item.pr where q.status = 'accepted' and p.status in ('open', 'stuck')
    and p.round = item.round and exists (${unassignedFindings('item.pr', 'item.round')})`,
    )
    .all() as { pr: number; id: number; agent: string; title: string; project: string | null }[];
  const reopened = [];
  for (const row of rows) {
    const item = get(row.pr)!;
    if (!reviewwork.current(item.thread, row.pr)) continue;
    db.prepare("update proposals set status = 'open', decided = null, accepted = null where id = ?").run(item.proposal);
    reopened.push(row);
  }
  return reopened;
}

export const instructions = (fix: Fix) => `Fix the named review findings on PR #${fix.pr}, round ${fix.round}.
${describe({ ...fix.item, findings: fix.findings })}

${fix.item.brief ?? ''}

This task answers ${fix.findings.length ? fix.findings.map(f => `finding #${f.id}`).join(', ') : 'the review touch-ups'}. Finish every named finding in this job before the final verification and push. Other findings in the ruling are context.
Report each named finding by number as fixed, disputed (why), or kept (why).`;
export function copyTask(before: number, after: number) {
  db.prepare(
    `insert into review_fix_tasks (job, pr, round, findings)
    select ?, pr, round, findings from review_fix_tasks where job = ?`,
  ).run(after, before);
  prioritizeFixes(after);
  const fix = context(after);
  if (fix) acceptDrawn(after, get(fix.pr)!);
}

function acceptDrawn(job: number, item: Item) {
  const proposal = db.prepare("select 1 from proposals where id = ? and status = 'open'").get(item.proposal);
  if (!proposal) return;
  const all = new Set(
    tasks(item.pr, item.round)
      .filter(j => holdsFindings(j.status))
      .flatMap(j => j.findings),
  );
  if (!item.findings.filter(f => f.kind !== 'nonblocking').every(f => all.has(f.id))) return;
  db.prepare("update proposals set status = 'accepted', decided = ?, accepted = ? where id = ?").run(
    new Date().toISOString(),
    job,
    item.proposal,
  );
  messages.withdraw(item.proposal);
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
    and not (j.status in (${REPLACEABLE.map(status => `'${status}'`).join(', ')}) and ${jobs.hasReplacement('j.id')}) order by coalesce(j.seq, j.id), j.id`,
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
const UNNAMED = 'name the task for what it fixes with --title "...": the reviewer did not name every fix';
// Keep every named fix in the round's title, as for a round without thread order.
function reviewed(fix: Fix) {
  const ruling = { blocking: fix.findings, touchups_task: fix.item.touchups };
  const touchedUp = !!fix.item.touchups;
  return untitledRound(ruling, touchedUp) ? undefined : roundTitle(ruling, touchedUp);
}
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
