// Checks a ruling's reviewer finding sources before the coordinator accepts it.
import { db } from './db.ts';

type Ruling = { finding_sources?: unknown; blocking?: unknown; nonblocking?: unknown; pre_existing?: unknown };
type Report = { agent: string; output: string | null };

export function record(ruling: number, reports: { id: number }[]) {
  const insert = db.prepare('insert into ruling_reports (ruling, report) values (?, ?)');
  for (const report of reports) insert.run(ruling, report.id);
}

export function copy(before: number, ruling: number) {
  db.prepare('insert into ruling_reports (ruling, report) select ?, report from ruling_reports where ruling = ?').run(
    ruling,
    before,
  );
}

export function problem(verdict: Ruling, ruling: number) {
  if (verdict.finding_sources !== true) return undefined;
  const reports = db
    .prepare('select j.agent, j.output from ruling_reports r join jobs j on j.id = r.report where r.ruling = ?')
    .all(ruling) as Report[];
  const findings = new Map(reports.map(r => [r.agent, JSON.parse(r.output!).findings as unknown[]]));
  const named = new Set<string>();
  for (const field of ['blocking', 'nonblocking', 'pre_existing'] as const) {
    const entries = verdict[field];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) return `"${field}" must be an array`;
    for (const [index, entry] of entries.entries()) {
      const place = `${field}[${index}].from`;
      if (!object(entry) || !Array.isArray(entry.from)) return `${place} must be an array`;
      for (const source of entry.from) {
        if (!object(source)) return `${place} must name reviewer findings as {by, finding}`;
        const { by, finding } = source;
        if (typeof by !== 'string' || !findings.has(by)) return `${place} must name a panel reviewer`;
        const report = findings.get(by)!;
        if (
          typeof finding !== 'number' ||
          !Number.isInteger(finding) ||
          finding < 0 ||
          finding >= report.length ||
          !object(report[finding])
        )
          return `${place} must name an integer index of a finding in ${by}'s report`;
        const key = JSON.stringify([by, finding]);
        if (named.has(key)) return `${place} repeats ${by}'s finding ${finding}`;
        named.add(key);
      }
    }
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
