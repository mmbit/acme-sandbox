// Resolve a prerequisite's merge edge through its branch's open PR.
// A finished task can first follow its open deliverable's remaining work on the same branch.
import { prepared } from './db.ts';
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

export function mergeWait(
  prior: number,
  open: ReadonlyMap<number, Work>,
  branchTask: (before: Work) => number | undefined,
): Target | undefined {
  const before = prepared('select id, kind, status, pr, thread, branch from jobs where id = ?').get(prior) as
    Work | undefined;
  if (!before) return;
  const branch = jobs.workBranchOf(before);
  const pr = prepared(
    `select number, status in ${jobs.OPEN_PRS} as open from prs where branch = ? order by number desc limit 1`,
  ).get(branch) as { number: number; open: number } | undefined;
  if (pr && !pr.open) return;
  const next = branchTask(before);
  if (next !== undefined) return { job: next };
  if (!pr) return;
  const work = [...open.values()].find(
    row => row.kind === 'work' && row.status === 'done' && jobs.workBranchOf(row) === branch,
  );
  return work ? { job: work.id } : { pr: pr.number };
}
