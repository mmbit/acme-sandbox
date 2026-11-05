// Expedited work in the plan (reviewplan.ts). It merges once a push passes its gates and tests, which its run ends
// with, and its review follows the merge (review.ts expedites): no round stands before it goes live. One merged so
// already (prs.expedited) is live. A pushed one in review that didn't merge on its checks (they failed, or it changes
// its own checks or what HQ shows the board) has its round before its merge, as any other; one still to push counts on
// them.
import { prepared } from './db.ts';
import { checksOwn } from './review.ts';
import * as screens from './screens.ts';
import { workBranchOf } from './jobs.ts';
import type { ReviewPlan } from './rounds.ts';

type Work = { id: number; branch: string | null; status: string };
type InReview = { number: number; panel: string | null; files: string; sha: string | null; expedited: number };

// Read once per play: the expedited jobs and their branches (jobs_expedited covers them: db.ts), as review.ts expedites
// finds one, by its job or by the branch it pushes to. Then for each work, its pull request in review if it has one:
// its merge with nothing before it, or undefined when its rounds stand before it.
export function onChecks() {
  const rows = prepared(
    `select id, coalesce(branch, 'job/' || id) branch from jobs indexed by jobs_expedited
    where expedite = 1 and kind = 'work'`,
  ).all() as { id: number; branch: string }[];
  const jobs = new Set(rows.map(row => row.id)),
    branches = new Set(rows.map(row => row.branch));
  return (work: Work, pr: InReview | undefined): ReviewPlan | undefined => {
    if (!jobs.has(work.id) && !branches.has(workBranchOf(work))) return undefined;
    const reviewed =
      !!pr &&
      !pr.expedited &&
      (work.status === 'done' || checksOwn(JSON.parse(pr.files)) || screens.owed(pr.number, pr.sha) !== undefined);
    return reviewed ? undefined : { panel: pr?.panel ?? 'expedited', count: 0, stages: [], terminal: null };
  };
}
