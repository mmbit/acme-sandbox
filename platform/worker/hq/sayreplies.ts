// What hq say answers: where a message went, or why it wasn't sent (messages.ts sends it).
import * as api from './api.ts';
import { present, shown, text } from './output.ts';
export type Said = {
  id: number;
  state: string;
  job?: number;
  waiting?: boolean;
  named?: string;
  sessions?: { message: number; job: number; agent: string }[];
  why?: string;
  added?: number;
  chain_full?: boolean;
  call?: number;
};

// (and a call with the board the recipient is on hears it too, within about 15 s: the coordinator's callmessages.ts offer.
export function said(to: string, sent: Said, deliverable: string | undefined, needsAnswer: boolean) {
  const where = delivery(to, sent, deliverable, needsAnswer);
  return present(sent.call)
    ? `${where}\n${to} is on call #${shown(sent.call)} with the board: the call hears it too, with ${to}'s next turn there.`
    : where;
}

function delivery(
  to: string,
  { id, state, job, why, added, chain_full, waiting, named, sessions }: Said,
  deliverable: string | undefined,
  needsAnswer: boolean,
) {
  const check = `Check: hq sent ${id}`;
  if (sessions) {
    const copies = sessions.map(s => `${s.agent}'s job #${s.job} (message #${s.message})`).join(', ');
    const unread =
      chain_full === true
        ? 'if none reads it, it lapses: it comes from a chain of messages that has started 3 jobs, the most one may'
        : 'if none reads it, one copy becomes a job';
    return `Sent to ${text(named)}: every session live on that has a copy, ${copies}. Each reads it at its next step, with who it went to, and acts on it only if it applies to its work; ${unread}. ${check}`;
  }
  if (state === 'queued' && waiting === true) {
    return `Queued for ${to}'s job #${job}, which isn't running now: its session reads it at its first step when it starts or resumes. ${check}`;
  }
  if (why === 'next-run') {
    return `Kept for ${to}: ${job ? `job #${job} reads it at its next step` : 'the next run reads it'}, even while a pause holds work. If unread, it stays for the following run. ${check}`;
  }
  if (state === 'job' && present(added)) {
    return `${to} has no running job that can read it now: it's added to job #${job}, which your message #${added} became and which hasn't started yet, so it runs with that one (message #${id}). ${check}`;
  }
  if (state === 'queued' && chain_full === true) {
    return `Queued for ${to}'s running job #${job}: it reads it at its next step. If the job ends first, it won't become a new job: it comes from a chain of messages that has started 3 jobs, the most one may (hq sent will say it wasn't read). ${check}`;
  }
  if (state === 'queued') {
    return `Queued for ${to}'s running job #${job}: it reads it at its next step; if the job ends first it becomes a new job. ${check}`;
  }
  if (why === 'deliverable') {
    // (a needed answer's job runs beside it, outside its task order: coordinator toJob.)
    const on = needsAnswer ? 'on its own beside that deliverable, outside its task order' : 'on that deliverable';
    return `Nobody is working on ${text(deliverable)} now: it's job #${job} for ${to} ${on} (message #${id}), which starts once it's sorted into the plan. ${check}`;
  }
  if (why === 'codex') {
    return `${to}'s running job is on Codex, which can't take a message mid-job: it's job #${job} now (message #${id}), which starts once it's sorted into the plan. ${check}`;
  }
  // (sorted: the coordinator's sorting.ts.)
  return `${to} has no running job: it's job #${job} now (message #${id}), which starts once it's sorted into the plan. ${check}`;
}

export function sayRefusal(status: number, to: string, words: string, error = ''): [string, number] {
  switch (status) {
    case 400:
      return ['hq say: the message is empty. Nothing was sent.', 1];
    case 403:
      return [
        "hq say: not allowed. --as takes only a team member of this job, never a colleague's name, and a call has no hq say (use hq job). Nothing was sent.",
        1,
      ];
    case 409:
      return [
        `hq say: ${to} has no running job that can read a message now, so it would start a new job, and this job is the last of the 3 a chain of messages may start. Nothing was sent. If ${to} must act on it, hand it over with hq job <agent> "title" <file>; a thanks or an acknowledgement needs no message.`,
        1,
      ];
    case 404:
      return [
        `hq say: "${to}" isn't a colleague who runs jobs (an agent in company/org.yaml or an alumnus). Nothing was sent. A teammate in your own session: use SendMessage. The board: hq ask.`,
        1,
      ];
    case 413:
      return [
        `hq say: the message is ${Buffer.byteLength(words)} characters, over the 8000 a message may have. Nothing was sent: shorten it, or hand the work over with hq job <agent> "title" <file>.`,
        1,
      ];
    case 429:
      return ['hq say: this job has sent 30 messages in the last hour, the most it may. Nothing was sent.', 1];
  }
  // (HQ's own words where it says why, e.g. a colleague no job runs as)
  if (api.isRefusal(status))
    return [`hq say: ${error || `HQ didn't take the message (HTTP ${status})`}. Nothing was sent.`, 1];
  return [
    `hq say: not confirmed (HTTP ${api.httpCode(status)}): HQ may have taken the message, and made a job of it, already. Don't send it again: check hq sent first.`,
    3,
  ];
}
