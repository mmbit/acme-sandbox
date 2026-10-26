// The book's Search (HQ's rail, booksearch.js): the words on the board's notes, written (handwriting read into type, or
// written with Apple's Scribble), said while drawing or typed, and the agents' answers on them (bookslips.ts), found by
// their words, each with its note, its page and day. The words are the notes' and slips' own rows, read at each search,
// so there's no second copy to keep in step: five thousand notes and answers take about 50 ms. The matching is
// booksearchwords.js, shared with HQ's dev mode. Board only: a guest's room has no route to it.
import { db } from './db.ts';
import { BOARD } from './book.ts';
import { findIn } from '../../hq/shell/booksearchwords.js';

type Entry = {
  note: number;
  n: number;
  page: number;
  day: string;
  kind: string;
  owner: string | null;
  how: string;
  by: string;
  text: string;
  at: string;
};

// GET /api/book/search?q=: { q, found: [{ note, n, page, day, kind (its page's), owner (its sheet's: null, nobody's),
// how ('written' | 'spoken' | 'typed', or 'answer': a slip's), by (who wrote or answered), text (the words around the
// find), at }], total }, the newest finds first, total: how many there are (findIn shows the newest)
export function searchBook(q: unknown, who = BOARD) {
  const query = typeof q === 'string' ? q : '';
  const noteColumns = `select n.id note, n.n, n.page, p.day, p.kind, s.owner`,
    boardNotesJoin = `join book_pages p on p.id = n.page join book_sheets s on s.id = n.sheet where p.who = ?`;
  const entries = db
    .prepare(
      `${noteColumns}, n.said how, n.by, n.words text, n.created at from book_notes n ${boardNotesJoin} and n.words != ''
      union all ${noteColumns}, 'answer' how, l.by, l.text, l.created at from book_slips l join book_notes n on n.id = l.note ${boardNotesJoin}`,
    )
    .all(who, who) as Entry[];
  return { q: query, ...(findIn(entries, query) as { found: Entry[]; total: number }) };
}
