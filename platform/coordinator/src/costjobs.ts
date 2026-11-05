// Every job as the cost book reads it (featurecost.ts): what its phase and owners need, and its spend over all its
// runs. Kept between books (keptpool.ts): a book reads again only the jobs whose rows changed since the last, where
// reading every job, usage row and run took 0.3 s at 24,500 jobs and grew with each.
import { db, workBranch } from './db.ts';
import { keptPool, type Notes, type RowAlias } from './keptpool.ts';
import { jobSpends, type Spend } from './costspend.ts';

export type CostJob = {
  id: number;
  status: string;
  thread: string | null;
  branch: string;
  kind: string;
  stage: string | null;
  pr: number | null;
  round: number | null;
  // a review's fix or follow-up (its phase), and the pull request it fixes where its row names one (its owners)
  fix: number;
  fix_pr: number | null;
  // its branch is a card's preview
  preview: number;
  // the branches of the pull requests a card's merge holds for it
  held: string[];
  // the branch of the pull request it fixes, else of its own, where that pull request is known
  pr_branch: string | null;
  spend: Spend;
  reported: boolean;
  ran: boolean;
};

// The book's order, a job's state then its id (jobs_play's): each thread's sums add its jobs in it
export const bookOrder = (a: CostJob, b: CostJob) => (a.status < b.status ? -1 : a.status > b.status ? 1 : a.id - b.id);

const ONLY = 'in (select value from json_each(?))';
// Every column the pool's reads take, in one statement keptpool.ts makes its triggers from: a read below that takes
// another belongs here too.
const READS = `select j.id, j.status, j.thread, ${workBranch('j')}, j.kind, j.stage, j.pr, j.round,
  (select ${workBranch('card')} from card_jobs c join jobs card on card.id = c.job),
  (select pr from review_fix_tasks where job = j.id),
  (select f.pr from review_followup_jobs r join findings f on f.id = r.finding where r.job = j.id),
  (select p.branch from card_merges m join prs p on p.number = m.pr where m.job = j.id),
  (select branch from prs where number = j.pr),
  (select max(ts) + sum(input + cache_write + cache_read + output) from usage where job = j.id),
  (select max(started) || max(ended) || sum(no_engine) from runs where job = j.id),
  (select sum(end + week + milliseconds) from seat_cost_jobs where job = j.id)
  from jobs j`;

// The jobs on a branch (SQL, a value): by the branch index, and the job whose own branch it is
const onBranch = (branch: string) =>
  `select id from jobs where branch = ${branch} union select id from jobs
  where id = cast(substr(${branch}, 5) as integer) and branch is null and ${branch} = 'job/' || id`;
// The jobs a fix or follow-up for the pull request `number` (SQL) is
const fixesFor = (number: string) =>
  `select job from review_fix_tasks where pr = ${number}
  union select r.job from review_followup_jobs r join findings f on f.id = r.finding where f.pr = ${number}`;
const OWN = (row: RowAlias) => `select ${row}.job`;
// For each table the pool reads, the jobs a row of it is read into: a job's own row (and, for a card's job, every job
// on its branch, whose preview it is), its usage, runs, meters, fixes and held merges; a finding its follow-up's job; a
// card the jobs on its job's branch; a pull request the jobs on it, fixing it or held by it.
const NOTES: Notes = {
  jobs: {
    of: row =>
      `select ${row}.id union select id from (${onBranch(workBranch(row))})
      where exists (select 1 from card_jobs where job = ${row}.id)`,
  },
  card_jobs: {
    of: row =>
      `select id from (${onBranch(`(select ${workBranch('card')} from jobs card where card.id = ${row}.job)`)})`,
  },
  review_fix_tasks: { of: OWN },
  review_followup_jobs: { of: OWN },
  findings: { of: row => `select job from review_followup_jobs where finding = ${row}.id` },
  card_merges: { of: OWN },
  prs: {
    of: row =>
      `select id from jobs where pr = ${row}.number union ${fixesFor(`${row}.number`)}
      union select job from card_merges where pr = ${row}.number`,
  },
  usage: { of: OWN },
  runs: { of: OWN },
  seat_cost_jobs: { of: OWN },
};

const pool = keptPool('cost', () => READS, readJobs, NOTES);
export const costJobs = () => pool.pool();
// The server's start: every job read ahead a slice at a time between the server's other work, so the first book after
// a start reads none of them at once (0.5-0.8 s at 24,500 jobs, warm)
const SLICE = 500;
export const readCostJobsAhead = () =>
  pool.seed(() => (db.prepare('select id from jobs order by id').all() as { id: number }[]).map(job => job.id), SLICE);

// The jobs `only` names, or every job, in the order of their ids (keptpool.ts's). jobs_play (db.ts) covers the columns
// a read of every job takes, so it reads no job's brief or report pages; a few jobs are read by their ids.
function readJobs(only?: number[]): CostJob[] {
  const rows = db
    .prepare(
      `select j.id, j.status, j.thread, ${workBranch('j')} branch, j.kind, j.stage, j.pr, j.round
      from jobs j ${only ? `where j.id ${ONLY}` : 'indexed by jobs_play'} order by j.id`,
    )
    .all(...(only ? [JSON.stringify(only)] : [])) as Pick<
    CostJob,
    'id' | 'status' | 'thread' | 'branch' | 'kind' | 'stage' | 'pr' | 'round'
  >[];
  const { previews, fixes, held } = links(only);
  const branchOf = prBranches(only && rows.flatMap(row => [row.pr ?? [], fixes.get(row.id) ?? []].flat()));
  const spends = jobSpends(only ?? null);
  return rows.map(row => {
    const fix_pr = fixes.get(row.id) ?? null,
      linked = fix_pr ?? row.pr;
    return {
      ...row,
      fix: fixes.has(row.id) ? 1 : 0,
      fix_pr,
      preview: previews.has(row.branch) ? 1 : 0,
      held: held.get(row.id) ?? [],
      pr_branch: (linked !== null ? branchOf.get(linked) : undefined) ?? null,
      ...spends(row.id),
    };
  });
}

// The previews' branches, and the jobs' fixes and held merges, each read once and looked up per job: a subquery per job
// would read them again for every job
function links(only?: number[]) {
  const args = only ? [JSON.stringify(only)] : [];
  const of = (column: string) => (only ? `where ${column} ${ONLY}` : '');
  const previews = new Set(
    (
      db.prepare(`select ${workBranch('card')} branch from card_jobs c join jobs card on card.id = c.job`).all() as {
        branch: string;
      }[]
    ).map(row => row.branch),
  );
  // (a job fixing two pull requests is held to the later one's)
  const fixes = new Map<number, number | null>();
  for (const { job, pr } of db
    .prepare(
      `select job, pr from review_fix_tasks ${of('job')}
      union select r.job, f.pr from review_followup_jobs r left join findings f on f.id = r.finding ${of('r.job')}
      order by job, pr`,
    )
    .all(...args, ...args) as { job: number; pr: number | null }[])
    fixes.set(job, pr ?? fixes.get(job) ?? null);
  const merges = db
    .prepare(
      `select distinct m.job, p.branch from card_merges m join prs p on p.number = m.pr ${of('m.job')}
      order by m.job, m.pr`,
    )
    .all(...args) as { job: number; branch: string }[];
  const held = new Map([...Map.groupBy(merges, row => row.job)].map(([job, rows]) => [job, rows.map(r => r.branch)]));
  return { previews, fixes, held };
}

// The branches of the pull requests `numbers` names, or of every one
const prBranches = (numbers?: number[]) =>
  new Map(
    (
      db
        .prepare(`select number, branch from prs ${numbers ? `where number ${ONLY}` : ''}`)
        .all(...(numbers ? [JSON.stringify(numbers)] : [])) as { number: number; branch: string }[]
    ).map(pr => [pr.number, pr.branch]),
  );
