// Feature and project costs sum each job once, with explicit feedback membership and shared review attribution.
import { KeptOwners } from './costowners.ts';
import { costPhase, phaseOf } from './taskphases.ts';
import { db } from './db.ts';
import { featurePlan } from './featureplan.ts';
import { emptyCost, addSpend, addCost, type Cost, jobSpends } from './costspend.ts';
import { bookOrder, costJobs, type CostJob } from './costjobs.ts';

export function featureCosts() {
  const book = costBook();
  return { report: (id: string) => featureReport(id, book), project: (id: string) => projectReport(id, book) };
}

// The book kept between calls: the jobs as last read (costjobs.ts), their
// owners, each thread's jobs, and each thread's sums with whether they were summed as feedback. A call sums again only
// the threads a changed job was or is owned by, so its cost no longer grows with every job ever run.
const kept = {
  jobs: [] as CostJob[],
  byId: new Map<number, CostJob>(),
  owners: new KeptOwners(),
  threadJobs: new Map<string, Set<number>>(),
  sums: new Map<string, { feedback: boolean; cost: Cost; rounds: Set<string> }>(),
};

type Book = ReturnType<typeof costBook>;
function costBook() {
  const plan = featurePlan();
  const threads = db.prepare('select id, project from threads').all() as { id: string; project: string }[];
  const changed = takeJobs(costJobs());
  const own = new Map<string, Cost>(),
    reviewRounds = new Map<string, Set<string>>();
  for (const { id } of threads) {
    const feedback = !!plan.membership.get(id)?.feedback;
    let sum = kept.sums.get(id);
    if (!sum || sum.feedback !== feedback || changed.has(id)) kept.sums.set(id, (sum = threadSum(id, feedback)));
    own.set(id, sum.cost);
    reviewRounds.set(id, sum.rounds);
  }
  const grouped = groupCosts(plan, own);
  return { plan, own, grouped, reviewRounds, ...lookups(plan, threads) };
}

// The server's start, once the jobs are read ahead (costjobs.ts): their owners taken in a slice of jobs at a time between
// the server's other work, in the order they came, then the book once, so the first view, thread or estimate after a
// start builds none of it (0.13 s at 26,600 jobs: a projects view's 0.66 s hold live, six minutes after a start). A
// book a request built meanwhile took every job in already: what's left of the slices goes.
const SLICE = 2_000;
export async function readCostBookAhead(slice = SLICE) {
  if (kept.jobs.length) return;
  const jobs = costJobs();
  for (let end = slice; end < jobs.length; end += slice) {
    const taken = jobs.slice(0, end);
    takeJobs(taken);
    await new Promise(resolve => setImmediate(resolve));
    if (kept.jobs !== taken) return;
  }
  costBook();
}

// The jobs read now taken into the kept book; returns the threads whose sums they change: those a changed job, or one
// whose owners it moved, was or is owned by. A row the pool read again is a new object; one it kept is the same.
function takeJobs(jobs: CostJob[]) {
  const threads = new Set<string>();
  if (jobs === kept.jobs) return threads;
  const changes: { before?: CostJob; after?: CostJob }[] = [];
  const now = new Map(jobs.map(job => [job.id, job]));
  for (const job of jobs)
    if (kept.byId.get(job.id) !== job) changes.push({ before: kept.byId.get(job.id), after: job });
  for (const job of kept.jobs) if (!now.has(job.id)) changes.push({ before: job });
  const had = kept.owners.update(changes);
  for (const { before, after } of changes)
    if (!had.has((before ?? after)!.id)) for (const part of kept.owners.of(after!.id)) threads.add(part.thread);
  for (const [id, owners] of had) {
    for (const part of owners ?? []) {
      threads.add(part.thread);
      kept.threadJobs.get(part.thread)?.delete(id);
    }
    for (const part of kept.owners.of(id)) {
      threads.add(part.thread);
      const members = kept.threadJobs.get(part.thread);
      if (members) members.add(id);
      else kept.threadJobs.set(part.thread, new Set([id]));
    }
  }
  kept.jobs = jobs;
  kept.byId = now;
  return threads;
}

// A thread's cost and review rounds, its jobs added in the book's order
function threadSum(thread: string, feedback: boolean) {
  const cost = emptyCost(),
    rounds = new Set<string>();
  for (const job of threadJobs([thread]))
    for (const part of kept.owners.of(job.id)) {
      if (part.thread !== thread) continue;
      const phase = feedback ? 'feedback' : costPhase(phaseOf(job));
      addSpend(cost.total, job.spend, part.share);
      addSpend(cost.split[phase], job.spend, part.share);
      if (!job.reported && job.ran) cost.missing_usage += part.share;
      if (job.kind === 'review' && job.pr !== null) rounds.add(`${job.pr}:${job.round}`);
    }
  // (kept for the next book and handed to every report: frozen, so no caller's change reaches the next)
  for (const spend of [cost.total, ...Object.values(cost.split)]) Object.freeze(spend);
  Object.freeze(cost.split);
  return { feedback, cost: Object.freeze(cost), rounds };
}
const threadJobs = (threads: string[]) =>
  [...new Set(threads.flatMap(thread => [...(kept.threadJobs.get(thread) ?? [])]))]
    .map(id => kept.byId.get(id)!)
    .sort(bookOrder);

// Each feature's members, each project's threads, the milestones and the threads' aliases, read once for the book's
// every report, not again per report
function lookups(plan: ReturnType<typeof featurePlan>, threads: { id: string; project: string }[]) {
  const aliases = new Map(
    (db.prepare('select old, id from thread_aliases').all() as { old: string; id: string }[]).map(row => [
      row.old,
      row.id,
    ]),
  );
  const canonical = (id: string) => aliases.get(id) ?? id;
  const featureOf = (thread: string) => plan.membership.get(thread)?.feature ?? thread;
  const milestones = new Map<string, string>();
  for (const row of plan.milestones) {
    const key = `${row.milestone} ${canonical(row.thread)}`;
    if (!milestones.has(key)) milestones.set(key, row.at);
  }
  const members = Map.groupBy(
    threads.map(thread => thread.id),
    featureOf,
  );
  const projects = Map.groupBy(threads, thread => thread.project);
  return { canonical, featureOf, members, projects, milestones, intervals: new Map<string, Cost>() };
}

function featureReport(id: string, book: Book) {
  id = book.canonical(id);
  const feature = book.featureOf(id);
  const { plan, own, grouped, reviewRounds } = book;
  const members = book.members.get(feature) ?? [];
  const milestone = (kind: string) => book.milestones.get(`${kind} ${feature}`) ?? null;
  const firstDelivery = milestone('delivered'),
    approved = milestone('approved');
  if (firstDelivery && !book.intervals.has(feature))
    book.intervals.set(
      feature,
      intervalCost(book, members, Date.parse(firstDelivery), approved ? Date.parse(approved) : Infinity),
    );
  return {
    feature,
    members,
    expected: plan.expected.get(feature) ?? null,
    used: grouped.get(feature) ?? emptyCost(),
    own: own.get(id) ?? emptyCost(),
    feedback_rounds: new Set(
      members.filter(member => plan.membership.get(member)?.feedback).map(member => plan.membership.get(member)!.round),
    ).size,
    review_rounds: new Set(members.flatMap(member => [...(reviewRounds.get(member) ?? [])])).size,
    first_delivery: firstDelivery,
    approved,
    after_delivery: book.intervals.get(feature) ?? null,
  };
}

function projectReport(id: string, book: Book) {
  const { grouped, plan } = book;
  const members = book.projects.get(id) ?? [];
  const roots = [...new Set(members.map(member => book.featureOf(member.id)))];
  const used = emptyCost();
  for (const root of roots) addCost(used, grouped.get(root)!);
  const expected = roots.flatMap(root => plan.expected.get(root) ?? []);
  return {
    used,
    expected_tokens: expected.reduce(
      (sum, estimate) => sum + Object.values(estimate.tokens).reduce((a, b) => a + b, 0),
      0,
    ),
    expected_seat_weeks:
      expected.length === roots.length && expected.every(estimate => estimate.seat_weeks !== null)
        ? expected.reduce((sum, estimate) => sum + estimate.seat_weeks!, 0)
        : null,
    missing_estimates: roots.length - expected.length,
    features: roots.length,
  };
}

// A feature's cost between its first delivery and its approval, over its members' jobs alone, not every job once per
// feature
function intervalCost(book: Book, members: string[], from: number, until: number) {
  const cost = emptyCost();
  const included = new Set(members);
  const jobs = threadJobs(members);
  const readSpend = jobSpends(jobs.map(job => job.id));
  for (const job of jobs) {
    const parts = kept.owners.of(job.id).filter(part => included.has(part.thread));
    const recorded = readSpend(job.id, from, until);
    for (const part of parts) {
      const phase = book.plan.membership.get(part.thread)?.feedback ? 'feedback' : costPhase(phaseOf(job));
      addSpend(cost.total, recorded.spend, part.share);
      addSpend(cost.split[phase], recorded.spend, part.share);
      if (!recorded.reported && recorded.ran) cost.missing_usage += part.share;
    }
  }
  return cost;
}

function groupCosts(plan: ReturnType<typeof featurePlan>, own: Map<string, Cost>) {
  const grouped = new Map<string, Cost>();
  for (const [thread, cost] of own) {
    const feature = plan.membership.get(thread)?.feature ?? thread;
    const total = grouped.get(feature) ?? emptyCost();
    addCost(total, cost);
    grouped.set(feature, total);
  }
  return grouped;
}
