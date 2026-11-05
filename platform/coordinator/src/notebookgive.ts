// A page of the board's given to a guest: a copy in their own notebook (their journal, notebookguestshelf.ts), theirs to
// carry on with, as the board's Duplicate is. Everyone invited somewhere is offered (ink/bookassign.ts listPeople), and
// someone new comes in by name and address as a Share's guest does. The copy has every unit of the page, and the
// versions on them (a call's prototypes, an agent's tries) as pictures to look at: the page's answers stay with it, as
// a duplicate's do. Their notes on it go where the notes on their journal go.
import { db, inOneStep } from './db.ts';
import * as guests from './guests.ts';
import { BOARD } from './ink/book.ts';
import { listPeople } from './ink/bookassign.ts';
import { changed, newPage, pageOf, pageRow } from './notebook.ts';
import { managedPage } from './notebookaccess.ts';
import { copyUnits } from './notebookduplicate.ts';
import { journalOf } from './notebookguestshelf.ts';
import { shelfLink, whoOf } from './notebookmembers.ts';
import type { Refused } from './pagechecks.ts';

// What of a version comes with it: the frame as shown, never its branch, preview or pick
const VERSION = ['by', 'job', 'text', 'picture', 'link', 'created', 'style', 'version', 'ink', 'source'];

// POST /api/notebooks/pages/give { id, to } (to: someone invited, the people list's 'guest:<grant>') or { id, person:
// { name, email } } (someone new): { name, page, link }, the copy as their notebook lists it and their shelf's link
export function givePage(b: any) {
  const p = pageRow(Number(b?.id), BOARD);
  if (!p) return 404;
  if (managedPage(p.id)) return 403;
  const invited = b?.person ? guests.invite(b.person.name, b.person.email) : nameOf(b?.to);
  if (Array.isArray(invited)) return invited as Refused;
  const name = typeof invited === 'string' ? invited : invited?.name;
  if (!name) return [404, 'nobody invited by that name', 'givePerson'] as Refused;
  const { journal, id } = inOneStep(() => {
    const journal = journalOf(name),
      who = whoOf(journal),
      id = newPage(journal.notebook);
    db.prepare('update book_pages set who = ?, label = ? where id = ?').run(who, p.label, id);
    for (const { unit, copy } of copyUnits(p, pageRow(id, who)!)) copyVersions(unit.id, copy.id);
    return { journal, id };
  });
  changed(journal.notebook, id);
  return { name: journal.guest, page: pageOf(pageRow(id, whoOf(journal))!), link: shelfLink(journal.guest) };
}

const nameOf = (to: unknown) => listPeople().everyone.find(person => person.to === to)?.name;
function copyVersions(unit: number, copy: number) {
  db.prepare(
    `insert into book_slips (grp, ${VERSION.join(', ')}) select ?, ${VERSION.join(', ')} from book_slips
    where grp = ? and style = 'version' and crossed is null order by id`,
  ).run(copy, unit);
}
