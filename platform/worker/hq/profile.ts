// hq profile: the profiler's switch for the board's pages, and what each profiled page's session measured
// (shared/profile/README.md).
import * as api from './api.ts';
import { takeValues } from './flags.ts';
import { print, stop } from './output.ts';

const USAGE =
  'usage: hq profile on [hq | <product> | all] [--hours <n>] | off [<where>] | [<where>] [--since <time>] | --session <id>';
export const profile = {
  help: `
   hq profile on [hq | <product> | all] [--hours <n>] measure memory and smoothness on the board's pages there: HQ, a
                                                     product's preview, or every one (the default), for 24 h or --hours
                                                     (a week at most). Each page loaded meanwhile sends a sample every 20 s
   hq profile off [<where>]                          stop it there, or everywhere
   hq profile [<where>] [--since <time>]             each page's session since --since (UTC, ISO; the last day by
                                                     default): its counts' change per hour, what grew most, slow frames
   hq profile --session <id>                         one session's samples, a JSON line each`,

  async run(given: string[]) {
    const { values, args } = takeValues(given, ['--hours', '--since', '--session'], 'Nothing done');
    if (args[0] === 'on' || args[0] === 'off') return switched(args[0], args.slice(1), values.hours);
    if (args.length > 1 || values.hours) stop(USAGE);
    if (values.session) return samples(values.session);
    return sessions(args[0], values.since);
  },
};

async function switched(state: 'on' | 'off', where: string[], hours: string | undefined) {
  if (where.length > 1 || (state === 'off' && hours)) stop(USAGE);
  const body = { on: state === 'on', where: where[0], hours: hours === undefined ? undefined : Number(hours) };
  const answer = await api.call('profile', { body });
  if (answer.status !== 200) stop(api.errorIn(answer.body, 'Nothing switched.'));
  const { until, switched } = JSON.parse(answer.body) as { until?: string; switched?: Switched[] };
  if (until)
    return print(`The profiler is on for ${where[0] ?? 'all'} until ${until}: it starts on each page as it loads.`);
  print(switched?.length ? `Still on: ${switched.map(onFor).join(', ')}.` : 'The profiler is off everywhere.');
}

async function samples(session: string) {
  const answer = await api.call(`profile?${new URLSearchParams({ session })}`);
  if (answer.status !== 200) stop(api.errorIn(answer.body, "Couldn't read the samples."));
  const { samples } = JSON.parse(answer.body) as { samples: unknown[] };
  print(...(samples.length ? samples.map(s => JSON.stringify(s)) : ['No samples for that session.']));
}

async function sessions(where: string | undefined, since: string | undefined) {
  const query = new URLSearchParams({ ...(where && { where }), ...(since && { since }) });
  const answer = await api.call(`profile?${query}`);
  if (answer.status !== 200) stop(api.errorIn(answer.body, "Couldn't read the profiles."));
  const { switched, sessions } = JSON.parse(answer.body) as { switched: Switched[]; sessions: Session[] };
  print(switched.length ? `On: ${switched.map(onFor).join(', ')}.` : 'The profiler is off.', '');
  if (!sessions.length) return print('No profiled page in that time.');
  for (const s of sessions) print(...linesOf(s), '');
}

type Switched = { where: string; until: string };
const onFor = (s: Switched) => `${s.where} until ${s.until}`;
type Trend = { first: number; last: number; most: number; perHour: number } | null;
type Grown = { name: string; from: number; to: number; change: number };
type Ending = { session: string; clean: boolean; hidden?: boolean };
type Session = {
  session: string;
  slug: string;
  page: string;
  agent: string;
  screen: string;
  deviceMemory: number | null;
  // a page's mark of how it ended (profile.js): the session before this one, and this one's own end
  after: Ending | null;
  ended: Ending | null;
  began: string;
  minutes: number;
  samples: number;
  counts: Record<string, Trend>;
  grewMost: { regions: Grown[]; listeners: Grown[] };
  slowFrames: { first: number | null; last: number | null };
  longTasks: { count: number; worst: number };
  worstFrame: number;
  states: string[];
};

// A session as a few lines: where and on what, how it began and ended, every count's trend, and what grew
function linesOf(s: Session) {
  // (a page killed while hidden may be iOS reclaiming it in the background, not a crash)
  const ended = !s.ended
    ? ''
    : s.ended.clean
      ? ', reloaded or left'
      : s.ended.hidden
        ? ', ended in the background without closing (reclaimed by the browser, or killed)'
        : ', ended without closing (killed: out of memory or a crash)';
  const after = !s.after
    ? ''
    : s.after.clean
      ? ' after a reload'
      : ` after ${s.after.session} was ${s.after.hidden ? 'reclaimed or killed in the background' : 'killed'}`;
  const trends = Object.entries(s.counts)
    .filter((entry): entry is [string, NonNullable<Trend>] => !!entry[1])
    .map(([name, t]) => `${name} ${t.first}→${t.last} (most ${t.most}, ${t.perHour >= 0 ? '+' : ''}${t.perHour}/h)`);
  const grew = (list: Grown[]) => list.map(g => `${g.name} ${g.from}→${g.to}`).join(', ') || 'nothing';
  return [
    `${s.session}  ${s.slug}${s.page}  ${s.began}, ${s.minutes} min, ${s.samples} samples${after}${ended}`,
    `  ${s.agent} ${s.screen}${s.deviceMemory ? `, ${s.deviceMemory} GB` : ''}`,
    `  ${trends.join('; ')}`,
    `  grew most: elements in ${grew(s.grewMost.regions)}; listeners ${grew(s.grewMost.listeners)}`,
    `  slow frames ${s.slowFrames.first ?? '-'}% in the first quarter, ${s.slowFrames.last ?? '-'}% in the last; worst frame ${s.worstFrame} ms; ` +
      `${s.longTasks.count} long tasks (worst ${s.longTasks.worst} ms)`,
    `  states: ${s.states.join(' | ') || '-'}`,
  ];
}
