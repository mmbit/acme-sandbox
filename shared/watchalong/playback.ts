// A store's recordings read on a thread of their own, so one long session (2.9 MB a minute as posted, hundreds of MB
// for a long call) never holds its app's event loop: a recording's moments and times, the events a replay to a time
// needs, and every event for a player. The thread keeps the recording it read last, as one is usually stepped through
// ask after ask, and ends IDLE_MS after the last ask, letting the recording go.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { recordingOf, type RecordedEvent, type Session } from './store.ts';
import { Moments, type Moment } from './moments.ts';
import { replayAt } from './shown.ts';

// A recording's moments, folded and settled, and its times: clockMs, how far the page's clock ran behind the
// server's (its sessions are one page's, so one gap), and its first and last event's on the page's clock
export type Played = { clockMs: number; first: number; last: number; moments: Moment[] };
type Asked = { kind: 'played' } | { kind: 'at'; time: number } | { kind: 'every' };
// What each kind of ask is answered with
type Answers = { played: Played | undefined; at: RecordedEvent[]; every: Buffer };
type Ask = Asked & { id: number; dir: string; sessions: Session[] };
// (a Buffer handed over comes as a Uint8Array)
type Answer = { id: number; answer?: Answers[keyof Answers] | Uint8Array; error?: string };

export const IDLE_MS = 60_000;

// What's recorded in these sessions of the store's folder (dir), in order, or undefined when nothing is
export const played = (dir: string, sessions: Session[]) => ask(dir, sessions, { kind: 'played' });
// The events a past moment's mirror needs (shown.ts replayAt)
export const at = (dir: string, sessions: Session[], time: number) => ask(dir, sessions, { kind: 'at', time });
// Every event as NDJSON, an event a line
export const every = (dir: string, sessions: Session[]) => ask(dir, sessions, { kind: 'every' });

// ---------------------------------------------------------------- the app's side
// The thread and its asks waiting for an answer (a thread that ends leaves them unanswered, so they fail)
type Reader = {
  worker: Worker;
  waiting: Map<number, { resolve: (answer: Answers[keyof Answers]) => void; reject: (error: Error) => void }>;
};
let reader: Reader | undefined,
  idle: NodeJS.Timeout | undefined,
  asked = 0;

function ask<A extends Asked>(dir: string, sessions: Session[], asking: A) {
  const { worker, waiting } = (reader ??= started());
  clearTimeout(idle);
  worker.ref();
  const id = ++asked;
  return new Promise<Answers[A['kind']]>((resolve, reject) => {
    // (the thread answers an ask with its kind's answer)
    waiting.set(id, { resolve: answer => resolve(answer as Answers[A['kind']]), reject });
    worker.postMessage({ ...asking, id, dir, sessions } satisfies Ask);
  });
}
function started(): Reader {
  const worker = new Worker(new URL(import.meta.url)),
    waiting: Reader['waiting'] = new Map();
  const mine = { worker, waiting };
  worker.on('message', ({ id, answer, error }: Answer) => {
    const asker = waiting.get(id)!;
    waiting.delete(id);
    if (error === undefined) asker.resolve(answer instanceof Uint8Array ? asBuffer(answer) : answer);
    else asker.reject(new Error(`The recording couldn't be read: ${error}`));
    if (waiting.size) return;
    worker.unref();
    idle = setTimeout(() => ended(new Error('the thread was idle')), IDLE_MS).unref();
  });
  worker.on('error', error => ended(error));
  worker.on('exit', code => ended(new Error(`the recording's thread ended (${code})`)));
  return mine;
  function ended(error: Error) {
    if (reader === mine) reader = undefined;
    for (const asker of waiting.values()) asker.reject(error);
    waiting.clear();
    void worker.terminate();
  }
}
const asBuffer = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);

// ---------------------------------------------------------------- the thread
type Read = { key: string; events: RecordedEvent[]; played: Played | undefined };
let kept: Read | undefined;

if (!isMainThread)
  parentPort!.on('message', (asked: Ask) => {
    try {
      const recording = readOf(asked.dir, asked.sessions);
      if (asked.kind === 'played')
        return parentPort!.postMessage({ id: asked.id, answer: recording.played } satisfies Answer);
      if (asked.kind === 'at')
        return parentPort!.postMessage({
          id: asked.id,
          answer: replayAt(recording.events, asked.time),
        } satisfies Answer);
      const ndjson = lined(recording.events);
      parentPort!.postMessage({ id: asked.id, answer: ndjson } satisfies Answer, [ndjson.buffer]);
    } catch (err) {
      parentPort!.postMessage({
        id: asked.id,
        error: err instanceof Error ? err.message : String(err),
      } satisfies Answer);
    }
  });

// The sessions' recording, read again only when they changed (a live one grows)
function readOf(dir: string, sessions: Session[]) {
  const key = JSON.stringify([dir, sessions.map(session => [session.id, session.bytes])]);
  if (kept?.key === key) return kept;
  kept = undefined; // (the one before goes first: two long ones needn't fit at once)
  const recordings = sessions.map(session => recordingOf(dir, session)).filter(recording => recording.events.length);
  const events = recordings.flatMap(recording => recording.events);
  const moments = new Moments();
  moments.add(events);
  moments.settle(Infinity);
  kept = {
    key,
    events,
    played: recordings.length
      ? {
          clockMs: Math.min(...recordings.map(recording => recording.clockMs)),
          first: events[0].timestamp,
          last: events.at(-1)!.timestamp,
          moments: moments.list,
        }
      : undefined,
  };
  return kept;
}

// An event a line, in a buffer of its own to hand over whole (a whole session may pass the longest string V8 makes,
// so it's put together a few events at a time: a canvas frame is tens of KB)
function lined(events: RecordedEvent[]) {
  const parts: Buffer[] = [];
  for (let i = 0; i < events.length; i += LINES_A_PART)
    parts.push(
      Buffer.from(
        events
          .slice(i, i + LINES_A_PART)
          .map(event => `${JSON.stringify(event)}\n`)
          .join(''),
      ),
    );
  const ndjson = Buffer.allocUnsafeSlow(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) offset += part.copy(ndjson, offset);
  return ndjson;
}
const LINES_A_PART = 64;
