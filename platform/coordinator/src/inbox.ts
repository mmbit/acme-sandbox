// Shared storage for proposals and owner-directed review findings.
import { db, redacted, once, lacks } from './db.ts'; // (lacks)

// agent, job: the proposer and its job; for_agent: who it proposes does the work (the proposer when null); thread: the
// thread it proposes; project: the project whose owner decides it (null: the CEO); heard_by: the owner's planning job
// that takes it, since heard_at (when it reached that job's owner); status: open, accepted (accepted: the job it became)
// or dropped (why). planning_jobs: each owner's planning jobs, the open one taking what arrives until it ends.
db.exec(`create table if not exists proposals (id integer primary key, created text not null, agent text not null,
  job integer, title text not null, brief text not null, for_agent text, thread text, status text not null default 'open',
  decided text, accepted integer, why text, project text, heard_by integer, heard_at text);
  create table if not exists planning_jobs (job integer primary key, agent text not null)`);
db.exec('create index if not exists proposals_accepted on proposals (accepted) where accepted is not null');
redacted('proposals', 'title', 'brief', 'why');

db.exec(`create table if not exists review_inbox (pr integer primary key, proposal integer not null unique,
  round integer not null, branch text not null, agent text not null, decision text not null, summary text not null,
  findings text not null, thread text, project text, touchups text);
  create table if not exists review_fix_tasks (job integer primary key, pr integer not null, round integer not null, findings text not null)`);
db.exec(
  `create table if not exists review_holds (branch text not null, job integer not null, primary key (branch, job))`,
);
redacted('review_inbox', 'summary', 'findings');
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

// Outstanding finding identities for owner assignment.
export function unassignedFindings(pr: string, round: string) {
  return `select json_extract(finding.value, '$.id') id from review_inbox r, json_each(r.findings) finding
    where r.pr = ${pr} and r.round = ${round}
      and coalesce(json_extract(finding.value, '$.kind'), 'blocking') != 'nonblocking'
      and not exists (select 1 from review_fix_tasks f join jobs j on j.id = f.job
        join json_each(f.findings) assigned where f.pr = r.pr and f.round = r.round
          and j.status not in ('failed', 'cancelled') and assigned.value = json_extract(finding.value, '$.id'))`;
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

// Review items on a thread with a window (windows.ts): their findings hold that window up, so they reach whoever acts at
// once (proposals.ts tell), and a planning job holding any orders by the earliest of their windows (backlog.ts).
const WINDOWED = `from review_inbox r join proposals p on p.id = r.proposal join threads t on t.id = r.thread
  where p.status = 'open' and t.status = 'open' and t.deadline is not null`;
export const windowed = (proposal: number) => !!db.prepare(`select 1 ${WINDOWED} and r.proposal = ?`).get(proposal);
export const heldWindows = () =>
  new Map(
    (
      db
        .prepare(
          `select p.heard_by job, min(t.deadline) deadline ${WINDOWED} and p.heard_by is not null
        group by p.heard_by`,
        )
        .all() as { job: number; deadline: number }[]
    ).map(({ job, deadline }) => [job, deadline]),
  );
