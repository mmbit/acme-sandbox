// A free page sent on its own (its plane: a one-off sheet for one agent, never their batch), beside the sheets' sending
// (booksheets.ts, which delivers it once its seconds are over).
import { readFileSync, rmSync } from 'node:fs';
import { db, inOneStep } from './db.ts';
import { findAgent } from './jobs.ts';
import { BASE, BOARD, pictureOf, row as pageRow } from './book.ts';
import { isRefused, wordsOf, type Anchor, type Refused } from './pagechecks.ts';
import { DIR } from './pagescraps.ts';
import { SEND_MS, insertNote, sheetOf, type Note, type Sheet } from './booknotes.ts';

// POST /api/book/page/send { id, to }: a free page goes to an agent as it is, in SEND_MS unless it's undone first: a
// one-off sheet for that agent (book_sheets.page) holding one note, the page's picture its snip and its label its
// words. Never a batch: the agent's open sheet stays as it is. The sheet.
export async function sendPage(b: any, who = BOARD) {
  const p = pageRow(Number(b?.id), who);
  if (!p) return 404;
  if (p.kind !== 'free') return [400, 'a free page is sent on its own; a sheet goes with its plane'] as Refused;
  if (!(typeof b.to === 'string' && findAgent(b.to))) return [400, 'to is an agent'] as Refused;
  const file = await pictureOf(p);
  // (deleted while it was drawn)
  if (!file || !pageRow(p.id, who)) return 404;
  const said = wordsOf(p.label, 'typed');
  if (isRefused(said)) return said;
  // (where it is: its picture on HQ, the page as a whole, nothing on it singled out)
  const anchor: Anchor = {
    v: 1,
    url: `${BASE}/picture?id=${p.id}`,
    el: null,
    view: { x: 0, y: 0, w: p.w, h: p.h, dpr: 2 },
    ink: [],
  };
  const picture = { type: 'image/png', clean: readFileSync(`${DIR}/${file}`) };
  const id = inOneStep(() => {
    const sheet = Number(
      db
        .prepare('insert into book_sheets (who, owner, created, page) values (?, ?, ?, ?)')
        .run(who, b.to, new Date().toISOString(), p.id).lastInsertRowid,
    );
    insertNote(sheet, p.id, who, anchor, said, picture, null);
    // (its seconds start once its note is on it: a sheet goes with what was on it at the tap)
    db.prepare("update book_sheets set status = 'sending', send_at = ? where id = ?").run(Date.now() + SEND_MS, sheet);
    return sheet;
  });
  return sheetOf(id);
}
// POST /api/book/undo on a page sent on its own: within its seconds the one-off sheet is gone, as if never sent
// ({ id, status: 'undone' }); after them, too late
export function undoPage(s: Sheet) {
  if (s.status !== 'sending' || s.send_at! <= Date.now())
    return [409, 'too late to undo: the page has gone'] as Refused;
  for (const n of db.prepare('select snip from book_notes where sheet = ?').all(s.id) as Pick<Note, 'snip'>[])
    if (n.snip) rmSync(`${DIR}/${n.snip}`, { force: true });
  inOneStep(() => {
    db.prepare('delete from book_notes where sheet = ?').run(s.id);
    db.prepare('delete from book_sheets where id = ?').run(s.id);
  });
  return { id: s.id, status: 'undone' };
}
// The task a page sent on its own makes: the page is the work (place: where it is, as deliver names it; text: its note's).
// (--artifact)
export const pageTask = (page: number, place: string, text: string) => ({
  title: `A page from the board's book: ${place}`.slice(0, 200),
  prompt: `The board sent you a page from its book (the Sketchbook): page #${page}, as it drew it. It is yours to take \
on as one piece of work. \`hq sketch ${page}\` reads the page (its picture, its label, what's on it); \`hq note <id>\` \
saves the picture below as a file.

When it's done, or to answer it, clip your answer onto its note: \`hq answer <id> "what you made, or the answer"\` \
(plain words for the board, a sentence or two; \`--picture <file>\` or \`--link <preview url>\` to show it, \
\`--artifact <id>\` for something new that runs, an app or a page, by its id in HQ's artifacts).

${text}`,
});
