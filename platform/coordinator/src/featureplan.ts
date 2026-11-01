// Feature membership, expected through-approval cost, and explicitly recorded board milestones.
import { featureGroups } from './featuregroups.ts';
import { readConfidence, type Confidence } from './confidence.ts';
import { db, redacted, redactedJson, columnsOf, once, inOneStep } from './db.ts';
import { ceo } from './company.ts';
import { inProcess } from './jobs.ts';
import { findThread, ownerOf } from './projects.ts';
import { readBudget } from './tokenbudget.ts';
import type { CostPhase } from './costspend.ts';

db.exec(`create table if not exists feature_rounds (
  thread text primary key, feature text not null, feedback integer not null, round text not null, by text not null, at text not null);
create table if not exists feature_estimates (
  id integer primary key, thread text not null, tokens text not null, seat_weeks real,
  feedback_rounds real not null, refs text not null, why text not null, by text not null, at text not null, confidence text);
create index if not exists feature_estimates_thread on feature_estimates(thread, id);
create table if not exists feature_milestones (
  thread text not null, milestone text not null, at text not null, evidence text not null, by text not null,
  primary key(thread, milestone))`);

once('2026-11-01-feature-confidence', () => {
  if (columnsOf('feature_estimates').includes('confidence')) return;
  db.exec('alter table feature_estimates add column confidence text');
});
redactedJson('feature_estimates', 'confidence');
redacted('feature_estimates', 'why');
redacted('feature_milestones', 'evidence');

export type ExpectedCost = {
  confidence?: Confidence | null;
  tokens: Record<CostPhase, number>;
  seat_weeks: number | null;
  feedback_rounds: number;
  refs: number[];
  why: string;
  by: string;
  at: string;
};
export const canonicalThread = (id: string) =>
  (db.prepare('select id from thread_aliases where old = ?').get(id) as { id: string } | undefined)?.id ?? id;

export function featurePlan() {
  const rounds = db.prepare('select thread, feature, feedback, round from feature_rounds').all() as {
    thread: string;
    feature: string;
    feedback: number;
    round: string;
  }[];
  const membership = new Map(
    featureGroups().map(row => [
      canonicalThread(row.thread),
      { feature: canonicalThread(row.feature), feedback: row.feedback, round: row.round },
    ]),
  );
  for (const [id, row] of new Map(
    rounds.map(row => [
      canonicalThread(row.thread),
      { feature: canonicalThread(row.feature), feedback: !!row.feedback, round: row.round },
    ]),
  ))
    membership.set(id, row);
  includeFollowups(membership);
  const estimates = db
    .prepare(
      `select e.* from feature_estimates e
    where id = (select max(id) from feature_estimates where thread = e.thread)`,
    )
    .all() as (Omit<ExpectedCost, 'tokens' | 'refs' | 'confidence'> & {
    thread: string;
    tokens: string;
    refs: string;
    confidence: string | null;
  })[];
  const expected = new Map(
    estimates.map(({ thread, tokens, refs, confidence, ...estimate }) => [
      canonicalThread(thread),
      {
        ...estimate,
        tokens: JSON.parse(tokens),
        refs: JSON.parse(refs),
        confidence: confidence ? JSON.parse(confidence) : null,
      } as ExpectedCost,
    ]),
  );
  const milestones = db.prepare('select thread, milestone, at from feature_milestones').all() as {
    thread: string;
    milestone: string;
    at: string;
  }[];
  return { membership, expected, milestones };
}

export function linkFeedback(thread: string, feature: string, by: string, round = '', feedback = true) {
  if (feedback && !round.trim()) return 'a feedback round needs its board label';
  const member = findThread(thread),
    root = findThread(feature);
  if (!member || !root) return 'both the feedback deliverable and its original feature must exist';
  const plan = featurePlan();
  const rootId = plan.membership.get(root.id)?.feature ?? root.id;
  const children = [...plan.membership].filter(([, child]) => child.feature === member.id);
  const affected = [
    member.id,
    plan.membership.get(member.id)?.feature ?? member.id,
    rootId,
    ...children.map(([id]) => id),
  ];
  if (affected.some(id => !mayRecord(id, by)))
    return denied('only the owners, CEO or Process can link these deliverables');
  if (rootId === member.id) return 'a feature cannot be its own feedback round';
  round = feedback ? round.trim() : '';
  const write = db.prepare(`insert into feature_rounds values (?, ?, ?, ?, ?, ?)
    on conflict(thread) do update set feature = excluded.feature, feedback = excluded.feedback, round = excluded.round, by = excluded.by, at = excluded.at`);
  const at = new Date().toISOString();
  inOneStep(() => {
    for (const [id, child] of children)
      write.run(id, rootId, feedback || child.feedback ? 1 : 0, feedback ? round : child.round, by, at);
    write.run(member.id, rootId, feedback ? 1 : 0, round, by, at);
  });
  return { thread: member.id, feature: rootId };
}

export function saveFeatureEstimate(thread: string, ask: unknown, by: string) {
  const found = findThread(thread);
  if (!found) return 'the deliverable does not exist';
  const root = featurePlan().membership.get(found.id)?.feature ?? found.id;
  if (!mayRecord(root, by)) return denied('only the owner, CEO or Process can record its expected cost');
  const estimate = readEstimate(ask);
  if (typeof estimate === 'string') return estimate;
  const at = new Date().toISOString();
  db.prepare(
    `insert into feature_estimates (thread, tokens, seat_weeks, feedback_rounds, refs, why, by, at, confidence)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    root,
    JSON.stringify(estimate.tokens),
    estimate.seat_weeks,
    estimate.feedback_rounds,
    JSON.stringify(estimate.refs),
    estimate.why,
    by,
    at,
    JSON.stringify(estimate.confidence),
  );
  return { ...estimate, by, at };
}

function readEstimate(ask: unknown) {
  if (!ask || typeof ask !== 'object') return 'expected cost must be a JSON object';
  const value = ask as Partial<ExpectedCost>;
  const budget = readBudget(ask);
  if (typeof budget === 'string') return budget;
  if (value.seat_weeks !== null && !nonnegative(value.seat_weeks))
    return 'seat_weeks must be nonnegative, or null when unmeasured';
  if (!Array.isArray(value.refs) || value.refs.some(id => !Number.isSafeInteger(id) || id <= 0))
    return 'refs must be past job numbers';
  if (typeof value.why !== 'string' || !value.why.trim())
    return 'why must explain the scope comparison, or why no past job fits';
  const confidence = readConfidence(value.confidence);
  if (typeof confidence === 'string') return confidence;
  return {
    ...budget,
    confidence,
    seat_weeks: value.seat_weeks!,
    refs: value.refs,
    why: value.why.trim(),
  };
}
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const mayRecord = (id: string, by: string) => by === ceo() || inProcess(by) || by === ownerOf(findThread(id)!);
const denied = (why: string): [number, string] => [403, why];

export function recordMilestone(thread: string, milestone: string, at: unknown, evidence: unknown, by: string) {
  const found = findThread(thread);
  if (!found) return 'the feature does not exist';
  const root = featurePlan().membership.get(found.id)?.feature ?? found.id;
  if (!mayRecord(root, by)) return denied('only the owner, CEO or Process can record a board milestone');
  if (!['delivered', 'approved'].includes(milestone)) return 'milestone must be delivered or approved';
  const instant = typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(instant) || !/[zZ]|[+-]\d\d:\d\d$/.test(String(at)) || instant > Date.now())
    return 'at must be a past ISO instant with a zone';
  if (typeof evidence !== 'string' || !evidence.trim()) return 'evidence must name the delivery or the board approval';
  const other = db
    .prepare('select at from feature_milestones where thread = ? and milestone = ?')
    .get(root, milestone === 'delivered' ? 'approved' : 'delivered') as { at: string } | undefined;
  if (other && (milestone === 'delivered' ? instant > Date.parse(other.at) : instant < Date.parse(other.at)))
    return 'approval cannot be before first delivery';
  db.prepare(
    `insert into feature_milestones values (?, ?, ?, ?, ?)
    on conflict(thread, milestone) do update set at = excluded.at, evidence = excluded.evidence, by = excluded.by`,
  ).run(root, milestone, new Date(instant).toISOString(), evidence.trim(), by);
  return { thread: root, milestone, at: new Date(instant).toISOString() };
}

export function moveFeature(from: string, to: string) {
  db.prepare('update feature_rounds set thread = ? where thread = ?').run(to, from);
  db.prepare('update feature_rounds set feature = ? where feature = ?').run(to, from);
  db.prepare('update feature_estimates set thread = ? where thread = ?').run(to, from);
  db.prepare('update feature_milestones set thread = ? where thread = ?').run(to, from);
}

type Membership = Map<string, { feature: string; feedback: boolean; round: string }>;
function includeFollowups(membership: Membership) {
  const rows = db
    .prepare(
      `select distinct j.thread, source.thread original from review_followup_jobs followup
    join jobs j on j.id = followup.job join findings f on f.id = followup.finding join prs p on p.number = f.pr
    join jobs source on coalesce(source.branch, 'job/' || source.id) = p.branch
    where j.thread is not null and source.thread is not null and source.kind = 'work'`,
    )
    .all() as { thread: string; original: string }[];
  for (const [thread, sources] of Map.groupBy(rows, row => row.thread)) {
    if (membership.has(thread)) continue;
    const roots = new Set(sources.map(source => membership.get(source.original)?.feature ?? source.original));
    if (roots.size !== 1) continue;
    const source = sources[0].original;
    membership.set(thread, membership.get(source) ?? { feature: source, feedback: false, round: '' });
  }
}
