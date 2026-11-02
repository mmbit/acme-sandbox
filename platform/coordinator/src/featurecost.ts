// Feature and project costs sum each job once, with explicit feedback membership and shared review attribution.
import { assignments } from './costowners.ts';
import { costPhase, phaseOf } from './taskphases.ts';
import { db } from './db.ts';
import { workBranch } from './jobs.ts';
import { featurePlan, canonicalThread } from './featureplan.ts';
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
  // jobs_play (db.ts) covers these columns, so the scan reads no job's brief or report pages
  const jobs = db
    .prepare(
      `select j.id, j.thread, ${workBranch('j')} branch, j.kind, j.stage, j.pr, j.round,
    exists(select 1 from card_jobs c join jobs card on card.id = c.job where ${workBranch('card')} = ${workBranch('j')}) preview,
    exists(select 1 from review_fix_tasks f where f.job = j.id union select 1 from review_followup_jobs f where f.job = j.id) fix
    from jobs j indexed by jobs_play`,
    )
    .all() as CostJob[];
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
  return { plan, threads, own, grouped, reviewRounds, jobs, assigned, readSpend, intervals: new Map<string, Cost>() };
}

const featureOf = (thread: string, book: Book) => book.plan.membership.get(thread)?.feature ?? thread;
function featureReport(id: string, book: Book) {
  id = canonicalThread(id);
  const feature = featureOf(id, book);
  const { plan, threads, own, grouped, reviewRounds } = book;
  const members = threads.filter(thread => featureOf(thread.id, book) === feature).map(thread => thread.id);
  const milestone = (kind: string) =>
    plan.milestones.find(row => canonicalThread(row.thread) === feature && row.milestone === kind)?.at ?? null;
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
  const roots = [...new Set(members.map(member => featureOf(member.id, book)))];
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
