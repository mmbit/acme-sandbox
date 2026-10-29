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
type Minutes = { total: number; median: number | null };
type Threads = {
  count: number;
  one_agent: number;
  tasks: number;
  pull_requests: number;
  rounds: number;
  review_runs: number;
  work: Minutes;
  review: Minutes;
  waiting: Minutes;
  review_share: number | null;
  waiting_share: number | null;
  handoffs: { count: number; review: Minutes; start: Minutes };
  waiting_split: Record<WaitPart, { minutes: number; share: number | null }>;
  line_split: Record<'line' | 'line_review', Record<LineHold, { minutes: number; share: number | null }>>;
  side_by_side: Record<'held' | 'apart' | 'shared_files' | 'one_pr' | 'unknown', Minutes & { count: number }>;
};
type WaitPart = 'line' | 'line_review' | 'order' | 'after' | 'card_or_time' | 'fix_drawn' | 'other';
// What each part of the threads' waiting is, in the words the split prints (the coordinator's threadwaits.ts)
const WAIT_WORDS: Record<WaitPart, string> = {
  line: 'in line for a start (the machine)',
  line_review: 'only review steps in that line',
  order: 'held for the task before (deliverables in order)',
  after: "another branch's job, its review and merge",
  card_or_time: 'a card, a time or an event',
  fix_drawn: 'a fix still to be drawn',
  other: 'nothing queued otherwise',
};
// What stood in the way of the line's ready jobs (threadwaits.ts lineHolds), each a share of its line
type LineHold = 'seats' | 'memory' | 'slots' | 'unrecorded';
const LINE_WORDS: Record<LineHold, string> = {
  seats: 'no ready seat for its engine (draining, a limit, a paced week)',
  memory: 'the worker short of memory',
  slots: 'every slot taken',
  unrecorded: 'before seats and memory were recorded',
};
type Calibration = {
  days: number;
  sizes: {
    count: number;
    by_agent: Group[];
    by_area: Group[];
    by_sizer: Group[];
    by_queue: Group[];
    given_sizes: Spread;
    given_sizes_corrected: Spread;
  };
  eta: Lead[];
  threads: Threads;
};
const QUEUED_HOW: Record<string, string> = {
  call: 'a board call',
  meeting: 'a meeting',
  inbox: 'an accepted proposal',
  hq: "HQ's own",
  agent: "an agent's hq job",
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
    ['By how it was queued', c.sizes.by_queue.map(g => ({ ...g, key: QUEUED_HOW[g.key] }))],
  ];
  for (const [title, list] of groups) {
    print(`  ${title}:`);
    for (const g of list) print(`    ${g.key}, ${plural(g.count, 'job')}: ${spreadWords(g)}`);
  }
  const { given_sizes: given, given_sizes_corrected: corrected } = c.sizes;
  print(
    `  Sizes given by agents and models, as given: ${given.count ? `${plural(given.count, 'job')}, ${spreadWords(given)}` : 'none.'}`,
    `    the same, as the play now counts them: ${corrected.count ? spreadWords(corrected) : 'none.'}`,
  );
  print('', "ETAs against the landings: the prediction log's row standing that long before each landing.");
  for (const lead of c.eta) print(leadLine(lead));
  threads(c.threads);
}

function threads(t: Threads) {
  print('', 'Deliverables: the pull requests merged in the window, by their deliverable.');
  if (!t.count) return print('  none merged.');
  const each = (n: number, of: number) => Math.round((n / of) * 10) / 10;
  print(
    `  ${plural(t.count, 'deliverable')}: ${t.one_agent} with one agent, ${t.count - t.one_agent} with two or more; ` +
      `${plural(each(t.tasks, t.count), 'task')} and ${plural(each(t.pull_requests, t.count), 'pull request')} a deliverable, ` +
      `${plural(each(t.rounds, t.pull_requests), 'review round')} a pull request (${plural(t.review_runs, 'review run')}).`,
    `  From the first task queued to the last merge: work ${minutesWords(t.work, 'deliverable')}, review ${minutesWords(t.review, 'deliverable')}, ` +
      `waiting ${minutesWords(t.waiting, 'deliverable')}; review ${percent(t.review_share ?? 0)} and waiting ` +
      `${percent(t.waiting_share ?? 0)} of all deliverable time.`,
  );
  const h = t.handoffs;
  if (!h.count) print("  Hand-offs (a task queued --after another branch's job): none.");
  else
    print(
      `  Hand-offs (a task queued --after another branch's job): ${h.count}, waiting for that job's review and merge ` +
        `${minutesWords(h.review, 'hand-off')}, then for their start ${minutesWords(h.start, 'hand-off')}.`,
    );
  waitingSplit(t);
}

function waitingSplit(t: Threads) {
  const parts = Object.entries(t.waiting_split) as [WaitPart, { minutes: number; share: number | null }][];
  print('  The waiting, by what held the deliverable (a minute two held counts for the first):');
  for (const [part, { minutes, share }] of parts) {
    print(`    ${WAIT_WORDS[part]}: ${duration(minutes)}${share === null ? '' : ` (${percent(share)})`}`);
    const split = part === 'line' || part === 'line_review' ? Object.entries(t.line_split[part]) : [];
    const held = (split as [LineHold, { minutes: number; share: number | null }][]).filter(([, h]) => h.minutes);
    if (held.length)
      print(
        `      of it: ${held.map(([h, m]) => `${LINE_WORDS[h]} ${duration(m.minutes)} (${percent(m.share ?? 0)})`).join('; ')}`,
      );
  }
  const s = t.side_by_side;
  if (!s.held.count) return print('  Tasks held for another job (side by side?): none.');
  const each = (n: Minutes & { count: number }) => `${plural(n.count, 'task')}, ${minutesWords(n, 'task')}`;
  print(
    `  Tasks held for another job: ${each(s.held)}. Of them, no file shared with the job they waited for (could have ` +
      `run side by side): ${each(s.apart)}; files shared: ${each(s.shared_files)}; on the same pull request as that job: ` +
      `${each(s.one_pr)}; not known: ${each(s.unknown)}.`,
  );
}

const minutesWords = (m: Minutes, each: string) =>
  `${duration(m.total)} in all${m.median === null ? '' : ` (the median ${each} ${duration(m.median)})`}`;

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
  if (!b.jobs) return print('  within the deliverable: no job done had 3 or more of its deliverable done before it');
  print(
    `  on the ${plural(b.jobs, 'job')} with 3 or more of its deliverable done before it:`,
    `    agent, kind and words (the mean): ${b.usual.count ? spreadWords(b.usual) : 'no size'}`,
    `    the same within its deliverable: ${b.thread_first.count ? spreadWords(b.thread_first) : 'no size'}`,
  );
}

const percent = (share: number) => `${Math.round(share * 100)}%`;
