// STATUS.md's reading of the review findings (findings.ts): what became of each one that reached an author, per
// engine and per reviewer, and the pre-existing ones the project's follow-ups take. It reads rows only, so infra/report.sh
// can import it.

type Row = {
  day: string;
  pr: number;
  kind: string;
  file: string | null;
  line: number | null;
  issue: string;
  by: string;
  outcome: string | null;
  right: string | null;
};
type Reviewer = { agent: string; engine: string };
type Tally = {
  reached: number;
  fixed: number;
  not_fixed: number;
  wrong: number;
  stood: number;
  kept: number;
  open: number;
  noise: string;
};
const fresh = (): Tally => ({ reached: 0, fixed: 0, not_fixed: 0, wrong: 0, stood: 0, kept: 0, open: 0, noise: '' });
const NOT_NAMED = { agent: '(not named)', engine: '(not named)' };

// Per engine and per reviewer, the findings that reached an author and what became of them: fixed, not fixed (still
// open when the pull request ended), disputed and wrong (the author was right), disputed and stood (the reviewer was),
// kept on purpose, or not judged yet. Noise is the share of judged findings that were wrong or kept. A finding two
// reviewers made counts for each, and once for an engine. Then the confirmed pre-existing findings, newest first.
export function reading(rows: Row[]) {
  const engines = new Map<string, Tally>(),
    reviewers = new Map<string, Tally & { engine: string; pre_existing: number }>();
  const reviewerOf = (r: Reviewer) =>
    reviewers.get(r.agent) ?? reviewers.set(r.agent, { engine: r.engine, ...fresh(), pre_existing: 0 }).get(r.agent)!;
  const preExisting = [];
  for (const row of rows) {
    // a follow-up never reached the author (findings.ts record)
    if (row.kind === 'follow-up') continue;
    const by = reportersOf(row);
    if (row.kind === 'pre-existing') {
      for (const r of by) reviewerOf(r).pre_existing++;
      const place = `${row.file ?? ''}${row.line ? `:${row.line}` : ''}`;
      preExisting.push({ day: row.day, pr: row.pr, place, issue: row.issue, by: by.map(r => r.agent).join(', ') });
      continue;
    }
    for (const engine of new Set(by.map(r => r.engine)))
      count(engines.get(engine) ?? engines.set(engine, fresh()).get(engine)!, row);
    for (const r of by) count(reviewerOf(r), row);
  }
  for (const tally of [...engines.values(), ...reviewers.values()]) tally.noise = noiseOf(tally);
  return {
    engines: [...engines].map(([engine, tally]) => ({ engine, ...tally })),
    reviewers: [...reviewers].map(([agent, tally]) => ({ agent, ...tally })),
    preExisting: preExisting.sort((a, b) => b.day.localeCompare(a.day)),
  };
}

// `by` is the round's own record, written from the panel it knew
const reportersOf = (row: Row) => {
  const by = JSON.parse(row.by) as Reviewer[];
  return by.length ? by : [NOT_NAMED];
};
function count(tally: Tally, row: Row) {
  tally.reached++;
  if (row.outcome === 'fixed') tally.fixed++;
  else if (row.outcome === 'not fixed') tally.not_fixed++;
  else if (row.outcome === 'disputed') tally[row.right === 'author' ? 'wrong' : 'stood']++;
  else if (row.outcome === 'kept') tally.kept++;
  else tally.open++;
}
const noiseOf = (t: Tally) => {
  const judged = t.reached - t.open;
  return judged ? `${Math.round((100 * (t.wrong + t.kept)) / judged)}%` : '';
};
