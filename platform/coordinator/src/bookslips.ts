// Answers on the book's notes (booknotes.ts has the notes and sheets):
//   - A note whose words end in a question mark asks now: its owner answers it within seconds in a quick run (chat.ts),
//     outside the queue, and the answer is clipped onto the note as a slip. Only a note the board wrote in HQ asks: one
//     a product page's own code could have posted proves nothing until the board's send (feedback.ts).
//   - A slip: an agent's answer on a note (hq answer), with a picture or a preview's link if it has one. A tick closes
//     it; anything written under it is a reply, a new note on the owner's sheet, anchored where the note was.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db, redacted } from './db.ts';
import { publish } from './events.ts';
import { ceo } from './company.ts';
import { findAgent, jobAgent, type Reader } from './jobs.ts';
import * as feedback from './feedback.ts';
import { onQuickRun, quickRun } from './chat.ts';
import { keepFile } from './uploads.ts';
import { BOARD, notFound, serveFile } from './book.ts';
import { addNote, keep, note, sheetRow, shown, type Note } from './booknotes.ts';
import { dataUrlPicture, isRefused, type Refused } from './pagechecks.ts';
import { DIR } from './pagescraps.ts';

const SLIP_MAX = 4000,
  LINK_MAX = 500;
// (job: the run that answered. ticked: when the board ticked it.)
db.exec(`create table if not exists book_slips (id integer primary key autoincrement, note integer not null, by text not null,
  job integer, text text not null, picture text, link text, created text not null, ticked text);
  create index if not exists book_slips_note on book_slips (note)`);
redacted('book_slips', 'text', 'link');

type Slip = {
  id: number;
  note: number;
  by: string;
  job: number | null;
  text: string;
  picture: string | null;
  link: string | null;
  created: string;
  ticked: string | null;
};

// ---------------------------------------------------------------- a question now
// The owner's quick run (chat.ts): the note and how to see its snip; its final message is the slip.
const QUESTION = 'book-question';
export function ask(id: number) {
  const n = note(id)!,
    s = sheetRow(n.sheet, null)!,
    agent = s.owner ?? ceo();
  const kept = keep(n, null);
  const job = quickRun(agent, 'A question on a page in the board’s book', questionBrief(kept.text), QUESTION);
  feedback.fromBook(kept.from, job);
  db.prepare('update book_notes set asked = ? where id = ?').run(job, n.id);
  return job;
}
const questionBrief = (text: string) => `The board wrote a question on a page in HQ, in its book, for you. Answer it \
now: your final message is the answer, exactly as the board reads it, clipped onto its note. Plain words, the answer \
first, about 60 words. \`hq note <id>\` saves the note's snip (the page around its mark) if the words don't say \
enough. If it needs work rather than an answer, say what you'd do: the board sends it with its sheet. Don't queue \
work, change files or ask the board for it.

${text}`;
// Its answer, clipped on (a run that failed leaves the note as it was: the board asks again)
onQuickRun(QUESTION, (job, status, result) => {
  const n = db.prepare('select * from book_notes where asked = ?').get(job) as Note | undefined;
  if (!n || status !== 'done' || !result) return;
  addSlip(n.id, jobAgent(job) ?? ceo(), job, result, null, null);
});

// ---------------------------------------------------------------- slips
// POST /api/agent/answer { note, text, picture?, link? } (hq answer): an agent's answer clipped onto a note the board
// sent it (note: its number in the job's brief, a sent note's on HQ). The agent whose job holds the note answers it.
export function answer(b: any, me: Reader) {
  const n = db.prepare('select * from book_notes where review = ?').get(Number(b?.note)) as Note | undefined;
  const holder =
    n && (db.prepare('select job from review_notes where id = ?').get(n.review) as { job: number | null }).job;
  if (!n || !holder || jobAgent(holder) !== me.agent)
    return [404, `note ${b?.note} isn't one of the board's book notes sent to you`] as Refused;
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text || text.length > SLIP_MAX) return [400, `an answer is text, at most ${SLIP_MAX} characters`] as Refused;
  const link = b.link == null ? null : String(b.link);
  if (link !== null && !(/^https:\/\/[^\s]+$/.test(link) && link.length <= LINK_MAX))
    return [400, 'a link is an https address'] as Refused;
  const picture = b.picture == null ? null : dataUrlPicture(b.picture);
  if (isRefused(picture)) return picture;
  return { slip: addSlip(n.id, me.agent, me.id || null, text, picture, link) };
}
function addSlip(
  noteId: number,
  by: string,
  job: number | null,
  text: string,
  picture: { type: string; clean: Buffer } | null,
  link: string | null,
) {
  const id = Number(
    db
      .prepare('insert into book_slips (note, by, job, text, link, created) values (?, ?, ?, ?, ?, ?)')
      .run(noteId, by, job, text, link, new Date().toISOString()).lastInsertRowid,
  );
  if (picture) {
    const file = `slip${id}-${randomBytes(4).toString('hex')}.${picture.type === 'image/png' ? 'png' : 'jpg'}`;
    keepFile(`${DIR}/${file}`, picture.clean);
    db.prepare('update book_slips set picture = ? where id = ?').run(file, id);
  }
  publish({ type: 'log', agent: by, text: `An answer clipped onto a note in the board's book` });
  return slipOf(db.prepare('select * from book_slips where id = ?').get(id) as Slip);
}
// POST /api/book/slip/tick { id, ticked }: a tick closes the slip's note (false: open again)
export function tick(b: any, who = BOARD) {
  const slip = slipRow(Number(b?.id), who);
  if (!slip) return 404;
  if (typeof b.ticked !== 'boolean') return [400, 'ticked is true or false'] as Refused;
  db.prepare('update book_slips set ticked = ? where id = ?').run(b.ticked ? new Date().toISOString() : null, slip.id);
  const open = db.prepare('select 1 from book_slips where note = ? and ticked is null').get(slip.note);
  db.prepare(`update book_notes set status = ? where id = ? and status != 'open'`).run(
    open ? 'sent' : 'closed',
    slip.note,
  );
  return { slip: slipOf(slipRow(slip.id, who)!), note: shown(note(slip.note)!) };
}
// POST /api/book/slip/reply { id, words, said? }: writing under a slip, a new note on the owner's open sheet, anchored
// where the note was (a question asks now)
export function replyTo(b: any, who = BOARD) {
  const slip = slipRow(Number(b?.id), who);
  if (!slip) return 404;
  const n = note(slip.note)!,
    owner = sheetRow(n.sheet, null)!.owner;
  if (typeof b.words !== 'string' || !b.words.trim()) return [400, 'a reply has words'] as Refused;
  return addNote(
    { page: n.page, anchor: JSON.parse(n.anchor), words: b.words, said: b.said ?? 'written', to: owner },
    who,
    true,
    slip.id,
  );
}
// GET /api/book/slip/picture?id=<slip>
export function serveSlipPicture(req: IncomingMessage, res: ServerResponse, who = BOARD) {
  const slip = slipRow(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('id')), who);
  if (!slip?.picture || !existsSync(`${DIR}/${slip.picture}`)) return notFound(res);
  serveFile(res, slip.picture);
}

// A note's slips, as HQ reads them
export const slipsOf = (note: number) =>
  (db.prepare('select * from book_slips where note = ? order by id').all(note) as Slip[]).map(slipOf);
const slipRow = (id: number, who: string) => {
  const slip = db.prepare('select * from book_slips where id = ?').get(id) as Slip | undefined;
  return slip && sheetRow(note(slip.note)!.sheet, who) ? slip : undefined;
};
const slipOf = (s: Slip) => ({
  id: s.id,
  note: s.note,
  by: s.by,
  name: findAgent(s.by)?.name ?? s.by,
  text: s.text,
  picture: s.picture ? `/api/book/slip/picture?id=${s.id}` : null,
  link: s.link,
  created: s.created,
  ticked: s.ticked,
});
