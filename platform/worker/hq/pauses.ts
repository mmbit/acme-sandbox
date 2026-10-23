// hq thread pause | resume and hq project pause | resume: a paused project or thread, whose queued work HQ's claim holds
// (the coordinator's pauses.ts); hq decision: pauses that wait for a decision of the board's (its decisions.ts).
import * as api from './api.ts';
import { plural, print, stop, text } from './output.ts';

type Kind = 'thread' | 'project';
type Paused = {
  target: string;
  why: string;
  until: { id: number; agent: string; state: string }[];
  held: number;
  running: { id: number; status: string }[];
};

const named = (kind: Kind) => (kind === 'thread' ? '<project>/<slug>' : '<project>');

export const help = (kind: Kind) => `
   hq ${kind} pause ${named(kind)} "why" [--until <job>]...
                                                     pause the ${kind === 'thread' ? 'thread' : 'project, every thread of it'}: nothing queued on it starts
                                                     (work, reviews, fixes) until it's resumed, or with --until, until
                                                     those jobs are all done and merged. Work already running goes on
                                                     (stop it, or let it finish: hq stop pauses a review or ruling). The
                                                     CEO or the project's owner. A hold the board agreed goes in as a
                                                     pause, then hq item link <item> pause:<${kind}>
   ${`hq ${kind} resume ${named(kind)}`.padEnd(50)}let its queued work start again (the CEO's pause, or one with
                                                     the board's item: the CEO only)`;

export async function pause(kind: Kind, given: string[]) {
  const until: number[] = [],
    args: string[] = [];
  for (let i = 0; i < given.length; i++) {
    if (given[i] !== '--until') {
      args.push(given[i]);
      continue;
    }
    const job = /^#?([0-9]+)$/.exec(given[++i] ?? '')?.[1];
    if (!job) stop('Nothing was paused: --until takes a job number');
    until.push(Number(job));
  }
  const [id, why, ...rest] = args;
  if (!id || !why?.trim() || rest.length) stop(`usage: hq ${kind} pause ${named(kind)} "why" [--until <job>]...`);
  const answer = await api.call('pauses', { body: api.withSpeaker({ [kind]: id, why, until }) });
  const paused = api.parseOrNull(answer.body) as Paused | null;
  if (!api.isSuccess(answer.status) || !paused?.target)
    stop(`Nothing was paused: ${api.errorIn(answer.body, 'no answer')} (hq followthrough lists the pauses)`);
  const resumes = paused.until.length
    ? `It resumes by itself once ${paused.until.map(u => `#${u.id} (${text(u.agent)}, ${text(u.state)})`).join(' and ')} ${paused.until.length > 1 ? 'are' : 'is'} done and merged, or by hq ${kind} resume.`
    : `It holds until hq ${kind} resume ${text(paused.target)}.`;
  const running = paused.running.map(r => `#${r.id}${r.status === 'queued' ? ' (held mid-run)' : ''}`);
  print(
    `Paused ${text(paused.target)}: ${text(paused.why)}`,
    `${plural(paused.held, 'queued job')} on it held. ${resumes}`,
    ...(running.length
      ? [`Started before the pause: ${running.join(', ')}. Stop each (hq stop) or let it finish, as the reason says.`]
      : []),
  );
}

export async function resume(kind: Kind, [id, ...rest]: string[]) {
  if (!id || rest.length) stop(`usage: hq ${kind} resume ${named(kind)}`);
  const answer = await api.call('pauses/resume', { body: api.withSpeaker({ [kind]: id }) });
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
   hq decision link <id> <card>                      the open card that asks it, filed already or in place of another`,

  async run(given: string[]) {
    if (given[0] === 'link') return link(given.slice(1));
    const blocks: string[] = [],
      args: string[] = [];
    for (let i = 0; i < given.length; i++) {
      if (given[i] === '--blocks') while (given[i + 1] && !given[i + 1].startsWith('--')) blocks.push(given[++i]);
      else args.push(given[i]);
    }
    const [name, ...rest] = args;
    if (!name?.trim() || rest.length || !blocks.length)
      stop('usage: hq decision "name" --blocks <project | project/thread>..., or hq decision link <id> <card>');
    const answer = await api.call('decisions', { body: { name, blocks } });
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
  const answer = await api.call('decisions/link', { body: { id: Number(id), card: Number(card) } });
  if (!api.isSuccess(answer.status)) stop(`Not tied: ${api.errorIn(answer.body, 'no answer')}`);
  print(`Card #${card} asks decision #${id}: the board's answer on it lets the work go.`);
}
