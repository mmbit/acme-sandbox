// Shared storage for proposals and owner-directed review findings.
import { db, redacted, redactedJson, once, lacks } from './db.ts'; // (lacks)
import type { Proposal } from './proposals.ts';

// agent, job: the proposer and its job; for_agent: who it proposes does the work (the proposer when null); thread: the
// thread it proposes; project: the project whose owner decides it (null: the CEO); heard_by: the owner's planning job
// or running session that takes it, since heard_at (when it reached that job's owner); status: open, accepted (accepted: the job it became)
// or dropped (why); request: a card of the proposer's that its work waits for (hq propose --after request:<id>): the
// job it becomes waits for it too, and the card's answer, if it comes first, goes into the brief (cardHeard); held: that
// answer is its asker's too, which no job heard (holdAnswer).
// planning_jobs: each owner's planning jobs by project (null: no project's), the open one taking what arrives for it
// until it ends.
db.exec(`create table if not exists proposals (id integer primary key, created text not null, agent text not null,
  job integer, title text not null, brief text not null, for_agent text, thread text, status text not null default 'open',
  decided text, accepted integer, why text, project text, heard_by integer, heard_at text, request integer,
  held integer not null default 0);
  create table if not exists planning_jobs (job integer primary key, agent text not null, project text)`);
// (planning jobs from before have no project: they keep what they hold.)
once(
  '2026-10-25-planning-jobs-project',
  () => lacks('planning_jobs', 'project') && db.exec('alter table planning_jobs add column project text'),
);
once(
  '2026-10-31-proposals-request',
  () => lacks('proposals', 'request') && db.exec('alter table proposals add column request integer'),
);
once(
  '2026-10-31-proposals-held',
  () => lacks('proposals', 'held') && db.exec('alter table proposals add column held integer not null default 0'),
);
db.exec('create index if not exists proposals_accepted on proposals (accepted) where accepted is not null');
redacted('proposals', 'title', 'brief', 'why');

// A card answered or taken off the desk phone before the open proposals whose work waits for it are accepted puts its
// line at the end of their briefs (jobs.ts tellWaiting), so the job each becomes hears it.
export function cardHeard(request: number, line: string) {
  db.prepare("update proposals set brief = brief || ? where request = ? and status = 'open'").run(
    `\n\n${line}`,
    request,
  );
}
// When neither the asker nor a job queued after the card hears its answer (jobs.ts answerHeard), those proposals hold it
// for the asker: the first accepted is the job that heard it, or, all dropped, the asker hears it (jobs.ts
// heldAnswerDropped). Whether any does.
export const holdAnswer = (request: number) =>
  db.prepare("update proposals set held = 1 where request = ? and status = 'open'").run(request).changes > 0;
// Whether the proposals that held card `request`'s answer for its asker are all dropped (false: none held it)
export const answerLetGo = (request: number) =>
  !!db
    .prepare("select 1 from proposals where request = ? and held = 1 group by request having sum(status = 'open') = 0")
    .get(request);

export function openProposal(id: number): Proposal | string {
  const p = db.prepare('select * from proposals where id = ?').get(id) as Proposal | undefined;
  if (!p) return `there's no proposal #${id} (hq inbox)`;
  if (p.status !== 'open') return `proposal #${id} was ${p.status} already`;
  return p;
}

db.exec(`create table if not exists review_inbox (pr integer primary key, proposal integer not null unique,
  round integer not null, branch text not null, agent text not null, decision text not null, summary text not null,
  findings text not null, thread text, project text, touchups text);
  create table if not exists review_fix_tasks (job integer primary key, pr integer not null, round integer not null, findings text not null)`);
db.exec(
  `create table if not exists review_holds (branch text not null, job integer not null, primary key (branch, job))`,
);
redacted('review_inbox', 'summary');
redactedJson('review_inbox', 'findings');
// touchups: the title the consolidator gave its touch-ups' check (reviewinbox.ts).
once(
  '2026-10-22-review-inbox-touchups',
  () => lacks('review_inbox', 'touchups') && db.exec('alter table review_inbox add column touchups text'),
);

// A review inbox item names the ruling that made it (proposals.job): those from before, the round's last consolidation.
once(
  '2026-10-22-review-inbox-ruling',
  `update proposals set job = (select max(j.id) from review_inbox r join jobs j on j.pr = r.pr
  and j.round = r.round where r.proposal = proposals.id and j.kind = 'consolidate' and j.status = 'done' and j.voided is null)
  where id in (select proposal from review_inbox)`,
);

// The statuses of a fix job that ended short of the push that starts the next round. A fix task that ended so no longer
// holds its findings, so they can be drawn again. Left alone, review.ts reviveFixes runs it again by itself.
export const ENDED_SHORT = ['failed', 'stopped', 'cancelled'];
export const ENDED_SHORT_SQL = `(${ENDED_SHORT.map(status => `'${status}'`).join(', ')})`;
export const holdsFindings = (status: string) => !ENDED_SHORT.includes(status);

// Outstanding finding identities for owner assignment.
export function unassignedFindings(pr: string, round: string) {
  return `select json_extract(finding.value, '$.id') id from review_inbox r, json_each(r.findings) finding
    where r.pr = ${pr} and r.round = ${round}
      and coalesce(json_extract(finding.value, '$.kind'), 'blocking') != 'nonblocking'
      and not exists (select 1 from review_fix_tasks f join jobs j on j.id = f.job
        join json_each(f.findings) assigned where f.pr = r.pr and f.round = r.round
          and j.status not in ${ENDED_SHORT_SQL} and assigned.value = json_extract(finding.value, '$.id'))`;
}

// Closing records the source before inbox delivery. Acceptance supplies its replacement edge.
db.exec(`create table if not exists review_redraws (pr integer primary key, branch text not null,
  job integer, dropped integer not null default 0)`);
once(
  'review-redraw-edges',
  `insert or replace into review_redraws (pr, branch, job, dropped)
  select r.pr, r.branch, case when q.status = 'accepted' then q.accepted end, q.status = 'dropped'
  from review_inbox r join proposals q on q.id = r.proposal where r.decision = 'close'`,
);

// Review findings and jobs waiting for sorting hold their thread's window (windows.ts). Their owner hears them at
// once (proposals.ts tell), and a planning job holding any orders by the earliest window (backlog.ts).
const WINDOWED = `from (
    select proposal, thread from review_inbox
    union select s.proposal, j.thread from sorts s join jobs j on j.id = s.job
  ) r join proposals p on p.id = r.proposal join threads t on t.id = r.thread join thread_windows w on w.id = t.id
  where p.status = 'open' and t.status = 'open' and w.deadline is not null`;
export const windowed = (proposal: number) => !!db.prepare(`select 1 ${WINDOWED} and r.proposal = ?`).get(proposal);
export const heldWindows = () =>
  new Map(
    (
      db
        .prepare(
          `select p.heard_by job, min(w.deadline) deadline ${WINDOWED} and p.heard_by is not null
        group by p.heard_by`,
        )
        .all() as { job: number; deadline: number }[]
    ).map(({ job, deadline }) => [job, deadline]),
  );
