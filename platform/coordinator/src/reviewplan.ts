// The measured runs and panels a pull request still needs before it can merge.
import { db, prepared } from './db.ts';
import { sweepAction, officeOnly, RULING_SWEEP_MS } from './review.ts';
import { org, roles, ceo } from './company.ts';
import { OPEN_JOBS, workBranchOf } from './jobs.ts';
import { withPicks } from './models.ts';
import { fitIn, mean, wholeSeconds } from './arithmetic.ts';
import type { ReviewPlan, ReviewStage } from './rounds.ts';
import { ownerOf } from './projects.ts';

const WEEK_MS = 7 * 24 * 60 * 60_000,
  GUESS_MS = 15 * 60_000,
  SLOW_SHARE = 0.8;
type PullRequest = {
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
};
type Run = {
  id: number;
  pr: number;
  round: number;
  agent: string;
  engine: string;
  kind: string;
  stage: string | null;
  status: string;
};
type Measurement = { engine: string; kind: string; ms: number };
export type ProspectiveRun = Run & { branch: string; thread: string | null };
type Work = {
  opensReview?: boolean;
  id: number;
  kind: string;
  origin: string;
  engine: string;
  status: string;
  branch: string | null;
  pr: number | null;
  agent: string;
};

export function reviewPlans(now: number, prospective?: ProspectiveRun) {
  const record = records(now, prospective),
    actors = panelActors(record);
  return (work: Work): ReviewPlan | undefined => {
    if (work.opensReview === false || work.kind !== 'work' || work.origin === 'fix' || work.origin === 'merge')
      return undefined;
    const pr = record.branches.get(workBranchOf(work));
    const resolution = pr ? resolutionOf(sweepAction(pr), now) : undefined;
    if (
      pr &&
      (resolution !== undefined ||
        !inReview(pr) ||
        (!pr.round && officeOnly(pr.author, pr.branch, JSON.parse(pr.files), JSON.parse(pr.links), pr.number)))
    )
      return {
        panel: pr.panel ?? 'records',
        count: 0,
        stages: [],
        terminal: null,
        unresolved: inReview(pr),
        ...resolution,
      };
    const own = pr ? (record.runs.get(pr.number) ?? []) : [];
    const panel = pr?.panel ?? (pr && own.length && !own.some(run => run.kind === 'review') ? 'check' : 'triage');
    const current = Math.max(1, pr?.round ?? 1);
    const fixing = own.some(run => run.round === current && run.kind === 'work' && isOpen(run));
    const undrawn = pr && !fixing ? record.undrawn.get(pr.number) : undefined;
    if (undrawn && !undrawn.sorter) return undrawnFix(pr!, undrawn.owner);
    const count = Math.max(current + Number(fixing || !!undrawn), record.counts.get(pr?.review_class ?? panel) ?? 1);
    const selection = pr ? record.selections.get(pr.number) : undefined;
    const reviewers = panelMembers(
      own.filter(run => run.round === current && run.id > (pr?.since ?? 0)),
      selection,
    );
    return buildPlan({
      panel,
      count,
      current,
      own: Map.groupBy(own, run => run.round),
      reviewers,
      selected: !!selection,
      pr,
      record,
      actors: { ...actors, consolidator: selection?.consolidator ?? actors.consolidator },
      work,
      sorter: undrawn?.sorter,
    });
  };
}

// Ruled "changes" with its findings in the owner's inbox and no fix task drawn. While the owner's planning job holds
// them, its sort is the round's next stage, then the fix it draws and the next round (buildPlan), so the thread's window
// orders the sort and the thread has a finish; heard nowhere else (an owner's session, the CEO's summary), no merge
// until someone draws one.
function undrawnFix(pr: PullRequest, owner: string): ReviewPlan {
  return {
    ...{ panel: pr.panel ?? 'records', count: 0, stages: [], terminal: null, unresolved: true },
    waiting: `its review asked for changes and no fix task is drawn (findings:${pr.number}, ${owner}'s to decide)`,
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

function resolutionOf(action: ReturnType<typeof sweepAction>, now: number) {
  if (!action?.merges) return undefined;
  if (!action.author) return { resolutionAt: now + RULING_SWEEP_MS };
  if (action.kind === 'office' && action.author.going) return { resolutionAfter: action.author.id };
  return undefined;
}

// Every pull request's state from prs_plan, never a row's verdict (db.ts), and the files and links of those in review,
// the only ones whose files are read (sweepAction, officeOnly): the rest read as none.
function pullRequests() {
  const prs = prepared(
    `select number, branch, author, panel, review_class, round, status, sha, since from prs indexed by prs_plan
    order by number`,
  ).all() as PullRequest[];
  const texts = prepared('select files, links from prs where number = ?');
  for (const pr of prs) Object.assign(pr, inReview(pr) ? texts.get(pr.number) : { files: '[]', links: '[]' });
  return prs;
}

function records(now: number, prospective?: ProspectiveRun) {
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
  // jobs_review_runs covers the jobs columns here to skip wide job rows (db.ts).
  const measured = prepared(
    `select j.engine, case when j.stage = 'triage' then 'triage' else j.kind end kind,
    sum((julianday(r.ended) - julianday(r.started)) * 86400000) ms
    from runs r cross join jobs j indexed by jobs_review_runs on j.id = r.job
    left join review_fix_tasks f on f.job = j.id
    where r.ended > ? and j.status = 'done'
    and (j.kind in ('review', 'consolidate') or j.stage = 'fix' and coalesce(f.round, j.round) is not null)
    and not exists (select 1 from runs o where o.job = j.id and o.ended is null) group by j.id`,
  ).all(new Date(now - WEEK_MS).toISOString()) as Measurement[];
  const panels = Map.groupBy(
    prs.filter(pr => pr.status === 'merged'),
    pr => pr.review_class ?? 'check',
  );
  return {
    branches: new Map(prs.map(pr => [pr.branch, pr])),
    selections: recordedSelections(),
    runs: Map.groupBy(runs, run => run.pr),
    undrawn: undrawnOwners(),
    counts: new Map(
      [...panels].map(([panel, prs]) => [
        panel,
        Math.ceil(
          fitIn(
            prs.map(pr => pr.round),
            SLOW_SHARE,
          ) ?? 1,
        ),
      ]),
    ),
    measured: measuredSizes(Map.groupBy(measured, run => `${run.kind}:${run.engine}`)),
  };
}

function recordedSelections() {
  const selections = db
    .prepare(
      `select t.pr, t.selection from review_triage t join prs p indexed by prs_plan
    on p.number = t.pr and p.round = t.round and p.sha = t.sha where t.job > p.since
    and t.job = (select max(job) from review_triage where pr = t.pr and round = t.round and sha = t.sha)`,
    )
    .all() as { pr: number; selection: string }[];
  return new Map(selections.map(row => [row.pr, JSON.parse(row.selection) as Selected]));
}

function measuredSizes(groups: Map<string, Measurement[]>) {
  return new Map(
    [...groups].map(([key, runs]) => {
      const times = runs.map(run => run.ms),
        usualMs = wholeSeconds(mean(times)!);
      return [key, { usualMs, slowMs: Math.max(usualMs, wholeSeconds(fitIn(times, SLOW_SHARE)!)) }] as const;
    }),
  );
}

function panelActors(record: ReturnType<typeof records>) {
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
const inReview = (pr: { status: string }) => ['open', 'board', 'stuck'].includes(pr.status);
const isOpen = (run: Run) => ['queued', 'running', 'blocked'].includes(run.status);

type Selected = { consolidator: string; reviewers: { agent: string }[] };
function panelMembers(own: Run[], selected: Selected | undefined) {
  if (selected) return selected.reviewers.map(reader => reader.agent);
  const reviews = own.filter(run => run.kind === 'review' && run.status !== 'cancelled');
  if (reviews.length) {
    const round = Math.max(...reviews.map(run => run.round));
    return [...new Set(reviews.filter(run => run.round === round).map(run => run.agent))];
  }
  return [];
}

type Context = {
  panel: string;
  count: number;
  current: number;
  own: Map<number, Run[]>;
  reviewers: string[];
  selected: boolean;
  pr: PullRequest | undefined;
  record: ReturnType<typeof records>;
  actors: ReturnType<typeof panelActors>;
  work: Work;
  // the owner's planning job holding the round's undrawn findings (undrawnFix): the stage before its fix
  sorter?: Sorter;
};
type Sorter = { id: number; agent: string; engine: string };
function buildPlan(context: Context): ReviewPlan {
  const stages: ReviewStage[] = [];
  let preceding: string[] = [];
  const since = context.pr?.since ?? 0;
  if (context.sorter)
    preceding = [
      addStage(context, stages, `${context.current}:sort`, 'work', context.sorter.agent, [], context.sorter),
    ];
  for (let round = context.current; round <= context.count; round++) {
    // A round restarted on its own number (a kept touch-up's push, a merge check, the whole panel called) leaves its
    // reads and rulings before prs.since behind; its fix tasks stay, whenever they were drawn.
    const own = (context.own.get(round) ?? []).filter(run => run.kind === 'work' || run.id > since);
    const fixing = own.some(run => run.kind === 'work' && isOpen(run));
    const checking = own.find(run => run.kind === 'consolidate' && run.stage !== 'ruling' && isOpen(run));
    const ruled =
      fixing || own.some(run => run.kind === 'consolidate' && run.stage !== 'triage' && run.status === 'done');
    if (!ruled) preceding = addReads(context, stages, round, own, preceding, checking);
    if (!ruled) {
      const known = own.findLast(run => run.kind === 'consolidate' && run.stage !== 'triage' && isOpen(run));
      preceding = [
        addStage(context, stages, `${round}:ruling`, 'consolidate', context.actors.consolidator, preceding, known),
      ];
    }
    if (ruled && !fixing) preceding = addChecks(context, stages, round, own, preceding);
    if (round < context.count || fixing) {
      const fixes = own.filter(run => run.kind === 'work' && isOpen(run));
      if (fixes.length)
        for (const fix of fixes)
          preceding = [addStage(context, stages, `${round}:fix:${fix.id}`, 'work', fix.agent, preceding, fix)];
      else
        preceding = [
          addStage(context, stages, `${round}:fix`, 'work', context.pr?.author ?? context.work.agent, preceding),
        ];
    }
  }
  return {
    panel: context.panel,
    count: context.count,
    stages,
    terminal: preceding.at(-1) ?? null,
    unresolved: !!context.pr && inReview(context.pr),
  };
}

// A ruled round's consolidation queued since its ruling (the retry of a ruling whose verdict couldn't be read) is what
// resolves it: a stage of its own, so the work waiting on the merge gives it its window, not a stall with none.
function addChecks(context: Context, stages: ReviewStage[], round: number, own: Run[], preceding: string[]) {
  for (const check of own.filter(run => run.kind === 'consolidate' && isOpen(run))) {
    const measurement = check.stage === 'triage' ? 'triage' : 'consolidate';
    const key = `${round}:check:${check.id}`;
    preceding = [addStage(context, stages, key, 'consolidate', check.agent, preceding, check, measurement)];
  }
  return preceding;
}

function addReads(
  context: Context,
  stages: ReviewStage[],
  round: number,
  own: Run[],
  preceding: string[],
  checking: Run | undefined,
) {
  const triage = own.findLast(run => run.stage === 'triage' && run.status !== 'cancelled');
  const ruling = own.some(run => run.kind === 'consolidate' && run.stage !== 'triage' && isOpen(run));
  const reviewers = round === context.current ? context.reviewers : [];
  const selected = round === context.current && context.selected;
  const needsTriage = !selected && !reviewers.length && !checking && !ruling;
  if ((triage && isOpen(triage)) || (needsTriage && triage?.status !== 'done'))
    preceding = [
      addStage(
        context,
        stages,
        `${round}:triage`,
        'consolidate',
        context.actors.consolidator,
        preceding,
        triage && isOpen(triage) ? triage : undefined,
        'triage',
      ),
    ];
  if (!checking) {
    const reviews = reviewers.flatMap(agent => {
      const known = own.findLast(run => run.kind === 'review' && run.agent === agent && run.status !== 'cancelled');
      if (known?.status === 'done') return [];
      return [addStage(context, stages, `${round}:review:${agent}`, 'review', agent, preceding, known)];
    });
    if (reviews.length) preceding = reviews;
  }
  return preceding;
}

function addStage(
  context: Context,
  stages: ReviewStage[],
  key: string,
  kind: ReviewStage['kind'],
  agent: string,
  after: string[],
  known?: Pick<Run, 'id' | 'agent' | 'engine'>,
  measurement: string = kind,
) {
  const engine = known?.engine ?? (kind === 'work' ? context.work.engine : context.actors.engines.get(agent)!);
  const { usualMs, slowMs } = context.record.measured.get(`${measurement}:${engine}`) ?? {
    usualMs: GUESS_MS,
    slowMs: GUESS_MS,
  };
  stages.push({
    key,
    kind,
    agent: known?.agent ?? agent,
    engine,
    usualMs,
    slowMs,
    after: [...after],
    ...(known ? { job: known.id } : {}),
  });
  return key;
}
