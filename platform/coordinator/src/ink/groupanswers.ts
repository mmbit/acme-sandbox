// A notebook group's answers as HQ reads them with the group (notebookgroups.ts groupOf): the slips on the notes it and
// its replies went as, the answers made on it before or after its page was sent, each once; the answer still coming on
// it or a reply of its (the writing placeholder); its try's versions page (booktry.ts), or null; the agents'
// desk-phone cards on those notes (bookasks.ts); and a versions page's group, or old book note. Both are read in one
// shape (readOf), so HQ draws a versions page (bookanswerversions.js) the same way for either.
import { db } from '../db.ts';
import { findAgent } from '../jobs.ts';
import { answersOnGroups, comingOf, slipsOf, waitingOf, type Listed } from './bookslips.ts';
import { asksOn } from './bookasks.ts';
import { sheetRow, type Note } from './booknotes.ts';
import type { Group } from '../notebookgroups.ts';

// What HQ reads of a note with its answers, a group's or an old book note's: its own parts (head), its owner and the
// agent's name, and its children, the answers and the board's replies under them, in the order they came
export function readOf<H extends object, A extends { created: string }, R extends { created: string }>(
  head: H,
  owner: string | null,
  answers: A[],
  replies: R[],
) {
  return {
    ...head,
    owner,
    owner_name: owner ? (findAgent(owner)?.name ?? owner) : null,
    children: [
      ...answers.map(a => ({ kind: 'answer' as const, ...a })),
      ...replies.map(r => ({ ...r, kind: 'reply' as const })),
    ].sort((a, b) => a.created.localeCompare(b.created)),
  };
}

export function answersOf(g: Group, replies: Group[], listed: Listed) {
  const notes = [g, ...replies].flatMap(x => (x.note ? [x.note] : [])),
    onNotes = notes.flatMap(n => slipsOf(n, listed));
  const onGroups = answersOnGroups(
    [g, ...replies].map(x => x.id),
    listed,
  ).filter(a => !onNotes.some(n => n.id === a.id));
  const top = g.parent === null,
    asking = top ? [g, ...replies] : [];
  return {
    answers: [...onNotes, ...onGroups],
    // (an answer coming on the note or a reply before why an ended ask brought none)
    waiting: asking.map(comingOf).find(w => w) ?? asking.map(waitingOf).find(w => w) ?? null,
    tries_page: top ? triesPage(g.id) : null,
    asks: notes.flatMap(asksOn),
  };
}
// A versions page's read (booktry.ts): the group it tries (tries) or an old book's note (tries_note, a call's), as tried; nothing for any other page
export function triesOf(
  p: { tries: number | null; tries_note: number | null },
  show: (g: Group) => unknown,
  listed: Listed,
) {
  if (p.tries) return { tries: p.tries, tried: triedOf(p.tries, show) };
  if (p.tries_note) return { tries_note: p.tries_note, tried: triedNoteOf(p.tries_note, listed) };
  return {};
}
// A versions page's group, as HQ reads it (show), or null once it's deleted
function triedOf(id: number, show: (g: Group) => unknown) {
  const g = db.prepare('select * from notebook_groups where id = ?').get(id) as Group | undefined;
  return g && g.deleted === null ? show(g) : null;
}
// An old book's note a versions page is for (a call's: booktry.ts), as HQ reads a tried group: its snip the picture, its
// versions, the board's replies on them (notes, whose ink lives in their snips only: none drawn) and its try still
// going; null once it's wiped.
function triedNoteOf(id: number, listed: Listed) {
  const n = db.prepare('select * from book_notes where id = ?').get(id) as
    (Note & { tried: number | null }) | undefined;
  if (!n) return null;
  const versions = slipsOf(n.id, listed).filter(s => s.style === 'version');
  const replies = db
    .prepare(`select * from book_notes where answers in (select value from json_each(?)) order by id`)
    .all(JSON.stringify(versions.map(v => v.id))) as Note[];
  const head = {
    id: n.id,
    page: n.page,
    by: n.by,
    ink: [],
    pictures: n.snip ? [{ url: `/api/book/snip?id=${n.id}` }] : [],
    words: n.words,
    said: n.said,
    waiting: waitingOf(n),
  };
  const answered = replies.map(r => ({
    id: r.id,
    by: r.by,
    answers: r.answers,
    ink: [],
    words: r.words,
    created: r.created,
  }));
  return readOf(head, sheetRow(n.sheet, null)?.owner ?? null, versions, answered);
}
const triesPage = (group: number) =>
  (db.prepare('select id from book_pages where tries = ? order by id limit 1').get(group) as { id: number } | undefined)
    ?.id ?? null;
