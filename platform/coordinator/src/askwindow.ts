// The window of work drawn from the board's ask, as it's queued: the claim pauses work in the way only for work with one.
// (its messages say deliverable, the board's word for a thread)
import { db } from './db.ts';
import { ceo } from './company.ts';
import * as messages from './messages.ts';
import * as windows from './windows.ts';

export type AskSource = 'call' | 'intercom' | 'notes';
// What the queuer says of its time (hq job --by, hq route --by): a window, or that it has none.
export type By = windows.Window | 'none';

const SOURCE_WORDS: Record<AskSource, string> = {
  call: 'from a call',
  intercom: 'on the intercom',
  notes: 'in its notes',
};

// --by <when> (a time, as hq window reads it), --by <project>/<slug> (that deliverable's window), or --by none; or why
// it can't be read. Undefined: not given.
export function readBy(given: unknown, now = Date.now()): By | { refused: string } | undefined {
  if (given == null) return undefined;
  const text = String(given).trim();
  if (text === 'none') return 'none';
  if (text.includes('/')) {
    const deliverable = windows.threadOf({ thread: text });
    if (typeof deliverable === 'string') return { refused: deliverable };
    if (deliverable.deadline === null)
      return { refused: `${deliverable.id} has no window to take: give its time (--by <when>)` };
    return { deadline: deliverable.deadline, aim: deliverable.aim ?? deliverable.deadline };
  }
  const at = windows.parse(text, now, false, '--by');
  return typeof at === 'string' ? { refused: at } : { deadline: at, aim: at };
}

// The ask a job is drawn from, by where it's queued: handing out a call's item or on a live call, or from the CEO's
// intercom (its chat job). Null: an agent's own work.
export function sourceOf(queuer: { id: number; call?: boolean }, handsOutItem: boolean): AskSource | null {
  if (queuer.call || handsOutItem) return 'call';
  const queuing = db.prepare('select kind from jobs where id = ?').get(queuer.id) as { kind: string } | undefined;
  return queuing?.kind === 'chat' ? 'intercom' : null;
}

// The window a thread has or serves: its own, else the earliest of the open threads that need it, at any depth, through
// open threads only (a done one's needs order nothing: threadorder.ts needsOpen), as the claim orders by needs. Null:
// nothing timed waits on it.
export function servedWindow(thread: string | null) {
  if (!thread) return null;
  const served = db
    .prepare(
      `with recursive serving(id) as (select $thread union select n.thread from thread_needs n join serving s on n.needs = s.id
      join threads o on o.id = n.thread and o.status = 'open')
    select t.id thread, t.deadline from threads t join serving s on s.id = t.id
    where t.status = 'open' and t.deadline is not null order by t.deadline, t.id limit 1`,
    )
    .get({ thread }) as { thread: string; deadline: number } | undefined;
  return served ?? null;
}

// The window --by puts on the job's thread: never later than one it has (a deliverable's agreed time isn't loosened by
// the work that serves it: hq window moves it). Undefined: it keeps its own.
export function narrowed(thread: string, by: windows.Window) {
  const deadline = windows.threadOf({ thread });
  return typeof deadline !== 'string' && deadline.deadline !== null && deadline.deadline <= by.deadline
    ? undefined
    : by;
}

// Why the CEO's own queuing of an ask with no window is refused: the question it answers by queuing it again.
export const untimedRefusal = (source: AskSource) =>
  `this is the board's ask (${SOURCE_WORDS[source]}) and it is in no deliverable, so it would wait behind every window. ` +
  "File it under the deliverable it serves, or give --by <when> (the board's, else hq when's), " +
  '--by <project>/<slug> to take that window, or --by none if it has no time';

// What the queuer hears when it isn't refused and the CEO isn't asked: on a live call, whose agent judges the time
// itself or leaves it untimed, never asking the board by when, and on a
// customer's call, whose details stay with its agent. A job in no thread goes on the one it serves first: a window is a
// thread's (a live call's promise puts one it queued there: server.ts promisedWork).
export const untimedLine = (job: number, onCall: boolean) =>
  "It has no window: it's in no deliverable. " +
  (onCall
    ? "Don't ask the board by when. If the board named a time or wants the work soon, or you judge a time sensible " +
      `(the when tool's), note that time with promise, its deadline and this job (${job})` +
      ', with the open deliverable it serves: its deliverable takes the time at once. ' +
      'Otherwise leave it untimed.'
    : `Give it its time: hq job move ${job} <project>/<slug> (the deliverable it serves), then ` +
      `hq window ${job} <when> (the board's, else hq when's).`);

// Anyone else's ask with no window: the CEO is asked for its time, as a message (hq say's).
export function askCeo(from: messages.From, job: { id: number; agent: string; title: string }, source: AskSource) {
  return messages.send(
    from,
    ceo(),
    `Job #${job.id} for ${job.agent} ("${job.title}") is the board's ask (${SOURCE_WORDS[source]}). ` +
      `${untimedLine(job.id, false)} Or leave it if it has none.`,
  );
}
