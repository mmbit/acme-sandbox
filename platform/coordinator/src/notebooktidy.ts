// A sketch page nobody wrote, drew or dropped anything on isn't kept once another page shows. The book asks for it at
// every page it shows (booktidy.js), so a blank page left on any screen, or by a book shut on it, goes the next time a
// page is turned to.
import { rmSync } from 'node:fs';
import { db, inOneStep } from './db.ts';
import { BOARD } from './ink/book.ts';
import { changed, notebookRow } from './notebook.ts';
import { managedNotebook } from './notebookaccess.ts';
import type { Refused } from './pagechecks.ts';
import { DIR } from './pagescraps.ts';

// Blank: an open, untitled sketch page (not a call's, an ask's or a try's versions page) that no group was ever made
// on (one deleted stays, for Undo, and so does its page) and with nothing of the old book's on it
const BLANK = `kind = 'free' and archived = 0 and send_at is null and label = '' and tries is null
  and tries_note is null and ink = '[]' and scraps = '[]' and texts = '[]' and waiting = '[]'
  and not exists (select 1 from notebook_groups g where g.page = book_pages.id)`;

// POST /api/notebooks/pages/tidy { notebook, keep }: the notebook's blank pages but the one shown (keep) let go, and a
// sent page's link to one as the fresh page its send made. { gone }: how many went
export function tidyPages(b: any, who = BOARD) {
  const n = notebookRow(Number(b?.notebook), who),
    keep = Number(b?.keep);
  if (!n) return 404;
  if (managedNotebook(n.id)) return 403;
  if (!Number.isInteger(keep)) return [400, 'keep is the page shown, its id'] as Refused;
  const gone = inOneStep(() => {
    const pages = db
      .prepare(`select id, picture from book_pages where notebook = ? and id != ? and ${BLANK}`)
      .all(n.id, keep) as { id: number; picture: string | null }[];
    for (const p of pages) {
      db.prepare('update book_pages set fresh = null where fresh = ?').run(p.id);
      db.prepare('delete from book_pages where id = ?').run(p.id);
      if (p.picture) rmSync(`${DIR}/${p.picture}`, { force: true });
    }
    return pages.length;
  });
  if (gone) changed(n.id, null);
  return { gone };
}
