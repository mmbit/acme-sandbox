// A notebook page sent in: each of its groups goes to its agent as a note, the way the book's sheets go (booksheets.ts
// delivers them): the groups cut from one agent's work as one task for them, the rest through the CEO's routing check,
// which decides who takes each. SEND_MS to undo, then it's theirs; the page stays, read-only, marked sent, and a fresh
// page takes new groups. A reply written under an answer goes at once, with the same seconds to undo. Each send's sheets
// are its own (book_sheets.notebook_page), never an owner's batch on the old book's pages.
import { rmSync } from 'node:fs';
import { db, inOneStep } from './db.ts';
import { BOARD } from './ink/book.ts';
import { render } from './ink/bookrender.ts';
import { DIR } from './pagescraps.ts';
import { SEND_MS, insertNote, note, sheetRow, type Note } from './ink/booknotes.ts';
import { deliverDue } from './ink/booksheets.ts';
import {
  changed,
  gone,
  mine,
  newPage,
  openPageOf,
  pageOf,
  pageRow,
  shut,
  triesPageOfNote,
  type NotebookPage,
} from './notebook.ts';
import { groupOn, insertGroup, partsOf, putAside, rootOf, row, type Group } from './notebookgroups.ts';
import { boxOf } from './notebookparts.ts';
import { judgeLater } from './ink/bookjudge.ts';
import { frameOf, replySnip, sentSnip } from './ink/bookpick.ts';
import { inkOf, isRefused, wordsOf, type Anchor, type Refused } from './pagechecks.ts';

// Room round a group's picture, in page px
const PAD = 24;

// POST /api/notebooks/pages/send { id }: the page's groups go in SEND_MS, unless it's undone first
// (RESEND: a call's page sent at hang-up is sent again on it.)
export const RESEND = 'the page changed while it was being sent: send it again';
export async function sendPage(b: any, who = BOARD, stillOpen?: () => boolean) {
  const p = pageRow(Number(b?.id), who);
  if (!p) return 404;
  if (shut(p)) return [409, 'this page has been sent', 'pageSent'] as Refused;
  const sendable = () =>
    db
      .prepare(
        "select * from notebook_groups where page = ? and parent is null and deleted is null and status = 'open' order by id",
      )
      .all(p.id) as Group[];
  const groups = sendable();
  if (!groups.length) return [409, 'nothing on this page to send', 'pageEmpty'] as Refused;
  // (a tried group goes with the version the board picked beside it.)
  const snips = await Promise.all(groups.map(async g => (await sentSnip(g)) ?? snipOf(g)));
  // (a group changed, gone or added while its pictures were drawn: sent as the board sees it now, so read again)
  const now = pageRow(p.id, who),
    after = sendable();
  if (
    !now ||
    shut(now) ||
    after.length !== groups.length ||
    after.some((g, i) => g.id !== groups[i].id || g.updated !== groups[i].updated)
  )
    return [409, RESEND, 'pageChanged'] as Refused;
  if (stillOpen && !stillOpen()) return [403, 'this invitation has closed', 'invitationEnded'] as Refused;
  inOneStep(() => {
    db.prepare('update book_pages set send_at = ? where id = ?').run(asNotes(who, groups, snips), p.id);
    // (a fresh page only when no other is open: never a second blank one.)
    const fresh = openPageOf(p.notebook) === null ? newPage(p.notebook) : null;
    db.prepare('update book_pages set fresh = ? where id = ?').run(fresh, p.id);
    changed(p.notebook, p.id);
  });
  deliverLater();
  return pageOf(pageRow(p.id, who)!);
}
// Groups as notes on a sheet of this send's for each owner, their seconds started: when they go (inside inOneStep)
function asNotes(who: string, groups: Group[], snips: ({ type: string; clean: Buffer } | null)[]) {
  const sheets = new Map<string | null, number>();
  groups.forEach((g, i) => {
    const sheet = sheets.get(g.owner) ?? newSheet(who, g.owner, g.page);
    sheets.set(g.owner, sheet);
    const id = insertNote(sheet, g.page, g.by, anchorOf(g), saidOf(g), snips[i], null);
    db.prepare("update notebook_groups set status = 'sent', note = ? where id = ?").run(id, g.id);
  });
  // (its seconds start once its notes are on it: a sheet goes with what was on it at the tap, booksheets.ts deliver)
  const at = Date.now() + SEND_MS;
  for (const sheet of sheets.values())
    db.prepare("update book_sheets set status = 'sending', send_at = ? where id = ?").run(at, sheet);
  return at;
}

// ---------------------------------------------------------------- invited people's notes, sent for the board
// An invited person's note on a share waits in the board's My Notebook, an open
// scrap, until the board sends its page. hq guestnotes: the CEO lists those waiting (never their words) and, on the
// board's word, sends one owner's as the board's Send would, the board's own notes beside them left on the page.
const guestsWaiting = (who: string, owner?: string | null) =>
  (
    db
      .prepare(
        `select g.* from notebook_groups g join book_pages p on p.id = g.page join notebooks b on b.id = p.notebook
        where b.who = ? and b.kind = 'mine' and g.parent is null and g.deleted is null and g.status = 'open'
        and g.by like 'guest:%' order by g.id`,
      )
      .all(who) as Group[]
  ).filter(g => owner === undefined || g.owner === owner);
// GET /api/agent/guestnotes: for each owner, how many wait, on which pages, about which addresses, how many show nothing
// on their page (no picture, no words: carried from an old sheet without a snip) and since when. (mine(): the notes
// still on an old sheet carried in first, as the board's shelf does: notebookcarry.ts.)
export function guestNotes(who = BOARD) {
  mine(who);
  const owners = new Map<string | null, Group[]>();
  for (const g of guestsWaiting(who)) owners.set(g.owner, [...(owners.get(g.owner) ?? []), g]);
  return {
    owners: [...owners].map(([owner, groups]) => ({
      owner,
      notes: groups.length,
      pages: [...new Set(groups.map(g => g.page))],
      places: [...new Set(groups.map(g => addressOf(anchorOf(g).url)))],
      blank: groups.filter(g => !boxOf(partsOf(g))).length,
      since: groups[0].created,
    })),
  };
}
const addressOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '';
  }
};
// POST /api/agent/guestnotes/send { owner }: those waiting for owner (null: nobody's, the routing check's) go to it in
// SEND_MS, as one task, their writers' words marked outside text (booksheets.ts deliver)
export async function sendGuestNotes(b: any, who = BOARD) {
  const owner = b?.owner === null || typeof b?.owner === 'string' ? (b.owner as string | null) : undefined;
  if (owner === undefined) return [400, 'owner is the agent the notes are for, or null'] as Refused;
  mine(who);
  const groups = guestsWaiting(who, owner);
  if (!groups.length) return [404, "no invited person's notes wait for that owner"] as Refused;
  const snips = await Promise.all(groups.map(async g => (await sentSnip(g)) ?? snipOf(g)));
  // (one changed, gone or sent with its page while their pictures were drawn: sent as the board sees them now)
  const after = guestsWaiting(who, owner);
  if (after.length !== groups.length || after.some((g, i) => g.id !== groups[i].id || g.updated !== groups[i].updated))
    return [409, RESEND] as Refused;
  inOneStep(() => {
    asNotes(who, groups, snips);
    for (const g of groups) changed(pageRow(g.page, who)!.notebook, g.page);
  });
  deliverLater();
  return { owner, notes: groups.length };
}
// POST /api/notebooks/pages/undo { id }: a send taken back within its seconds; the page is open again, and the fresh
// page the send made goes while it's blank and untitled
export function undoSend(b: any, who = BOARD) {
  const p = pageRow(Number(b?.id), who);
  if (!p) return 404;
  if (p.send_at === null) return [409, "this page hasn't been sent", 'pageNotSent'] as Refused;
  if (gone(p)) return [409, 'too late to undo: the page has gone', 'pageGone'] as Refused;
  const groups = db
    .prepare('select * from notebook_groups where page = ? and parent is null and note is not null')
    .all(p.id) as Group[];
  inOneStep(() => {
    for (const g of groups) {
      const n = note(g.note!);
      if (!n || sheetRow(n.sheet, null)?.status !== 'sending') continue;
      unsend(n);
      db.prepare("update notebook_groups set status = 'open', note = null where id = ?").run(g.id);
    }
    db.prepare('update book_pages set send_at = null, fresh = null where id = ?').run(p.id);
    db.prepare(
      `delete from book_pages where id = ? and send_at is null and label = ''
      and not exists (select 1 from notebook_groups g where g.page = book_pages.id)`,
    ).run(p.fresh);
    changed(p.notebook, p.id);
  });
  return pageOf(pageRow(p.id, who)!);
}
// POST /api/notebooks/groups/reply { answer, words?, said?, ink?, frame? }: the board's reply under an agent's answer (a
// slip): a reply group under the answered group, gone to the agent who answered in SEND_MS (deleteReply takes it back).
// On a version, frame is where HQ showed its picture, in the page's px: the reply's snip is the ink over it. stillOpen: a guest's invitation, checked before the reply goes
export async function replyTo(b: any, who = BOARD, stillOpen?: () => boolean) {
  // (an answer on a group not sent yet is on its grp)
  const slip = db.prepare('select id, note, grp, by from book_slips where id = ?').get(Number(b?.answer)) as
    { id: number; note: number | null; grp: number | null; by: string } | undefined;
  const answered = slip && groupOn(slip);
  // (a version of an old book's note, a call's, has no group: the reply is a note on its versions page, under the
  // note's anchor; a note wiped, its versions kept for Undo, takes none.)
  const tried = !answered && slip?.note ? note(slip.note) : undefined;
  const p = answered ? pageRow(answered.page, who) : tried ? triesPageOfNote(tried.id) : undefined;
  if (!slip || !p || p.who !== who) return 404;
  const said = wordsOf(b.words, b.said ?? 'written');
  if (isRefused(said)) return said;
  const ink = b.ink === undefined ? [] : inkOf(b.ink);
  if (isRefused(ink)) return ink;
  if (!said.words && !ink.length) return [400, 'a reply has words or ink', 'replyEmpty'] as Refused;
  const closed = () => !!stillOpen && !stillOpen();
  if (!answered) {
    const snip = ink.length ? await replySnip(slip.id, frameOf(b.frame), ink) : null;
    if (closed()) return [403, 'this invitation has closed', 'invitationEnded'] as Refused;
    const still = note(tried!.id); // (wiped while its snip was drawn)
    if (!still) return 404;
    return replyOnNote(p, slip, JSON.parse(still.anchor) as Anchor, said, snip, who);
  }
  const top = rootOf(answered);
  const parts = { ink, texts: [], pictures: [] };
  const snip = ink.length
    ? ((await replySnip(slip.id, frameOf(b.frame), ink)) ?? (await snipOf({ ...top, ...partsJson(parts) })))
    : null;
  if (closed()) return [403, 'this invitation has closed', 'invitationEnded'] as Refused;
  const reply = inOneStep(() => {
    const g = insertGroup(p, 'reply', who, parts, {
      parent: top.id,
      answers: slip.id,
      words: said.words,
      said: said.said,
    });
    const id = replyNote(p.id, anchorOf(top), slip, said, snip, who);
    db.prepare("update notebook_groups set status = 'sent', note = ? where id = ?").run(id, g.id);
    return g;
  });
  if (who === BOARD) judgeLater({ grp: reply.id }); // (with the answer it replies to)
  return { id: reply.id, parent: top.id };
}
// A reply to an answer as a note on a sheet of its own, gone to the agent who answered in SEND_MS: its id (a form's answers go this way too, bookanswer.ts)
export function replyNote(
  page: number,
  anchor: Anchor,
  slip: { id: number; by: string },
  said: { words: string; said: string | null },
  snip: { type: string; clean: Buffer } | null,
  who: string,
) {
  const sheet = newSheet(who, slip.by, page),
    id = insertNote(sheet, page, who, anchor, said, snip, slip.id);
  db.prepare("update book_sheets set status = 'sending', send_at = ? where id = ?").run(Date.now() + SEND_MS, sheet);
  deliverLater();
  return id;
}
// A reply on a version of an old book's note (a call's): a note on the versions page, under the note's own anchor, the
// judge's to read as any reply (a ring picks it: bookpick.ts).
function replyOnNote(
  p: NotebookPage,
  slip: { id: number; by: string },
  anchor: Anchor,
  said: { words: string; said: string | null },
  snip: { type: string; clean: Buffer } | null,
  who: string,
) {
  const id = replyNote(p.id, anchor, slip, said, snip, who);
  changed(p.notebook, p.id);
  if (who === BOARD) judgeLater({ note: id });
  return { note: id };
}
// POST /api/notebooks/replies/delete { id }: a reply taken back in its seconds, its note and sheet gone, never sent;
// kept aside as a deleted group is
export function deleteReply(b: any, who = BOARD) {
  const g = row(Number(b?.id));
  const p = g && g.kind === 'reply' && pageRow(g.page, who);
  if (!g || !p || g.deleted !== null) return 404;
  const n = note(g.note!)!,
    s = sheetRow(n.sheet, null)!;
  if (s.status !== 'sending' || s.send_at! <= Date.now())
    return [409, 'too late to take back: the reply has gone', 'replyGone'] as Refused;
  inOneStep(() => {
    unsend(n);
    putAside(g, p);
  });
  return { ok: true, id: g.id };
}

// ---------------------------------------------------------------- shared
const deliverLater = () => setTimeout(deliverDue, SEND_MS + 50).unref();
// A sheet of the book's for one send's groups of one owner (null: the routing check's), from this notebook page: its
// own, never the owner's batch
const newSheet = (who: string, owner: string | null, page: number) =>
  Number(
    db
      .prepare('insert into book_sheets (who, owner, created, notebook_page) values (?, ?, ?, ?)')
      .run(who, owner, new Date().toISOString(), page).lastInsertRowid,
  );
function unsend(n: Note) {
  if (n.snip) rmSync(`${DIR}/${n.snip}`, { force: true });
  db.prepare('delete from book_notes where id = ?').run(n.id);
  db.prepare('delete from book_sheets where id = ? and not exists (select 1 from book_notes where sheet = ?)').run(
    n.sheet,
    n.sheet,
  );
}
// Where a group's note is: a scrap where it was cut, a drawing its place on the notebook page
export function anchorOf(g: Group): Anchor {
  if (g.anchor) return JSON.parse(g.anchor) as Anchor;
  const box = boxOf(partsOf(g)) ?? { x: 0, y: 0, w: 0, h: 0 };
  return { v: 1, url: `/api/book/picture?id=${g.page}`, el: null, view: { ...box, dpr: 2 }, ink: [] };
}
// A group's words as its note's: its post-it's, else its typed words
const saidOf = (g: Group) => {
  const typed = (JSON.parse(g.texts) as { text: string }[]).map(t => t.text).join('\n');
  // (a typed note from review mode keeps how it was said)
  return g.words ? { words: g.words, said: g.said } : { words: typed, said: typed ? (g.said ?? 'typed') : null };
};
const partsJson = (p: { ink: unknown[]; texts: unknown[]; pictures: unknown[] }) => ({
  ink: JSON.stringify(p.ink),
  texts: JSON.stringify(p.texts),
  pictures: JSON.stringify(p.pictures),
});
// The group drawn alone, with a little room round it: its note's snip, what the agent sees of it (null: a scrap whose
// picture was split off is its words only). The book's judge sees it too.
export async function snipOf(g: Group) {
  const parts = partsOf(g),
    box = boxOf(parts);
  if (!box) return null;
  const drawn = {
    x: box.x - PAD,
    y: box.y - PAD,
    w: box.w + 2 * PAD,
    h: box.h + 2 * PAD,
    ink: parts.ink as never,
    scraps: parts.pictures,
    texts: parts.texts as never,
  };
  return { type: 'image/png', clean: await render(drawn, DIR) };
}
