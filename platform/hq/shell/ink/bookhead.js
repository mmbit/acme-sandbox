// The names the book gives its pages in the bar, overview and search.
import { DAYS, MONTHS, titleCase } from '../../util.js';
import * as world from '../../world/world.js';
import { clockWhen } from '../../world/clock.js';
import { word } from './bookscope.js';

// A page's title: a notebook page's own (its label, '' for one with none), or an old page's: whose sheet it is, a call's
// (who it was with and when it started, on the company's clock: "00:34" today, "Mon 00:34" another day; just "Call"
// once its call is gone), or a free page's label. (a notebook page's)
export function titleOf(page) {
  if (page.notebook) return page.label ?? '';
  const name = id => world.agents?.get(id)?.data.name ?? titleCase(id);
  if (page.kind === 'sheet') return `For ${name(page.owner)}`;
  if (page.kind === 'guest') return `A guest's notes for ${name(page.owner)}`;
  if (page.kind === 'call') return page.agent ? `Call with ${name(page.agent)}, ${clockWhen(page.started)}` : 'Call';
  return page.label;
}
// A page's name where pages are listed (the pages control, a group's Move to page…): its title, or Untitled page when
// it has none
export const nameOf = page => titleOf(page) || word('Untitled page');

// A day as the book names it, in its overview (bookzoom.js), the pages control and Search's finds (booksearch.js):
// Today, or "Mon 26 Oct".
export const dayName = (day, today) => (day === today ? 'Today' : dateOf(day));
function dateOf(day) {
  const d = new Date(`${day}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
