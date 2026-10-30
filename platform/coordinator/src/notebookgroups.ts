// A notebook page's groups: everything on a page is a group, the unit that moves, deletes, goes to an agent and gets
// answered. A scrap is a cut of a page somewhere (its picture, where it was: the anchor, and its post-it's words); a
// drawing is strokes, typed words and pictures that belong together. HQ decides which group a new stroke joins (one
// that starts inside a group joins it); lasso joins and splits them. No group holds another, and none spans pages.
//   - A group's elements are in its page's CSS px: ink (ink.js strokes), texts (typed words) and pictures (files of the
//     book's, notebookpictures.ts).
//   - Once its page is sent a group is read-only. Its answers are its children: the agents' slips on the note it went
//     as (bookslips.ts) and the board's replies to them, groups of kind 'reply' under it (notebooksend.ts). Its asks
//     are the agents' desk-phone cards about that note or its replies' (hq ask --note: bookasks.ts). (asks)
//   - Delete keeps it aside SWEEP_MS for Undo (restore).
import { existsSync, rmSync } from 'node:fs';
import { ours, pictureUrl } from './notebookpictures.ts';
import { emptyGroup, hasAny, joined, picks, shifted } from '../../hq/shell/ink/notebookparts.js';
import { boxOf } from '../../hq/shell/ink/notebookstack.js';
import { db, inOneStep, lacks } from './db.ts'; // (lacks)
import { BOARD } from './ink/book.ts';
import { inkOf, isRefused, textsOf, wordsOf, type Anchor, type Refused } from './pagechecks.ts';
import { DIR, SWEEP_MS, scrapsOf, type Scrap } from './pagescraps.ts';
import { listedOnce } from './ink/bookslips.ts';
import { answersOf, readOf, triesOf } from './ink/groupanswers.ts';
import { changed, currentPage, pageRow, shut, type NotebookPage } from './notebook.ts';
import { judgeEdited, judgeLater } from './ink/bookjudge.ts';
import { spotsAgain, spotsClear } from './ink/answerplace.ts';

// parent: a reply's group. answers: the slip a reply is under. owner: the agent a scrap was cut from the work of (the
// page's data-owner), who gets it when its page is sent; null, the routing check decides. note: the note it went as.
// deleted: when it was deleted (ms), kept for Undo until SWEEP_MS later.
db.exec(`create table if not exists notebook_groups (id integer primary key autoincrement, page integer not null,
  parent integer, answers integer, kind text not null, by text not null, ink text not null default '[]',
  texts text not null default '[]', pictures text not null default '[]', anchor text, words text not null default '',
  said text, owner text, status text not null default 'open', note integer, created text not null, updated text not null,
  deleted integer, asked integer, asked_spot text, expect integer);
  create index if not exists notebook_groups_page on notebook_groups (page)`);
// (the answers' columns, as Group has them; tried: the try run making its versions, booktry.ts; reason: bookanswer.ts
// noAnswer's)
for (const column of ['asked integer', 'asked_spot text', 'expect integer', 'tried integer', 'reason integer'])
  if (lacks('notebook_groups', column.split(' ')[0])) db.exec(`alter table notebook_groups add column ${column}`);

// A group's elements (notebookparts.js), in its page's px
export type Parts = { ink: unknown[]; texts: unknown[]; pictures: Scrap[] };
export type Group = {
  id: number;
  page: number;
  parent: number | null;
  answers: number | null;
  kind: 'scrap' | 'drawing' | 'note' | 'reply'; // (note: typed words stacked as a post-it, notebookscraps.ts)
  by: string;
  ink: string;
  texts: string;
  pictures: string;
  anchor: string | null;
  words: string;
  said: string | null;
  owner: string | null;
  status: 'open' | 'sent';
  note: number | null;
  created: string;
  updated: string;
  deleted: number | null;
  asked: number | null; // (the run answering it, bookanswer.ts.)
  asked_spot: string | null; // (where its answer lies: JSON {dx, dy, w, h})
  expect: number | null; // (how many versions its try run makes: hq answer --expect)
  reason: number | null; // (the slip saying why no answer came, while it's shown)
};

// ---------------------------------------------------------------- a page whole
// GET /api/notebooks/pages/groups?page=: the page, its notebook and its groups, each with its children
export function listGroups(b: any, who = BOARD) {
  const p = pageRow(Number(b?.page), who);
  if (!p) return 404;
  const listed = listedOnce(),
    rows = db
      .prepare('select * from notebook_groups where page = ? and deleted is null order by id')
      .all(p.id) as Group[];
  const replies = rows.filter(g => g.parent !== null);
  return {
    page: p.id,
    notebook: p.notebook,
    title: p.label,
    handed: p.handed,
    groups: rows.filter(g => g.parent === null).map(g => groupOf(g, replies, listed)),
    ...triesOf(p, shown), // (a try's versions page: what it tries.)
  };
}

// ---------------------------------------------------------------- writing
// POST /api/notebooks/groups/create { page, ink?, texts?, pictures? }: a drawing on an open page. by: who drew it, the
// page's own person, or a call's agent on the board's (ink/callpage.ts) (by)
export function createGroup(b: any, who = BOARD, by = who) {
  const p = openPage(Number(b?.page), who);
  if (isRefused(p)) return p;
  const parts = elementsOf(b, who, emptyGroup);
  if (isRefused(parts)) return parts;
  if (!hasAny(parts)) return [400, 'a group holds something: ink, words or a picture', 'noteEmpty'] as Refused;
  const g = insertGroup(p, 'drawing', by, parts, {});
  if (by === BOARD && parts.texts.length) judgeLater({ grp: g.id }); // (bookjudge.ts)
  return shown(g);
}
// POST /api/notebooks/groups/edit { id, since, ink?, texts?, pictures?, words?, said? }: an open group's elements
// changed (drawn on, moved on its page, its post-it typed again). since: its updated as the screen last read it; one
// changed since on another screen is refused, to read again.
// by: who changed it (a call's agent: ink/callpage.ts)
export const CHANGED = 'this group changed on another screen: read it again';
export function editGroup(b: any, who = BOARD, by = who) {
  const g = openGroup(Number(b?.id), who);
  if (isRefused(g)) return g;
  if (b.since !== g.updated) return [409, CHANGED, 'noteChanged'] as Refused;
  const parts = elementsOf(b, who, partsOf(g));
  if (isRefused(parts)) return parts;
  const said = b.words === undefined ? { words: g.words, said: g.said } : wordsOf(b.words, b.said);
  if (isRefused(said)) return said;
  if (!hasAny(parts) && g.kind !== 'scrap') return [400, 'an empty group is deleted instead', 'noteDelete'] as Refused;
  write(g.id, parts, { words: said.words, said: said.said });
  if (by === BOARD) judgeEdited(g, said.words, parts.texts); // (bookjudge.ts)
  return shown(row(g.id)!);
}
// POST /api/notebooks/groups/move { id, page, dx?, dy? }: an open group onto another open page of the same person's,
// shifted by dx, dy
export function moveGroup(b: any, who = BOARD) {
  const g = openGroup(Number(b?.id), who);
  if (isRefused(g)) return g;
  const to = openPage(Number(b.page), who);
  if (isRefused(to)) return to;
  const dx = Number(b.dx ?? 0),
    dy = Number(b.dy ?? 0);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return [400, 'dx and dy are numbers'] as Refused;
  const from = g.page;
  inOneStep(() => {
    write(g.id, shifted(partsOf(g), dx, dy), {});
    db.prepare('update notebook_groups set page = ? where id = ? or parent = ?').run(to.id, g.id, g.id);
    changed(to.notebook, from);
    spotsClear(to.id);
  });
  changed(to.notebook, to.id);
  return shown(row(g.id)!);
}
// POST /api/notebooks/groups/delete { id }: an open group gone, kept aside for Undo (a reply: notebooksend.ts
// deleteReply)
export function deleteGroup(b: any, who = BOARD) {
  const g = row(Number(b?.id));
  const p = g && pageRow(g.page, who);
  if (!g || !p || g.deleted !== null) return 404;
  if (g.kind === 'reply') return [409, 'a reply is taken back with /api/notebooks/replies/delete'] as Refused;
  if (g.status !== 'open' || shut(p))
    return [409, 'a sent page is read-only: what the board wrote there stays', 'pageReadonly'] as Refused;
  putAside(g, p);
  return { ok: true, id: g.id };
}
// POST /api/notebooks/groups/restore { id }: Undo of a delete, the group back as it was, on its page if that's still
// open, else on the notebook's current page
export function restoreGroup(b: any, who = BOARD) {
  const g = row(Number(b?.id));
  const p = g && pageRow(g.page, who);
  if (!g || !p || g.deleted === null) return 404;
  if (g.kind === 'reply')
    return [409, "a reply taken back isn't sent again: write it again", 'replyRewrite'] as Refused;
  const page = g.parent === null && shut(p) ? currentPage(p.notebook) : p.id;
  db.prepare('update notebook_groups set deleted = null, page = ? where (id = ? or parent = ?) and deleted = ?').run(
    page,
    g.id,
    g.id,
    g.deleted,
  );
  spotsClear(page);
  // (its own answers placed again too: a spot kept from before the controls grew, or from the page it was on)
  spotsAgain(page, g.parent ?? g.id);
  changed(p.notebook, page);
  return shown(row(g.id)!);
}
// What hears groups joined: the group they joined into, and the ones joined away (a call page's asks follow theirs:
// ink/callnotes.ts)
const joinings: ((into: number, away: number[]) => void)[] = [];
export const onJoined = (hear: (into: number, away: number[]) => void) => void joinings.push(hear);
// POST /api/notebooks/groups/join { ids }: open groups of one page as one, the first's (lasso). One scrap at most: a
// scrap's place and words are its own, and a group signed by someone else (an invited person's note) stays theirs.
// The others are deleted, for Undo's split.
export function joinGroups(b: any, who = BOARD) {
  const ids: number[] = Array.isArray(b?.ids) ? [...new Set<number>(b.ids.map(Number))] : [];
  if (ids.length < 2) return [400, 'ids is two groups or more'] as Refused;
  const groups = ids.map(id => openGroup(id, who));
  const refused = groups.find(isRefused);
  if (refused) return refused;
  const all = groups as Group[];
  if (all.some(g => g.page !== all[0].page))
    return [400, "groups join on one page: a group doesn't span pages"] as Refused;
  if (all.some(g => g.kind === 'reply')) return [400, 'a reply stays under its answer'] as Refused;
  if (all.some(g => g.by !== all[0].by)) return [400, 'a note written by someone else stays its own'] as Refused;
  if (all.filter(g => g.kind === 'scrap').length > 1) return [400, 'a group holds one scrap at most'] as Refused;
  const into = all.find(g => g.kind === 'scrap') ?? all[0],
    rest = all.filter(g => g !== into);
  const parts = rest.reduce((sum, g) => joined(sum, partsOf(g)), partsOf(into));
  inOneStep(() => {
    write(into.id, parts, {});
    for (const g of rest) db.prepare('update notebook_groups set deleted = ? where id = ?').run(Date.now(), g.id);
    for (const hear of joinings)
      hear(
        into.id,
        rest.map(g => g.id),
      );
  });
  const p = pageRow(into.page, who)!;
  changed(p.notebook, p.id);
  return { group: shown(row(into.id)!), joined: rest.map(g => g.id) };
}
// What hears a group split: the group, and the one lifted out of it (a call page's asks follow their own words:
// ink/callnotes.ts)
const splits: ((from: number, lifted: number) => void)[] = [];
export const onSplit = (hear: (from: number, lifted: number) => void) => void splits.push(hear);
// POST /api/notebooks/groups/split { id, ink?, texts?, pictures? }: the elements named (by their index in the group)
// lifted out into a group of their own, a drawing (lasso, or Undo's of a join)
export function splitGroup(b: any, who = BOARD) {
  const g = openGroup(Number(b?.id), who);
  if (isRefused(g)) return g;
  const parts = partsOf(g),
    taken = {
      ink: picks(b.ink, parts.ink),
      texts: picks(b.texts, parts.texts),
      pictures: picks(b.pictures, parts.pictures),
    };
  if (Object.values(taken).some(t => t === null))
    return [400, "ink, texts and pictures are lists of the group's own indexes"] as Refused;
  const out = { ink: taken.ink!, texts: taken.texts!, pictures: taken.pictures! };
  const left = {
    ink: parts.ink.filter((_, i) => !out.ink.includes(i)),
    texts: parts.texts.filter((_, i) => !out.texts.includes(i)),
    pictures: parts.pictures.filter((_, i) => !out.pictures.includes(i)),
  };
  if (!hasAny(out) || (!hasAny(left) && g.kind !== 'scrap'))
    return [400, 'a split leaves something on each side'] as Refused;
  const p = pageRow(g.page, who)!;
  const lifted = inOneStep(() => {
    write(g.id, left, {});
    const split = insertGroup(
      p,
      'drawing',
      g.by,
      {
        ink: out.ink.map(i => parts.ink[i]),
        texts: out.texts.map(i => parts.texts[i]),
        pictures: out.pictures.map(i => parts.pictures[i]),
      },
      {},
    );
    for (const hear of splits) hear(g.id, split.id);
    return split;
  });
  return { group: shown(row(g.id)!), split: shown(row(lifted.id)!) };
}

// ---------------------------------------------------------------- shared
// The elements a request gives, each checked as a page's are (pagechecks.ts, pagescraps.ts), the rest as they were
function elementsOf(b: any, who: string, was: Parts): Parts | Refused {
  const ink = b.ink === undefined ? was.ink : inkOf(b.ink);
  if (isRefused(ink)) return ink;
  const texts = b.texts === undefined ? was.texts : textsOf(b.texts);
  if (isRefused(texts)) return texts;
  const placed =
    b.pictures === undefined ? was.pictures : scrapsOf(b.pictures, 0, f => ours(f, who) && existsSync(`${DIR}/${f}`));
  if (isRefused(placed)) return placed;
  return { ink, texts: texts ?? [], pictures: placed };
}
export function insertGroup(
  p: NotebookPage,
  kind: Group['kind'],
  by: string,
  parts: Parts,
  more: Omit<Partial<Group>, 'anchor'> & { anchor?: Anchor },
) {
  const now = new Date().toISOString();
  const id = Number(
    db
      .prepare(
        `insert into notebook_groups (page, parent, answers, kind, by, ink, texts, pictures, anchor, words, said, owner,
        created, updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ...[p.id, more.parent ?? null, more.answers ?? null, kind, by],
        ...[JSON.stringify(parts.ink), JSON.stringify(parts.texts), JSON.stringify(parts.pictures)],
        ...[more.anchor ? JSON.stringify(more.anchor) : null, more.words ?? '', more.said ?? null, more.owner ?? null],
        ...[now, now],
      ).lastInsertRowid,
  );
  spotsClear(p.id); // (an answer's spot it covers moves: answerplace.ts)
  changed(p.notebook, p.id);
  return row(id)!;
}
function write(id: number, parts: Parts, more: { words?: string; said?: string | null }) {
  const g = row(id)!;
  db.prepare(
    'update notebook_groups set ink = ?, texts = ?, pictures = ?, words = ?, said = ?, updated = ? where id = ?',
  ).run(
    ...[JSON.stringify(parts.ink), JSON.stringify(parts.texts), JSON.stringify(parts.pictures)],
    ...[more.words ?? g.words, more.said === undefined ? g.said : more.said, new Date().toISOString(), id],
  );
  const p = pageRow(g.page, null)!;
  spotsClear(p.id);
  changed(p.notebook, p.id);
}
export const partsOf = (g: Group): Parts => ({
  ink: JSON.parse(g.ink),
  texts: JSON.parse(g.texts),
  pictures: JSON.parse(g.pictures),
});
export function openPage(id: number, who: string): NotebookPage | Refused {
  const p = pageRow(id, who);
  if (!p) return [404, 'no such page', 'unavailable'];
  if (shut(p)) return [409, 'a sent page is read-only: draw on the current page', 'pageReadonly'];
  return p;
}
function openGroup(id: number, who: string): Group | Refused {
  const g = row(id);
  const p = g && g.deleted === null && pageRow(g.page, who);
  if (!g || !p) return [404, 'no such group', 'unavailable'];
  if (g.status !== 'open' || shut(p))
    return [409, 'a sent page is read-only: what the board wrote there stays', 'pageReadonly'];
  return g;
}
// A group deleted, with its children, kept aside SWEEP_MS for Undo
export function putAside(g: Group, p: NotebookPage) {
  forgetDeleted();
  db.prepare('update notebook_groups set deleted = ? where id = ? or parent = ?').run(Date.now(), g.id, g.id);
  changed(p.notebook, p.id);
}
// The deleted groups past their Undo, and their pictures (not one a group left still names: a join's group keeps its
// joined-away groups' pictures)
function forgetDeleted() {
  const old = db.prepare('select * from notebook_groups where deleted < ?').all(Date.now() - SWEEP_MS) as Group[];
  for (const g of old) db.prepare('delete from notebook_groups where id = ?').run(g.id);
  const named = db.prepare(
    "select 1 from notebook_groups g, json_each(g.pictures) j where json_extract(j.value, '$.file') = ?",
  );
  for (const g of old)
    for (const c of partsOf(g).pictures) if (!named.get(c.file)) rmSync(`${DIR}/${c.file}`, { force: true });
}
// Every element of a page's groups, replies too, for its picture (bookpicture.ts)
export function drawnGroups(page: number) {
  const groups = db.prepare('select * from notebook_groups where page = ? and deleted is null').all(page) as Group[];
  return groups.map(partsOf).reduce(joined, emptyGroup);
}
// The box round all of a page's groups (null: none)
export const groupsBox = (page: number) => boxOf(drawnGroups(page));
export const row = (id: number) =>
  (Number.isInteger(id) && id > 0 ? db.prepare('select * from notebook_groups where id = ?').get(id) : undefined) as
    Group | undefined;
// A group's root: a reply's parent (the board's note it's written under), else the group itself
export const rootOf = (g: Group) => (g.parent === null ? g : row(g.parent)!);
// The group a book note went as, unless it's deleted: a deleted group is kept only for Undo, so nothing answers on it
// or tries it
export const groupOfNote = (note: number) =>
  db.prepare('select * from notebook_groups where note = ? and deleted is null').get(note) as Group | undefined;
// The group an answer or a judged target is on, unless it's deleted (as groupOfNote: nor is a reply written under it):
// its own (grp), else the group its note went as
export const groupOn = (x: { grp?: number | null; note?: number | null }) => {
  const g = x.grp != null ? row(x.grp) : x.note != null ? groupOfNote(x.note) : undefined;
  return g?.deleted === null ? g : undefined;
};
// What HQ reads of a group: its elements, its box, its children (answers and replies, in the order they came), asks
export const shown = (g: Group) =>
  groupOf(g, db.prepare('select * from notebook_groups where parent = ? and deleted is null').all(g.id) as Group[]);
function groupOf(g: Group, replies: Group[], listed = listedOnce()) {
  const parts = partsOf(g),
    mineReplies = replies.filter(r => r.parent === g.id);
  const { answers, ...about } = answersOf(g, mineReplies, listed); // (waiting, tries_page, asks)
  const head = { ...element(g, parts), anchor: g.anchor ? (JSON.parse(g.anchor) as Anchor) : null, ...about };
  return readOf(
    head,
    g.owner,
    answers,
    mineReplies.map(r => ({ ...element(r, partsOf(r)), answers: r.answers })),
  );
}
const element = (g: Group, parts: Parts) => ({
  id: g.id,
  page: g.page,
  kind: g.kind,
  by: g.by,
  ink: parts.ink,
  texts: parts.texts,
  pictures: parts.pictures.map(c => ({ ...c, url: pictureUrl(c.file) })),
  words: g.words,
  said: g.said,
  status: g.status,
  note: g.note,
  box: boxOf(parts),
  created: g.created,
  updated: g.updated,
});
