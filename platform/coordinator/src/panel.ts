// Branch authors and the independent consolidator selected for a round.
import { db, redacted } from './db.ts';
import { ceo, roles } from './company.ts';

db.exec(`create table if not exists review_triage (job integer primary key, pr integer not null,
  round integer not null, sha text, base text, selection text not null);
  create index if not exists review_triage_round on review_triage (pr, round, job)`);
redacted('review_triage', 'selection');

export function authors(branch: string, author?: string) {
  const rows = db
    .prepare(
      `with author_jobs as (
      select j.id, j.agent from jobs j left join threads t on t.id = j.thread
      where (j.kind in ('work', 'chat') and coalesce(j.branch, t.branch, 'job/' || j.id) = ?)
      or (j.kind = 'consolidate' and exists (
        select 1 from touchups u join prs p on p.number = u.pr
        where u.job = j.id and u.head is not null and p.branch = ?))
    ) select agent from author_jobs union select m.agent from job_members m join author_jobs j on j.id = m.job`,
    )
    .all(branch, branch) as { agent: string }[];
  return new Set(rows.map(row => row.agent).concat(author ? [author] : []));
}

export function authorsOf(pr: number) {
  const row = db.prepare('select branch, author from prs where number = ?').get(pr) as {
    branch: string;
    author: string;
  };
  return authors(row.branch, row.author);
}

export function consolidator(pr?: number) {
  const excluded = pr === undefined ? new Set<string>() : authorsOf(pr);
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
  if (assigned && !excluded.has(assigned)) return assigned;
  return roles().consolidators.find(agent => !excluded.has(agent)) ?? ceo();
}

export const reviewers = (pr: number) => {
  const authors = authorsOf(pr);
  return roles().reviewers.filter(agent => !authors.has(agent));
};

export type Seat = { agent: string; files: string[]; domains: string[]; slice: boolean };

export function threadContext(branch: string) {
  const thread = db.prepare('select id, goal from threads where id = ?').get(threadOfBranch(branch)) as
    { id: string; goal: string } | undefined;
  if (!thread) return undefined;
  const tasks = db
    .prepare(
      `select agent, title from jobs where kind = 'work' and (stage is null or stage = 'fix') and thread = ?
    and status != 'cancelled' order by coalesce(seq, id), id`,
    )
    .all(thread.id) as { agent: string; title: string }[];
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
