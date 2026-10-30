// Branch authors, review eligibility and the consolidator selected for a round.
import { db, redactedJson } from './db.ts';
import { org, roles } from './company.ts';
import { findAgent, SEAT_READY } from './jobs.ts';
import * as ordering from './ordering.ts';
import * as planner from './planner.ts';
import { withPicks } from './models.ts';

db.exec(`create table if not exists review_triage (job integer primary key, pr integer not null,
  round integer not null, sha text, base text, selection text not null);
  create index if not exists review_triage_round on review_triage (pr, round, job)`);
redactedJson('review_triage', 'selection');

// The jobs that can be on the branch come by index first (its own, its thread's, the job it's named after, a touch-up's
// pull request), then the rule decides: the rule alone read every job row, and a review's start asks 5 times (0.3 s).
export function authors(branch: string, author?: string) {
  const rows = db
    .prepare(
      `with maybe as (
      select id from jobs where branch = ?1
      union select j.id from threads t cross join jobs j on j.thread = t.id where t.branch = ?1 and j.branch is null
      union select id from jobs where ?1 like 'job/%' and id = cast(substr(?1, 5) as integer)
      union select u.job from prs p cross join touchups u on u.pr = p.number where p.branch = ?1
    ), author_jobs as (
      select j.id, j.agent from maybe cross join jobs j on j.id = maybe.id left join threads t on t.id = j.thread
      where (j.kind in ('work', 'chat') and coalesce(j.branch, t.branch, 'job/' || j.id) = ?1)
      or (j.kind = 'consolidate' and exists (
        select 1 from touchups u join prs p on p.number = u.pr
        where u.job = j.id and u.head is not null and p.branch = ?1))
    ) select agent from author_jobs union select m.agent from job_members m join author_jobs j on j.id = m.job`,
    )
    .all(branch) as { agent: string }[];
  return new Set(rows.map(row => row.agent).concat(author ? [author] : []));
}

export function authorsOf(pr: number) {
  const row = db.prepare('select branch, author from prs where number = ?').get(pr) as {
    branch: string;
    author: string;
  };
  return authors(row.branch, row.author);
}

export function excludedAuthors(pr: number) {
  const authors = authorsOf(pr);
  return authors.size === 1 ? authors : new Set<string>();
}

export function consolidator(pr?: number, stage = 'triage') {
  const candidates = consolidators(pr);
  const selected =
    pr === undefined
      ? undefined
      : (db
          .prepare(
            `select t.selection from review_triage t join prs p
    on p.number = t.pr and p.round = t.round and p.sha = t.sha where t.pr = ? and t.job > p.since order by t.job desc limit 1`,
          )
          .get(pr) as { selection: string } | undefined);
  const assigned = selected ? (JSON.parse(selected.selection).consolidator as string) : undefined;
  if (assigned && candidates.includes(assigned)) return assigned;
  if (!candidates.length) throw new Error(`No eligible consolidator${pr === undefined ? '' : ` for PR #${pr}`}`);
  return pr === undefined ? candidates[0] : soonest(pr, candidates, stage);
}

// The candidate whose seats start the round's next run soonest: the fewest rounds' runs ahead of it per seat of the
// candidate's engine that takes it now, the preference order breaking ties. Ahead are the runs running and the queued
// ones the shared plan puts first (planner.ts compare). Seat eligibility uses that plan's key too (pacedTakes).
function soonest(pr: number, candidates: string[], stage: string) {
  const t = Date.now();
  const { branch, round } = db.prepare('select branch, round from prs where number = ?').get(pr) as {
    branch: string;
    round: number;
  };
  const { id } = db.prepare('select coalesce(max(id), 0) + 1 id from jobs').get() as { id: number };
  const timings = ordering.withRound(
    {
      id,
      pr,
      round,
      branch,
      thread: threadOfBranch(branch),
      stage,
      agent: candidates[0],
      engine: findAgent(candidates[0])!.engine,
      kind: 'consolidate',
      status: 'queued',
    },
    t,
  );
  const order = timings.get(id)!;
  const seats = db
    .prepare(
      `select engine, iif(pace is null or week_resets <= $now, null, week_resets) until from seats where ${SEAT_READY}`,
    )
    .all({ now: t }) as { engine: string; until: number | null }[];
  const runs = db
    .prepare(
      `select id, engine, status from jobs indexed by jobs_status
    where status in ('queued', 'running') and kind in ('review', 'consolidate')`,
    )
    .all() as { id: number; engine: string; status: string }[];
  const goesFirst = (run: (typeof runs)[number]) =>
    run.status === 'running' || planner.compare(timings.get(run.id)!, order) < 0;
  const wait = (agent: string) => {
    const engine = findAgent(agent)?.engine,
      taking = seats.filter(seat => seat.engine === engine && planner.pacedTakes(order, seat.until ?? undefined));
    const ahead = runs.filter(run => run.engine === engine && goesFirst(run)).length;
    return taking.length ? ahead / taking.length : Infinity;
  };
  const waits = candidates.map(wait);
  return candidates[waits.indexOf(Math.min(...waits))];
}

// Each agent on the engine it runs on, from one read of the chart (a findAgent per agent read it and the picks again).
export function consolidators(pr?: number): string[] {
  const excluded = pr === undefined ? new Set<string>() : excludedAuthors(pr);
  const agents: { id: string; engine: string }[] = withPicks(org()).departments.flatMap(
    (department: { agents?: { id: string; engine: string }[] }) => department.agents ?? [],
  );
  const staff = agents.map(agent => agent.id);
  // (the first of an id, as findAgent finds it)
  const engines = new Map(agents.map(agent => [agent.id, agent.engine] as const).reverse());
  const eligible = new Set<string>(
    staff.filter(agent => !excluded.has(agent) && ['claude', 'codex'].includes(engines.get(agent) ?? '')),
  );
  const configured = roles();
  for (const candidates of [configured.consolidators, configured.reviewers, staff]) {
    const available = [...new Set<string>(candidates)].filter(agent => eligible.has(agent));
    if (available.length) return available;
  }
  return [];
}

// Logs and follow-ups credit the recorded round job, or the author before review starts.
export function attribution(pr: number) {
  const { agent } = db
    .prepare(
      `select coalesce((
    select j.agent from jobs j where j.pr = p.number and j.round = p.round
    and j.kind = 'consolidate' and j.id > p.review_since and j.voided is null
    order by j.id desc limit 1
  ), p.author) agent from prs p where p.number = ?`,
    )
    .get(pr) as { agent: string };
  return agent;
}

export const reviewers = (pr: number) => {
  const excluded = excludedAuthors(pr);
  return roles().reviewers.filter(agent => !excluded.has(agent));
};

export type Seat = { agent: string; files: string[]; domains: string[]; slice: boolean; security: boolean };

export function threadContext(branch: string) {
  const thread = db.prepare('select id, goal from threads where id = ?').get(threadOfBranch(branch)) as
    { id: string; goal: string } | undefined;
  if (!thread) return undefined;
  const tasks = db
    .prepare(
      `select id, agent, title from jobs where kind = 'work' and (stage is null or stage = 'fix') and thread = ?
    and status != 'cancelled' order by coalesce(seq, id), id`,
    )
    .all(thread.id) as { id: number; agent: string; title: string }[];
  return { ...thread, tasks };
}

export function threadOfBranch(branch: string) {
  const row = db
    .prepare(
      `select thread from jobs where kind = 'work' and thread is not null
    and coalesce(branch, 'job/' || id) = ? order by id limit 1`,
    )
    .get(branch) as { thread: string } | undefined;
  const drawn = db.prepare('select id from threads where branch = ?').get(branch) as { id: string } | undefined;
  return drawn?.id ?? row?.thread ?? null;
}
