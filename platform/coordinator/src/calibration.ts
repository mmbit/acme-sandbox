// hq estimate --calibration: both layers' misses over the work done lately. The sizes (the latest each job had, and who
// gave it) against the agent time the job took, by agent, by area and by sizer; and the ETAs the prediction log
// (predictionlog.ts) held an hour, six hours and a day before each landing against the landing.
import { pastJobs, type PastJob } from './matching.ts';
import { latestSizes } from './predictions.ts';
import { landings } from './landings.ts';
import * as predictionlog from './predictionlog.ts';
import { byLead, LEADS, type Sample } from './backtest.ts';
import { spread } from './accuracy.ts';

const DAY_MS = 24 * 60 * 60_000;

export function report(ask: { days?: unknown }, now = Date.now()) {
  const days = ask.days === undefined ? 7 : Number(ask.days);
  if (!Number.isInteger(days) || days < 1 || days > 30) return 400;
  const since = new Date(now - days * DAY_MS).toISOString();
  const done = pastJobs().filter(j => j.finished >= since);
  return { days, sizes: sizeMisses(done), eta: etaMisses(done.map(j => j.id)) };
}

// ---- layer 1: the sizes

function sizeMisses(done: PastJob[]) {
  const sizes = latestSizes();
  const sized = done.flatMap(j => {
    const size = sizes.get(j.id);
    return size && size.at <= j.finished ? [{ j, size }] : [];
  });
  const grouped = (keyOf: (s: (typeof sized)[number]) => string) => {
    const groups = new Map<string, [number, number][]>();
    for (const s of sized) groups.set(keyOf(s), [...(groups.get(keyOf(s)) ?? []), [s.size.agent_ms, s.j.agent_ms]]);
    return [...groups]
      .map(([key, pairs]) => ({ key, ...spread(pairs) }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  };
  return {
    count: sized.length,
    by_agent: grouped(s => s.j.agent),
    by_area: grouped(s => areaOf(s.j)),
    by_sizer: grouped(s => s.size.by),
  };
}

// The folder (its first two levels: platform/coordinator, products/carrel) the job's pull request changed most files
// in, the first by name of equals; work with no pull request is its own area.
export function areaOf(j: Pick<PastJob, 'pr' | 'files'>) {
  if (j.pr === null) return '(no pull request)';
  const counts = new Map<string, number>();
  for (const file of JSON.parse(j.files) as string[]) {
    const folder = file.split('/').slice(0, 2).join('/');
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  const [area] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? ['(no files)'];
  return area;
}

// ---- layer 2: the ETAs

// For each job that landed and each lead, the log's row standing that long before the landing (the last one written
// by then): a row stands until the next one moves it.
function etaMisses(jobs: number[]) {
  const landed = landings(jobs);
  const rows = predictionlog.ofJobs([...landed.keys()]);
  const samples: Sample[] = [];
  for (const { lead, ms } of LEADS)
    for (const [job, at] of landed) {
      const standing = rows.findLast(r => r.job === job && r.at <= at - ms);
      if (standing) samples.push({ lead, merged: standing.merged, held: standing.held, landed: at });
    }
  return byLead(samples);
}
