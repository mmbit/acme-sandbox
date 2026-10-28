// Answers on the book's notes (booknotes.ts has the notes and sheets):
//   - A note whose words end in a question mark asks now: its owner answers it within seconds in a quick run (chat.ts),
//     outside the queue, and the answer is clipped onto the note as a slip. Only a note the board wrote in HQ asks: one
//     a product page's own code could have posted proves nothing until the board's send (feedback.ts).
//   - Words the board types in a box on a page that end in a question mark ask the same way, and the answer is typed onto
//     the page under them (booktyped.ts.).
//   - A slip: an agent's answer on a note (hq answer), with a picture or a preview's link if it has one. A tick closes
//     it; anything written under it is a reply, a new note on the owner's sheet, anchored where the note was.
//   - A slip can name an artifact (hq answer --artifact): what it made that runs, shown on the slip as artifacts.ts lists
//     it, its running preview and its cover, once it's there (merged and running). And "now": a cut of the note's place
//     from the live page, kept from before rule zero (HQ cut it while the note's hairline showed there; nothing of a
//     note is on a page now), beside the snip the board marked ("then").
//   - A slip clipped on, ticked or opened again is a 'book' event, so HQ reads the book again at once.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
// (inOneStep)
import { db, inOneStep, lacks, once, redacted } from '../db.ts'; // (lacks, once)
import { publish } from '../events.ts';
import { ceo } from '../company.ts';
import { findAgent, jobAgent, notePage, type Reader } from '../jobs.ts';
import * as feedback from '../feedback.ts';
import { onQuickRun, quickRun } from '../chat.ts';
import { keepFile } from '../uploads.ts';
import { BOARD } from './book.ts';
import { addNote, note, sheetRow, shown, type Note } from './booknotes.ts';
import { keep } from './booksheets.ts';
import { dataUrlPicture, isRefused, type Refused } from '../pagechecks.ts';
import { DIR, notFound, serveFile } from '../pagescraps.ts';
import * as artifacts from '../artifacts.ts';

const SLIP_MAX = 4000,
  LINK_MAX = 500;
// (job: the run that answered. ticked: when the board ticked it. artifact: the id of what it made that runs, as
// artifacts.ts lists it; now, now_at: the note's place cut again from the live page, its file and when.)
db.exec(`create table if not exists book_slips (id integer primary key autoincrement, note integer not null, by text not null,
  job integer, text text not null, picture text, link text, created text not null, ticked text, artifact text, now text,
  now_at text);
  create index if not exists book_slips_note on book_slips (note)`);
once('2026-10-26-book-slips-previews', () => {
  for (const column of ['artifact', 'now', 'now_at'])
    if (lacks('book_slips', column)) db.exec(`alter table book_slips add column ${column} text`);
});
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
  artifact: string | null;
  now: string | null;
  now_at: string | null;
};
// An artifact's id as artifacts.ts makes them: an app's slug, top/path for an artifact.yaml, a company artifact's open
// (an address, hence the colon).
const ARTIFACT = /^[A-Za-z0-9._/:-]{1,200}$/;

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
// ("If only the board can decide it, ask with hq ask ... --note")
const questionBrief = (text: string) => `The board wrote a question on a page in HQ, in its book, for you. Answer it \
now: your final message is the answer, exactly as the board reads it, clipped onto its note. Plain words, the answer \
first, about 60 words. \`hq note <id>\` saves the note's snip (the page around its mark) if the words don't say \
enough. If it needs work rather than an answer, say what you'd do: the board sends it with its sheet. Don't queue \
work or change files. If only the board can decide it, ask with \`hq ask ... --note <id>\` (a card clipped under the \
note in its book, and on its desk phone) and say so in your answer: an answer that ends in a question asks nothing.

${text}`;
// Its answer, clipped on (a run that failed leaves the note as it was: the board asks again)
onQuickRun(QUESTION, (job, status, result) => {
  const n = db.prepare('select * from book_notes where asked = ?').get(job) as Note | undefined;
  if (!n || status !== 'done' || !result) return;
  addSlip(n.id, jobAgent(job) ?? ceo(), job, result);
});

// ---------------------------------------------------------------- slips
// POST /api/agent/answer { note, text, picture?, link?, artifact? } (hq answer): an agent's answer clipped onto a note
// the board sent it (note: its number in the job's brief, a sent note's on HQ). The agent whose job holds the note
// answers it. It's the note answered too (feedback.ts markAnswered's), unless the job marked it fixed or answered: a job
// that ends without marking it doesn't send it back to routing. (artifact, answered)
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
  const artifact = b.artifact ?? null;
  if (
    artifact !== null &&
    !(typeof artifact === 'string' && ARTIFACT.test(artifact) && !artifact.split('/').includes('..'))
  )
    return [400, "an artifact is its id, as HQ's artifacts list it: an app's slug, or a path"] as Refused;
  // (the slip and the note answered in one step)
  return inOneStep(() => {
    const slip = addSlip(n.id, me.agent, me.id || null, text, { picture, link, artifact });
    feedback.answeredInBook(n.review!, text);
    return { slip };
  });
}
// (more: an answer's picture, link and artifact.)
type More = { picture?: { type: string; clean: Buffer } | null; link?: string | null; artifact?: string | null };
function addSlip(noteId: number, by: string, job: number | null, text: string, more: More = {}) {
  const id = Number(
    db
      .prepare('insert into book_slips (note, by, job, text, link, artifact, created) values (?, ?, ?, ?, ?, ?, ?)')
      .run(noteId, by, job, text, more.link ?? null, more.artifact ?? null, new Date().toISOString()).lastInsertRowid,
  );
  if (more.picture) {
    db.prepare('update book_slips set picture = ? where id = ?').run(keepPicture(`slip${id}`, more.picture), id);
  }
  publish({ type: 'log', agent: by, text: `An answer clipped onto a note in the board's book` });
  // (the page its note's group is on, read again)
  publish({ type: 'book', agent: by, text: 'slip', ...notePage(noteId) });
  return slipOf(db.prepare('select * from book_slips where id = ?').get(id) as Slip);
}
// A slip's picture kept as a file in the book's folder: its name.
function keepPicture(name: string, picture: { type: string; clean: Buffer }) {
  const file = `${name}-${randomBytes(4).toString('hex')}.${picture.type === 'image/png' ? 'png' : 'jpg'}`;
  keepFile(`${DIR}/${file}`, picture.clean);
  return file;
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
  publish({ type: 'book', agent: slip.by, text: 'slip', ...notePage(slip.note) });
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
// GET /api/book/slip/picture?id=<slip>, and GET /api/book/slip/now?id=<slip> (its "now": which)
export function serveSlipPicture(
  req: IncomingMessage,
  res: ServerResponse,
  who = BOARD,
  which: 'picture' | 'now' = 'picture',
) {
  const slip = slipRow(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('id')), who);
  const file = slip?.[which];
  if (!file || !existsSync(`${DIR}/${file}`)) return notFound(res);
  serveFile(res, file);
}

// A note's slips, as HQ reads them (listed: the artifacts as this read of the book lists them)
export const slipsOf = (note: number, listed = listedOnce()) =>
  (db.prepare('select * from book_slips where note = ? order by id').all(note) as Slip[]).map(s => slipOf(s, listed));
// The artifacts, listed once for a whole read of the book (its sheets, a page's notes, a note) and only once a slip names
// one: artifacts.ts walks the repository for them, on the coordinator's event loop.
export type Listed = () => artifacts.Artifact[];
export const listedOnce = (): Listed => {
  let listed: artifacts.Artifact[] | undefined;
  return () => (listed ??= artifacts.list());
};
const slipRow = (id: number, who: string) => {
  const slip = db.prepare('select * from book_slips where id = ?').get(id) as Slip | undefined;
  return slip && sheetRow(note(slip.note)!.sheet, who) ? slip : undefined;
};
// (preview, now, now_at)
const slipOf = (s: Slip, listed = listedOnce()) => ({
  id: s.id,
  note: s.note,
  by: s.by,
  name: findAgent(s.by)?.name ?? s.by,
  text: s.text,
  picture: s.picture ? `/api/book/slip/picture?id=${s.id}` : null,
  link: s.link,
  preview: s.artifact ? previewOf(s.artifact, listed()) : null,
  now: s.now && s.now_at ? `/api/book/slip/now?id=${s.id}&v=${Date.parse(s.now_at).toString(36)}` : null,
  now_at: s.now ? s.now_at : null,
  created: s.created,
  ticked: s.ticked,
});
// The artifact a slip names, as HQ shows it: its running preview (open) and cover (picture, HQ's address), or pending
// while it isn't listed yet (the work that answered is still in review, or not running).
function previewOf(id: string, listed: artifacts.Artifact[]) {
  const a = listed.find(x => x.id === id);
  return a ? { name: a.name, open: a.open, picture: a.picture } : { pending: true as const };
}
