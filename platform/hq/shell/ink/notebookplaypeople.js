// Who the board's scraps can be handed to, played in memory (notebookplay.js): bookassign.ts's routes with the same
// answers and refusals, on the store's state s. s.people: the seed's people, { to, name, kind }; a group's assigned:
// [{ to, answered, at }] (at: when it was handed over, for the short list's order).
import { refuse } from './notebookplaychecks.js';
import { shown } from './notebookplaygroups.js';

// the short list's length (bookassign.ts SHORT_LIST)
const SHORT_LIST = 4;

// A route's handler for its 'METHOD path': (s, the body or a GET's query)
export const PEOPLE_ROUTES = {
  'GET /api/notebooks/people': listPeople,
  'POST /api/notebooks/groups/assign': assignGroup,
};
// The short list (the people picked most recently, topped up from everyone) and everyone, by name
function listPeople(s) {
  const everyone = [...s.people].sort((a, b) => a.name.localeCompare(b.name)),
    handed = s.groups.flatMap(g => g.assigned ?? []).sort((a, b) => b.at.localeCompare(a.at));
  const picked = handed.map(a => everyone.find(p => p.to === a.to)).filter(p => p !== undefined);
  return { recent: [...new Set([...picked, ...everyone])].slice(0, SHORT_LIST), everyone };
}
// The board's scrap handed to someone on the list: it stays where it is, wearing their tag
function assignGroup(s, b) {
  const g = s.group(Number(b?.id));
  const p = g && g.parent === null && g.deleted === null && s.page(g.page);
  if (!p) refuse(404, 'no such scrap of the board’s');
  if (s.shut(p)) refuse(409, 'a sent page is read-only: hand over a scrap on an open page');
  const person = s.people.find(x => x.to === b.to);
  if (!person) refuse(400, 'to is someone on the list (GET /api/notebooks/people): a guest in a book, or an agent');
  g.assigned = [...(g.assigned ?? []), { to: person.to, answered: false, at: s.stamp() }];
  s.changed(p.notebook, p.id);
  return { group: shown(s, g), to: person };
}

// Who a group went to, once each, for its tags (notebookplaygroups.js groupOf)
export function assignedOf(s, g) {
  const latest = new Map((g.assigned ?? []).map(a => [a.to, a]));
  return [...latest.values()].flatMap(a => {
    const person = s.people.find(p => p.to === a.to);
    return person ? [{ ...person, answered: !!a.answered }] : [];
  });
}
