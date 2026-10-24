// Review rounds become ordinary runs in the same plan as the work they review.
import { unloop } from './plancycles.ts';
import type { OrderingSnapshot, QueuedJob, Size } from './eta.ts';

export type ReviewStage = {
  key: string;
  job?: number;
  kind: 'review' | 'consolidate' | 'work';
  agent: string;
  engine: string;
  usualMs: number;
  slowMs: number;
  after: string[];
};
export type ReviewPlan = {
  panel: string;
  count: number;
  stages: ReviewStage[];
  terminal: string | null;
  unresolved?: boolean;
  resolutionAt?: number;
  resolutionAfter?: number;
  // why nothing resolves it until someone acts (reviewplan.ts)
  waiting?: string;
};

export function expand<T extends OrderingSnapshot>(
  snapshot: T,
  sizes: ReadonlyMap<number, Size>,
  pace: 'usual' | 'slow' = 'usual',
  keepLoops = false,
) {
  const rows = snapshot.jobs.map(row => ({
    ...row,
    reasons: [...row.reasons],
    dependencies: [...(row.dependencies ?? [])],
  }));
  const byId = new Map(rows.map(row => [row.id, row]));
  const expandedSizes = new Map(sizes),
    terminals = new Map<number, number>(),
    stages = new Map<number, number[]>(),
    sources = new Map<number, { owner: number; stage: string }>();
  let nextId = Math.min(0, ...rows.map(row => row.id)) - 1;
  let orderId = Math.max(0, ...rows.map(row => row.orderId ?? row.id));
  for (const owner of snapshot.jobs) {
    if (!owner.reviewPlan) continue;
    const stageIds = new Map(owner.reviewPlan.stages.map(stage => [stage.key, stage.job ?? nextId--]));
    stages.set(owner.id, [...stageIds.values()]);
    for (const stage of owner.reviewPlan.stages) {
      const id = stageIds.get(stage.key)!;
      const dependencies = stage.after.map(key => stageIds.get(key)!);
      if (stage.job === undefined) dependencies.push(owner.id);
      let row = byId.get(id);
      if (!row) {
        row = { ...synthetic(owner, stage, id), orderId: ++orderId };
        sources.set(id, { owner: owner.id, stage: stage.key });
        rows.push(row);
        byId.set(id, row);
        const pooledMs = pace === 'slow' ? stage.slowMs : stage.usualMs;
        expandedSizes.set(id, { agent_ms: pooledMs });
      }
      row.dependencies.push(...dependencies.filter(job => job !== id).map(job => ({ job, until: 'done' as const })));
    }
    let endpoint = owner.reviewPlan.terminal ? stageIds.get(owner.reviewPlan.terminal)! : null;
    if (endpoint === null && owner.reviewPlan.unresolved) {
      endpoint = nextId--;
      sources.set(endpoint, { owner: owner.id, stage: 'resolution' });
      rows.push(pendingResolution(owner, endpoint));
      expandedSizes.set(endpoint, { agent_ms: 0 });
    }
    if (endpoint !== null) mapTerminal(owner, endpoint, snapshot.jobs, terminals);
  }
  if (!keepLoops) unloop(rows, terminals);
  return { snapshot: { ...snapshot, jobs: rows }, sizes: expandedSizes, terminals, stages, sources };
}

function mapTerminal(owner: QueuedJob, terminal: number, jobs: QueuedJob[], terminals: Map<number, number>) {
  terminals.set(owner.id, terminal);
  const pr = owner.review?.pr ?? owner.pr;
  if (pr !== null)
    for (const row of jobs)
      if (row.kind === 'work' && (row.review?.pr ?? row.pr) === pr) terminals.set(row.id, terminal);
}

function pendingResolution(owner: QueuedJob, id: number) {
  const stage: ReviewStage = {
    key: 'resolution',
    kind: 'consolidate',
    agent: owner.agent,
    engine: owner.engine,
    usualMs: 0,
    slowMs: 0,
    after: [],
  };
  const pending = synthetic(owner, stage, id);
  pending.kind = 'resolution';
  pending.dependencies.push({ job: owner.id, until: 'done' });
  const { resolutionAt, resolutionAfter, waiting } = owner.reviewPlan!;
  if (resolutionAfter !== undefined) pending.dependencies.push({ job: resolutionAfter, until: 'done' });
  else if (resolutionAt !== undefined) pending.notBefore = resolutionAt;
  else pending.reasons.push({ on: 'stalled', why: waiting ?? 'Its pull request awaits resolution' });
  return pending;
}

function synthetic(
  owner: QueuedJob,
  stage: ReviewStage,
  id: number,
): QueuedJob & { dependencies: NonNullable<QueuedJob['dependencies']> } {
  return {
    ...owner,
    id,
    agent: stage.agent,
    engine: stage.engine,
    kind: stage.kind,
    title: `${owner.title}: ${stage.key}`,
    origin: stage.kind === 'work' ? 'fix' : owner.origin,
    status: 'queued',
    spentMs: 0,
    finished: null,
    seat: null,
    for_seat: null,
    board: 0,
    followThrough: false,
    after: 'released',
    follows: undefined,
    needs: undefined,
    waitsFor: [],
    cards: [],
    wakes: [],
    dependencies: [],
    review: null,
    reviewPlan: undefined,
    opensReview: false,
    reasons: owner.reasons.filter(reason => reason.on === 'stalled' || reason.on === 'board'),
  };
}
