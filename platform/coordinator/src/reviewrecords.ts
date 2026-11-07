// What the review plan reads in one pass: the pull requests, the runs on those in review, their recorded panels, the
// owners holding their undrawn findings and each review class's round count.
import { prepared } from './db.ts';
import { expeditedPlans } from './expeditedplan.ts';
import { org, roles, ceo } from './company.ts';
import { OPEN_JOBS } from './jobs.ts';
import { withPicks } from './models.ts';
import { fitIn } from './arithmetic.ts';
import { measuredSizes, SLOW_SHARE } from './reviewtime.ts';
import { ownerOf } from './projects.ts';

export type PullRequest = {
  number: number;
  branch: string;
  author: string;
  panel: string | null;
  review_class: string | null;
  round: number;
  status: string;
  files: string;
  links: string;
  sha: string | null;
  since: number;
  expedited: number;
};
export type Run = {
  id: number;
  pr: number;
  round: number;
  agent: string;
  engine: string;
  kind: string;
  stage: string | null;
  status: string;
};
export type Selected = { consolidator: string; reviewers: { agent: string }[] };
export type Sorter = { id: number; agent: string; engine: string };

// Every pull request's state from prs_plan, never a row's verdict (db.ts), and the files and links of those in review,
// the only ones whose files are read (sweepAction, officeOnly, expeditedPlans): the rest read as none. Of those, too,
// whether it merged expedited.
function pullRequests() {
  const prs = prepared(
    `select number, branch, author, panel, review_class, round, status, sha, since from prs indexed by prs_plan
    order by number`,
  ).all() as PullRequest[];
  const texts = prepared('select files, links, expedited from prs where number = ?');
  for (const pr of prs)
    Object.assign(pr, inReview(pr) ? texts.get(pr.number) : { files: '[]', links: '[]', expedited: 0 });
  return prs;
}

export function records(now: number, prospective?: Run) {
  const prs = pullRequests();
  // (jobs_review_runs covers the jobs columns, prs_plan the pull requests': db.ts.)
  const runs = prepared(
    `select j.id, p.number pr, max(1, coalesce(f.round, j.round, p.round)) round,
    j.agent, j.engine, j.kind, j.stage, j.status from (
      select j.id from prs p indexed by prs_plan cross join jobs j on j.pr = p.number
      where p.status in ('open', 'board', 'stuck')
      union select f.job from prs p indexed by prs_plan join review_fix_tasks f on f.pr = p.number
      where p.status in ('open', 'board', 'stuck')
    ) candidate cross join jobs j indexed by jobs_review_runs on j.id = candidate.id
    left join review_fix_tasks f on f.job = j.id join prs p indexed by prs_plan on p.number = coalesce(f.pr, j.pr)
    where p.status in ('open', 'board', 'stuck') order by coalesce(j.seq, j.id), j.id`,
  ).all() as Run[];
  if (prospective) runs.push(prospective);
  const panels = Map.groupBy(
    prs.filter(pr => pr.status === 'merged'),
    pr => pr.review_class ?? 'check',
  );
  return {
    branches: new Map(prs.map(pr => [pr.branch, pr])),
    expedited: expeditedPlans(),
    selections: recordedSelections(),
    runs: Map.groupBy(runs, run => run.pr),
    undrawn: undrawnOwners(),
    counts: new Map([...panels].map(([panel, prs]) => [panel, roundCount(prs.map(pr => pr.round))])),
    measured: measuredSizes(now),
  };
}

// A review class's round count: the rounds four in five of its merged pull requests fit in (as a stage's slow size)
const roundCount = (rounds: number[]) => Math.ceil(fitIn(rounds, SLOW_SHARE) ?? 1);

function recordedSelections() {
  const selections = prepared(
    `select t.pr, t.selection from review_triage t join prs p indexed by prs_plan
    on p.number = t.pr and p.round = t.round and p.sha = t.sha where t.job > p.since
    and t.job = (select max(job) from review_triage where pr = t.pr and round = t.round and sha = t.sha)`,
  ).all() as { pr: number; selection: string }[];
  return new Map(selections.map(row => [row.pr, JSON.parse(row.selection) as Selected]));
}

export function panelActors(record: ReturnType<typeof records>) {
  const assigned = roles();
  const selected = new Set([
    ...assigned.consolidators,
    ceo(),
    ...assigned.reviewers,
    ...[...record.runs.values()].flatMap(runs => runs.filter(run => run.kind !== 'work').map(run => run.agent)),
  ]);
  const agents = org().departments.flatMap((department: { agents?: { id: string; engine: string }[] }) =>
    (department.agents ?? []).filter(agent => selected.has(agent.id)),
  );
  const picked = withPicks({ departments: [{ agents }] });
  const engines = new Map<string, string>(
    picked.departments[0].agents.map((agent: { id: string; engine: string }) => [agent.id, agent.engine] as const),
  );
  const reviewers = assigned.reviewers;
  return {
    reviewers,
    consolidator: assigned.consolidator,
    engines,
    claude: reviewers.filter(agent => engines.get(agent) !== 'codex'),
    codex: reviewers.filter(agent => engines.get(agent) === 'codex'),
  };
}

// Each pull request whose round's "changes" ruling waits in its owner's inbox, that owner, and the owner's open
// planning job that holds it (proposals.ts tell), if one does
const undrawnOwners = () =>
  new Map(
    (
      prepared(
        `select r.pr, r.project, j.id, j.agent, j.engine from review_inbox r join proposals q on q.id = r.proposal
        join prs p on p.number = r.pr left join planning_jobs s on s.job = q.heard_by
        left join jobs j on j.id = s.job and j.status in ${OPEN_JOBS}
        where q.status = 'open' and r.decision = 'changes' and p.round = r.round and p.status in ('open', 'stuck')`,
      ).all() as ({ pr: number; project: string | null } & (Sorter | { id: null; agent: null; engine: null }))[]
    ).map(({ pr, project, ...sorter }) => [
      pr,
      { owner: ownerOf({ project }), sorter: sorter.id === null ? undefined : sorter },
    ]),
  );

export const inReview = (pr: { status: string }) => ['open', 'board', 'stuck'].includes(pr.status);
