// A page's title and the book's head (bookpages.js): the day shown, the days either side with pages, and New page.
import { DAYS, MONTHS, titleCase } from '../util.js';
import * as world from '../world/world.js';

// A page's head: whose sheet it is, a call's, or a free page's label
export function titleOf(page) {
  const name = id => world.agents?.get(id)?.data.name ?? titleCase(id);
  if (page.kind === 'sheet') return `For ${name(page.owner)}`;
  if (page.kind === 'guest') return `A guest's notes for ${name(page.owner)}`;
  return page.kind === 'call' ? 'Call' : page.label;
}
// The head: the day before with pages, this day, the one after, and New page; in an invited person's book, whose it is
// and the way back to the board's own
export function heading(book) {
  const before = book.days.find(d => d < book.day),
    after = [...book.days, book.today].filter(d => d > book.day).sort()[0];
  const [prev, next] = book.head.querySelectorAll('[data-go]');
  const when = book.head.querySelector('.bk-when');
  when.textContent = `${book.whose ? `${book.whose.name}’s book · ` : ''}${dayName(book.day, book.today)}`;
  when.style.setProperty('--bk-who', book.whose?.colour ?? '');
  book.head.querySelector('.bk-new').hidden = !!book.whose;
  book.head.querySelector('.bk-mine').hidden = !book.whose;
  Object.assign(prev, { hidden: !before, textContent: before ? `‹ ${dayName(before, book.today)}` : '' });
  Object.assign(next, { hidden: !after, textContent: after ? `${dayName(after, book.today)} ›` : '' });
  prev.dataset.day = before ?? '';
  next.dataset.day = after ?? '';
  book.zoom.again();
}
// A day as the book names it, in its head, its far view (bookzoom.js) and Search's finds (booksearch.js): Today, or
// "Mon 26 Oct".
export function dayName(day, today) {
  if (day === today) return 'Today';
  const d = new Date(`${day}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
