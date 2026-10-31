// Assigning: one of the board's scraps handed to a person picked from a short list, the people it picked most recently,
// or from everyone. A guest gets a copy on their own Asks page, kept in step with the original both ways: what either
// side writes on it shows on the other, so their answer shows on the board's scrap. An agent gets the scrap itself to
// answer at once (bookanswer.ts answerNow), its answer landing beside the original.
import { copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { db } from '../db.ts';
import { org } from '../company.ts';
import { BOARD } from './book.ts';
import { answerNow } from './bookanswer.ts';
import { asksPage } from './askpages.ts';
import { byHand, pageRow, shut, type NotebookPage } from '../notebook.ts';
import { insertGroup, partsOf, row, shown, write, type Group, type Parts } from '../notebookgroups.ts';
import { forGuest, whoOf, type Membership } from '../notebookguests.ts';
import { DIR } from '../pagescraps.ts';
import type { Refused } from '../pagechecks.ts';

// person: who it went to, as Person.to says it. copy: a guest's copy; answered: the guest has written on it
db.exec(`create table if not exists notebook_assigns (id integer primary key autoincrement, grp integer not null,
  person text not null, copy integer, answered integer not null default 0, created text not null);
  create index if not exists notebook_assigns_grp on notebook_assigns (grp);
  create index if not exists notebook_assigns_copy on notebook_assigns (copy)`);
// A picture of a handed-over scrap is the same picture on every side by its key (the file it first was), each side
// holding its own file of it
db.exec(`create table if not exists notebook_assign_pictures (grp integer not null, file text not null,
  key text not null, primary key (grp, file))`);

// to: 'agent:<id>' or a guest's book's 'guest:<grant>' (notebookguests.ts whoOf), so a name given to someone new
// later never takes over what went to the one before
export type Person = { to: string; name: string; kind: 'guest' | 'agent' };
type Assign = {
  id: number;
  grp: number;
  person: string;
  copy: number | null;
  answered: number;
};
// The short list's length: the few a glance takes in, as the deck draws it
const SHORT_LIST = 4;

// ---------------------------------------------------------------- the list
// GET /api/notebooks/people: the short list (the people picked most recently, topped up from everyone) and everyone a
// scrap can go to: the guests in a book now, and the agents
export function listPeople() {
  const everyone = people();
  const picked = (db.prepare('select person from notebook_assigns order by id desc').all() as { person: string }[])
    .map(a => everyone.find(p => p.to === a.person))
    .filter(p => p !== undefined);
  const recent = [...new Set([...picked, ...everyone])].slice(0, SHORT_LIST);
  return { recent, everyone };
}
function people(): Person[] {
  const named = db.prepare('select distinct guest from notebook_guests').all() as { guest: string }[];
  const guests = named
    .flatMap(g => forGuest(g.guest).slice(0, 1))
    .map(m => ({ to: whoOf(m), name: m.guest, kind: 'guest' as const }));
  const staff: { id: string; name?: string; temp?: boolean }[] = (org().departments ?? []).flatMap(
    (d: any) => d.agents ?? [],
  );
  const agents = staff
    .filter(a => !a.temp)
    .map(a => ({ to: `agent:${a.id}`, name: a.name ?? a.id, kind: 'agent' as const }));
  return [...guests, ...agents].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- handing it over
// POST /api/notebooks/groups/assign { id, to }: the board's scrap to that person; it stays where it is
export function assignGroup(b: any) {
  const g = row(Number(b?.id));
  const p = g && g.parent === null && g.deleted === null ? pageRow(g.page, BOARD) : undefined;
  if (!g || !p) return [404, 'no such scrap of the board’s'] as Refused;
  if (shut(p)) return [409, 'a sent page is read-only: hand over a scrap on an open page'] as Refused;
  const person = people().find(x => x.to === b.to);
  if (!person)
    return [400, 'to is someone on the list (GET /api/notebooks/people): a guest in a book, or an agent'] as Refused;
  const given = person.kind === 'agent' ? toAgent(g, person) : toGuest(g, p, person);
  if (Array.isArray(given)) return given;
  return { group: shown(row(g.id)!), to: person };
}
// An agent's to answer: it owns the scrap from now, and answers it now
function toAgent(g: Group, person: Person) {
  const agent = person.to.slice('agent:'.length);
  db.prepare('update notebook_groups set owner = ? where id = ?').run(agent, g.id);
  remember(g.id, person.to, null);
  answerNow({ grp: g.id }, { id: 0, why: 'The board handed this scrap to you to answer.' });
}
// A copy on the guest's Asks page, its last unit and as tall as the original's, its pictures their own
function toGuest(g: Group, p: NotebookPage, person: Person) {
  const page = landingFor(person.name, p.notebook);
  if (!page) return [409, `${person.name} has no open page to take it: their page is handed in`] as Refused;
  const parts = partsOf(g),
    files = parts.pictures.map(c => copied(page.id, c.file));
  const own = { ...parts, pictures: parts.pictures.map((c, i) => ({ ...c, file: files[i] })) };
  const anchor = g.anchor ? JSON.parse(g.anchor) : undefined;
  const copy = insertGroup(page, g.kind, g.by, own, { anchor, words: g.words, said: g.said, h: g.h });
  remember(g.id, person.to, copy.id);
  parts.pictures.forEach((c, i) => pair(g.id, c.file, copy.id, files[i]));
}
// Where a guest's copy lands: in the book the scrap is in if they're in it, else on the latest work shared with them,
// else in their latest book. On shared work (a review round's or a lasting guest's) it lands on their own page on it,
// where it waits in red (notebookguestshelf.ts.); elsewhere on their Asks page.
function landingFor(name: string, notebook: number) {
  const memberships = forGuest(name);
  const m: Membership =
    memberships.find(x => x.notebook === notebook) ?? memberships.findLast(onWork) ?? memberships.at(-1)!;
  const page = onWork(m) ? pageRow(m.page, null)! : (asksPage(m.notebook, whoOf(m)) as NotebookPage);
  return shut(page) ? null : page;
}
const onWork = (m: Membership) =>
  !!db
    .prepare(
      'select 1 from notebook_rounds where notebook = ?1 union select 1 from notebook_reviews where notebook = ?1',
    )
    .get(m.notebook);
const remember = (grp: number, person: string, copy: number | null) =>
  db
    .prepare('insert into notebook_assigns (grp, person, copy, created) values (?, ?, ?, ?)')
    .run(grp, person, copy, new Date().toISOString());
// A copy of a picture as one of the page's own (notebookpictures.ts ours)
function copied(page: number, file: string) {
  const to = `${page}-g-${randomBytes(4).toString('hex')}.${file.endsWith('.png') ? 'png' : 'jpg'}`;
  copyFileSync(`${DIR}/${file}`, `${DIR}/${to}`);
  return to;
}

// ---------------------------------------------------------------- in step
// A scrap or a copy of it written on (notebookgroups.ts editGroup, by: whose hand): the same ink, words, pictures and
// places on the original and every other copy (all in their unit's px), as a change of that hand's there, so each
// screen's Undo takes it back as one step. Each side then reads as changed, so a screen that wrote on what it read
// before is refused to read again (editGroup's since).
export function keepInStep(g: Group, by: string) {
  const back = db.prepare('select * from notebook_assigns where copy = ?').get(g.id) as Assign | undefined;
  const original = back ? row(back.grp)! : g;
  const parts = partsOf(g);
  // (answered once they've written on it: ink, typed words or a picture the board's hasn't. Their copy moved on their page,
  // as the page lays its scraps out, answers nothing.)
  if (back && written(parts, partsOf(original)))
    db.prepare('update notebook_assigns set answered = 1 where id = ?').run(back.id);
  const sides = [original, ...copiesOf(original.id).map(a => row(a.copy!)!)];
  for (const to of sides.filter(x => x.id !== g.id)) mirror(g, parts, to, by);
}
const written = (theirs: Parts, board: Parts) =>
  theirs.ink.length !== board.ink.length ||
  theirs.pictures.length !== board.pictures.length ||
  textOf(theirs) !== textOf(board);
const textOf = (parts: Parts) => (parts.texts as { text?: string }[]).map(t => t.text).join('\n');
function mirror(from: Group, parts: Parts, to: Group, by: string) {
  const p = pageRow(to.page, null);
  if (to.deleted !== null || !p || shut(p)) return;
  const pictures = parts.pictures.map(c => ({ ...c, file: twinOf(from.id, c.file, to) }));
  byHand(by, () => write(to.id, { ...parts, pictures }, { words: from.words, said: from.said }));
}
const copiesOf = (grp: number) =>
  db.prepare('select * from notebook_assigns where grp = ? and copy is not null').all(grp) as Assign[];
// A picture's file on another side: that side's own, copied onto its page the first time the picture reaches it
function twinOf(grp: number, file: string, to: Group) {
  const key = registerKey(grp, file);
  const kept = db.prepare('select file from notebook_assign_pictures where grp = ? and key = ?').get(to.id, key);
  if (kept) return (kept as { file: string }).file;
  const own = copied(to.page, file);
  pair(grp, file, to.id, own);
  return own;
}
// own: on group to, the same picture as file on group grp
function pair(grp: number, file: string, to: number, own: string) {
  const key = registerKey(grp, file);
  db.prepare('insert into notebook_assign_pictures (grp, file, key) values (?, ?, ?)').run(to, own, key);
}
// A picture's key, the picture registered as its own key the first time it's asked for
function registerKey(grp: number, file: string) {
  db.prepare('insert or ignore into notebook_assign_pictures (grp, file, key) values (?, ?, ?)').run(grp, file, file);
  return (
    db.prepare('select key from notebook_assign_pictures where grp = ? and file = ?').get(grp, file) as { key: string }
  ).key;
}

// ---------------------------------------------------------------- read with the scrap
// Who the board's scrap went to, for its tags: answered once a guest wrote on their copy, or the agent answered
export function assignedOf(grp: number) {
  const rows = db.prepare('select * from notebook_assigns where grp = ? order by id').all(grp) as Assign[];
  if (!rows.length) return [];
  const everyone = people();
  return [...new Map(rows.map(a => [a.person, a])).values()].flatMap(a => {
    const person = everyone.find(p => p.to === a.person);
    return person ? [{ ...person, answered: answered(a) }] : [];
  });
}
const answered = (a: Assign) =>
  a.copy !== null
    ? !!a.answered
    : !!db.prepare('select 1 from book_slips where grp = ? and by = ?').get(a.grp, a.person.slice('agent:'.length));
