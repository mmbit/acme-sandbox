// Invited people's identity, permanent ink colour and storage allowance, shared by their notebook pages.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { db, once } from '../db.ts';
import * as guests from '../guests.ts';
import { managedPage } from '../notebookaccess.ts';
import { DIR, isGroupPicture, isScrap } from '../pagescraps.ts';

// One identity grant per guest and invited address. Existing drawings keep their 'guest:<id>' author.
// A new address gets a separate grant, so it never inherits someone else's pages.
db.exec(`create table if not exists sketch_guests (id integer primary key autoincrement, guest text not null collate nocase,
  email text not null collate nocase, granted text not null, withdrawn text)`);

// Every invitation gives its guest an identity and permanent ink colour. Notebook membership decides which pages
// they can open. A grant alone opens no guest room.
export function give(name: string) {
  const email = guests.emailOf(name);
  if (!email || grantOf(name)) return;
  const before = db
    .prepare('select id from sketch_guests where guest = ? and email = ? order by id desc')
    .get(name, email) as { id: number } | undefined;
  if (before) db.prepare('update sketch_guests set withdrawn = null where id = ?').run(before.id);
  else
    db.prepare('insert into sketch_guests (guest, email, granted) values (?, ?, ?)').run(
      name,
      email,
      new Date().toISOString(),
    );
}
guests.addWelcome(give);
// Existing invitations need the same identity grant.
once('2026-10-26-a-book-each', () => {
  const invited = db.prepare('select name from guests where email is not null and revoked is null').all();
  for (const { name } of invited as { name: string }[]) give(name);
});
// A person's open grant: given and not taken back, at the address they still have (a new address isn't the person
// the board gave it to: guests.ts invites someone else under a name only once nothing holds it, and this does)
export type Grant = { id: number; guest: string; email: string; withdrawn: string | null };
export function grantOf(name: string) {
  const email = guests.emailOf(name);
  return email
    ? (db
        .prepare('select * from sketch_guests where guest = ? and email = ? and withdrawn is null order by id desc')
        .get(name, email) as Grant | undefined)
    : undefined;
}
export const hasBook = (name: string) => !!grantOf(name);
export const whoOf = (g: Grant) => `guest:${g.id}`;
// (and a book with a page in it holds them at that address: guests.ts gives the name to someone else only once nothing
// does. An empty one holds nothing: every invite gives a book, so an empty one holding would keep every name for good.)
guests.addHolder(name => {
  const g = grantOf(name);
  const pages = g ? (db.prepare('select id from book_pages where who = ?').all(whoOf(g)) as { id: number }[]) : [];
  return pages.some(
    page => !managedPage(page.id) || !!db.prepare('select 1 from notebook_groups where page = ?').get(page.id),
  );
});
// The book a board's request names (who): its own ('board', or none), or one an invited person has now; null for any
// other.
export function bookFor(who: unknown) {
  if (who === undefined || who === null || who === '' || who === 'board') return 'board';
  const g = typeof who === 'string' ? grantBy(who) : undefined;
  return g && grantOf(g.guest)?.id === g.id ? whoOf(g) : null;
}
// GET /api/book/people: everyone with a book of their own now, for the board's rail ({ who, name, colour }): whoever
// was last drawn in first, then the latest given.
export function people() {
  const rows = db
    .prepare(
      `select g.*, (select max(p.updated) from book_pages p where p.who = 'guest:' || g.id) at from sketch_guests g
      where g.withdrawn is null order by at is null, at desc, g.id desc`,
    )
    .all() as Grant[];
  return rows
    .filter(g => grantOf(g.guest)?.id === g.id)
    .map(g => ({ who: whoOf(g), name: g.guest, colour: colourOf(g) }));
}
// A person's colour, theirs for good: the guest pages' colours that tell people apart (guests.ts), one per grant, so their
// ink and name tag in the board's book read as theirs.
export const colourOf = (g: { id: number }) => guests.colourOf(g.id);
// ...a person's while they have a grant (Reviews' people rows: their dot)
export const colourFor = (name: string) => {
  const g = grantOf(name);
  return g ? colourOf(g) : null;
};
// Who wrote a note on the board's sheet, as the book shows it: an invited person's name and colour (their notes stay
// theirs once the grant is closed: withdrawn, or the person at a new address), or null for the board's own.
export function guestOf(who: string) {
  const g = grantBy(who);
  return g ? { name: g.guest, colour: colourOf(g) } : null;
}
// The grant a who names ('guest:<id>'), withdrawn or not: its person and the address they had it at
export function grantBy(who: string) {
  const id = /^guest:(\d+)$/.exec(who)?.[1];
  return id ? (db.prepare('select * from sketch_guests where id = ?').get(Number(id)) as Grant | undefined) : undefined;
}
// Whose book a sketch is in: the person's name, or null for the board's
export function ownerOf(who: string) {
  const id = /^guest:(\d+)$/.exec(who)?.[1];
  const g = id
    ? (db.prepare('select guest from sketch_guests where id = ?').get(Number(id)) as { guest: string })
    : null;
  return g?.guest ?? null;
}
// The space an invited person's Sketchbook takes in all: its ink as stored, its pictures and its scraps' files.
// Everything in the data volume goes off-site every night within the bucket's room (R2's free 10 GB at the least, more
// where the company's BACKUP_BUCKET_GB allows; backup.ts's heads-up when it nears that); one person's book may take 1%
// of the least room, so a hundred people drawing until their books are full still leave the backup most of its room.
// A save past it is refused (BOOK_FULL), and the page says to delete a
// sketch. The board's own book has no such cap: it is the board's space.
export const GUEST_SPACE = 100 * 1024 * 1024;
// (the Notebook, once the Sketchbook)
export const BOOK_FULL = 'Your Notebook is full: delete a sketch you no longer need to keep drawing';
// The space a person's book would take with this save (its ink's length, its picture) in place of the sketch's as it
// is now: every sketch's ink, picture, scraps' and groups' picture files (a notebook page's, placed or not), and its row (ROW_BYTES: its other columns, at most a label
// and a few dates, and the table's index entry)
const ROW_BYTES = 1024;
export function spaceAfter(s: { id: number; who: string }, ink: number, drawn: { clean: Buffer } | null) {
  const rows = db.prepare('select id, picture, length(ink) ink from book_pages where who = ?').all(s.who) as {
    id: number;
    picture: string | null;
    ink: number;
  }[];
  const size = (f: string) => (existsSync(`${DIR}/${f}`) ? statSync(`${DIR}/${f}`).size : 0),
    files = readdirSync(DIR);
  let used = ink + (drawn?.clean.length ?? 0);
  for (const o of rows) {
    if (o.id !== s.id) used += o.ink + (o.picture ? size(o.picture) : 0);
    used += ROW_BYTES + files.filter(f => isScrap(o.id, f) || isGroupPicture(o.id, f)).reduce((t, f) => t + size(f), 0);
  }
  return used;
}
// Whether a person's book has no room for anything more: a new page or a picture on one
export const bookFull = (who: string) => spaceAfter({ id: 0, who }, ROW_BYTES, null) > GUEST_SPACE;
// Whether a person's book has no room for this picture.
export const noRoomFor = (who: string, drawn: { clean: Buffer }) => spaceAfter({ id: 0, who }, 0, drawn) > GUEST_SPACE;
// (an invited person's Send and its quota went with HQ's Sketchbook app)
