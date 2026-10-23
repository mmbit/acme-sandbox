// Team members working inside a lead's session (Claude Code sub-agents). The worker reports them from
// the session's event stream; HQ shows them as temporary colleagues in the lead's department.
import { db, once } from './db.ts';
import { publish } from './events.ts';
import './log.ts';

db.exec(`create table if not exists team (job integer not null, id text not null, name text not null,
  parent text, department text, state text, task text, updated integer, primary key (job, id));
  create table if not exists job_members (job integer not null, agent text not null, primary key (job, agent))`);

// The log keeps members whose live registrations have ended.
once('job-members-backfill', `insert or ignore into job_members (job, agent) select job, id from team;
  insert or ignore into job_members (job, agent) select distinct job, agent from job_log where agent is not null`);

type TeamMember = { job: number; id: string; name: string; parent: string | null; department: string; state: string; task: string | null };
type Report = { job: number; id?: string; name?: string; parent?: string; department?: string;
  state?: string; task?: string; done?: boolean };

export function teamEvent(r: Report) {
  if (r.done) {
    db.prepare('delete from team where job = ?').run(r.job);
    return { ok: true };
  }
  if (!r.id) return 400;
  if (!running(r.job)) return 409;   // a report that came in after its run ended
  db.prepare(`insert into team (job, id, name, parent, department, state, task, updated) values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (job, id) do update set state = coalesce(excluded.state, state), task = coalesce(excluded.task, task),
    updated = excluded.updated`).run(r.job, r.id, r.name ?? r.id, r.parent ?? null, r.department ?? null,
    r.state ?? 'working', r.task ?? null, Date.now());
  db.prepare('insert or ignore into job_members (job, agent) values (?, ?)').run(r.job, r.id);
  publish({ type: 'status', agent: r.id, state: r.state ?? 'working', text: r.task });
  return { ok: true };
}

// A team lives in one run of its lead's job: members are only ever added while that job is running.
const running = (job: number) => !!db.prepare("select 1 from jobs where id = ? and status = 'running'").get(job);

// A run's members go when it ends, however it ends. The worker says so (done), but not when it's cut off: a crash, a
// restart that takes the coordinator down with it, a lost connection. Whatever it couldn't say goes here, before each
// claim, so a job's next run (a resumed session too) starts with no team. Logged, as only a lost report leaves any.
export function sweepTeam() {
  const ended = db.prepare(`select t.job, j.status, group_concat(t.id, ', ') ids, max(t.updated) heard from team t
    left join jobs j on j.id = t.job where j.status is not 'running' group by t.job`).all() as
    { job: number; status: string | null; ids: string; heard: number }[];
  if (!ended.length) return;
  db.prepare("delete from team where job not in (select id from jobs where status = 'running')").run();
  for (const team of ended)
    console.log(`team: job #${team.job} (${team.status ?? 'gone'}) ended without saying so; its members ${team.ids} went (last heard ${new Date(team.heard).toISOString()})`);
}

// The members of jobs running now, per department (a run's members are removed when it ends: teamEvent, sweepTeam).
export function teamMembers() {
  const members = db.prepare(`select t.job, t.id, t.name, t.parent, t.department, t.state, t.task from team t
    join jobs j on j.id = t.job and j.status = 'running'`).all() as TeamMember[];
  return members.map(m => ({ ...m, name: capitalised(m.name) }));
}

// HQ shows a colleague's name capitalised, whatever case its lead gave it. The id stays as it is (hq --as, SendMessage).
const capitalised = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

// A member's latest step in its lead's job (log.ts), cut to a task's length: what it's doing, for one its lead gave only a
// name (company.ts). It reads job_log's text, the line agents may read (a job holding a customer's details keeps the step
// itself in board).
export const lastStep = (job: number, id: string) => (db.prepare(
  "select text from job_log where job = ? and agent = ? and text != '' order by id desc limit 1").get(job, id) as { text: string } | undefined)?.text.slice(0, 120);

// A member the worker registered for this job (hq --as): the only other name a job's token may speak as.
export const inTeam = (job: number, id: string) => !!db.prepare('select 1 from team where job = ? and id = ?').get(job, id);

// Whether this run of the job has started a member: one that holds the job's token too, whatever name it speaks as.
//
export const hasTeam = (job: number) => !!db.prepare('select 1 from team where job = ?').get(job);
