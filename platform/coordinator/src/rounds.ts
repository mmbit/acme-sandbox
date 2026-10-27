// Review rounds become ordinary runs in the same plan as the work they review.
import { unloop } from './plancycles.ts';
import type { OrderingSnapshot, QueuedJob, Size } from './eta.ts';

export type ReviewStage = {
  memoryMb?: number | null;
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
  const expansion = expandRows(snapshot, keepLoops);
  return { ...expansion, sizes: sized(expansion, sizes, pace) };
}

// The review stages as rows of their own, the same at every size and pace: a play expands its queue once for its order
// and both paces (simulation.ts playOrder), each taking the stages' sizes at its pace (sized).
export type Expansion<T extends OrderingSnapshot = OrderingSnapshot> = {
  snapshot: T;
  terminals: Map<number, number>;
  stages: Map<number, number[]>;
  sources: Map<number, { owner: number; stage: string }>;
  // each added row's pooled time at both paces, in the order they were added
  pooled: { id: number; usualMs: number; slowMs: number }[];
};
export function expandRows<T extends OrderingSnapshot>(snapshot: T, keepLoops = false): Expansion<T> {
  const rows = snapshot.jobs.map(row => ({
    ...row,
    reasons: [...row.reasons],
    dependencies: [...(row.dependencies ?? [])],
  }));
  const byId = new Map(rows.map(row => [row.id, row]));
  const terminals = new Map<number, number>(),
    stages = new Map<number, number[]>(),
    sources = new Map<number, { owner: number; stage: string }>(),
    pooled: Expansion['pooled'] = [];
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
        pooled.push({ id, usualMs: stage.usualMs, slowMs: stage.slowMs });
      }
      row.dependencies.push(...dependencies.filter(job => job !== id).map(job => ({ job, until: 'done' as const })));
    }
    let endpoint = owner.reviewPlan.terminal ? stageIds.get(owner.reviewPlan.terminal)! : null;
    if (endpoint === null && owner.reviewPlan.unresolved) {
      endpoint = nextId--;
      sources.set(endpoint, { owner: owner.id, stage: 'resolution' });
      rows.push(pendingResolution(owner, endpoint));
      pooled.push({ id: endpoint, usualMs: 0, slowMs: 0 });
    }
    if (endpoint !== null) mapTerminal(owner, endpoint, snapshot.jobs, terminals);
  }
  if (!keepLoops) unloop(rows, terminals);
  return { snapshot: { ...snapshot, jobs: rows }, terminals, stages, sources, pooled };
}

// The sizes of an expansion's rows at a pace: the jobs' own, and each added stage's pooled time.
export function sized(expansion: Expansion, sizes: ReadonlyMap<number, Size>, pace: 'usual' | 'slow') {
  const expanded = new Map(sizes);
  for (const { id, usualMs, slowMs } of expansion.pooled)
    expanded.set(id, { agent_ms: pace === 'slow' ? slowMs : usualMs });
  return expanded;
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
    memoryMb: stage.memoryMb ?? null,
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
    board: Number(owner.itemWork ?? false),
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
