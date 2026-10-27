// The book's sheets and notes (book.ts has the pages, bookslips.ts the answers). A mark on a page is a note: its snip (a picture of the page
// around it, the mark's lines on it: the only place they're kept), its anchor (pagechecks.ts: where it is, its lines
// left out: rule zero, insertNote) and its words, spoken, typed or written. A note joins
// its page owner's sheet, one open sheet an owner (a free page's notes: the sheet of pages nobody owns), numbered there
// as the page shows it. Nothing on a sheet reaches anyone until the board sends it:
//   - Send takes effect SEND_MS later; Undo before then takes it back. Then the sheet goes to its owner as one task
//     (booksheets.ts).
//   - A note whose words end in a question mark asks now, and answers clip onto notes as slips (bookslips.ts).
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db, inOneStep, once } from './db.ts';
import { findAgent } from './jobs.ts';
import { keepFile } from './uploads.ts';
import { BOARD, row as pageRow } from './book.ts';
import { anchorOf, asks, dataUrlPicture, isRefused, wordsOf, type Anchor, type Refused } from './pagechecks.ts';
import { DIR, SWEEP_MS, notFound, serveFile } from './pagescraps.ts';
import { ask, listedOnce, slipsOf, type Listed } from './bookslips.ts'; // (listedOnce)
import { guestOf } from './sketchpeople.ts';
import { linksOf, setLink, unlink } from './booklinks.ts';
import { onCall } from './bookcalls.ts';
import { asksOn } from './bookasks.ts';

// The ten seconds to undo a send, and how many notes a sheet holds (its task's brief quotes each)
export const SEND_MS = 10_000;
const MAX_NOTES = 200;

export type Sheet = {
  id: number;
  who: string;
  owner: string | null;
  status: string;
  created: string;
  send_at: number | null;
  sent: string | null;
  job: number | null;
  page: number | null;
  notebook_page: number | null;
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

// The lines notes kept before rule zero, which HQ's pages drew again as marks and hairlines: gone, once (their snips have
// them).
export const forgetLines = () =>
  db
    .prepare(
      "update book_notes set anchor = json_set(anchor, '$.ink', json('[]')) where json_array_length(anchor, '$.ink') > 0",
    )
    .run().changes;
once('2026-10-27-book-notes-inkless', forgetLines);

// ---------------------------------------------------------------- notes (the board's, HQ session)
// POST /api/book/note { page, anchor, words?, said?, snip?, to?, by? }: a note on a page of the book, on its owner's
// open sheet (to: another agent's, or null for the pages nobody owns' sheet). asking: whether its words may ask now
// (the board's own, in HQ). { note, sheet, asked }: asked, its question's quick run.
// A call's page's notes go on the call's own sheet, never sent; the agent's ink is never a note (bookcalls.ts). The
// board's question there asks now as anywhere, the call's agent answering it on the page as well as on the line (the
// board on call #239: being on a call changes nothing about how the book works.)
// (answers: the slip it's a reply under, replyTo's. by: who wrote it, the book's own person unless an invited guest's
// note joins the board's sheet: 'guest:<grant>' (feedback.ts, a share's note). Only the board's own words ask now: a
// guest's question waits for the board's plane like the rest.)
export function addNote(b: any, who = BOARD, asking = true, answers: number | null = null, by = who) {
  const page = pageRow(Number(b?.page), who);
  if (!page) return 404;
  const anchor = anchorOf(b.anchor);
  if (isRefused(anchor)) return anchor;
  const said = wordsOf(b.words, b.said);
  if (isRefused(said)) return said;
  const snip = b.snip == null ? null : dataUrlPicture(b.snip);
  if (isRefused(snip)) return snip;
  // (a call's agent's ink isn't kept)
  if (b.by !== undefined) return [400, "a note is the book's own: by isn't given"] as Refused;
  const call = page.kind === 'call' ? onCall(page) : null;
  if (isRefused(call)) return call;
  const owner = b.to === undefined ? page.owner : b.to;
  if (!call && owner !== null && !(typeof owner === 'string' && findAgent(owner)))
    return [400, 'to is an agent, or null for nobody'] as Refused;
  const sheet = call ? sheetRow(call.sheet, who)! : openSheet(who, owner);
  if (count(sheet.id) >= MAX_NOTES) return [413, `a sheet holds ${MAX_NOTES} notes: send it first`] as Refused;
  const id = insertNote(sheet.id, page.id, by, anchor, said, snip, answers);
  const asked = asking && by === BOARD && asks(said.words) ? ask(id) : null; // (call: job #19916)
  return { note: shown(note(id)!), sheet: sheetOf(sheet.id), asked };
}
export function insertNote(
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
      .run(sheet, page, n, by, inkless(anchor), said.words, said.said, now, now, answers).lastInsertRowid,
  );
  if (snip) keepSnip(id, snip);
  return id;
}
// A note's anchor as it's kept: without the mark's lines, which live only in its snip, so nothing can draw them on a page
// again (rule zero, the board's, 2026-10-27)
const inkless = (anchor: Anchor) => JSON.stringify({ ...anchor, ink: [] });
// A note's snip kept as a file of its own
function keepSnip(id: number, snip: { type: string; clean: Buffer }) {
  const file = `n${id}-${randomBytes(4).toString('hex')}.${snip.type === 'image/png' ? 'png' : 'jpg'}`;
  keepFile(`${DIR}/${file}`, snip.clean);
  db.prepare('update book_notes set snip = ? where id = ?').run(file, id);
}
// POST /api/book/note/edit { id, words?, said?, was? }: an open note's words corrected (a word written over). Words that
// newly end in a question mark ask now, a call's too (job #19916). was: the words they replace, refused when the note has
// others by now (handwriting read late leaves the board's typed words.)
export function editNote(b: any, who = BOARD) {
  const n = openNote(Number(b?.id), who);
  if (!n) return 404;
  if (b.was !== undefined && b.was !== n.words)
    return [409, 'the note has other words by now: read it again'] as Refused;
  const said = b.words === undefined ? { words: n.words, said: n.said } : wordsOf(b.words, b.said);
  if (isRefused(said)) return said;
  db.prepare('update book_notes set words = ?, said = ?, updated = ? where id = ?').run(
    said.words,
    said.said,
    new Date().toISOString(),
    n.id,
  );
  // (a guest's note never asks, corrected or not, nor a call's agent's ink)
  const asked = n.by === BOARD && asks(said.words) && !asks(n.words) ? ask(n.id) : null;
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
    unlink(n.id);
    renumber(n.sheet);
  });
  return { note: shown(note(n.id)!), sheet: sheetOf(to.id) };
}
// POST /api/book/note/delete { id }: an open note wiped. It's kept aside as it was, its snip too, for Undo
// (restoreNote) as long as a page's taken-off pictures are (pagescraps.ts SWEEP_MS), then forgotten.
export function wipeNote(id: number, who = BOARD) {
  const n = openNote(id, who);
  if (!n) return 404;
  const owner = sheetRow(n.sheet, who)!.owner;
  inOneStep(() => {
    forgetWiped();
    db.prepare('insert into book_wiped (id, who, owner, sheet, note, wiped) values (?, ?, ?, ?, ?, ?)').run(
      ...[n.id, who, owner, n.sheet, JSON.stringify(n), Date.now()],
    );
    db.prepare('delete from book_notes where id = ?').run(n.id);
    unlink(n.id);
    renumber(n.sheet);
  });
  return { ok: true };
}
// POST /api/book/note/restore { id }: Undo of a wipe, the note back as it was, the same note: its writer (an invited
// guest's stays theirs), words, mark and snip. It goes last on its owner's open sheet (a call's note on its call's
// page's), and asks nothing again. On a sheet that's sending it counts as made now, so it stays behind (booksheets.ts
// deliver: only what was on the sheet at the plane's tap goes). { note, sheet }.
export function restoreNote(b: any, who = BOARD) {
  const w = db.prepare('select * from book_wiped where id = ? and who = ?').get(Number(b?.id), who) as
    { owner: string | null; sheet: number; note: string } | undefined;
  if (!w) return 404;
  const n = JSON.parse(w.note) as Note,
    was = sheetRow(w.sheet, who);
  const sheet = was?.status === 'call' ? was : openSheet(who, w.owner);
  if (count(sheet.id) >= MAX_NOTES) return [413, `a sheet holds ${MAX_NOTES} notes: send it first`] as Refused;
  inOneStep(() => {
    db.prepare(
      `insert into book_notes (id, sheet, page, n, by, anchor, words, said, snip, status, created, updated, review,
      asked, answers) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
    ).run(
      ...[n.id, sheet.id, n.page, count(sheet.id) + 1, n.by, n.anchor, n.words, n.said, n.snip],
      ...[sheet.status === 'sending' ? new Date().toISOString() : n.created, n.updated, n.review, n.asked, n.answers],
    );
    db.prepare('delete from book_wiped where id = ?').run(n.id);
  });
  return { note: shown(note(n.id)!), sheet: sheetOf(sheet.id) };
}
// The wiped notes past their Undo, and their snips: at each wipe, and as the server starts
function forgetWiped() {
  const old = db.prepare('select id, note from book_wiped where wiped < ?').all(Date.now() - SWEEP_MS) as {
    id: number;
    note: string;
  }[];
  for (const w of old) {
    const { snip } = JSON.parse(w.note) as Note;
    if (snip) rmSync(`${DIR}/${snip}`, { force: true });
    db.prepare('delete from book_wiped where id = ?').run(w.id);
  }
}
forgetWiped();
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
// POST /api/book/note/link { id, to, linked }: two open notes of one sheet linked (they go together), or no longer
// (booklinks.ts). The sheet.
export function linkNotes(b: any, who = BOARD) {
  const one = openNote(Number(b?.id), who),
    two = openNote(Number(b?.to), who);
  if (!one || !two) return 404;
  if (typeof b.linked !== 'boolean') return [400, 'linked is true or false'] as Refused;
  if (one.id === two.id) return [400, 'a note goes with another note, not itself'] as Refused;
  if (one.sheet !== two.sheet) return [400, 'notes go together on one sheet'] as Refused;
  setLink(one.id, two.id, b.linked);
  return sheetOf(one.sheet);
}
// GET /api/book/notes?page=: the notes on a page, each with its slips
export function pageNotes(page: number, who = BOARD) {
  if (!pageRow(page, who)) return 404;
  const listed = listedOnce();
  return {
    notes: (db.prepare('select * from book_notes where page = ? order by id').all(page) as Note[]).map(n =>
      shown(n, listed),
    ),
  };
}
// GET /api/book/snip?id=<note>: a note's snip
export function serveSnip(req: IncomingMessage, res: ServerResponse, who = BOARD) {
  const n = note(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('id')));
  if (!n?.snip || !sheetRow(n.sheet, who) || !existsSync(`${DIR}/${n.snip}`)) return notFound(res);
  serveFile(res, n.snip);
}

// ---------------------------------------------------------------- shared
// The open sheet (or the one in its seconds to undo) of an owner's in a book, made if there's none (never a page sent
// on its own's one-off, nor a notebook page's send's)
function openSheet(who: string, owner: string | null) {
  const found = db
    .prepare(
      "select * from book_sheets where who = ? and owner is ? and status in ('open', 'sending') and page is null and notebook_page is null",
    )
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
export const openNote = (id: number, who: string) => {
  const n = note(id);
  return n && n.status === 'open' && sheetRow(n.sheet, who)?.status !== 'sent' ? n : undefined;
};
export const notesOf = (sheet: number) =>
  db.prepare("select * from book_notes where sheet = ? and status = 'open' order by n").all(sheet) as Note[];
export const count = (sheet: number) =>
  (db.prepare("select count(*) n from book_notes where sheet = ? and status = 'open'").get(sheet) as { n: number }).n;
// The sheet's open notes numbered 1, 2, … in their order, after one left it
export function renumber(sheet: number) {
  notesOf(sheet).forEach((n, i) => db.prepare('update book_notes set n = ? where id = ?').run(i + 1, n.id));
  db.prepare(
    "delete from book_sheets where id = ? and status in ('open', 'call') and not exists (select 1 from book_notes where sheet = ?)",
  ).run(sheet, sheet);
}
// What HQ reads of a sheet, a note and a slip (listed: the artifacts as this read of the book lists them, bookslips.ts.
export function sheetOf(id: number, listed = listedOnce()) {
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
    // (a page sent on its own: that page.)
    page: s.page,
    notes: notes.map(n => shown(n, listed)),
  };
}
export function shown(n: Note, listed: Listed = listedOnce()) {
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
    slips: slipsOf(n.id, listed),
    // the notes it goes with
    links: linksOf(n.id),
    // an invited person's note on the board's sheet: their name tag and colour
    guest: guestOf(n.by),
    // the desk-phone cards about it, which the book shows under it
    asks: asksOn(n.id),
    // whose sheet it's on (null: nobody's), and whether that's a call's
    ...onSheet(n.sheet),
  };
}
const onSheet = (id: number) => {
  const s = sheetRow(id, null)!;
  return { owner: s.owner, onCall: s.status === 'call' };
};
