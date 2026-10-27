// hq thread pause | resume and hq project pause | resume: a paused project or thread, whose queued work HQ's claim holds
// (the coordinator's pauses.ts); hq decision: pauses that wait for a decision of the board's (its decisions.ts).
import * as api from './api.ts';
import { minute, plural, print, stop, text } from './output.ts';

type Kind = 'thread' | 'project';
type Paused = {
  target: string;
  why: string;
  untilTime: string | null;
  until: { id: number; agent: string; state: string }[];
  held: number;
  running: { id: number; status: string }[];
};
// What lifts a pause (the coordinator's pauses.ts): its time, the jobs it waits for, the board's decision
export type Lift = {
  untilTime: string | null;
  until: { id: number; agent?: string; state?: string }[];
  decision?: { name: string; card: number | null } | null;
};

// (the work in no thread: the coordinator's jobs.ts DESK.)
const DESK = `
                                                     The project unsorted (or its group's code) is the work in no
                                                     thread: what a call and HQ queue there (the intercom, meetings,
                                                     a call's follow-up and expedited work go on)`;
const named = (kind: Kind) => (kind === 'thread' ? '<project>/<slug>' : '<project>');

// (--until-time's forms, the board's own time with its date and no zone among them)
export const help = (kind: Kind) => `
   hq ${kind} pause ${named(kind)} "why" (--until <job>... | --until-time <time> | --by-hand)
                                                     pause the ${kind === 'thread' ? 'thread' : 'project, every thread of it'}: nothing queued on it starts
                                                     (work, reviews, fixes) until it's resumed. What it waits for wakes
                                                     you, never lifts it: --until jobs once they're all merged or ended,
                                                     --until-time a time (2h, 90m or 1h30m from now; 2026-10-26 09:00
                                                     with no zone, on the company's clock; one with Z or a time of day
                                                     alone, 14:30, is UTC), both once both are met; HQ queues you a job
                                                     to judge: resume, tell the board, or pause it again on what's still
                                                     missing (paused already, the same command keeps it on with new
                                                     conditions). --by-hand: nothing wakes you. Work already running goes
                                                     on (stop it, or let it finish: hq stop pauses a review or ruling). The CEO or the project's owner. A
                                                     hold the board agreed goes in as a pause, then hq item link <item>
                                                     pause:<${kind}>${kind === 'project' ? DESK : ''}
   ${`hq ${kind} resume ${named(kind)}`.padEnd(50)}let its queued work start again (the CEO's pause, or one with
                                                     the board's item: the CEO only)`;

export async function pause(kind: Kind, given: string[]) {
  const until: number[] = [],
    args: string[] = [];
  let untilTime: string | undefined,
    byHand = false;
  for (let i = 0; i < given.length; i++) {
    if (given[i] === '--until-time') {
      untilTime = given[++i];
      if (!untilTime)
        stop(
          "Nothing was paused: --until-time takes a time (2h, 90m, 2026-10-26 09:00 on the company's clock, 14:30 UTC)",
        );
    } else if (given[i] === '--by-hand') byHand = true;
    else if (given[i] !== '--until') args.push(given[i]);
    else {
      const job = /^#?([0-9]+)$/.exec(given[++i] ?? '')?.[1];
      if (!job) stop('Nothing was paused: --until takes a job number');
      until.push(Number(job));
    }
  }
  const [id, why, ...rest] = args;
  if (!id || !why?.trim() || rest.length)
    stop(`usage: hq ${kind} pause ${named(kind)} "why" (--until <job>... | --until-time <time> | --by-hand)`);
  const answer = await api.change('pauses', { body: api.withSpeaker({ [kind]: id, why, until, untilTime, byHand }) });
  const paused = api.parseOrNull(answer.body) as Paused | null;
  if (!api.isSuccess(answer.status) || !paused?.target)
    stop(`Nothing was paused: ${api.errorIn(answer.body, 'no answer')} (hq followthrough lists the pauses)`);
  const waits = [
    ...(paused.until.length
      ? [
          `${paused.until.map(u => `#${u.id} (${text(u.agent)}, ${text(u.state)})`).join(' and ')} ${paused.until.length > 1 ? 'have' : 'has'} merged or ended`,
        ]
      : []),
    // (on the run's clock, its zone named)
    ...(paused.untilTime ? [`${minute(text(paused.untilTime))} has come`] : []),
  ];
  const resumes = waits.length
    ? `Once ${waits.join(' and ')}, HQ queues you a job to judge it; only hq ${kind} resume ${text(paused.target)} lifts it.`
    : `It holds until hq ${kind} resume ${text(paused.target)}: nothing wakes you about it.`;
  const running = paused.running.map(r => `#${r.id}${r.status === 'queued' ? ' (held mid-run)' : ''}`);
  print(
    `Paused ${text(paused.target)}: ${text(paused.why)}`,
    `${plural(paused.held, 'queued job')} on it held. ${resumes}`,
    ...(running.length
      ? [`Started before the pause: ${running.join(', ')}. Stop each (hq stop) or let it finish, as the reason says.`]
      : []),
  );
}

// What a pause waits for, in words: "it's resumed: its owner judges it once 2026-10-26 08:00 UTC has come and #12 (kit,
// queued) has merged or ended"; a decision's, the board's answer; one by hand, nothing wakes its owner
export function liftWords(p: Lift) {
  if (p.decision)
    return `the board decides "${text(p.decision.name)}"${p.decision.card ? ` (card #${p.decision.card})` : ''}`;
  const jobs = p.until.map(u => `#${u.id}${u.agent ? ` (${text(u.agent)}, ${text(u.state ?? '')})` : ''}`);
  const parts = [
    ...(p.untilTime ? [`${minute(p.untilTime)} has come`] : []),
    ...(jobs.length ? [`${jobs.join(' and ')} ${jobs.length > 1 ? 'have' : 'has'} merged or ended`] : []),
  ];
  return parts.length
    ? `it's resumed: its owner judges it once ${parts.join(' and ')}`
    : "it's resumed by hand: nothing wakes its owner";
}

export async function resume(kind: Kind, [id, ...rest]: string[]) {
  if (!id || rest.length) stop(`usage: hq ${kind} resume ${named(kind)}`);
  const answer = await api.change('pauses/resume', { body: api.withSpeaker({ [kind]: id }) });
  if (!api.isSuccess(answer.status)) stop(`Nothing was resumed: ${api.errorIn(answer.body, 'no answer')}`);
  print(`Resumed ${id}: its queued work starts as seats free up.`);
}

export const decision = {
  help: `
   hq decision "name" --blocks <project | project/thread>...
                                                     the CEO names a decision the board has yet to make ("pick the art
                                                     direction"), before its card exists, and pauses what depends on it:
                                                     its queued work, reviews and fixes wait. Only the board's answer on
                                                     its card (hq ask ... --decides <id>) lets it go
   hq decision show <id>                             the assigned card author reads its waiting pull requests
   hq decision link <id> <card>                      the open card that asks it, filed already or in place of another
   hq decision settle <id> item:<n> | card:<n>       the CEO settles a visual decision without its card, citing the
                                                     board's word given elsewhere (a call's item, a card it answered)
                                                     as its Go live: the CEO's judgment, recorded with the word. The
                                                     held merges go on, and its queued card job and open card, if
                                                     any, end`,

  async run(given: string[]) {
    if (given[0] === 'show') return show(given.slice(1));
    if (given[0] === 'link') return link(given.slice(1));
    if (given[0] === 'settle') return settle(given.slice(1));
    const blocks: string[] = [],
      args: string[] = [];
    for (let i = 0; i < given.length; i++) {
      if (given[i] === '--blocks') while (given[i + 1] && !given[i + 1].startsWith('--')) blocks.push(given[++i]);
      else args.push(given[i]);
    }
    const [name, ...rest] = args;
    if (!name?.trim() || rest.length || !blocks.length)
      stop('usage: hq decision "name" --blocks <project | project/thread>..., or hq decision link <id> <card>');
    const answer = await api.change('decisions', { body: { name, blocks } });
    const made = api.parseOrNull(answer.body) as { id?: number; blocks?: string[] } | null;
    if (!api.isSuccess(answer.status) || !made?.id)
      stop(`Nothing was paused: ${api.errorIn(answer.body, 'no answer')}`);
    print(
      `Decision #${made.id}: ${made.blocks!.map(text).join(', ')} wait for it. Its card: hq ask ... --decides ${made.id}, or hq decision link ${made.id} <card>.`,
      "The board's answer on that card lets the work go.",
    );
  },
};

async function link([id, card, ...rest]: string[]) {
  if (!/^[0-9]+$/.test(id ?? '') || !/^[0-9]+$/.test(card ?? '') || rest.length)
    stop('usage: hq decision link <id> <card>');
  const answer = await api.change('decisions/link', { body: { id: Number(id), card: Number(card) } });
  if (!api.isSuccess(answer.status)) stop(`Not tied: ${api.errorIn(answer.body, 'no answer')}`);
  print(`Card #${card} asks decision #${id}: the board's answer on it lets the work go.`);
}

async function settle([id, word, ...rest]: string[]) {
  if (!/^[0-9]+$/.test(id ?? '') || !/^(item|card):[0-9]+$/.test(word ?? '') || rest.length)
    stop('usage: hq decision settle <id> item:<n> | card:<n>');
  const answer = await api.change('decisions/settle', { body: { id: Number(id), word } });
  const settled = api.parseOrNull(answer.body) as {
    merges?: number[];
    cardJob?: number | null;
    card?: number | null;
  } | null;
  if (!api.isSuccess(answer.status) || !settled?.merges) stop(`Not settled: ${api.errorIn(answer.body, 'no answer')}`);
  const ended = [settled.cardJob && `card job #${settled.cardJob}`, settled.card && `card #${settled.card}`].filter(
    Boolean,
  );
  print(
    `Decision #${id} is settled, citing the board's ${word.replace(':', ' #')}: ${
      settled.merges.length
        ? settled.merges.map(n => `PR #${n}`).join(', ') + ' go on to merge'
        : 'no pull request waits on it now'
    }${ended.length ? `, and ${ended.join(' and ')} end${ended.length > 1 ? '' : 's'}` : ''}.`,
  );
}

async function show([id, ...rest]: string[]) {
  if (!/^[0-9]+$/.test(id ?? '') || rest.length) stop('usage: hq decision show <id>');
  const answer = await api.call(`decisions/show?id=${id}`);
  if (!api.isSuccess(answer.status)) stop(api.errorIn(answer.body, 'no answer'));
  const decision = api.parseOrNull(answer.body) as {
    name: string;
    request: number | null;
    merges: { number: number; branch: string; author: string; sha: string }[];
  };
  print(
    `Decision #${id}: ${decision.name}`,
    decision.request ? `Card #${decision.request}` : 'No card yet',
    ...decision.merges.map(pr => `PR #${pr.number}: ${pr.branch} at ${pr.sha}, by ${pr.author}`),
  );
}
