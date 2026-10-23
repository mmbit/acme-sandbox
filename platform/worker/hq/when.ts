// hq when: when new work could be done, played into the plan as it stands (the coordinator's when.ts): the earliest
// without making any window miss, or with --by whether it makes that time, and only if not, what would.
import * as api from './api.ts';
import { deadlineLines, type Deadline } from './deadlines.ts';
import { at, comparedWords, duration, waitWords, type Basis, type Wait } from './estimate.ts';
import { plural, print, stop, text } from './output.ts';

type PlayTime = { work_ms: number; review_ms: number; waiting_ms: number; deploy_ms: number; total_ms: number };
type Trial = {
  time?: PlayTime | null;
  rounds: number;
  fixes: number;
  finish: number | null;
  start: number | null;
  waits: Wait[];
  gives: Give[];
  unpriced: string[];
  deadlines: Deadline[];
};
type Give = { thread: string; project: string; name: string; deadline: number; past_ms: number | null };
type Answer = {
  work: { title: string; agent: string; engine: string };
  size: { agent_minutes: number; given: boolean; compared: number; basis: Basis; guessed: boolean };
  free: Trial;
  earliest?: Trial & { found: boolean; due: number | null };
  by?: Trial & {
    at: number;
    makes: boolean;
    due?: number | null;
    pushed?: Give[];
    giving?: boolean;
    widen?: Give[];
    seat?: (Trial & { makes: boolean; due: number | null }) | null;
  };
  horizon_days: number;
  played: { plays: number; ms: number };
};

const USAGE = 'usage: hq when "what the work is" [size] [--agent <id>] [--after <job>] [--by <time>]';

export const when = {
  help: `
   hq when "what the work is" [size] [--agent <id>] [--after <job>] [--by <time>]
                                                     when new work could be done (merged and deployed), played into the
                                                     plan as it stands: sized like hq estimate, or by the size given
                                                     (90m, 2h, 1h30m), as --agent's work (yours by default), after
                                                     --after's job. The earliest it can be done without making any
                                                     window miss, and the window to set for it (hq window). With --by
                                                     (2h, 14:30, 2026-10-06T14:30Z), whether it makes that time, and only
                                                     if not, what would, each as played: the windows that would give
                                                     and by how much, and one more seat`,

  async run(given: string[]) {
    const flags: Record<string, string> = {};
    const words: string[] = [];
    for (let i = 0; i < given.length; i++) {
      const name = given[i].match(/^--(agent|after|by)$/)?.[1];
      if (!name) words.push(given[i]);
      else if (!given[i + 1]) stop(`usage: --${name} needs a value`);
      else flags[name] = given[++i];
    }
    if (!words.length || words.length > 2) stop(USAGE);
    const [q, size] = words;
    const query = new URLSearchParams({ q, ...(size ? { size } : {}), ...flags });
    const found: Answer = JSON.parse(
      await api.orStop(api.get(`when?${query}`), "Couldn't play the work into the plan."),
    );
    print(sizeLine(found), '');
    print(...(found.by ? byLines(found.by, found.work.engine) : earliestLines(found)), ...unpricedLines(found));
    print('', ...agreedLines(found));
    print(
      '',
      `(Played ${found.played.plays} ways on the queue as it is, in ${(found.played.ms / 1000).toFixed(1)} s.)`,
    );
  },
};

function sizeLine({ work, size }: Answer) {
  const on = size.given
    ? 'as given'
    : size.guessed
      ? 'a first guess: too few done jobs to compare against'
      : `the mean of ${comparedWords(size.compared, size.basis)}`;
  return `${text(work.title)}, as ${text(work.agent)}'s work: ${duration(size.agent_minutes)} of agent time (${on}).`;
}

// The earliest without a window missing for it and the window that gives it, beside the time it's done with no window;
// or that no time in the play's reach holds every window, and what each way of queuing it would miss.
function earliestLines({ free, earliest, horizon_days }: Answer) {
  const e = earliest!;
  if (!e.found) {
    const same = e.finish === free.finish && e.gives.map(g => g.thread).join() === free.gives.map(g => g.thread).join();
    return [
      `No time in the next ${horizon_days} days holds every window.`,
      ...played(same ? `With its deadline as late as ${at(e.due!)} or none` : 'With no window at all', free),
      ...(same ? [] : played(`With its deadline as late as ${at(e.due!)}`, e)),
      ...timeLines(free),
    ];
  }
  const starts = e.start !== null ? ` (it starts about ${at(e.start)})` : '';
  const plain = free.finish === null ? 'it has no finish in sight' : `it's done about ${at(free.finish)}`;
  const misses = free.gives.length ? `, making ${plural(free.gives.length, 'window')} miss` : '';
  return [
    `At the earliest without making any window miss: done about ${at(e.finish!)}${starts}.`,
    e.due === null
      ? "That's when it's done with no window at all: it needs none."
      : `Its window for that: deadline ${at(e.due)}, aim ${at(e.finish!)}. With no window at all ${plain}${misses}.`,
    ...timeLines(e),
  ];
}

// Whether it makes the time, and only when it doesn't, what would, as played: the windows giving for it, one more seat.
function byLines(by: NonNullable<Answer['by']>, engine: string) {
  const done = (t: Trial) => (t.finish === null ? 'no finish in sight' : `done about ${at(t.finish)}`);
  if (by.makes && by.due != null)
    return [
      `By ${at(by.at)}: yes, ${done(by)} with every window held. Its window: deadline ${at(by.due)}, aim ${at(by.finish!)}.`,
      ...timeLines(by),
    ];
  if (by.makes)
    return [
      `By ${at(by.at)}: yes, ${done(by)} with no window set. A deadline at ${at(by.at)} would move it ahead of work whose windows then miss:`,
      ...(by.pushed ?? []).map(giveLine),
      ...timeLines(by),
    ];
  const lines = by.giving
    ? [`By ${at(by.at)} only if these windows give for it (${done(by)}):`, ...by.widen!.map(giveLine)]
    : [`Not by ${at(by.at)} even with the windows ahead of it giving way: ${done(by)}.`];
  const seat = `one more ${engine} seat`;
  if (!by.seat)
    lines.push(
      `With ${seat}: not played, as HQ has no ${engine} seat with measured fill rates and reported slots to copy.`,
    );
  else if (by.seat.makes) {
    const window = by.seat.due === null ? 'with no window set' : `its deadline ${at(by.seat.due)}`;
    lines.push(`${by.giving ? 'Or' : `By ${at(by.at)}`} with ${seat}: ${done(by.seat)}, no window giving (${window}).`);
  } else lines.push(`Not by ${at(by.at)} with ${seat} and every window held: ${done(by.seat)}.`);
  return [...lines, ...timeLines(by)];
}

// A play's finish and the windows it makes miss.
function played(head: string, t: Trial) {
  const done = t.finish === null ? 'no finish in sight' : `done about ${at(t.finish)}`;
  return t.gives.length
    ? [`${head}: ${done}, and these windows miss:`, ...t.gives.map(giveLine)]
    : [`${head}: ${done}.`];
}

const giveLine = (g: Give) => `- ${text(g.thread)} (${text(g.project)}: ${text(g.name)}) ${giveWords(g)}`;
// (a window inside its deadline only has to let the work go first: widened, the plan runs it after)
const giveWords = (g: Give) =>
  g.past_ms === null
    ? `has no finish in sight before its deadline ${at(g.deadline)}`
    : g.past_ms > 0
      ? `past its deadline ${at(g.deadline)} by ${duration(g.past_ms / 60_000)}`
      : `still done by its deadline ${at(g.deadline)}, once widened to go after it`;

function timeLines(t: Trial) {
  const time = t.time;
  const [work, review, waiting, deploy, total] = time ? roundedMinutes(time) : [];
  const split = time
    ? [
        `Time from this quote to live: ${duration(work)} work + ${duration(review)} review + ${duration(waiting)} waiting + ${duration(deploy)} deploy = ${duration(total)} total.`,
        `Review includes rulings and fixes, with ${plural(t.rounds, 'planned round')} and ${plural(t.fixes, 'fix run')}. Parallel reviews count once.`,
      ]
    : [];

  const waits = t.waits.filter(w => w.on !== 'horizon');
  return [...split, ...(waits.length ? [`It waits on: ${waits.map(waitWords).join('; ')}.`] : [])];
}

// Round the parts together so the displayed minutes still add up to the total.
function roundedMinutes(time: PlayTime) {
  const parts = [time.work_ms, time.review_ms, time.waiting_ms, time.deploy_ms].map(ms => ms / 60_000);
  const whole = parts.map(Math.floor),
    total = Math.round(time.total_ms / 60_000);
  const order = parts.map((part, i) => ({ i, remainder: part - whole[i] })).sort((a, b) => b.remainder - a.remainder);
  const missing = total - whole.reduce((sum, minutes) => sum + minutes, 0);
  for (const { i } of order.slice(0, missing)) whole[i]++;
  return [...whole, total];
}

// Each agreed deadline as the answer's play leaves it, against the plan without the work: the play its time comes from
// (the earliest that holds every window, else none at all; with --by, the one it answers with).
function agreedLines({ free, earliest, by }: Answer) {
  const answer = by ?? (earliest?.found ? earliest : free);
  return deadlineLines(answer.deadlines, 'the work');
}

// The seats the plays counted as never filling, their fill rates not measured yet (as hq estimate says it).
function unpricedLines({ free, earliest, by }: Answer) {
  const seats = new Set([free, earliest, by, by?.seat].flatMap(t => t?.unpriced ?? []));
  return seats.size
    ? [`Seat fill rates are not measured yet for ${[...seats].join(', ')}: the play counts them as never filling.`]
    : [];
}
