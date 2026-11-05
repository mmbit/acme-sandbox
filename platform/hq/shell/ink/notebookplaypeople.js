// Who the board's scraps can be handed to, played in memory (notebookplay.js): bookassign.ts's routes with the same
// answers and refusals, on the store's state s: the guests, from any open page. s.people: the seed's people, { to, name,
// kind, colour?, notebooks? } (notebooks: the books they're invited to, every one when not given), its agents only for
// the tags of scraps handed to one before scraps went to guests only; a group's assigned: [{ to, answered, at }] (at:
// when it was handed over, for the short list's order). A group seeded with handed: { answered, from? } is a copy
// handed to this side (a guest's, from the board's group from), which its Answer answers.
import { refuse } from './notebookplaychecks.js';
import { shown } from './notebookplaygroups.js';

// the short list's length (bookassign.ts SHORT_LIST)
const SHORT_LIST = 4;

// A route's handler for its 'METHOD path': (s, the body or a GET's query)
export const PEOPLE_ROUTES = {
  'GET /api/notebooks/people': listPeople,
  'POST /api/notebooks/groups/assign': assignGroup,
  'POST /api/notebooks/groups/answer': answerGroup,
};
// The short list (the guests picked most recently, topped up from everyone) and every guest a scrap on the page can go
// to, by name: the ones invited to its book; every guest on the board's own book, when none is, or without a page
const guests = s => s.people.filter(p => p.kind === 'guest').map(personOf);
const personOf = p => ({
  to: p.to,
  name: p.name,
  kind: p.kind,
  initial: [...p.name.trim()][0]?.toUpperCase() ?? '?',
  colour: p.colour ?? null,
});
function invitedFor(s, page) {
  const p = s.page(Number(page)),
    n = p && s.notebook(p.notebook);
  if (!n || n.kind === 'mine') return guests(s);
  const names = new Set(
    s.people.filter(x => x.kind === 'guest' && (!x.notebooks || x.notebooks.includes(n.id))).map(x => x.to),
  );
  const invited = guests(s).filter(x => names.has(x.to));
  return invited.length ? invited : guests(s);
}
function listPeople(s, q) {
  const page = q?.page;
  const everyone = (page == null ? guests(s) : invitedFor(s, page)).sort((a, b) => a.name.localeCompare(b.name)),
    handed = s.groups.flatMap(g => g.assigned ?? []).sort((a, b) => b.at.localeCompare(a.at));
  const picked = handed.map(a => everyone.find(p => p.to === a.to)).filter(p => p !== undefined);
  return { recent: [...new Set([...picked, ...everyone])].slice(0, SHORT_LIST), everyone };
}
// A scrap on an open page handed to a guest on the list: it stays where it is, wearing their tag
function assignGroup(s, b) {
  const g = s.group(Number(b?.id));
  const p = g && g.parent === null && g.deleted === null && s.page(g.page);
  if (!p) refuse(404, 'no such scrap of the board’s');
  if (s.shut(p)) refuse(409, 'a sent page is read-only: hand over a scrap on an open page');
  const person = guests(s).find(x => x.to === b.to);
  if (!person) refuse(400, 'to is a guest on the list (GET /api/notebooks/people?page=)');
  g.assigned = [...(g.assigned ?? []), { to: person.to, answered: false, at: s.stamp() }];
  s.changed(p.notebook, p.id);
  return { group: shown(s, g), to: person };
}

// The person's Answer on a copy handed to them, the one thing that reads it as answered (on the board's group it came
// from too)
function answerGroup(s, b) {
  const g = s.group(Number(b?.id));
  const p = g && g.deleted === null && s.page(g.page);
  if (!p) refuse(404, 'no such scrap');
  if (!g.handed) refuse(409, 'only a scrap handed to you is answered');
  g.handed.answered = true;
  const from = g.handed.from != null && s.group(Number(g.handed.from));
  for (const a of from?.assigned ?? []) if (a.to === g.handed.to || g.handed.to == null) a.answered = true;
  if (from) s.changed(s.page(from.page).notebook, from.page);
  s.changed(p.notebook, p.id);
  return { group: shown(s, g) };
}
// A story's guest pressing Answer on their copy of group (its id), handed to to: the board's group reads it answered
export function answeredBy(s, group, to) {
  const g = s.group(Number(group));
  const a = g?.assigned?.findLast(x => x.to === to);
  if (!a) throw new Error(`group ${group} wasn't handed to ${to}`);
  a.answered = true;
  s.changed(s.page(g.page).notebook, g.page);
}

// Who a group went to, once each, for its tags (notebookplaygroups.js groupOf)
export function assignedOf(s, g) {
  const latest = new Map((g.assigned ?? []).map(a => [a.to, a]));
  return [...latest.values()].flatMap(a => {
    const person = s.people.find(p => p.to === a.to);
    return person ? [{ ...personOf(person), answered: !!a.answered }] : [];
  });
}
// An Asks page's gathering (askgather.ts): after its own units, the open questions on its book's other pages, each
// where it is, with elsewhere: { page, label }; none is a place among the page's own (ownAfter: its end)
export function gatheredOn(s, p) {
  if (p.kind !== 'asks') return [];
  const at = g => s.page(g.page);
  return s.groups
    .filter(g => g.parent === null && g.deleted === null && g.page !== p.id && at(g)?.notebook === p.notebook)
    .filter(g => questionOf(s, g)?.answered === false)
    .sort((a, b) => at(a).pos - at(b).pos || a.pos - b.pos || a.id - b.id)
    .map(g => ({ ...shown(s, g), elsewhere: { page: g.page, label: at(g).label } }));
}
export const ownAfter = (s, p, after) =>
  after != null && after !== 'start' && gatheredOn(s, p).some(g => g.id === Number(after)) ? undefined : after;
// A question on the group read (bookassign.ts questionOf): a copy handed to this side, or an agent's design ask (its
// card), answered or not; null for anything else
export function questionOf(s, g) {
  if (g.handed) return { answered: !!g.handed.answered };
  const asks = s.asks.filter(a => a.group === g.id);
  return asks.length ? { answered: !asks.some(a => a.status === 'open') } : null;
}
