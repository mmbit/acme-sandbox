// Which session a colleague's message reaches (hq say): the work it names. messages.ts stores and delivers it, and
// says what becomes of an unread one.
import { db } from './db.ts';
import * as messages from './messages.ts';
import type { From, Sending } from './messages.ts';
import { notTheirs } from './call.ts';
import { findThread, ownerOf, type Thread } from './projects.ts';

// An agent may run several sessions at once, so a message names the work it's about. The session that started last is
// no stand-in for the one meant.
// A job reaches that job's session alone. The job must be to's.
// A deliverable reaches every session live on it, only to's if the message names to. With none live, it becomes a job
// on the deliverable, for to or else the deliverable's owner. It must be open, as hq job's must be (projects.ts
// threadForJob).
// An agent alone reaches their one live session, or every one when several run.
// A live session is a running Claude work job other than the sender's: a review, or Codex, takes no message mid-run.
// A refusal is [status, why].
type Live = { job: number; agent: string };
export type About = { job?: number; deliverable?: string };
export function sendAbout(
  from: From & { job: number },
  to: string | undefined,
  { job, deliverable }: About,
  text: string,
  needsAnswer = false,
) {
  if (job !== undefined && deliverable !== undefined)
    return refusal('name one job by its number, or one deliverable, not both');
  if (deliverable !== undefined) {
    const thread = findThread(deliverable);
    if (thread?.status !== 'open') return refusal(`${deliverable} isn't an open deliverable (hq deliverable list)`);
    return toDeliverable(from, to, thread, text, needsAnswer);
  }
  if (to === undefined) return refusal('name the colleague, with the job the message is about');
  if (job === undefined) return toAgent(from, to, text, needsAnswer);
  const wrong = notTheirs(to, job);
  if (wrong) return refusal(wrong[1]);
  return messages.send(from, to, text, { only: job, needsAnswer });
}
const refusal = (why: string): [number, string] => [422, why];

function toDeliverable(
  from: From & { job: number },
  to: string | undefined,
  thread: Thread,
  text: string,
  needsAnswer: boolean,
) {
  const live = liveSessions(from.job, thread.id, to);
  if (!live.length) return messages.send(from, to ?? ownerOf(thread), text, { thread: thread.id, needsAnswer });
  const named = to ? `${to}'s work on the deliverable ${thread.id}` : `the deliverable ${thread.id}`;
  return copies(from, live, named, text, { thread: thread.id, needsAnswer });
}

function toAgent(from: From & { job: number }, to: string, text: string, needsAnswer: boolean) {
  const live = liveSessions(from.job, undefined, to);
  if (live.length < 2) return messages.send(from, to, text, { needsAnswer });
  return copies(from, live, `${to}, naming no job`, text, { needsAnswer });
}

const liveSessions = (sender: number, thread: string | undefined, agent: string | undefined) =>
  db
    .prepare(
      `select id job, agent from jobs where status = 'running' and kind = 'work' and engine = 'claude' and id != ?
    and (?2 is null or thread = ?2) and (?3 is null or agent = ?3) order by id`,
    )
    .all(sender, thread ?? null, agent ?? null) as Live[];

// A copy for each live session, each saying who they all went to. One becomes a job if none is read
// (messages.ts jobEnded), unless its chain of messages is full.
function copies(from: From & { job: number }, live: Live[], named: string, text: string, sending: Sending) {
  const copiedTo =
    `${named}: HQ gave it to every session live on that (${live.map(s => `${s.agent}'s job #${s.job}`).join(', ')}). ` +
    "If it applies to your work, do what it says; if it doesn't, ignore it.";
  const sent = messages.sendCopies(from, live, text, { ...sending, copiedTo });
  if (typeof sent === 'number') return sent;
  const sessions = sent.map(copy => ({ message: copy.id, job: copy.job!, agent: copy.agent }));
  const full = sent.some(copy => 'chain_full' in copy);
  return { id: sent[0].id, state: 'queued', named, sessions, ...(full ? { chain_full: true } : {}) };
}
