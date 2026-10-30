// A notebook page's units in order (notebookgroups.ts): where a new one goes and the order an old page read in.
import { db } from './db.ts';

// A new unit's place in its page's order: the page's last, or between unit after and the next. Once halving leaves no
// number between them, the page's units are numbered again first (0, 1, 2, ... as they stand).
export function posAfter(page: number, after?: { id: number; pos: number | null }): number {
  if (!after) return lastPos(page) + 1;
  const { next } = db
    .prepare('select min(pos) next from notebook_groups where page = ? and parent is null and pos > ?')
    .get(page, after.pos) as { next: number | null };
  if (next === null) return after.pos! + 1;
  const between = (after.pos! + next) / 2;
  if (between > after.pos! && between < next) return between;
  renumber(page);
  return posAfter(page, db.prepare('select id, pos from notebook_groups where id = ?').get(after.id) as typeof after);
}
function renumber(page: number) {
  const units = db
    .prepare('select id from notebook_groups where page = ? and parent is null order by pos, id')
    .all(page) as { id: number }[];
  const numbered = db.prepare('update notebook_groups set pos = ? where id = ?');
  units.forEach((g, i) => numbered.run(i, g.id));
}
// A place before a page's first unit (0: none on it)
export function firstPos(page: number) {
  const { first } = db
    .prepare('select min(pos) first from notebook_groups where page = ? and parent is null')
    .get(page) as { first: number | null };
  return first === null ? 0 : first - 1;
}
// The last place in a page's order, its Undo's deleted units too (-1: none)
export const lastPos = (page: number) =>
  (
    db.prepare('select max(pos) last from notebook_groups where page = ? and parent is null').get(page) as {
      last: number | null;
    }
  ).last ?? -1;

// Things with their boxes on a page as they read: top to bottom, then left to right, then as they came; one with no box
// last
export const inReadingOrder = <T extends { id: number; box: { x: number; y: number } | null }>(placed: T[]) =>
  placed.sort((a, b) => edge(a.box, 'y') - edge(b.box, 'y') || edge(a.box, 'x') - edge(b.box, 'x') || a.id - b.id);
const edge = (box: { x: number; y: number } | null, side: 'x' | 'y') => box?.[side] ?? Number.MAX_VALUE;
