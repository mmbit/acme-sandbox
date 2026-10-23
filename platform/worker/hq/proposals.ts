// New work proposed to a project's owner instead of queued (hq propose), and the owner's inbox of it (hq inbox): the
// coordinator's proposals.ts.
import * as api from './api.ts';
import { readTextOrStdin } from './files.ts';
import { takeThread, takeValues } from './flags.ts';
import { inbox as messageInbox } from './messages.ts';
import { minute, print, stop, text } from './output.ts';

const INBOX_ID = /^(?:[0-9]+|findings:[0-9]+)$/;
const FINDINGS = 'findings:';

type Proposal = {
  id: number | string;
  created: string;
  agent: string;
  title: string;
  brief: string;
  for_agent: string | null;
  thread: string | null;
  project: string | null;
  owner: string;
  status: string;
  accepted: number | null;
  why: string | null;
};

export const propose = {
  help: `
   hq propose "title" <brief-file | -> [--project <project>] [--for <agent>] [--thread <project>/<slug>]
                                                     propose new work beyond your job's thread to the owner of the
                                                     project it's for (--project, else your thread's), instead of queueing
                                                     it: it waits in their inbox, not the queue, until they accept it into
                                                     their plan (a job with your brief, for you or --for) or drop it with
                                                     why. Your job's own follow-ups (its fixes, hand-offs within its
                                                     thread) are hq job, as before`,

  async run(given: string[]) {
    const { values, args } = takeValues(given, ['--for', '--thread', '--project'], 'Nothing was proposed');
    const [title, briefPath, ...rest] = args;
    if (!title?.trim() || !briefPath || rest.length)
      stop(
        'usage: hq propose "title" <brief-file | -> [--project <project>] [--for <agent>] [--thread <project>/<slug>]',
      );
    const brief = readTextOrStdin(briefPath).trim();
    const body = api.withSpeaker({
      title,
      brief,
      ...(values.for && { for: values.for }),
      ...(values.thread && { thread: values.thread }),
      ...(values.project && { project: values.project }),
    });
    const answer = await api.call('proposals', { body });
    const made = api.parseOrNull(answer.body) as { id?: number; owner?: string; project?: string | null } | null;
    if (!api.isSuccess(answer.status) || !made?.id)
      stop(`Nothing was proposed: ${api.errorIn(answer.body, 'no answer')}`);
    const whose = made.project ? `${text(made.owner)}'s inbox (${text(made.project)}'s owner)` : "the CEO's inbox";
    print(
      `Proposal #${made.id} is in ${whose}. Nothing is queued until it's accepted: don't queue it yourself.`,
      "If it's dropped while this job runs, you hear why here; hq inbox shows what became of it.",
    );
  },
};

export const inbox = {
  help: `
   hq inbox [<id>] [--all]                           the work proposed to you (hq propose: for the projects you own, and
                                                     for the CEO what no owner has), then what became of your own
                                                     proposals; <id>: one proposal's brief; --all: the CEO's view of
                                                     every open proposal, whoever's it is
   hq inbox accept <id> --code WORD [--for <agent>] [--thread <project>/<slug> | --thread new:<project> "name" "done when"]
                                                     its project's owner (or the CEO) queues it as a job with its
                                                     proposer's brief, in a thread of their plan: the one named, else the
                                                     one proposed, else the proposer's job's when it's in that project.
                                                     --code: its task's word, as hq job's; --for: who takes it (a review
                                                     follow-up bundle's), else the one it was proposed for
   hq inbox accept findings:<pr> --for <agent> --findings <id,id,...> [--thread <thread>]
                                                     draw one fix task naming its review findings, in the reviewed thread
                                                     a closed item: --for and --thread draw replacement work and move its waits
   hq inbox drop <id> "why"                          its owner (or the CEO) drops it, why in a line the proposer hears${messageInbox.help}`,

  async run(given: string[]) {
    const [command, ...rest] = given;
    if (command === '--hook') return messageInbox.run(given);
    if (command === 'accept') return accept(rest);
    if (command === 'drop') return drop(rest);
    const all = given.includes('--all');
    const [id, ...more] = given.filter(arg => arg !== '--all');
    if ((id !== undefined && !INBOX_ID.test(id)) || more.length)
      stop('usage: hq inbox [<id>] [--all], hq inbox accept <id> ..., or hq inbox drop <id> "why"');
    const route = all ? 'proposals?all=1' : 'proposals';
    const listed = JSON.parse(await api.orStop(api.get(route), "Couldn't read the inbox.")) as Proposal[];
    if (id !== undefined) {
      const one = listed.find(p => String(p.id) === id);
      if (!one) stop(`There's no proposal #${id} in your inbox${all ? '' : ' (the CEO: hq inbox --all)'}.`);
      return print(line(one), '', text(one.brief));
    }
    if (!listed.length) return print('No proposals.');
    print(...listed.map(line));
  },
};

// A proposal in a line: its id, title, who proposed it for whom, the thread, when, and what became of it.
function line(p: Proposal) {
  const who = `from ${text(p.agent)}${p.for_agent ? ` for ${text(p.for_agent)}` : ''}`;
  const thread = p.thread ? `, in ${text(p.thread)}` : p.project ? `, for ${text(p.project)}` : '';
  const whose = p.status === 'open' ? `, ${text(p.owner)}'s to decide` : '';
  const became =
    p.status === 'accepted'
      ? `: accepted as job #${p.accepted}`
      : p.status === 'dropped'
        ? `: dropped, ${text(p.why)}`
        : '';
  return `#${p.id} ${text(p.title)} (${who}${thread}${whose}, ${minute(p.created)} UTC)${became}`;
}

async function accept(given: string[]) {
  const { values, args: remaining } = takeValues(given, ['--for', '--findings', '--code'], 'Not accepted');
  const { thread, newThread, args } = takeThread(remaining);
  const [id, ...rest] = args;
  // Old briefs and memories pass a numeric priority after the proposal id.
  if (/^[0-4]$/.test(rest[0] ?? ''))
    stop(
      `Not accepted: hq inbox accept takes no priority any more. Work runs in the order of its thread's window (hq window) and what waits on it. Remove the priority ${rest[0]} after the proposal id and run the same command again, keeping all other arguments.`,
    );
  if (!INBOX_ID.test(id ?? '') || rest.length)
    stop(
      'usage: hq inbox accept <id> --code WORD [--for <agent>] [--thread <project>/<slug> | --thread new:<project> "name" "done when"]',
    );
  const body = {
    id: id.startsWith(FINDINGS) ? id : Number(id),
    ...(values.for && { for: values.for }),
    ...(values.findings && { findings: values.findings }),
    ...(values.code && { code: values.code }),
    ...(thread !== undefined && { thread }),
    ...(newThread !== undefined && { newThread }),
  };
  const answer = await api.call('proposals/accept', { body });
  const queued = api.parseOrNull(answer.body) as { job?: number; code?: string | null; thread?: string | null } | null;
  if (!api.isSuccess(answer.status) || !queued?.job) stop(`Not accepted: ${api.errorIn(answer.body, 'no answer')}`);
  print(
    `Queued as job #${queued.job}${queued.code ? ` ${text(queued.code)}` : ''}${queued.thread ? `, in ${text(queued.thread)}` : ''}.`,
  );
}

async function drop([id, why, ...rest]: string[]) {
  if (!INBOX_ID.test(id ?? '') || !why?.trim() || rest.length) stop('usage: hq inbox drop <id> "why"');
  const answer = await api.call('proposals/drop', { body: { id: id.startsWith(FINDINGS) ? id : Number(id), why } });
  const done = api.parseOrNull(answer.body) as { ok?: boolean; told?: boolean } | null;
  if (!api.isSuccess(answer.status) || !done?.ok) stop(`Not dropped: ${api.errorIn(answer.body, 'no answer')}`);
  print(`Dropped #${id}. ${done.told ? 'Its proposer heard why.' : 'Its proposer reads why in hq inbox.'}`);
}
