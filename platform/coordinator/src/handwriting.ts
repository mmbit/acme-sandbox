// Handwriting read into type: the board's ink on HQ's page, while its mark's post-it is open (shared/review/written.js),
// goes here as a picture of the ink alone, and a small model says whether it's writing and what it says. The words come
// back to the post-it, editable there, and the note keeps them as said 'written' (the book shows and edits them too). The
// model decides what's writing: a ring, an arrow or a tick is none, whatever its strokes. The worker runs it on a Claude
// seat, one short call with no tools and the picture on stdin (worker.ts readLoop), as it does the meetings' bubbles.
// The picture is never stored: it lives in memory for the length of the board's request (a day's count is kept).
import { db } from './db.ts';
import { companyDay } from './company.ts';
import { answerOf, smallCall } from './smallmodel.ts';
import { WORDS_MAX, dataUrlPicture, isRefused, type Refused } from './pagechecks.ts';

// The board's request waits WAIT_MS for the words (the post-it fills whenever they come, and a note already sent takes
// them as an edit).
const WAIT_MS = 120_000;
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

export type Read = { writing: boolean; words: string };

// POST /api/book/read { ink }: the words in the board's ink (a PNG or JPEG data URL), { writing, words }, once the model
// has read it. 429 past the day's readings, 504 when no answer came in time, 502 when the model's answers were no use.
export async function read(b: any): Promise<Read | Refused> {
  const pic = dataUrlPicture(b?.ink);
  if (isRefused(pic)) return pic;
  return readPicture(pic);
}
// A picture of ink read, as the board's request reads it: the writing on a sheet page going with its notes reads this
// way too (bookwriting.ts). The call goes through the small model's queue (smallmodel.ts smallCall, the worker's
// claim and answer).
export async function readPicture(pic: { type: string; clean: Buffer }): Promise<Read | Refused> {
  const day = companyDay(Date.now());
  const { reads } = (db.prepare('select reads from handwriting_reads where day = ?').get(day) as { reads: number }) ?? {
    reads: 0,
  };
  if (reads >= READS_A_DAY) return [429, `handwriting is read ${READS_A_DAY} times a day, and today's are used`];
  db.prepare(
    'insert into handwriting_reads (day, reads) values (?, 1) on conflict (day) do update set reads = reads + 1',
  ).run(day);
  db.prepare('delete from handwriting_reads where day < ?').run(companyDay(Date.now() - 7 * 864e5));
  const image = { type: 'image', source: { type: 'base64', media_type: pic.type, data: pic.clean.toString('base64') } };
  return smallCall({
    name: 'the handwriting reader',
    content: [image, { type: 'text', text: PROMPT }],
    schema: SCHEMA,
    check: readAnswer,
    wait: WAIT_MS,
    failed: "the handwriting reader couldn't read it",
  });
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
