// The units on a notebook's page that nobody wrote on, which a page lets go as it locks.
import { db } from './db.ts';

// A page's units with nothing on them nor under them (a scrap made empty to write on that nobody wrote on: no ink,
// words or picture, no post-it words, no reply, slip (on it, or on the note it went as), card or try of its own), let
// go as the page locks: nobody writes on it any more (ink/callnotes.ts ended, notebooksend.ts sendPage). Put aside as
// a delete is, for Undo.
const EMPTY = `parent is null and deleted is null and ink = '[]' and texts = '[]' and pictures = '[]' and words = ''
  and request is null and tried is null and asked is null
  and not exists (select 1 from notebook_groups c where c.parent = notebook_groups.id)
  and not exists (select 1 from book_slips s where s.grp = notebook_groups.id or s.note = notebook_groups.note)`;
export const emptyOn = (page: number) =>
  (db.prepare(`select id from notebook_groups where page = ? and ${EMPTY}`).all(page) as { id: number }[]).map(
    g => g.id,
  );
export function dropEmpty(page: number) {
  db.prepare(`update notebook_groups set deleted = ? where page = ? and ${EMPTY}`).run(Date.now(), page);
}
