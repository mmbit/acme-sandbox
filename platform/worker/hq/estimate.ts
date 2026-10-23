// Sizing work (the coordinator's estimates.ts): its agent time (a queued job's with its ETA), the past jobs like it that
// come from, and what the seats have left of their week; or how well past estimates held (--accuracy). When new work
// could be done is hq when's (when.ts).
import * as api from './api.ts';
import { changeLines } from './deadlines.ts';
import { minute, plural, print, stop } from './output.ts';
import * as scoring from './scoring.ts';
import { duration, waitWords as wordsOf, type Wait } from './waits.ts';

export { duration, type Wait };

// (set's help: its own agent too)
export const estimate = {
  help: `
   hq estimate ["what the work is" | '#<job>'] [--agent <id>] [--path <folder/>] [--limit n]
                                                     size work on done jobs like it: the same agent's (--agent, else
                                                     anyone's) and kind, by their titles' words: its agent time (when it
                                                     could be done: hq when). A queued job (#n): its own estimate, its
                                                     ETA now and what it waits on. Then each done job compared
                                                     against, or an agent's or a folder's latest (no words): each one's
                                                     agent time (an AI hour is one agent working for an hour, from each
                                                     start to its end: a wait that ends the run, for a seat, a deploy or a
                                                     card filed with hq request, is left out; an hq wait is not),
                                                     its seat spend and size, then the seats' headroom (each week's share
                                                     left, when it resets, the pace it goes at). Give the board the
                                                     agent hours, and a time that counts the seats: work that won't fit
                                                     before they run out waits for the reset. A job marked as waiting on
                                                     tools (renders, test suites) took hours that cost the seats little
   hq estimate --accuracy [--days n]                 how well the estimates held over the last n days (7): agent time and
                                                     ETA against what happened, the worst misses and what moved, and
                                                     the matching tried again on the work done since, beside simpler ways,
                                                     and the matching within a thread beside HQ's
   hq estimate --calibration [--days n]              both layers' misses over the last n days (7): sizes against the
                                                     agent time taken by agent, area and sizer; ETAs against the
                                                     landings an hour, six hours and a day ahead (the prediction log)
   hq estimate --backtest [--days n] [--save <file>] the play replayed on the hourly snapshots of the last n days (7),
                                                     scored an hour, six hours and a day ahead, and how often the slow
                                                     time held. --save writes the snapshots with what landed, for
                                                     platform/coordinator/scripts/backtest.ts to score a branch's play
                                                     beside main's
   hq estimate set <job> <time> ["why"]              re-size a queued or running job: its agent time (90m, 2h, 1h30m)
                                                     replaces the size the sizer or the tool gave it, and the threads
                                                     whose ETA moved are named with their new time. The CEO, whoever
                                                     queued the job, its thread's owner, or its own agent once the work
                                                     outgrows its brief`,

  async run(given: string[]) {
    if (given[0] === 'set') return setSize(given.slice(1));
    const { words, flags } = takeFlags(given);
    const scored = new URLSearchParams(flags.days ? { days: flags.days } : {});
    if ('calibration' in flags) return scoring.calibration(scored);
    if ('backtest' in flags) return scoring.backtest(scored, flags.save);
    if ('accuracy' in flags)
      return printAccuracy(
        JSON.parse(await api.orStop(api.get(`estimate/accuracy?${scored}`), "Couldn't read the estimates.")),
      );
    const query = new URLSearchParams({ q: words, ...flags });
    const found: Found = JSON.parse(await api.orStop(api.get(`estimate?${query}`), "Couldn't read past jobs."));
    if (found.estimate) printEstimate(found, words);
    if (words || flags.agent || flags.path) printJobs(found, words);
    printSeats(found.seats);
  },
};

function takeFlags(given: string[]) {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < given.length; i++) {
    const name = given[i].match(/^--(agent|path|limit|days|save)$/)?.[1];
    const mode = given[i].match(/^--(accuracy|calibration|backtest)$/)?.[1];
    if (mode) flags[mode] = '';
    else if (!name) rest.push(given[i]);
    else if (!given[i + 1]) stop(`usage: --${name} needs a value`);
    else flags[name] = given[++i];
  }
  if (rest.length > 1)
    stop('usage: hq estimate ["what the work is" | \'#<job>\'] [--agent <id>] [--path <folder/>] [--limit n]');
  return { words: rest[0] ?? '', flags };
}

// ---- estimate types

type Job = {
  id: number;
  agent: string;
  title: string;
  finished: string;
  agent_minutes: number;
  wall_minutes: number | null;
  runs: number;
  rebuilt: boolean;
  spend: number | null;
  unit: string;
  files: number;
  pr: { number: number; status: string; merged_at: string | null } | null;
  tool_bound: boolean;
};
type Typical = { agent_minutes: number; low: number; high: number; spend: number | null; unit: string | null };
type Seat = {
  id: string;
  engine: string;
  state: string;
  five_hour: number | null;
  five_hour_resets: number | null;
  five_hour_per_hour: number | null;
  week_per_hour: number | null;
  week: number | null;
  week_resets: number | null;
};
type Engine = {
  engine: string;
  left_percent: number;
  measured_seats: number;
  unmeasured_seats: number;
  next_reset: number | null;
};
export type Basis = { kind: string | null; agent: string | null; words: string[]; entry?: string; routine?: string };
type Outlook = {
  unpricedSeats?: string[];
  start: number | null;
  done: number | null;
  merged: number | null;
  left_minutes: number;
  waits: Wait[];
  cards?: { request: number; at: number }[];
  held?: number | null;
};
type Found = {
  job?: Job;
  jobs: Job[];
  typical: Typical | null;
  estimate?: { agent_minutes: number; compared: number; basis: Basis; guessed: boolean };
  outlook?: Outlook | null;
  sizes?: Sized[];
  seats: { seats: Seat[]; engines: Engine[] };
};
type Sized = {
  by: string;
  at: string;
  agent_minutes: number;
  low_minutes: number | null;
  high_minutes: number | null;
  refs: number[];
  why: string;
};

// ---- estimates

// Own agent time, its measurement basis, and the plan's merge time.
function printEstimate({ estimate, outlook, sizes }: Found, words: string) {
  const e = estimate!;
  const on = e.guessed
    ? 'a first guess: too few done jobs to compare against'
    : `the mean of ${comparedWords(e.compared, e.basis)}`;
  print(`The estimate: ${duration(e.agent_minutes)} of agent time (${on}).`);
  const resized = sizes?.filter(s => s.by !== 'tool') ?? [];
  if (resized.length) print(sizedLine(resized[0], resized.length - 1));
  if (outlook) print(outlookLine(outlook, words));
  print('');
}

// The size that counts, when the sizer or an agent gave one after the tool.
function sizedLine(s: Sized, earlier: number) {
  const range =
    s.low_minutes !== null && s.high_minutes !== null
      ? ` (${duration(s.low_minutes)} to ${duration(s.high_minutes)})`
      : '';
  const on = s.refs.length ? `, on ${s.refs.map(id => `#${id}`).join(', ')}` : '';
  const why = s.why ? `: ${s.why}` : '';
  const before = earlier ? ` (${plural(earlier, 'earlier size')} kept)` : '';
  return `Sized since: ${duration(s.agent_minutes)} of agent time${range} by ${s.by}, ${minute(s.at)} UTC${on}${why}. The ETA plays on it${before}.`;
}

// What the mean stood on: done jobs like it, or a scheduled job's earlier runs.
export const comparedWords = (n: number, b: Basis) =>
  b.entry
    ? `${plural(n, 'earlier run')} of this entry (${b.entry})`
    : b.routine
      ? `${plural(n, 'earlier run')} of the ${b.routine} routine's entries`
      : `${plural(n, 'done job')} like it: ${basisWords(b)}`;

const basisWords = (b: Basis) =>
  b.entry
    ? `this entry's earlier runs (${b.entry})`
    : b.routine
      ? `earlier runs of the ${b.routine} routine's entries`
      : [
          b.agent ? `${b.agent}'s` : "anyone's",
          b.kind ? `${b.kind} jobs` : 'jobs of any kind',
          b.words.length ? `by the words ${b.words.map(w => `"${w}"`).join(', ')}` : 'the latest',
        ].join(', ');

function outlookLine(o: Outlook, words: string) {
  const who = `${words} now`;
  const left = `${duration(o.left_minutes)} of agent time left; `;
  const later = o.start !== null && o.start > Date.now() + 60_000;
  const start = later ? `it starts about ${at(o.start!)}, and ` : '';
  const held =
    o.held && o.held > (o.merged ?? 0) ? ` (by ${at(o.held)} four times in five: the time a promise holds to)` : '';
  const merged = o.merged === null ? 'no merge in sight' : `is merged about ${at(o.merged)}${held}`;
  const waits = o.waits.length ? ` Waits on: ${o.waits.map(waitWords).join('; ')}.` : '';
  const cards = o.cards?.length
    ? ` It counts on the board answering ${o.cards.map(c => `card #${c.request} by ${at(c.at)}`).join(' and ')}, as it usually does.`
    : '';
  const basis = o.unpricedSeats?.length
    ? ` Seat fill rates are not measured yet for ${o.unpricedSeats.join(', ')}.`
    : '';
  return `${who}: ${left}${start}${merged}.${waits}${cards}${basis}`;
}

export const waitWords = (w: Wait) => wordsOf(w, at);

function printJobs({ job, jobs, typical }: Found, words: string) {
  if (job) print(`Job #${job.id} itself:`, ...jobLines(job), '');
  if (!jobs.length) return print('No done job like it.', '');
  print(
    `Done jobs like ${words ? `"${words}"` : 'that'}, best match first. Agent time is the agent working, from each start to its end;`,
    'waits that end a run (a seat, a deploy, a card filed with hq request) are left out, an hq wait is not (≈: runs rebuilt from older records).',
  );
  for (const j of jobs) print(...jobLines(j));
  if (typical) {
    const spend = typical.spend === null ? '' : `, ${spendText(typical.spend, typical.unit!)} of seat spend`;
    print(
      `Typical of these: ${duration(typical.agent_minutes)} of agent time (the middle half ${duration(typical.low)} to ${duration(typical.high)})${spend}.`,
    );
  }
  print('');
}

function jobLines(j: Job) {
  const wall = j.wall_minutes === null ? '' : `, ${duration(j.wall_minutes)} from its first start to its end`;
  const pr = j.pr
    ? `, ${j.files} files changed, PR #${j.pr.number} ${j.pr.merged_at ? `merged ${minute(j.pr.merged_at)} UTC` : j.pr.status}`
    : ', no pull request';
  const spent = j.spend === null ? 'seat spend not reported' : `${spendText(j.spend, j.unit)} of seat spend`;
  const lines = [
    `#${j.id} ${j.agent}, done ${minute(j.finished)} UTC: ${j.title}`,
    `  ${j.rebuilt ? '≈' : ''}${duration(j.agent_minutes)} of agent time in ${plural(j.runs, 'run')}${wall}; ${spent}${pr}`,
  ];
  if (j.tool_bound)
    lines.push('  Mostly waiting on tools that use no tokens (renders, test suites): its hours cost the seats little.');
  return lines;
}

// ---- seats

function printSeats({ seats, engines }: Found['seats']) {
  print('The seats now (the week, then the 5-hour window):');
  for (const s of seats) print(`  ${s.id} (${s.engine}, ${s.state}): ${seatLine(s)}`);
  for (const e of engines) print(engineLine(e));
}

function seatLine(s: Seat) {
  if (s.week === null) return 'no reading yet';
  const week = `${Math.round(s.week * 100)}% of its week used${s.week_resets ? `, resets ${at(s.week_resets)}` : ''}`;
  const window =
    s.five_hour === null
      ? ''
      : `; 5-hour window ${Math.round(s.five_hour * 100)}%${s.five_hour_resets ? `, resets ${at(s.five_hour_resets)}` : ''}`;
  const rates = [
    [s.week_per_hour, 'week'],
    [s.five_hour_per_hour, '5-hour window'],
  ] as const;
  const measured = rates
    .filter(([rate]) => rate !== null)
    .map(([rate, name]) => `${(rate! * 100).toFixed(1)}% of its ${name} per agent-hour`);
  return week + window + (measured.length ? `. Measured: ${measured.join(', ')}` : '');
}

// Weekly headroom across seats with readings.
function engineLine(e: Engine) {
  // A seat back from a restart or a limit has no reading until it runs again: what it has left isn't known, so the
  // seats may last longer than said.
  const unread = e.unmeasured_seats
    ? ` (${e.unmeasured_seats} more without one yet, back from a restart or a limit)`
    : '';
  if (!e.measured_seats)
    return `${e.engine}: none of its ${plural(e.unmeasured_seats, 'seat')} has a reading yet (back from a restart or a limit), so what's left isn't known.`;
  const left = `${e.left_percent}% of one seat's week left on ${plural(e.measured_seats, 'seat')} with a reading${unread}`;
  const reset = e.next_reset ? `, the first weekly reset ${at(e.next_reset)}` : '';
  return `${e.engine}: ${left}${reset}.`;
}

export const at = (ms: number) =>
  new Date(ms).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }) + ' UTC';

const spendText = (amount: number, unit: string) =>
  unit === '$' ? `$${amount.toFixed(2)}` : `${Math.round(amount).toLocaleString('en-GB')} tokens`;

// ---- queue changes

// hq estimate set: the job's new size, and what it moved.
async function setSize([target, time, why = '', ...rest]: string[]) {
  const job = /^#?([0-9]+)$/.exec(target ?? '')?.[1];
  if (!job || !time || rest.length) stop('usage: hq estimate set <job> <time: 90m, 2h, 1h30m> ["why"]');
  const answer = await api.call('sizes', { body: api.withSpeaker({ job: Number(job), time, why }) });
  const set = api.parseOrNull(answer.body);
  if (set?.ok !== true) stop(`Couldn't re-size #${job}: ${api.errorIn(answer.body, 'no answer')}`);
  print(`Job #${job} is sized at ${duration(set.size.agent_ms / 60_000)} of agent time now.`);
  if (set.moves) print(...changeLines(set, 'the new size'));
}

// ---- accuracy

export type Spread = {
  count: number;
  median_factor: number | null;
  within_twice: number | null;
  sum_ratio: number | null;
};
type Named = { id: number; agent: string; title: string };
type Accuracy = {
  days: number;
  agent_time: Spread & {
    worst: (Named & { predicted_minutes: number; actual_minutes: number; basis: Basis; picks: number[] })[];
  };
  eta: {
    count: number;
    median_miss_minutes: number | null;
    late_share: number | null;
    worst: (Named & { eta: number; landed: number; late_minutes: number; moved: Moved })[];
  };
  matching: (Spread & { way: string })[];
  matching_by_thread?: scoring.ByThread;
  matching_by_schedule?: Record<'scheduled' | 'rest', { jobs: number; now: Spread; matching_alone: Spread }>;
};
type Moved = {
  start_minutes: number | null;
  run_minutes: number | null;
  board_minutes: number;
};

function printAccuracy(a: Accuracy) {
  print(`How the estimates held over the last ${plural(a.days, 'day')}.`, '');
  const t = a.agent_time;
  print(`Agent time: ${plural(t.count, 'job')} with a stored estimate${t.count ? `: ${spreadWords(t)}` : '.'}`);
  for (const w of t.worst)
    print(
      `  #${w.id} ${w.agent}: ${w.title}`,
      `    estimated ${duration(w.predicted_minutes)}, took ${duration(w.actual_minutes)}; compared on ${basisWords(w.basis)} (${w.picks.map(id => `#${id}`).join(', ')})`,
    );
  const e = a.eta;
  const late = e.late_share === null ? '' : `, ${Math.round(e.late_share * 100)}% later than said`;
  const miss = e.median_miss_minutes === null ? '.' : `: the median miss ${duration(e.median_miss_minutes)}${late}.`;
  print('', `ETA: ${plural(e.count, 'job')} merged or ended with one${miss}`);
  for (const w of e.worst)
    print(
      `  #${w.id} ${w.agent}: ${w.title}`,
      `    said ${at(w.eta)}, landed ${at(w.landed)} (${signed(w.late_minutes, 'late', 'early')}): ${movedWords(w.moved)}`,
    );
  print(
    '',
    'The matching, tried again on the work done since (each job sized from the jobs done before it was queued):',
  );
  for (const m of a.matching) print(`  ${m.way}: ${m.count ? spreadWords(m) : 'no jobs'}`);
  if (a.matching_by_thread) scoring.byThread(a.matching_by_thread);
  const s = a.matching_by_schedule;
  if (s)
    for (const [group, g] of [
      ["scheduled jobs, on their entry's runs", s.scheduled],
      ['the rest', s.rest],
    ] as const)
      print(
        `  ${group}: ${plural(g.jobs, 'job')}`,
        `    HQ's way now: ${g.now.count ? spreadWords(g.now) : 'no jobs'}`,
        `    the matching alone, as before: ${g.matching_alone.count ? spreadWords(g.matching_alone) : 'no jobs'}`,
      );
}

export const spreadWords = (s: Spread) =>
  `the median miss ×${s.median_factor} either way, ${Math.round(s.within_twice! * 100)}% within twice or half, ` +
  `all of them together ${s.sum_ratio ?? '?'} of what they took.`;

const movedWords = (m: Moved) =>
  [
    m.start_minutes === null ? 'no start' : `started ${signed(m.start_minutes, 'later', 'sooner')}`,
    m.run_minutes === null ? '' : `ran ${signed(m.run_minutes, 'longer', 'shorter')}`,
    m.board_minutes ? `the board's cards ${duration(m.board_minutes)}` : '',
  ]
    .filter(Boolean)
    .join(', ');

const signed = (minutes: number, more: string, less: string) =>
  minutes >= 0 ? `${duration(minutes)} ${more}` : `${duration(-minutes)} ${less}`;
