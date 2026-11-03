// A sketch page duplicated to carry on from it, played in memory (notebookplay.js): notebookduplicate.ts's route with
// the same answer and refusals, on the store's state s.
import { refuse } from './notebookplaychecks.js';
import { chapterOf } from './notebookchapters.js';
import { insertGroup, unitsOn } from './notebookplaygroups.js';

// POST /api/notebooks/pages/duplicate { id }: a new, open sketch page at the notebook's end with every unit of the page
// on it where it was, its answers left with it. → the copy's id
export function duplicatePage(s, b) {
  const p = s.page(Number(b?.id)) ?? refuse(404);
  if (chapterOf(p.kind, s.notebook(p.notebook)?.kind) !== 'sketch') refuse(409, 'only a sketch page is duplicated');
  const to = s.page(s.newPage(p.notebook));
  Object.assign(to, { x: p.x, y: p.y, w: p.w, h: p.h, zooms: { ...p.zooms } });
  for (const g of unitsOn(s, p.id)) {
    const { kind, by, ink, texts, pictures, anchor, words, said, owner, pos, h, column, place } = structuredClone(g);
    insertGroup(s, to, kind, by, { ink, texts, pictures }, { anchor, words, said, owner, pos, h, column, place });
  }
  return to.id;
}
