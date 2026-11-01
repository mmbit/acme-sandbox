// When work last moved, for the hourly check (threats.ts) to tell work that moved since the last check from work only
// acted on.
import { db } from './db.ts';
import { age } from '../../worker/hq/waits.ts';

// What moves it: a new commit pushed, a review round opened or its panel or ruling asked (a run that isn't a re-run of
// one), a ruling given, the merge and its deploy. A job queued, started, re-sent or ended with no push or ruling moves
// nothing. A thread's work is its tasks' pull requests'. Their review loops' jobs from db.ts jobs_pr_loop.
export const threadMoved = (thread: string) =>
  latestMove(
    "select number from prs where branch in (select coalesce(branch, 'job/' || id) from jobs where thread = $thread)",
    { thread },
  );
export const prMoved = (pr: number) => latestMove('select $pr', { pr });
const latestMove = (prs: string, args: Record<string, string | number>) =>
  (
    db
      .prepare(
        `select max(at) at from (select at from pushes where pr in (${prs})
        union all select min(created) from jobs indexed by jobs_pr_loop where pr in (${prs}) and kind in ('review', 'consolidate')
          group by pr, round, sha, kind, coalesce(stage, '')
        union all select finished from jobs indexed by jobs_pr_loop where pr in (${prs}) and kind = 'consolidate'
          and coalesce(stage, '') != 'triage' and status = 'done' and voided is null
          and id in (select ruling from finding_rulings)
        union all select merged_at from prs where number in (${prs})
        union all select (select min(finished) from deploys where ok = 1 and fetched > p.merged_at) from prs p
          where number in (${prs}))`,
      )
      .get(args) as { at: string | null }
  ).at;
export const movedWords = (at: string | null, now: number) =>
  at ? `Last moved ${age(now - Date.parse(at))} ago` : 'Nothing on it has moved yet (no push, round, merge or deploy)';
