// A guest's shelf (Ink 1.1, the deck's Guests chapter): one book per project they have something in, its first page the
// work shared with them from it, and their own journal for anything loose. One place to come back to: every guest has
// one link of their own (shelfLink), the same for every share, which the board's Share sends; signed in once, with a
// passkey after, it opens their shelf (/guest/notebooks/).
//   - A share of a piece of work (shares.ts) is a lasting guest's or a review round's; each person on it has their own
//     page in its notebook (notebookreviews.ts), where the notes they pin on the work land, and asks for them wait.
//   - An ask for them is a scrap of the board's handed to them (ink/bookassign.ts): its copy on their page counts on the
//     work's card and the book's cover until they write on it.
import { db } from './db.ts';
import * as guests from './guests.ts';
import * as shares from './shares.ts';
import * as artifacts from './artifacts.ts';
import { ownerOf } from './owed.ts';
import { makeNotebook, changed } from './notebook.ts';
import { BOARD } from './ink/book.ts';
import { addMember, forGuest, whoOf, type Membership } from './notebookguests.ts';

// The guest's one link, as the board's Share sends it: their door on the guest desk, opening their shelf
export const shelfLink = (name: string) => guests.doorLink(`shelf:${name.toLowerCase()}`).url;
const doorWords = {
  en: { title: 'Your shelf', text: 'Everything we share with you, one book per project.', button: 'Open your shelf' },
  nl: {
    title: 'Je boekenplank',
    text: 'Alles wat we met je delen, een boek per project.',
    button: 'Open je boekenplank',
  },
  de: {
    title: 'Dein Regal',
    text: 'Alles, was wir mit dir teilen, ein Buch pro Projekt.',
    button: 'Dein Regal öffnen',
  },
};
guests.addDoor(link => {
  const named = db.prepare('select distinct guest from notebook_guests').all() as { guest: string }[];
  const guest = named.find(g => guests.doorLink(`shelf:${g.guest.toLowerCase()}`).link === link)?.guest;
  if (!guest) return undefined;
  return {
    guest,
    open: forGuest(guest).length > 0,
    words: lang => doorWords[lang],
    go: () => (forGuest(guest).length > 0 ? '/guest/notebooks/' : null),
  };
});

type Linked = { m: Membership; share: shares.Share };
type Book = { key: string; name: string; asks: number; artifacts: ReturnType<typeof workOf>[] };
// GET /guest/notebooks/api/shelf: { books: [{ key, name, asks, artifacts }], journal }, the book with asks lit first
export function shelfOf(name: string) {
  const linked: Linked[] = [];
  let journal: Membership | undefined;
  for (const m of forGuest(name)) {
    const share = shareOf(m.notebook);
    if (share) linked.push({ m, share });
    else journal ??= m;
  }
  journal ??= makeJournal(name);
  const known = artifacts.list();
  const books = new Map<string, Book>();
  for (const l of linked) {
    const found = known.find(a => a.about === l.share.about);
    const place = found?.place.find(p => p.level === 'project') ?? found?.place[0];
    const key = place?.id ?? l.share.about;
    const book: Book = books.get(key) ?? {
      key,
      name: place?.name ?? ownerOf(l.share.about).name,
      asks: 0,
      artifacts: [],
    };
    const work = workOf(l, found?.name);
    book.artifacts.push(work);
    book.asks += work.asks;
    books.set(key, book);
  }
  const shelf = [...books.values()].sort((a, b) => Number(b.asks > 0) - Number(a.asks > 0));
  return { name, books: shelf, journal: { notebook: journal.notebook, page: journal.page, asks: asksFor(journal) } };
}

// A piece of work shared with them: its name, where it opens (through the guest desk's onward, which hands them their
// session there), their page on it and the asks waiting for them there; a review round's end
function workOf(l: Linked, name: string | undefined) {
  const url = `https://${l.share.host}${l.share.start}`;
  return {
    notebook: l.m.notebook,
    page: l.m.page,
    name: name ?? ownerOf(l.share.about).name,
    where: l.share.start === '/' ? l.share.host : l.share.host + l.share.start.split(/[?#]/)[0],
    open: `/guest/onward?to=${encodeURIComponent(url)}`,
    lasting: !!l.share.lasting,
    ends: l.share.lasting ? null : l.share.ends,
    asks: asksFor(l.m),
  };
}
const shareOf = (notebook: number) => {
  const linked = db.prepare('select share from notebook_reviews where notebook = ?').get(notebook) as
    { share: number } | undefined;
  return linked ? shares.byId(linked.share) : undefined;
};
// The board's scraps handed to them on their pages in a notebook, not written on yet
const asksFor = (m: Membership) =>
  (
    db
      .prepare(
        `select count(*) n from notebook_assigns a join notebook_groups g on g.id = a.copy
        join book_pages p on p.id = g.page where p.notebook = ? and p.who = ? and a.answered = 0 and g.deleted is null`,
      )
      .get(m.notebook, whoOf(m)) as { n: number }
  ).n;
// Their journal, made the first time their shelf is read: an invited notebook of theirs on the board's shelf, named for
// them, with no work linked
function makeJournal(name: string) {
  const id = makeNotebook(BOARD, 'invited', name);
  db.prepare('insert into notebook_colleagues (notebook, allowed) values (?, 0)').run(id);
  addMember(id, name, null);
  changed(id, null);
  return forGuest(name).find(m => m.notebook === id)!;
}
