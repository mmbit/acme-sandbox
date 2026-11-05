// hq activity: what a job or an agent is doing right now, the recent activity HQ's agent card shows the board (the
// coordinator's activity.ts), as agents can read it: each step's kind and the file or host it names, never a command's
// own words.
import * as api from './api.ts';
import { takeValues } from './flags.ts';
import { print, stop } from './output.ts';

type Line = { ts: string; agent: string | null; job: number | null; text: string };
type Activity = {
  job?: { id: number; agent: string; title: string; status: string; started: string | null };
  agent?: string;
  lines: Line[];
};

const USAGE = 'usage: hq activity <job | agent> [--since <30m | 2h | 2026-11-05T08:00Z>] [--limit <n>]';

export const activity = {
  help: `
   hq activity <job | agent> [--since <time>]        what a job (its lead and team members) or an agent (as on its HQ
                                                     card: its jobs' lines and the messages sent to it) is doing now:
                                                     its recent activity, oldest first, each line with its time (UTC),
                                                     who and, for an agent, the job: its statuses, steps (their kind and
                                                     the file or host they name; a command's own words and what it says
                                                     between steps are the board's alone), the messages it sent (an
                                                     agent's also those sent to it) and posts. The newest 30, or
                                                     everything after --since (30m, 2h or an ISO time, up to 300);
                                                     --limit <n> for more or fewer. Activity up to 5 November 2026,
                                                     before HQ kept each line's job, is the board's alone`,

  async run(given: string[]) {
    const { values, args } = takeValues(given, ['--since', '--limit'], 'Nothing read');
    const [who] = args;
    if (args.length !== 1 || !who) stop(USAGE);
    const job = /^#?[0-9]+$/.test(who) ? who.replace('#', '') : '';
    if (!job && !/^[a-z][a-z0-9-]*$/.test(who)) stop(USAGE);
    if (values.limit && !/^[0-9]+$/.test(values.limit)) stop(USAGE);
    const query = new URLSearchParams({
      ...(job ? { job } : { agent: who }),
      ...(values.since ? { since: sinceOf(values.since) } : {}),
      ...(values.limit ? { limit: values.limit } : {}),
    });
    const answer = await api.call(`activity?${query}`);
    if (answer.status !== 200) stop(api.errorIn(answer.body, "Couldn't read the activity."));
    const read = JSON.parse(answer.body) as Activity;
    const j = read.job;
    print(
      j
        ? `Job #${j.id} (${j.agent}, ${j.status}${j.started ? `, started ${clock(j.started)}` : ''}): ${j.title}`
        : `${read.agent}'s recent activity, as on its card:`,
    );
    if (!read.lines.length) return print(`  nothing${values.since ? ' since then' : ' yet'}`);
    for (const l of read.lines)
      print(`  ${clock(l.ts)}  ${l.agent ?? ''}${!j && l.job ? ` #${l.job}` : ''}: ${l.text}`);
  },
};

// 30m, 2h: that long ago; anything else as it's given (the coordinator refuses what isn't a time)
function sinceOf(given: string) {
  const ago = /^([0-9]+)([mh])$/.exec(given);
  return ago ? new Date(Date.now() - Number(ago[1]) * (ago[2] === 'h' ? 3_600_000 : 60_000)).toISOString() : given;
}
// 11-05 09:41:07 (UTC)
const clock = (ts: string) => ts.slice(5, 19).replace('T', ' ');
