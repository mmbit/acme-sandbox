// Feature and project costs sum each job once, with explicit feedback membership and shared review attribution.
import { assignments } from './costowners.ts';
import { costPhase, phaseOf } from './taskphases.ts';
import { db } from './db.ts';
import { workBranch } from './jobs.ts';
import { featurePlan } from './featureplan.ts';
import { emptyCost, addSpend, addCost, type Cost, jobSpends } from './costspend.ts';

export type CostJob = {
  id: number;
  thread: string | null;
  branch: string;
  kind: string;
  stage: string | null;
  pr: number | null;
  round: number | null;
  fix: number;
  preview: number;
};
export function featureCosts() {
  const book = costBook();
  return { report: (id: string) => featureReport(id, book), project: (id: string) => projectReport(id, book) };
}

type Book = ReturnType<typeof costBook>;
function costBook() {
  const plan = featurePlan();
  const threads = db.prepare('select id, project from threads').all() as { id: string; project: string }[];
  const jobs = costJobs();
  const assigned = assignments(jobs);
  const readSpend = jobSpends();
  const own = new Map(threads.map(thread => [thread.id, emptyCost()]));
  const reviewRounds = new Map<string, Set<string>>();
  for (const job of jobs)
    for (const assignment of assigned.get(job.id) ?? []) {
      const cost = own.get(assignment.thread);
      if (!cost) continue;
      const phase = plan.membership.get(assignment.thread)?.feedback ? 'feedback' : costPhase(phaseOf(job));
      const recorded = readSpend(job.id);
      addSpend(cost.total, recorded.spend, assignment.share);
      addSpend(cost.split[phase], recorded.spend, assignment.share);
      if (!recorded.reported && recorded.ran) cost.missing_usage += assignment.share;
      if (job.kind === 'review' && job.pr !== null) {
        const rounds = reviewRounds.get(assignment.thread) ?? new Set<string>();
        rounds.add(`${job.pr}:${job.round}`);
        reviewRounds.set(assignment.thread, rounds);
      }
    }
  const grouped = groupCosts(plan, own);
  return { plan, threads, own, grouped, reviewRounds, jobs, assigned, readSpend, ...lookups(plan, threads) };
}

// Every job with what its cost's phase and owner need. jobs_play (db.ts) covers these columns, so the scan reads no
// job's brief or report pages. The previews' branches and the fixes are read once each and looked up per job: a
// subquery per job would read them again for every job
function costJobs(): CostJob[] {
  const previews = new Set(
    (
      db.prepare(`select ${workBranch('card')} branch from card_jobs c join jobs card on card.id = c.job`).all() as {
        branch: string;
      }[]
    ).map(row => row.branch),
  );
  const fixes = new Set(
    (
      db.prepare('select job from review_fix_tasks union select job from review_followup_jobs').all() as {
        job: number;
      }[]
    ).map(row => row.job),
  );
  return (
    db
      .prepare(
        `select j.id, j.thread, ${workBranch('j')} branch, j.kind, j.stage, j.pr, j.round from jobs j indexed by jobs_play`,
      )
      .all() as Omit<CostJob, 'preview' | 'fix'>[]
  ).map(job => ({ ...job, preview: previews.has(job.branch) ? 1 : 0, fix: fixes.has(job.id) ? 1 : 0 }));
}

// Each feature's members, its milestones and the threads' aliases, read once for the book's every report, not again
// per report
function lookups(plan: ReturnType<typeof featurePlan>, threads: { id: string }[]) {
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
  return { canonical, featureOf, members, milestones, intervals: new Map<string, Cost>() };
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
  const { threads, grouped, plan } = book;
  const members = threads.filter(thread => thread.project === id);
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

function intervalCost(book: Book, members: string[], from: number, until: number) {
  const cost = emptyCost();
  const included = new Set(members);
  for (const job of book.jobs) {
    const parts = (book.assigned.get(job.id) ?? []).filter(part => included.has(part.thread));
    if (!parts.length) continue;
    const recorded = book.readSpend(job.id, from, until);
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
