// Handwriting read into type: the board's ink on HQ's page, while its mark's post-it is open (shared/review/written.js),
// goes here as a picture of the ink alone, and a small model says whether it's writing and what it says. The words come
// back to the post-it, editable there, and the note keeps them as said 'written' (the book shows and edits them too). The
// model decides what's writing: a ring, an arrow or a tick is none, whatever its strokes. The worker runs it on a Claude
// seat, one short call with no tools and the picture on stdin (worker.ts readLoop), as it does the meetings' bubbles.
// The picture is never stored: it lives in memory for the length of the board's request (a day's count is kept).
import { randomUUID } from 'node:crypto';
import { db } from './db.ts';
import { companyDay } from './company.ts';
import { redact } from './secrets.ts';
import { MODEL, answerOf } from './smallmodel.ts';
import { WORDS_MAX, dataUrlPicture, isRefused, type Refused } from './pagechecks.ts';

// The board's request waits WAIT_MS for the words (the post-it fills whenever they come, and a note already sent takes
// them as an edit). A claimed call that hasn't answered within CALL_MS has died (oneLine kills the CLI at 90 s): due again,
// TRIES calls in all.
const WAIT_MS = 120_000,
  CALL_MS = 95_000,
  TRIES = 2;
// Each reading spends a little of a Claude seat's window, which the company's jobs live on: READS_A_DAY bounds what a
// page left writing (or a client gone wrong) can take in a day, as the voice line bounds a call's pictures. A day's
// reading at the board's pace is a few dozen.
export const READS_A_DAY = 300;

db.exec('create table if not exists handwriting_reads (day text primary key, reads integer not null)');

export const SCHEMA = {
  type: 'object',
  properties: {
    writing: { type: 'boolean', description: 'whether the ink holds handwritten words' },
    words: {
      type: 'string',
      maxLength: WORDS_MAX,
      description: "the handwritten words as written, in their own language; '' when there are none",
    },
  },
  required: ['writing', 'words'],
  additionalProperties: false,
};
const PROMPT = `The picture is ink someone drew with a pen over a page of an app, the page itself left out: a note on what \
they saw there. A note can be marks (a ring round something, an arrow, a tick, a cross, an underline, a scribble), \
words written by hand, or both.

If there are handwritten words, write them out exactly as written: their language, spelling, capitals and punctuation, \
lines joined with a space, and leave the drawn marks out. A word you can't make out for sure: your best reading of it. \
If it's only marks, or nothing anyone wrote as words, writing is false and words is ''.`;

type Read = { writing: boolean; words: string };
type Reading = {
  id: string;
  ink: { type: string; data: string };
  claimed: number;
  tries: number;
  done: (r: Read | Refused) => void;
};
export type Claimed = { reading: string; model: string; content: unknown[]; schema: string };

// (ids unique across restarts: a worker's call outlives the coordinator, and its answer must not meet a later reading's id)
const readings: Reading[] = [];

// POST /api/book/read { ink }: the words in the board's ink (a PNG or JPEG data URL), { writing, words }, once the model
// has read it. 429 past the day's readings, 504 when no answer came in time, 502 when the model's answers were no use.
export async function read(b: any): Promise<Read | Refused> {
  const pic = dataUrlPicture(b?.ink);
  if (isRefused(pic)) return pic;
  const day = companyDay(Date.now());
  const { reads } = (db.prepare('select reads from handwriting_reads where day = ?').get(day) as { reads: number }) ?? {
    reads: 0,
  };
  if (reads >= READS_A_DAY) return [429, `handwriting is read ${READS_A_DAY} times a day, and today's are used`];
  db.prepare(
    'insert into handwriting_reads (day, reads) values (?, 1) on conflict (day) do update set reads = reads + 1',
  ).run(day);
  db.prepare('delete from handwriting_reads where day < ?').run(companyDay(Date.now() - 7 * 864e5));
  return new Promise(resolve => {
    const r: Reading = {
      id: randomUUID(),
      ink: { type: pic.type, data: pic.clean.toString('base64') },
      claimed: 0,
      tries: 0,
      done: answer => {
        clearTimeout(late);
        readings.splice(readings.indexOf(r), 1);
        resolve(answer);
      },
    };
    const late = setTimeout(() => r.done([504, 'the handwriting reader gave no answer in time']), WAIT_MS);
    readings.push(r);
  });
}

// POST /api/worker/reads/claim: the next ink to read, with the model's prompt (the picture and the words) and the
// answer's schema; null while there's none.
export function claim(now = Date.now()): Claimed | null {
  const r = readings.find(x => !x.claimed || (x.claimed <= now - CALL_MS && x.tries < TRIES));
  if (!r) return null;
  r.claimed = now;
  r.tries++;
  const image = { type: 'image', source: { type: 'base64', media_type: r.ink.type, data: r.ink.data } };
  return {
    reading: r.id,
    model: MODEL,
    content: [image, { type: 'text', text: PROMPT }],
    schema: JSON.stringify(SCHEMA),
  };
}

// POST /api/worker/reads/answer: the model's reading, or the call's failure (due again while it has tries left)
export function answer(given: { reading?: unknown; result?: unknown; error?: unknown }) {
  const r = readings.find(x => x.id === given.reading);
  if (!r) return { written: 0, why: 'no reading waits for it' };
  const a = given.error === undefined ? readAnswer(given.result) : 'the call failed';
  if (typeof a === 'string') {
    console.error(
      `Handwriting: reading ${r.id} failed: ${a}${given.error ? `: ${redact(String(given.error)).slice(-200)}` : ''}`,
    );
    if (r.tries < TRIES) r.claimed = 0;
    else r.done([502, "the handwriting reader couldn't read it"]);
    return { written: 0, why: a };
  }
  r.done(a);
  return { written: 1 };
}

function readAnswer(result: unknown): Read | string {
  const a = answerOf(result);
  if (typeof a === 'string') return a;
  if (typeof a.writing !== 'boolean' || typeof a.words !== 'string') return 'an answer without writing and words';
  const words = a.words.replace(/\s+/g, ' ').trim();
  if ([...words].length > WORDS_MAX) return 'words longer than a note holds';
  if (a.writing && !words) return 'writing without words';
  return a.writing ? { writing: true, words } : { writing: false, words: '' };
}
