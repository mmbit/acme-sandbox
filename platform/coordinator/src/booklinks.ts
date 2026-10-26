// Linked notes in the book: two notes of one sheet the board drew a line between, read as one (booknotes.ts linkNotes).
// A note that moves to another sheet, or is wiped, loses its links. a < b.
import { db } from './db.ts';

db.exec(`create table if not exists book_links (a integer not null, b integer not null, primary key (a, b));
  create index if not exists book_links_b on book_links (b)`);

// Two notes linked (they go together), or no longer
export function setLink(one: number, two: number, linked: boolean) {
  const [a, z] = one < two ? [one, two] : [two, one];
  if (linked) db.prepare('insert or ignore into book_links (a, b) values (?, ?)').run(a, z);
  else db.prepare('delete from book_links where a = ? and b = ?').run(a, z);
}
// The notes a note goes with, by id
export const linksOf = (id: number) =>
  (
    db
      .prepare('select b id from book_links where a = ? union select a from book_links where b = ? order by 1')
      .all(id, id) as { id: number }[]
  ).map(l => l.id);
// A note's every link gone
export const unlink = (id: number) => db.prepare('delete from book_links where a = ? or b = ?').run(id, id);

// A sheet's notes' texts as its job reads them: a linked note says which others go with it, by their numbers there
// (kept: the notes as sent notes on HQ, in the notes' order)
export function withLinks(notes: { id: number }[], kept: { id: number; text: string }[]) {
  const numbers = new Map(notes.map((n, i) => [n.id, kept[i].id]));
  return kept.map((k, i) => {
    const goes = linksOf(notes[i].id).flatMap(id => numbers.get(id) ?? []);
    if (!goes.length) return k.text;
    return `${k.text}\nGoes with note${goes.length === 1 ? '' : 's'} ${goes.map(id => `#${id}`).join(', ')}.`;
  });
}
