// Resolve a prerequisite's merge edge through its branch's open PR.
// A finished task can first follow its open deliverable's remaining work on the same branch.
import { prepared, workBranch } from './db.ts';
import * as jobs from './jobs.ts';

type Work = {
  id: number;
  kind: string;
  status: string;
  pr: number | null;
  thread: string | null;
  branch: string | null;
};
type Target = { job: number } | { pr: number };

// Each prerequisite's merge edge for one play: the prerequisites' rows and their branches' latest pull requests are read
// in one statement, for every prerequisite the play may ask about: at HQ's size, a statement per prerequisite is too
// slow for the claim's plan.
export function mergeWaits(
  priors: Iterable<number>,
  open: ReadonlyMap<number, Work>,
  branchTask: (before: Work) => number | undefined,
): (prior: number) => Target | undefined {
  const latest = (column: string) =>
    `(select ${column} from prs where branch = ${workBranch('j')} order by number desc limit 1)`;
  const found = prepared(
    `select j.id, j.kind, j.status, j.pr, j.thread, j.branch, ${latest('number')} pr_number,
      ${latest(`status in ${jobs.OPEN_PRS}`)} pr_open
    from jobs j where j.id in (select value from json_each(?))`,
  ).all(JSON.stringify([...new Set(priors)])) as (Work & { pr_number: number | null; pr_open: number | null })[];
  const read = new Map(found.map(({ pr_number, pr_open, ...work }) => [work.id, { work, pr_number, pr_open }]));
  // (the first done work on each branch, in the open rows' order)
  const doneWork = new Map<string, number>();
  for (const row of open.values())
    if (row.kind === 'work' && row.status === 'done' && !doneWork.has(jobs.workBranchOf(row)))
      doneWork.set(jobs.workBranchOf(row), row.id);
  return prior => {
    const before = read.get(prior);
    if (!before) return;
    const { work, pr_number: pr, pr_open: prOpen } = before;
    if (pr !== null && !prOpen) return;
    const next = branchTask(work);
    if (next !== undefined) return { job: next };
    if (pr === null) return;
    const done = doneWork.get(jobs.workBranchOf(work));
    return done !== undefined ? { job: done } : { pr };
  };
}
