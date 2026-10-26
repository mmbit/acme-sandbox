// The book's sheets and notes (book.ts has the pages, bookslips.ts the answers). A mark on a page is a note: its snip (a picture of the page
// around it), its anchor (pagechecks.ts: where it is, its ink) and its words, spoken, typed or written. A note joins
// its page owner's sheet, one open sheet an owner (a free page's notes: the sheet of pages nobody owns), numbered there
// as the page shows it. Nothing on a sheet reaches anyone until the board sends it:
//   - Send takes effect SEND_MS later; Undo before then takes it back. Then the sheet goes to its owner as one task, the
//     notes in its brief, or, nobody's, to the CEO's routing check as review notes do (routing.ts). Each note is kept as
//     a sent note on HQ too (feedback.ts fromBook): Reviews lists it, and the job it went to reads it and its snip with
//     hq note. A sent sheet is the board's word (jobs.ts BOARD_CALL), so paced seats take it. It stays in the day, sent.
//   - A note whose words end in a question mark asks now, and answers clip onto notes as slips (bookslips.ts).
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db, inOneStep, redacted } from './db.ts';
import { publish } from './events.ts';
import { ceo, names, roles } from './company.ts';
import { createJob, findAgent, NoSeat } from './jobs.ts';
import * as feedback from './feedback.ts';
import * as routing from './routing.ts';
import { keepFile } from './uploads.ts';
import { BOARD, notFound, row as pageRow, serveFile } from './book.ts';
import { anchorOf, asks, dataUrlPicture, isRefused, wordsOf, type Anchor, type Refused } from './pagechecks.ts';
import { DIR } from './pagescraps.ts';
import { ask, slipsOf } from './bookslips.ts';
import { onCall } from './bookcalls.ts';

// The ten seconds to undo a send, and how many notes a sheet holds (its task's brief quotes each)
export const SEND_MS = 10_000;
const MAX_NOTES = 200;
// (by: who wrote it, the board or an invited person. review: its sent note on HQ, feedback.ts, once it went to a job.
// asked: its question's quick run. answers: the slip it's a reply under.)
db.exec(`create table if not exists book_notes (id integer primary key autoincrement, sheet integer not null,
  page integer not null, n integer not null, by text not null, anchor text not null, words text not null default '',
  said text, snip text, status text not null default 'open', created text not null, updated text not null,
  review integer, asked integer, answers integer);
  create index if not exists book_notes_sheet on book_notes (sheet, n);
  create index if not exists book_notes_page on book_notes (page);
  create index if not exists book_notes_review on book_notes (review) where review is not null;
  create index if not exists book_notes_asked on book_notes (asked) where asked is not null`);
redacted('book_notes', 'anchor', 'words', 'said');

type Sheet = {
  id: number;
  who: string;
  owner: string | null;
  status: string;
  created: string;
  send_at: number | null;
  sent: string | null;
  job: number | null;
};
export type Note = {
  id: number;
  sheet: number;
  page: number;
  n: number;
  by: string;
  anchor: string;
  words: string;
  said: string | null;
  snip: string | null;
  status: string;
  created: string;
  updated: string;
  review: number | null;
  asked: number | null;
  answers: number | null;
};

// ---------------------------------------------------------------- notes (the board's, HQ session)
// POST /api/book/note { page, anchor, words?, said?, snip?, to?, by? }: a note on a page of the book, on its owner's
// open sheet (to: another agent's, or null for the pages nobody owns' sheet). asking: whether its words may ask now
// (the board's own, in HQ). { note, sheet, asked }: asked, its question's quick run.
// A call's page's notes go on the call's own sheet, never sent, and ask nothing: the agent on the call is the one
// listening; by: its agent, for the agent's ink (bookcalls.ts).
// (answers: the slip it's a reply under, replyTo's)
export function addNote(b: any, who = BOARD, asking = true, answers: number | null = null) {
  const page = pageRow(Number(b?.page), who);
  if (!page) return 404;
  const anchor = anchorOf(b.anchor);
  if (isRefused(anchor)) return anchor;
  const said = wordsOf(b.words, b.said);
  if (isRefused(said)) return said;
  const snip = b.snip == null ? null : dataUrlPicture(b.snip);
  if (isRefused(snip)) return snip;
  const call = page.kind === 'call' ? onCall(page, b.by, who) : null;
  if (isRefused(call)) return call;
  if (!call && b.by !== undefined) return [400, "only a call's page has notes by its agent"] as Refused;
  const owner = b.to === undefined ? page.owner : b.to;
  if (!call && owner !== null && !(typeof owner === 'string' && findAgent(owner)))
    return [400, 'to is an agent, or null for nobody'] as Refused;
  const sheet = call ? sheetRow(call.sheet, who)! : openSheet(who, owner);
  if (count(sheet.id) >= MAX_NOTES) return [413, `a sheet holds ${MAX_NOTES} notes: send it first`] as Refused;
  const id = insertNote(sheet.id, page.id, call?.by ?? who, anchor, said, snip, answers);
  const asked = asking && !call && asks(said.words) ? ask(id) : null;
  return { note: shown(note(id)!), sheet: sheetOf(sheet.id), asked };
}
function insertNote(
  sheet: number,
  page: number,
  by: string,
  anchor: Anchor,
  said: { words: string; said: string | null },
  snip: { type: string; clean: Buffer } | null,
  answers: number | null,
) {
  const now = new Date().toISOString(),
    n = count(sheet) + 1;
  const id = Number(
    db
      .prepare(
        `insert into book_notes (sheet, page, n, by, anchor, words, said, created, updated, answers)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sheet, page, n, by, JSON.stringify(anchor), said.words, said.said, now, now, answers).lastInsertRowid,
  );
  if (snip) {
    const file = `n${id}-${randomBytes(4).toString('hex')}.${snip.type === 'image/png' ? 'png' : 'jpg'}`;
    keepFile(`${DIR}/${file}`, snip.clean);
    db.prepare('update book_notes set snip = ? where id = ?').run(file, id);
  }
  return id;
}
// POST /api/book/note/edit { id, words?, said?, anchor? }: an open note corrected (a word written over, the mark moved).
// Words that newly end in a question mark ask now, unless it's a call's.
export function editNote(b: any, who = BOARD) {
  const n = openNote(Number(b?.id), who);
  if (!n) return 404;
  const said = b.words === undefined ? { words: n.words, said: n.said } : wordsOf(b.words, b.said);
  if (isRefused(said)) return said;
  const anchor = b.anchor === undefined ? JSON.parse(n.anchor) : anchorOf(b.anchor);
  if (isRefused(anchor)) return anchor;
  db.prepare('update book_notes set words = ?, said = ?, anchor = ?, updated = ? where id = ?').run(
    said.words,
    said.said,
    JSON.stringify(anchor),
    new Date().toISOString(),
    n.id,
  );
  const call = sheetRow(n.sheet, who)!.status === 'call';
  const asked = !call && asks(said.words) && !asks(n.words) ? ask(n.id) : null;
  return { note: shown(note(n.id)!), asked };
}
// POST /api/book/note/move { id, to }: an open note onto another owner's sheet (to: an agent, or null for nobody),
// last there. A call's note stays on its call's page's sheet.
export function moveNote(b: any, who = BOARD) {
  const n = openNote(Number(b?.id), who);
  if (!n) return 404;
  if (sheetRow(n.sheet, who)!.status === 'call')
    return [409, "a call's note stays on its call's page: the agent on the call heard it"] as Refused;
  if (b.to !== null && !(typeof b.to === 'string' && findAgent(b.to)))
    return [400, 'to is an agent, or null for nobody'] as Refused;
  const to = openSheet(who, b.to);
  if (to.id === n.sheet) return { note: shown(n), sheet: sheetOf(to.id) };
  if (count(to.id) >= MAX_NOTES) return [413, `a sheet holds ${MAX_NOTES} notes: send it first`] as Refused;
  inOneStep(() => {
    db.prepare('update book_notes set sheet = ?, n = ?, updated = ? where id = ?').run(
      to.id,
      count(to.id) + 1,
      new Date().toISOString(),
      n.id,
    );
    renumber(n.sheet);
  });
  return { note: shown(note(n.id)!), sheet: sheetOf(to.id) };
}
// POST /api/book/note/delete { id }: an open note wiped, its snip with it
export function wipeNote(id: number, who = BOARD) {
  const n = openNote(id, who);
  if (!n) return 404;
  if (n.snip) rmSync(`${DIR}/${n.snip}`, { force: true });
  inOneStep(() => {
    db.prepare('delete from book_notes where id = ?').run(n.id);
    renumber(n.sheet);
  });
  return { ok: true };
}
// POST /api/book/sheet/order { id, notes: [ids] }: the open sheet's notes in a new order, numbered again from 1
export function orderSheet(b: any, who = BOARD) {
  const s = sheetRow(Number(b?.id), who);
  if (!s || s.status === 'sent') return 404;
  const ids = Array.isArray(b.notes) ? b.notes.map(Number) : [];
  const now = notesOf(s.id).map(n => n.id);
  if (ids.length !== now.length || new Set(ids).size !== ids.length || !ids.every((id: number) => now.includes(id)))
    return [400, "notes is every one of the sheet's notes, once each, in their new order"] as Refused;
  inOneStep(() =>
    ids.forEach((id: number, i: number) => db.prepare('update book_notes set n = ? where id = ?').run(i + 1, id)),
  );
  return sheetOf(s.id);
}
// GET /api/book/notes?page=: the notes on a page, each with its slips
export function pageNotes(page: number, who = BOARD) {
  if (!pageRow(page, who)) return 404;
  return { notes: (db.prepare('select * from book_notes where page = ? order by id').all(page) as Note[]).map(shown) };
}
// GET /api/book/snip?id=<note>: a note's snip
export function serveSnip(req: IncomingMessage, res: ServerResponse, who = BOARD) {
  const n = note(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('id')));
  if (!n?.snip || !sheetRow(n.sheet, who) || !existsSync(`${DIR}/${n.snip}`)) return notFound(res);
  serveFile(res, n.snip);
}

// ---------------------------------------------------------------- sheets and sending
// GET /api/book/sheets: the open sheets (and those in their seconds to undo), then the latest SENT_LISTED sent, each
// with its notes and their slips
const SENT_LISTED = 30;
export function sheets(who = BOARD) {
  deliverDue();
  const open = db
    .prepare("select id from book_sheets where who = ? and status in ('open', 'sending') order by id")
    .all(who) as {
    id: number;
  }[];
  const sent = db
    .prepare("select id from book_sheets where who = ? and status = 'sent' order by id desc limit ?")
    .all(who, SENT_LISTED) as { id: number }[];
  return { open: open.map(s => sheetOf(s.id)), sent: sent.map(s => sheetOf(s.id)) };
}
// POST /api/book/send { id }: the sheet goes in SEND_MS, unless it's undone first
export function send(id: number, who = BOARD) {
  const s = sheetRow(id, who);
  if (!s || s.status === 'sent') return 404;
  if (s.status === 'call') return [409, "a call's notes stay on its page: the agent on the call heard them"] as Refused;
  if (!count(s.id)) return [409, 'nothing on this sheet to send'] as Refused;
  if (s.status === 'open')
    db.prepare("update book_sheets set status = 'sending', send_at = ? where id = ?").run(Date.now() + SEND_MS, s.id);
  setTimeout(deliverDue, SEND_MS + 50).unref();
  return sheetOf(s.id);
}
// POST /api/book/undo { id }: a send taken back within its seconds; the sheet is open again
export function undo(id: number, who = BOARD) {
  const s = sheetRow(id, who);
  if (!s) return 404;
  if (s.status === 'sending' && s.send_at! > Date.now())
    db.prepare("update book_sheets set status = 'open', send_at = null where id = ? and status = 'sending'").run(s.id);
  else if (s.status !== 'open') return [409, 'too late to undo: the sheet has gone'] as Refused;
  return sheetOf(s.id);
}
// Every send whose seconds are over goes now: at a send's own timer, at the server's start (one cut off by a restart),
// and before the sheets are read
export function deliverDue(now = Date.now()) {
  const due = db.prepare("select id from book_sheets where status = 'sending' and send_at <= ?").all(now) as {
    id: number;
  }[];
  for (const s of due)
    try {
      inOneStep(() => deliver(s.id));
    } catch (err) {
      // (it stays sending, tried again at the next read or start: never thrown from a send's timer)
      console.error(`Sheet #${s.id}: not delivered:`, err);
    }
}
function deliver(id: number) {
  const s = db.prepare("select * from book_sheets where id = ? and status = 'sending'").get(id) as Sheet | undefined;
  if (!s) return;
  const notes = notesOf(s.id);
  if (!notes.length) return void db.prepare('delete from book_sheets where id = ?').run(s.id);
  const pages = [...new Set(notes.map(n => n.page))].map(p => pageRow(p, null)!);
  const place = pages
    .map(p =>
      p.url ? `${p.url}${p.label ? ` (“${p.label}”)` : ''}` : `page #${p.id}${p.label ? ` “${p.label}”` : ''}`,
    )
    .join(', ');
  const kept = notes.map(n => keep(n, null));
  // (one that can't run on any seat goes to the CEO's check too, which passes it on: jobs.ts NoSeat)
  let job: number | null = null;
  if (s.owner)
    try {
      job = createJob({
        agent: s.owner,
        title: `The board's notes on ${place}`.slice(0, 200),
        prompt: taskBrief(kept.map(k => k.text)),
      }).id;
    } catch (err) {
      if (!(err instanceof NoSeat)) throw err;
    }
  const hq = names().hq;
  job ??= routing.queue(
    kept.map(k => ({
      id: k.id,
      slug: feedback.HQ,
      owner: s.owner ?? roles().process,
      name: hq,
      place: `${hq} (platform/hq)`,
      returns: false,
      text: k.text,
    })),
  );
  for (const k of kept) feedback.fromBook(k.from, job);
  db.prepare("update book_sheets set status = 'sent', sent = ?, job = ?, send_at = null where id = ?").run(
    new Date().toISOString(),
    job,
    s.id,
  );
  db.prepare("update book_notes set status = 'sent' where sheet = ? and status = 'open'").run(s.id);
  publish({
    type: 'log',
    agent: s.owner ?? ceo(),
    text: `The board sent a sheet of ${notes.length} note${notes.length === 1 ? '' : 's'} from its book: job #${job}`,
  });
}
// A note as a sent note on HQ (feedback.ts fromBook), its id there kept on it: { id, text, from }: from, to give it to
// its job once there is one
export function keep(n: Note, job: number | null) {
  const a = JSON.parse(n.anchor) as Anchor;
  const from = { url: a.url, words: n.words, el: a.el, view: a.view, snip: n.snip, review: n.review };
  const kept = feedback.fromBook(from, job);
  db.prepare('update book_notes set review = ? where id = ?').run(kept.id, n.id);
  return { ...kept, from: { ...from, review: kept.id } };
}
const taskBrief = (
  texts: string[],
) => `The board wrote ${texts.length === 1 ? 'a note' : `${texts.length} notes`} on your work in \
its book (the Pencil on HQ's pages) and sent ${texts.length === 1 ? 'it' : 'them'} to you as one sheet: ${texts.length === 1 ? 'it is' : 'they are'} \
yours to take on, as one piece of work. \`hq note <id>\` saves a note's snip (the page around the mark, the ink on it) \
as a picture to look at.

When a note is done or answered, clip your answer onto it: \`hq answer <id> "what you did, or the answer"\` (plain \
words for the board, a sentence or two; \`--picture <file>\` or \`--link <preview url>\` to show it). The board ticks \
it, or writes a reply under it, which comes back to you as a new note.

${texts.join('\n\n')}`;

// ---------------------------------------------------------------- shared
// The open sheet (or the one in its seconds to undo) of an owner's in a book, made if there's none
function openSheet(who: string, owner: string | null) {
  const found = db
    .prepare("select * from book_sheets where who = ? and owner is ? and status in ('open', 'sending')")
    .get(who, owner) as Sheet | undefined;
  if (found) return found;
  const id = db
    .prepare('insert into book_sheets (who, owner, created) values (?, ?, ?)')
    .run(who, owner, new Date().toISOString()).lastInsertRowid;
  return db.prepare('select * from book_sheets where id = ?').get(id) as Sheet;
}
export const sheetRow = (id: number, who: string | null) =>
  db.prepare('select * from book_sheets where id = ? and (? is null or who = ?)').get(id, who, who) as
    Sheet | undefined;
export const note = (id: number) => db.prepare('select * from book_notes where id = ?').get(id) as Note | undefined;
const openNote = (id: number, who: string) => {
  const n = note(id);
  return n && n.status === 'open' && sheetRow(n.sheet, who)?.status !== 'sent' ? n : undefined;
};
const notesOf = (sheet: number) =>
  db.prepare("select * from book_notes where sheet = ? and status = 'open' order by n").all(sheet) as Note[];
const count = (sheet: number) =>
  (db.prepare("select count(*) n from book_notes where sheet = ? and status = 'open'").get(sheet) as { n: number }).n;
// The sheet's open notes numbered 1, 2, … in their order, after one left it
function renumber(sheet: number) {
  notesOf(sheet).forEach((n, i) => db.prepare('update book_notes set n = ? where id = ?').run(i + 1, n.id));
  db.prepare(
    "delete from book_sheets where id = ? and status in ('open', 'call') and not exists (select 1 from book_notes where sheet = ?)",
  ).run(sheet, sheet);
}
// What HQ reads of a sheet, a note and a slip
function sheetOf(id: number) {
  const s = db.prepare('select * from book_sheets where id = ?').get(id) as Sheet;
  const notes = db.prepare('select * from book_notes where sheet = ? order by n').all(id) as Note[];
  const name = s.owner ? (findAgent(s.owner)?.name ?? s.owner) : null;
  return {
    id: s.id,
    owner: s.owner,
    name,
    status: s.status,
    created: s.created,
    send_at: s.send_at,
    sent: s.sent,
    job: s.job,
    notes: notes.map(shown),
  };
}
export function shown(n: Note) {
  return {
    id: n.id,
    sheet: n.sheet,
    page: n.page,
    n: n.n,
    by: n.by,
    anchor: JSON.parse(n.anchor) as Anchor,
    words: n.words,
    said: n.said,
    snip: n.snip ? `/api/book/snip?id=${n.id}` : null,
    status: n.status,
    created: n.created,
    updated: n.updated,
    asked: n.asked,
    answers: n.answers,
    slips: slipsOf(n.id),
  };
}

deliverDue();
