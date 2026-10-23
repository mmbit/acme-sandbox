// How the estimates score against what happened (the coordinator's calibration.ts, backtest.ts and accuracy.ts): hq
// estimate --calibration, hq estimate --backtest [--save <file>], and --accuracy's thread matching.
import { writeFileSync } from 'node:fs';
import * as api from './api.ts';
import { duration, spreadWords, type Spread } from './estimate.ts';
import { plural, print } from './output.ts';

type Lead = {
  lead: string;
  count: number;
  no_merge: number;
  median_miss_minutes: number | null;
  late_share: number | null;
  held_share: number | null;
};
type Group = Spread & { key: string };
type Calibration = {
  days: number;
  sizes: { count: number; by_agent: Group[]; by_area: Group[]; by_sizer: Group[] };
  eta: Lead[];
};
type RoundScore = {
  size: string;
  count: number;
  no_merge: number;
  median_minutes: number | null;
  worst_minutes: number | null;
};
type Backtest = {
  days: number;
  version: number;
  snapshots: number;
  leads: Lead[];
  coverage: { planner_snapshots: number; legacy_snapshots: number };
  rounds: { small_up_to_minutes: number; groups: RoundScore[] };
};
export type ByThread = { jobs: number; usual: Spread; thread_first: Spread };

export async function calibration(days: URLSearchParams) {
  const c: Calibration = JSON.parse(
    await api.orStop(api.get(`estimate/calibration?${days}`), "Couldn't read the estimates."),
  );
  print(`How both layers missed over the last ${plural(c.days, 'day')}.`, '');
  print(`Sizes against the agent time each job took: ${plural(c.sizes.count, 'job')} with a size.`);
  const groups: [string, Group[]][] = [
    ['By agent', c.sizes.by_agent],
    ['By area (the folder its pull request changed most)', c.sizes.by_area],
    ['By sizer (haiku, the estimate tool, or the agent who set it)', c.sizes.by_sizer],
  ];
  for (const [title, list] of groups) {
    print(`  ${title}:`);
    for (const g of list) print(`    ${g.key}, ${plural(g.count, 'job')}: ${spreadWords(g)}`);
  }
  print('', "ETAs against the landings: the prediction log's row standing that long before each landing.");
  for (const lead of c.eta) print(leadLine(lead));
}

export async function backtest(days: URLSearchParams, save: string | undefined) {
  if (save !== undefined) {
    const saved = await api.orStop(api.get(`estimate/snapshots?${days}`), "Couldn't read the snapshots.");
    writeFileSync(save, saved);
    const { snapshots, landed } = JSON.parse(saved) as { snapshots: unknown[]; landed: unknown[] };
    return print(
      `Saved ${plural(snapshots.length, 'snapshot')} and ${plural(landed.length, 'landing')} to ${save}.`,
      `Score a play on it beside main's: node platform/coordinator/scripts/backtest.ts ${save}`,
    );
  }
  const b: Backtest = JSON.parse(await api.orStop(api.get(`estimate/backtest?${days}`), "Couldn't run the backtest."));
  print(
    `The play (version ${b.version}) replayed on ${plural(b.snapshots, 'snapshot')} of the last ${plural(b.days, 'day')}, against what landed:`,
  );
  for (const lead of b.leads) print(leadLine(lead));
  print(
    `Planner inputs: ${b.coverage.planner_snapshots}/${b.snapshots} snapshots; ${b.coverage.legacy_snapshots} legacy snapshots excluded.`,
  );
  print(`Windowed push-to-merge: small means own size up to ${b.rounds.small_up_to_minutes} min.`);
  for (const group of b.rounds.groups) print(roundLine(group));
}

function roundLine(group: RoundScore) {
  const measured =
    group.median_minutes === null
      ? 'no merged sample'
      : `median ${duration(group.median_minutes)}, worst ${duration(group.worst_minutes!)}`;
  return `  ${group.size}: ${group.count} jobs, ${measured}, ${group.no_merge} without a merge.`;
}

function leadLine(l: Lead) {
  if (!l.count) return `  ${l.lead} ahead: no work landed with a prediction then.`;
  const miss = l.median_miss_minutes === null ? 'none merged' : `the median miss ${duration(l.median_miss_minutes)}`;
  const late = l.late_share === null ? '' : `, ${percent(l.late_share)} later than said`;
  const held = l.held_share === null ? '' : `, ${percent(l.held_share)} by the time a promise holds to`;
  const none = l.no_merge ? ` (${l.no_merge} with no merge in sight)` : '';
  return `  ${l.lead} ahead: ${plural(l.count, 'job')}, ${miss}${late}${held}${none}.`;
}

export function byThread(b: ByThread) {
  if (!b.jobs) return print('  within the thread: no job done had 3 or more of its thread done before it');
  print(
    `  on the ${plural(b.jobs, 'job')} with 3 or more of its thread done before it:`,
    `    agent, kind and words (the mean): ${b.usual.count ? spreadWords(b.usual) : 'no size'}`,
    `    the same within its thread: ${b.thread_first.count ? spreadWords(b.thread_first) : 'no size'}`,
  );
}

const percent = (share: number) => `${Math.round(share * 100)}%`;
