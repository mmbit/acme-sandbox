// Assigning: a scrap of the board's, on any of its open pages, handed to a guest invited to that page's book or its
// project, picked from a short list, the ones it picked most recently, or from all of them. The guest gets a copy on
// their own Asks page, kept in step with the original both ways: what either side writes on it shows on the other, so
// their answer shows on the board's scrap, and it reads as answered once they press Answer. Never an agent:
// routing is ours, and a sketch's scraps reach their agent by themselves (the Ink README, What a page offers). A stored
// scrap tagged with an agent keeps its tag.
import { db } from '../db.ts';
import { org } from '../company.ts';
import { BOARD } from './book.ts';
import { asksPage } from './askpages.ts';
import { changed, notebookRow, pageRow, shut, type NotebookPage } from '../notebook.ts';
import { insertGroup, partsOf, row, shown, write, type Group, type Parts } from '../notebookgroups.ts';
import { active, forGuest, memberships, whoOf, type Membership } from '../notebookmembers.ts';
import { colourOf } from './sketchpeople.ts';
import * as shares from '../shares.ts';
import * as artifacts from '../artifacts.ts';
import { copyPicture } from '../notebookpictures.ts';
import type { Refused } from '../pagechecks.ts';

// person: who it went to, as Person.to says it. copy: a guest's copy; answered: the guest pressed Answer on it
db.exec(`create table if not exists notebook_assigns (id integer primary key autoincrement, grp integer not null,
  person text not null, copy integer, answered integer not null default 0, created text not null);
  create index if not exists notebook_assigns_grp on notebook_assigns (grp);
  create index if not exists notebook_assigns_copy on notebook_assigns (copy)`);
// A picture of a handed-over scrap is the same picture on every side by its key (the file it first was), each side
// holding its own file of it
db.exec(`create table if not exists notebook_assign_pictures (grp integer not null, file text not null,
  key text not null, primary key (grp, file))`);

// to: a guest's book's 'guest:<grant>' (notebookmembers.ts whoOf), so a name given to someone new later never takes
// over what went to the one before; 'agent:<id>' on a stored scrap tagged with an agent
// (initial and colour: their tag on the board's scrap, as their book's colour)
export type Person = { to: string; name: string; kind: 'guest' | 'agent'; initial: string; colour: string | null };
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
// GET /api/notebooks/people?page=: the short list (the guests picked most recently, topped up from everyone) and everyone a
// scrap on that page can go to: the guests invited to its book or its project,
// or every guest in a book now for the board's own book, which nobody is invited to, or without a page
export function listPeople(b?: any) {
  const everyone = b?.page == null ? people() : invitedFor(Number(b.page));
  const picked = (db.prepare('select person from notebook_assigns order by id desc').all() as { person: string }[])
    .map(a => everyone.find(p => p.to === a.person))
    .filter(p => p !== undefined);
  const recent = [...new Set([...picked, ...everyone])].slice(0, SHORT_LIST);
  return { recent, everyone };
}
function people(): Person[] {
  const named = db.prepare('select distinct guest from notebook_guests').all() as { guest: string }[];
  return named
    .flatMap(g => forGuest(g.guest).slice(0, 1))
    .map(m => ({ to: whoOf(m), name: m.guest, kind: 'guest' as const, ...tagOf(m.guest, m.grant_id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
const tagOf = (name: string, grant: number | null) => ({
  initial: [...name.trim()][0]?.toUpperCase() ?? '?',
  colour: grant === null ? null : colourOf({ id: grant }),
});
// from that project's work, and the project's own book), or every guest when the book is the board's own or nobody is
// invited there yet
function invitedFor(page: number) {
  const p = pageRow(page, BOARD);
  const n = p?.notebook == null ? undefined : notebookRow(p.notebook, BOARD);
  if (!n || n.kind === 'mine') return people();
  const known = artifacts.list(),
    project = projectOf(n.id, known);
  const shared = [...new Set(memberships().map(m => m.notebook))];
  const books = new Set([n.id, ...(project ? shared.filter(id => projectOf(id, known) === project) : [])]);
  const names = new Set(
    memberships()
      .filter(m => books.has(m.notebook) && active(m))
      .map(m => m.guest.toLowerCase()),
  );
  const invited = people().filter(x => names.has(x.name.toLowerCase()));
  return invited.length ? invited : people();
}
// The project a shared work's book is from (its share's work placed under a project), as a guest's shelf groups them
// (notebookguestshelf.ts); a project's own book's project
function projectOf(notebook: number, known: ReturnType<typeof artifacts.list>): string | null {
  const n = notebookRow(notebook, BOARD);
  if (n?.kind === 'project') return n.project;
  const linked = db.prepare('select share from notebook_reviews where notebook = ?').get(notebook) as
    { share: number } | undefined;
  const share = linked && shares.byId(linked.share);
  const work = share && known.find(a => a.about === share.about);
  return work?.place.find(x => x.level === 'project')?.id ?? null;
}
// The agents, to name the tags stored scraps may still carry
function agents(): Person[] {
  const staff: { id: string; name?: string }[] = (org().departments ?? []).flatMap((d: any) => d.agents ?? []);
  return staff.map(a => ({
    to: `agent:${a.id}`,
    name: a.name ?? a.id,
    kind: 'agent' as const,
    ...tagOf(a.name ?? a.id, null),
  }));
}

// ---------------------------------------------------------------- handing it over
// POST /api/notebooks/groups/assign { id, to }: a scrap on an open page of the board's to that guest; it stays where it
// is (any page's)
export function assignGroup(b: any) {
  const g = row(Number(b?.id));
  const p = g && g.parent === null && g.deleted === null ? pageRow(g.page, BOARD) : undefined;
  if (!g || !p) return [404, 'no such scrap of the board’s'] as Refused;
  if (shut(p)) return [409, 'a sent page is read-only: hand over a scrap on an open page'] as Refused;
  const person = people().find(x => x.to === b.to);
  if (!person) return [400, 'to is a guest on the list (GET /api/notebooks/people?page=)'] as Refused;
  const given = toGuest(g, p, person);
  if (Array.isArray(given)) return given;
  return { group: shown(row(g.id)!), to: person };
}
// A copy on the guest's Asks page, its last unit and as tall as the original's, its pictures their own
function toGuest(g: Group, p: NotebookPage, person: Person) {
  const page = landingFor(person.name, p.notebook);
  if (!page) return [409, `${person.name} has no open page to take it: their page is handed in`] as Refused;
  const parts = partsOf(g),
    files = parts.pictures.map(c => copyPicture(page.id, c.file));
  const own = { ...parts, pictures: parts.pictures.map((c, i) => ({ ...c, file: files[i] })) };
  const anchor = g.anchor ? JSON.parse(g.anchor) : undefined;
  const copy = insertGroup(page, g.kind, g.by, own, { anchor, words: g.words, said: g.said, h: g.h });
  remember(g.id, person.to, copy.id);
  parts.pictures.forEach((c, i) => pair(g.id, c.file, copy.id, files[i]));
  // (and an Asks page in their own book, which gathers every question handed to them: askgather.ts.)
  const home = forGuest(person.name).find(m => !onWork(m));
  if (home && home.notebook !== page.notebook) asksPage(home.notebook, whoOf(home));
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

// ---------------------------------------------------------------- in step
// A scrap or a copy of it written on (notebookgroups.ts editGroup): the same ink, words, pictures and
// places on the original and every other copy (all in their unit's px), as a change of that hand's there: no step of
// another screen's Undo, which takes back only its own. Each side then reads as changed, so a screen that wrote on what it read
// before is refused to read again (editGroup's since).
export function keepInStep(g: Group) {
  const back = db.prepare('select * from notebook_assigns where copy = ?').get(g.id) as Assign | undefined;
  const original = back ? row(back.grp)! : g;
  const parts = partsOf(g);
  const sides = [original, ...copiesOf(original.id).map(a => row(a.copy!)!)];
  for (const to of sides.filter(x => x.id !== g.id)) mirror(g, parts, to);
}
function mirror(from: Group, parts: Parts, to: Group) {
  const p = pageRow(to.page, null);
  if (to.deleted !== null || !p || shut(p)) return;
  const pictures = parts.pictures.map(c => ({ ...c, file: twinOf(from.id, c.file, to) }));
  write(to.id, { ...parts, pictures }, { words: from.words, said: from.said });
}
const copiesOf = (grp: number) =>
  db.prepare('select * from notebook_assigns where grp = ? and copy is not null').all(grp) as Assign[];
// A picture's file on another side: that side's own, copied onto its page the first time the picture reaches it
function twinOf(grp: number, file: string, to: Group) {
  const key = registerKey(grp, file);
  const kept = db.prepare('select file from notebook_assign_pictures where grp = ? and key = ?').get(to.id, key);
  if (kept) return (kept as { file: string }).file;
  const own = copyPicture(to.page, file);
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

// ---------------------------------------------------------------- the answer
// POST /api/notebooks/groups/answer { id } (and the guest room's): the person's Answer on their copy of a scrap handed
// to them, the one thing that reads it as answered on the board's scrap; what they wrote is on it already (in step)
export function answerGroup(b: any, who = BOARD) {
  const g = row(Number(b?.id));
  const p = g && g.deleted === null ? pageRow(g.page, who) : undefined;
  const handed = g && (db.prepare('select * from notebook_assigns where copy = ?').get(g.id) as Assign | undefined);
  if (!g || !p) return [404, 'no such scrap'] as Refused;
  if (!handed) return [409, 'only a scrap handed to you is answered'] as Refused;
  db.prepare('update notebook_assigns set answered = 1 where id = ?').run(handed.id);
  const original = row(handed.grp);
  const from = original && pageRow(original.page, null);
  if (from) changed(from.notebook, from.id);
  changed(p.notebook, p.id);
  return { group: shown(row(g.id)!) };
}
// A question on the group read: an agent's ask (its card, answered once no card of it is open) or a guest's copy of a
// scrap handed to them (answered once they pressed Answer); null for anything else
export function questionOf(g: Group, asks: { status: string }[]) {
  const handed = db.prepare('select answered from notebook_assigns where copy = ?').get(g.id) as
    { answered: number } | undefined;
  if (handed) return { answered: !!handed.answered };
  if (g.request !== null) return { answered: !asks.some(a => a.status === 'open') };
  return null;
}

// ---------------------------------------------------------------- read with the scrap
// Who the board's scrap went to, for its tags: answered once a guest pressed Answer on their copy, or the agent answered
export function assignedOf(grp: number) {
  const rows = db.prepare('select * from notebook_assigns where grp = ? order by id').all(grp) as Assign[];
  if (!rows.length) return [];
  const everyone = [...people(), ...agents()];
  return [...new Map(rows.map(a => [a.person, a])).values()].flatMap(a => {
    const person = everyone.find(p => p.to === a.person);
    return person ? [{ ...person, answered: answered(a) }] : [];
  });
}
const answered = (a: Assign) =>
  a.copy !== null
    ? !!a.answered
    : !!db.prepare('select 1 from book_slips where grp = ? and by = ?').get(a.grp, a.person.slice('agent:'.length));
