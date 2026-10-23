// The trust rule in review (CODE_STYLE.md, "Errors"): a reviewer finds the case before it writes the finding, the round
// dismisses a finding that guards against what we trust or falls back, and STATUS.md counts how often that still happens.

// Where a finding's case comes from: outside input, our own systems (trusted), or no case at all (a rule, readability)
type Origin = 'outside' | 'ours' | 'none';
// What a finding's fix adds: nothing that handles a case, a check that stops with an error, one more try, or carrying on
// with a default or lesser result
type Guard = 'none' | 'fail' | 'retry' | 'fallback';
type Finding = {
  from?: Origin;
  hides?: unknown;
  guard?: Guard;
  file?: unknown;
  line?: unknown;
  case?: unknown;
  issue?: unknown;
};
type Dismissal = 'trust' | 'fallback';
type Report = { findings?: unknown };
type Verdict = { dismissed?: unknown; blocking?: unknown };

export const TRUST_RULE = `
Trust what's ours, fail loudly on what isn't (CODE_STYLE.md, "Errors"). The language and its runtime, the platform,
established libraries and our own code, data and config are trusted: a case only they could cause is no finding, and
neither is a guard against it. Checks belong where outside input comes in (a request or a form, a person's typing or
upload, a third party's reply, the network, a file or setting someone supplies, model output), and there the code stops
with an error rather than carry on half done. It recovers only where it really can: one more try of a network call,
fetching a record again by a unique key of ours. A fallback that makes a failure look like a result (a default, a
placeholder, a lesser output, a swallowed error) is the worst case and never a fix: code that adds one is a finding. A
problem in our own code is fixed where it is, never guarded against where it's used. The fix that adds a check often
adds more risk than the case it guards against.
Find before you report: a finding starts from its case, the concrete input or state that reaches the line and where it
comes from. Nothing found is a fine outcome.`;

// "also", "caused_by", the consolidator's "by" and "earlier", and weighed's preExisting
// The reviewer's finding, its fields in the order they're written: the case before the claim, its places once the claim
// is known (findings.ts: "also", "caused_by"), the severity last. "hides" says what the line does, apart from what the
// fix adds: a finding on code that carries on past a failure is the rule's own, whatever its fix's label.
export const FINDING = `{"file": "...", "line": 0,
     "case": "the concrete input or state that reaches this line, and where it comes from (for a finding with no case: the rule it breaks)",
     "from": "outside" | "ours" | "none", "hides": true | false, "outcome": "what goes wrong, as it would happen", "issue": "...",
     "also": [{"file": "...", "line": 0}], "caused_by": {"file": "...", "line": 0}, "fix": "...",
     "secret": true (only for a secret in code), "guard": "none" | "fail" | "retry" | "fallback", "severity": "blocking" | "nonblocking"}`;
export const FINDING_NOTES = `   "from": where the case comes from: "outside" (outside input, as above), "ours" (our own systems, the runtime, a
   library) or "none" (no case: style, a rule, something missing). "guard": what the fix adds: "none" when it corrects
   or removes code, "fail" a check that stops with an error, "retry" one more try, "fallback" carrying on with a default
   or a lesser result. "hides": true when the code at the line, as the change has it, carries on past a failure (a
   default, a placeholder, a skipped error, a catch that swallows more than its case). The round dismisses a guard whose
   case isn't from outside, and every fallback, unless the line hides a failure: that finding is the trust rule's own.`;

// The consolidator's lists: what it drops and why, and blocking findings that name the case first
export const DISMISSED_FIELD = `, "dismissed": [{"file": "...", "line": 0, "rule": "trust" | "unshown", "why": "..."}]`;
export const BLOCKING = `[{"file": "...", "line": 0, "case": "...", "issue": "...", "also": [{"file": "...", "line": 0}], "fix": "...",
  "secret": true (only for a secret in code), "by": ["reviewer id"], "from": [{"by": "reviewer id", "finding": 0}], "earlier": 0 (only for a finding of the previous ruling's), "rule": "trust" (only for the trust rule)}]`;
export const CONSOLIDATOR_TRUST = `
Hold every finding to the trust rule below. Check its case against the code: a guard against a case from our own
systems or one that can't happen, and any fix that falls back, you drop as "trust"; a finding you can't show concretely
as "unshown". List each drop in "dismissed". Hardening the change itself adds (a guard against our own systems, a check
for a case that can't happen, a fallback) is a blocking finding with "rule": "trust".${TRUST_RULE}`;
export const FIX_TRUST = `A fix that adds a guard against our own systems, a check for a case that can't happen, or a
fallback isn't a fix under the trust rule (CODE_STYLE.md, "Errors"): it's blocking, with "rule": "trust".`;
export const AUTHOR_TRUST = `Fix each finding where it is, the way CODE_STYLE.md's "Errors" asks: no check, retry or fallback the finding doesn't name.`;

// A reviewer's report as the consolidator reads it: the findings the round weighs, how many it dismissed, and apart
// from them the ones on code the change doesn't touch (`preExisting`: findings.ts)
export function weighed(
  agent: string,
  output: string | null,
  preExisting: (f: object | null) => boolean = () => false,
) {
  const read = findingsOf(output);
  if (!read) return `### ${agent}\n${output ?? '(no output)'}`;
  // Source indices belong to the original report, before either filter.
  const indexed = read.findings.map((f, finding) => f && { ...f, finding });
  const kept = indexed.filter(f => !dismissal(f)),
    dropped = read.findings.length - kept.length;
  const preExistingFindings = kept.filter(preExisting);
  const note = dropped
    ? `\n(The round dismissed ${dropped} more under the trust rule: a guard against a case not from outside, or a fallback.)`
    : '';
  const separated = preExistingFindings.length ? { pre_existing: preExistingFindings } : {};
  return `### ${agent}\n${JSON.stringify({ ...read.report, findings: kept.filter(f => !preExistingFindings.includes(f)), ...separated })}${note}`;
}

// ---- STATUS.md's reading (infra/report.sh)

type Row = {
  day: string;
  pr: number | null;
  agent: string;
  kind: 'review' | 'consolidate';
  engine: string;
  stage: string | null;
  output: string | null;
};
// One dismissal, to check by hand against its pull request's diff: the round's (the finding's labels and its case) and
// the consolidator's trust drops (its why)
type Dropped = {
  day: string;
  pr: number | null;
  by: string;
  rule: string;
  place: string;
  from: string;
  guard: string;
  case: string;
};
type ReviewDay = {
  day: string;
  engine: string;
  reviews: number;
  findings: number;
  labelled: number;
  guards: number;
  hides: number;
  trust: number;
  fallback: number;
};
type VerdictDay = {
  day: string;
  stage: string;
  verdicts: number;
  dismissed_trust: number;
  dismissed_unshown: number;
  blocking: number;
  blocking_hardening: number;
};
const entry = <T>(days: Map<string, T>, id: string, fresh: () => T) => days.get(id) ?? days.set(id, fresh()).get(id)!;
// a verdict is model output: an entry that isn't an object counts, with no rule
type Entry = { rule?: string; file?: unknown; line?: unknown; why?: unknown };
const listOf = (list: unknown) => (Array.isArray(list) ? (list as (Entry | null)[]).map(item => item ?? {}) : []);
const percent = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : '');
const text = (value: unknown) => (value == null ? '' : String(value));
const placeOf = (f: { file?: unknown; line?: unknown }) => (f.line ? `${text(f.file)}:${text(f.line)}` : text(f.file));

// Per day: the reviewers' findings by engine (labelled: carrying "guard"; hides: on a line that carries on past a
// failure, never dismissed; trust and fallback: dismissed by the round),
// and the consolidator's verdicts by stage (its own drops, and blocking findings against hardening the change or its
// fixes added). The total's share is of labelled findings: the round's dismissals and the consolidator's trust drops.
// Then each of those dismissals, newest first.
export function reading(rows: Row[]) {
  const reviews = new Map<string, ReviewDay>(),
    verdicts = new Map<string, VerdictDay>(),
    dropped: Dropped[] = [];
  for (const row of rows) {
    if (row.kind === 'review') countReview(reviews, row, dropped);
    else countVerdict(verdicts, row, dropped);
  }
  const days = [...reviews.values()],
    checks = [...verdicts.values()];
  const sum = <T>(list: T[], field: keyof T) => list.reduce((total, day) => total + (day[field] as number), 0);
  const labelled = sum(days, 'labelled'),
    byRound = sum(days, 'trust') + sum(days, 'fallback'),
    byConsolidator = sum(checks, 'dismissed_trust');
  const newestFirst = (a: { day: string }, b: { day: string }) => b.day.localeCompare(a.day);
  return {
    reviews: days.sort(newestFirst),
    verdicts: checks.sort(newestFirst),
    total: {
      labelled,
      dismissed_by_round: byRound,
      dismissed_by_consolidator: byConsolidator,
      overhardening_share: percent(byRound + byConsolidator, labelled),
    },
    dismissals: dropped.sort(newestFirst),
  };
}

function countReview(days: Map<string, ReviewDay>, row: Row, dropped: Dropped[]) {
  const read = findingsOf(row.output);
  if (!read) return;
  const day = entry(days, `${row.day} ${row.engine}`, () => ({
    day: row.day,
    engine: row.engine,
    reviews: 0,
    findings: 0,
    labelled: 0,
    guards: 0,
    hides: 0,
    trust: 0,
    fallback: 0,
  }));
  day.reviews++;
  for (const finding of read.findings) {
    day.findings++;
    if (!finding?.guard) continue;
    day.labelled++;
    if (finding.guard !== 'none') day.guards++;
    if (finding.hides === true) day.hides++;
    const rule = dismissal(finding);
    if (!rule) continue;
    day[rule]++;
    dropped.push({
      day: row.day,
      pr: row.pr,
      by: row.agent,
      rule,
      place: placeOf(finding),
      from: text(finding.from),
      guard: finding.guard,
      case: text(finding.case ?? finding.issue),
    });
  }
}

function countVerdict(days: Map<string, VerdictDay>, row: Row, dropped: Dropped[]) {
  let verdict: Verdict;
  try {
    verdict = JSON.parse(row.output ?? '') as Verdict;
  } catch {
    return;
  } // an unreadable verdict decided nothing
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) return; // as does one that isn't an object
  const stage = row.stage ?? 'ruling';
  const day = entry(days, `${row.day} ${stage}`, () => ({
    day: row.day,
    stage,
    verdicts: 0,
    dismissed_trust: 0,
    dismissed_unshown: 0,
    blocking: 0,
    blocking_hardening: 0,
  }));
  day.verdicts++;
  for (const drop of listOf(verdict.dismissed)) {
    if (drop.rule !== 'trust' && drop.rule !== 'unshown') continue;
    day[`dismissed_${drop.rule}`]++;
    if (drop.rule === 'trust')
      dropped.push({
        day: row.day,
        pr: row.pr,
        by: row.agent,
        rule: 'trust',
        place: placeOf(drop),
        from: '',
        guard: '',
        case: text(drop.why),
      });
  }
  for (const { rule } of listOf(verdict.blocking)) {
    day.blocking++;
    if (rule === 'trust') day.blocking_hardening++;
  }
}

// A check or a retry against a case labelled ours or none, and any fallback, is no finding; a finding with no label
// stays, as does one on a line that hides a failure
const dismissal = (f: Finding | null): Dismissal | null =>
  f?.hides === true
    ? null
    : f?.guard === 'fallback'
      ? 'fallback'
      : (f?.guard === 'fail' || f?.guard === 'retry') && (f.from === 'ours' || f.from === 'none')
        ? 'trust'
        : null;
const findingsOf = (output: string | null) => {
  let report: Report | null;
  try {
    report = JSON.parse(output ?? '') as Report | null;
  } catch {
    return null;
  } // a report that isn't JSON is no report (unreported)
  return report && Array.isArray(report.findings) ? { report, findings: report.findings as (Finding | null)[] } : null;
};
