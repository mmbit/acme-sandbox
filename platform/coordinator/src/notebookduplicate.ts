// A sketch page duplicated to carry on from it (a page sent is locked, and its copy is drawn on): a new, open sketch
// page at the notebook's end, the current page from now, with everything the page has on it, each unit where
// it was. The page itself stays as it was sent. Its answers stay with it: they're about the notes it went as.
import { db, inOneStep } from './db.ts';
import { BOARD } from './ink/book.ts';
import { changed, newPage, pageChapter, pageOf, pageRow, type NotebookPage } from './notebook.ts';
import { insertGroup, partsOf, type Group, type Parts } from './notebookgroups.ts';
import { copyPicture } from './notebookpictures.ts';
import { managedPage } from './notebookaccess.ts';
import type { Refused } from './pagechecks.ts';

// POST /api/notebooks/pages/duplicate { id }: the copy, a page as the notebook's pages list it
export function duplicatePage(b: any, who = BOARD) {
  const p = pageRow(Number(b?.id), who);
  if (!p) return 404;
  if (managedPage(p.id)) return 403;
  if (pageChapter(p) !== 'sketch') return [409, 'only a sketch page is duplicated'] as Refused;
  const id = inOneStep(() => {
    const id = newPage(p.notebook);
    copyUnits(p, pageRow(id, who)!);
    return id;
  });
  changed(p.notebook, id);
  return pageOf(pageRow(id, who)!);
}
// A page's place, size and zoom and every unit on it, each where it was, onto another page, its pictures copied as that
// page's own (notebookpictures.ts ours: the page may be someone else's). Returns the units' copies beside the units
// they're copies of. (shared with notebookgive.ts)
export function copyUnits(from: NotebookPage, to: NotebookPage) {
  db.prepare('update book_pages set x = ?, y = ?, w = ?, h = ?, zooms = ? where id = ?').run(
    ...[from.x, from.y, from.w, from.h, from.zooms, to.id],
  );
  const units = db
    .prepare('select * from notebook_groups where page = ? and parent is null and deleted is null order by pos, id')
    .all(from.id) as Group[];
  return units.map(g => ({
    unit: g,
    copy: insertGroup(to, g.kind, g.by, ownPictures(partsOf(g), to), {
      ...{ anchor: g.anchor ? JSON.parse(g.anchor) : undefined, words: g.words, said: g.said, owner: g.owner },
      ...{ h: g.h, column: g.column },
    }),
  }));
}
const ownPictures = (parts: Parts, to: NotebookPage) => ({
  ...parts,
  pictures: parts.pictures.map(c => ({ ...c, file: copyPicture(to.id, c.file) })),
});
