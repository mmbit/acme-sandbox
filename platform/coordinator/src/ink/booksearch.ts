// The book's Search (HQ's rail, booksearch.js): the words in the board's notebooks (notebookgroups.ts): a scrap's or a
// reply's words, said while drawing or typed, handwriting read into type (a group's texts), and the agents' answers
// under them (bookslips.ts), found by their words, each with its group, its page and day. The words are the groups' and
// slips' own rows, read at each search, so there's no second copy to keep in step. The matching is booksearchwords.js,
// shared with HQ's dev mode. Board only: a guest's room has no route to it. (the notebooks' groups, not the sheets'
// notes)
import { db } from '../db.ts';
import { BOARD } from './book.ts';
import { findIn } from '../../../hq/shell/ink/booksearchwords.js';

type Entry = {
  note: number;
  n: number;
  page: number;
  notebook: number;
  day: string;
  kind: string;
  owner: string | null;
  how: string;
  by: string;
  text: string;
  at: string;
};

// GET /api/book/search?q=: { q, found: [{ note (the group, a reply's the one it's under), n (that group's place on its
// page), page, notebook (its page's: a find on the Shelf opens it there.), day,
// kind (its notebook's), owner (who its scrap goes to: null, the routing check's), how ('written' |
// 'spoken' | 'typed', or 'answer': a slip's), by (who wrote or answered), text (the words around the find), at }],
// total }, the newest finds first, total: how many there are (findIn shows the newest)
export function searchBook(q: unknown, who = BOARD) {
  const query = typeof q === 'string' ? q : '';
  const columns = `select coalesce(g.parent, g.id) note, (select count(*) from notebook_groups x where x.page = g.page
      and x.parent is null and x.deleted is null and x.id <= coalesce(g.parent, g.id)) n, g.page, p.notebook, p.day, b.kind,
      g.owner`,
    board = `join book_pages p on p.id = g.page join notebooks b on b.id = p.notebook where b.who = ? and g.deleted is null`,
    typed = `json_extract(t.value, '$.text')`;
  const entries = db
    .prepare(
      `${columns}, coalesce(g.said, 'typed') how, g.by, g.words text, g.created at from notebook_groups g ${board}
        and g.words != ''
      union all ${columns}, 'written' how, g.by, ${typed} text, g.updated at
        from notebook_groups g join json_each(g.texts) t ${board} and coalesce(${typed}, '') != ''
      union all ${columns}, 'answer' how, l.by, l.text, l.created at
        from book_slips l join notebook_groups g on g.note = l.note ${board}`,
    )
    .all(who, who, who) as Entry[];
  return { q: query, ...(findIn(entries, query) as { found: Entry[]; total: number }) };
}
