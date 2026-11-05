// An Asks page as the book's gathering of questions: after its own scraps, every
// open question on the same book's other pages, or for a guest's own book (not shared work) on any page of theirs, the
// copies handed to them from every book. Each stays where it is, read with elsewhere: { page, label } (its own page and
// title), so an edit, an answer, an assign or a delete names it by its id on its own page, and none is a place among
// the Asks page's own (unitAfter).
import { db } from '../db.ts';
import { BOARD } from './book.ts';
import { questionOf } from './bookassign.ts';
import { asksBy, askShown } from './bookasks.ts';
import { isUnitOn, row, shown, type Group } from '../notebookgroups.ts';
import { active, memberships, whoOf } from '../notebookmembers.ts';
import type { Refused } from '../pagechecks.ts';
import type { NotebookPage } from '../notebook.ts';

// Shared work's book (a review round's or a lasting guest's), as bookassign.ts onWork
const onWork = (notebook: number) =>
  !!db
    .prepare(
      'select 1 from notebook_rounds where notebook = ?1 union select 1 from notebook_reviews where notebook = ?1',
    )
    .get(notebook);
// An open question: an agent's ask with its card still open, or a copy handed over not answered yet
function gathered(p: NotebookPage) {
  if (p.kind !== 'asks') return [];
  const wide = p.who !== BOARD && !onWork(p.notebook);
  // (the other books by the guest room's own rule, open to them now)
  const open = wide
    ? memberships()
        .filter(m => active(m) && whoOf(m) === p.who)
        .map(m => m.notebook)
    : [];
  const rows = db
    .prepare(
      `select g.*, p.label at_label from notebook_groups g join book_pages p on p.id = g.page
      where p.who = ?1 and p.id != ?2 and g.parent is null and g.deleted is null
      and (g.request is not null or exists (select 1 from notebook_assigns a where a.copy = g.id))
      and (p.notebook = ?3 or p.notebook in (select value from json_each(?4)))
      order by p.notebook, p.pos, g.pos, g.id`,
    )
    .all(p.who, p.id, p.notebook, JSON.stringify(open)) as (Group & { at_label: string })[];
  return rows.filter(
    g =>
      (g.request === null || askShown(g.request)) &&
      questionOf(g, g.request ? asksBy(g.request) : [])?.answered === false,
  );
}
// The questions an Asks page gathers, as HQ reads a group, each with where it is
export const gatheredOn = (p: NotebookPage) =>
  gathered(p).map(({ at_label, ...g }) => ({ ...shown(g), elsewhere: { page: g.page, label: at_label } }));
// Where a create's or a move's after puts its unit on page p: right after a unit of the page's own (other than the one
// moved, self), its first for 'start', else its end; one of an Asks page's gathered questions is no place there, so
// its end too
export function unitAfter(
  after: unknown,
  p: NotebookPage,
  self?: number,
): { after?: Group; atStart: boolean } | Refused {
  if (after == null || (p.kind === 'asks' && gathered(p).some(g => g.id === Number(after)))) return { atStart: false };
  if (after === 'start') return { atStart: true };
  const g = row(Number(after));
  if (isUnitOn(g, p.id) && g.id !== self) return { after: g, atStart: false };
  return [400, self === undefined ? 'after is a unit on this page' : "after is another unit on that page, or 'start'"];
}
