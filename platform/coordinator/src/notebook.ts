// The Notebook: a person's notebooks on a shelf (and its archive), each a row of pages in its own order. A page is an
// endless canvas of groups (notebookgroups.ts); new groups land on the notebook's current page, the newest one not sent
// or archived, made when there's none. A page is sent whole (notebooksend.ts), and stays, read-only, marked sent.
//   - A page is a book_pages row (book.ts) with its notebook, its place in the notebook's order (pos), its send's time
//     (send_at, ms: still sending until then, sent from then on) and the fresh page its send made (fresh, which its
//     Undo takes away while still blank). Its own ink, scraps and words are the old book's, carried into groups as a
//     notebook is first made (notebookcarry.ts).
//   - Every change is a 'book' event with text 'notebook' and the page, so every screen showing it reads it again.
import { db, inOneStep, lacks } from './db.ts';
import { companyDay } from './company.ts';
import { publish } from './events.ts';
import { BOARD, COLUMNS, type Page } from './ink/book.ts';
import { isRefused, labelOf, type Refused } from './pagechecks.ts';
import { carryInto, uncarried } from './notebookcarry.ts';
import { groupsBox } from './notebookgroups.ts';
import { DIR } from './pagescraps.ts';
import { rmSync } from 'node:fs';

// kind: 'mine' (a person's own, where pins and their notes go), 'call' (a call's notes), 'round' (a guest review round)
// or 'invited' (one the board made for someone it invited). name: what the shelf shows.
db.exec(`create table if not exists notebooks (id integer primary key autoincrement, who text not null, kind text not null,
  name text not null default '', archived integer not null default 0, created text not null, updated text not null);
  create index if not exists notebooks_who on notebooks (who)`);
for (const column of ['notebook integer', 'pos real', 'send_at integer', 'fresh integer'])
  if (lacks('book_pages', column.split(' ')[0])) db.exec(`alter table book_pages add column ${column}`);
db.exec('create index if not exists book_pages_notebook on book_pages (notebook, pos)');

export const KINDS = ['mine', 'call', 'round', 'invited'] as const;
export type Notebook = {
  id: number;
  who: string;
  kind: (typeof KINDS)[number];
  name: string;
  archived: number;
  created: string;
  updated: string;
};
export type NotebookPage = Page & { notebook: number; pos: number; send_at: number | null; fresh: number | null };
const PAGE_COLUMNS = `${COLUMNS}, notebook, pos, send_at, fresh`;
// The size a new page starts at: it grows every way as it's drawn on
const NEW_PAGE = { w: 1200, h: 1600 };

// ---------------------------------------------------------------- the shelf
// GET /api/notebooks: the shelf (My Notebook first) and the archive
export function listNotebooks(who = BOARD) {
  mine(who);
  const all = db
    .prepare("select * from notebooks where who = ? order by kind = 'mine' desc, updated desc, id desc")
    .all(who) as Notebook[];
  return {
    shelf: all.filter(n => !n.archived).map(notebookOf),
    archive: all.filter(n => n.archived).map(notebookOf),
  };
}
// POST /api/notebooks/archive { id, archived }: a notebook onto the archive or back on the shelf (My Notebook stays)
export function archiveNotebook(b: any, who = BOARD) {
  const n = notebookRow(Number(b?.id), who);
  if (!n) return 404;
  if (typeof b.archived !== 'boolean') return [400, 'archived is true or false'] as Refused;
  if (n.kind === 'mine') return [409, 'My Notebook stays on the shelf'] as Refused;
  db.prepare('update notebooks set archived = ?, updated = ? where id = ?').run(
    Number(b.archived),
    new Date().toISOString(),
    n.id,
  );
  return notebookOf(notebookRow(n.id, who)!);
}
// A person's own notebook, made the first time it's asked for, with their old book carried in (and any old page since)
export function mine(who = BOARD) {
  const found = db.prepare("select * from notebooks where who = ? and kind = 'mine'").get(who) as Notebook | undefined;
  if (found && !uncarried(who)) return found;
  return inOneStep(() => {
    const id = found?.id ?? makeNotebook(who, 'mine', 'My Notebook');
    // (notes written the old way since land on the current page: every screen showing it reads it again.)
    const late = carryInto(id, who, () => currentPage(id));
    if (late) changed(id, late);
    return notebookRow(id, who)!;
  });
}
export function makeNotebook(who: string, kind: Notebook['kind'], name: string) {
  const now = new Date().toISOString();
  return Number(
    db
      .prepare('insert into notebooks (who, kind, name, created, updated) values (?, ?, ?, ?, ?)')
      .run(who, kind, name, now, now).lastInsertRowid,
  );
}

// ---------------------------------------------------------------- a notebook's pages
// GET /api/notebooks/pages?notebook=: its pages in their order (the current one made if there's none), then those
// archived
export function listPages(b: any, who = BOARD) {
  const n = notebookRow(Number(b?.notebook), who);
  if (!n) return 404;
  if (n.kind === 'mine') mine(who);
  // (a call's notebook has its one page, made with the call: callnotes.ts.)
  if (n.kind !== 'call') currentPage(n.id);
  const pages = pagesOf(n.id);
  return {
    notebook: notebookOf(n),
    pages: pages.filter(p => !p.archived).map(pageOf),
    archived: pages.filter(p => p.archived).map(pageOf),
  };
}
// POST /api/notebooks/pages/create { notebook }: a blank page after the others, the current one from now
export function createPage(b: any, who = BOARD) {
  const n = notebookRow(Number(b?.notebook), who);
  if (!n) return 404;
  return pageOf(pageRow(newPage(n.id), who)!);
}
// POST /api/notebooks/pages/order { notebook, pages: [ids] }: every page of the notebook, archived too, in a new order
export function orderPages(b: any, who = BOARD) {
  const n = notebookRow(Number(b?.notebook), who);
  if (!n) return 404;
  const ids = Array.isArray(b.pages) ? b.pages.map(Number) : [],
    now = pagesOf(n.id).map(p => p.id);
  if (ids.length !== now.length || new Set(ids).size !== ids.length || !ids.every((id: number) => now.includes(id)))
    return [400, "pages is every one of the notebook's pages, once each, in their new order"] as Refused;
  inOneStep(() =>
    ids.forEach((id: number, i: number) => db.prepare('update book_pages set pos = ? where id = ?').run(i, id)),
  );
  changed(n.id, null);
  return listPages({ notebook: n.id }, who);
}
// POST /api/notebooks/pages/archive { id, archived }: a page into the notebook's archive, or back
export function archivePage(b: any, who = BOARD) {
  const p = pageRow(Number(b?.id), who);
  if (!p) return 404;
  if (typeof b.archived !== 'boolean') return [400, 'archived is true or false'] as Refused;
  db.prepare('update book_pages set archived = ? where id = ?').run(Number(b.archived), p.id);
  changed(p.notebook, p.id);
  return pageOf(pageRow(p.id, who)!);
}
// POST /api/notebooks/pages/title { id, title }
export function titlePage(b: any, who = BOARD) {
  const p = pageRow(Number(b?.id), who),
    title = labelOf(b?.title);
  if (!p) return 404;
  if (isRefused(title)) return title;
  db.prepare('update book_pages set label = ? where id = ?').run(title, p.id);
  changed(p.notebook, p.id);
  return pageOf(pageRow(p.id, who)!);
}

// The page new groups land on: the newest page of the notebook neither sent nor archived, made if there's none
export function currentPage(notebook: number) {
  const open = db
    .prepare(
      'select id from book_pages where notebook = ? and archived = 0 and send_at is null order by created desc, id desc',
    )
    .get(notebook) as { id: number } | undefined;
  return open?.id ?? newPage(notebook);
}
export function newPage(notebook: number) {
  const n = db.prepare('select who from notebooks where id = ?').get(notebook) as { who: string },
    now = new Date().toISOString();
  const { last } = db.prepare('select max(pos) last from book_pages where notebook = ?').get(notebook) as {
    last: number | null;
  };
  const id = Number(
    db
      .prepare(
        "insert into book_pages (who, day, kind, label, created, updated, w, h, notebook, pos) values (?, ?, 'free', '', ?, ?, ?, ?, ?, ?)",
      )
      .run(n.who, companyDay(Date.now()), now, now, NEW_PAGE.w, NEW_PAGE.h, notebook, (last ?? -1) + 1).lastInsertRowid,
  );
  changed(notebook, id);
  return id;
}
// A page has changed: its box grows round its groups, its picture is drawn again when next read, its notebook moves up
// the shelf, and every screen showing it reads it again
export function changed(notebook: number, page: number | null) {
  const now = new Date().toISOString();
  if (page) {
    const p = pageRow(page, null)!,
      round = groupsBox(page);
    const x = Math.min(p.x, round?.x ?? p.x),
      y = Math.min(p.y, round?.y ?? p.y);
    const w = Math.max(p.x + p.w, round ? round.x + round.w : 0) - x,
      h = Math.max(p.y + p.h, round ? round.y + round.h : 0) - y;
    if (p.picture) rmSync(`${DIR}/${p.picture}`, { force: true });
    db.prepare('update book_pages set picture = null, updated = ?, x = ?, y = ?, w = ?, h = ? where id = ?').run(
      ...[now, Math.floor(x), Math.floor(y), Math.ceil(w), Math.ceil(h), page],
    );
  }
  db.prepare('update notebooks set updated = ? where id = ?').run(now, notebook);
  publish({ type: 'book', agent: BOARD, text: 'notebook', ...(page ? { page } : {}) });
}

// ---------------------------------------------------------------- shared
export const notebookRow = (id: number, who: string) =>
  (Number.isInteger(id) && id > 0
    ? db.prepare('select * from notebooks where id = ? and who = ?').get(id, who)
    : undefined) as Notebook | undefined;
// One of a person's notebook pages (who null: anyone's)
export const pageRow = (id: number, who: string | null) =>
  (Number.isInteger(id) && id > 0
    ? db
        .prepare(
          `select ${PAGE_COLUMNS} from book_pages where id = ? and notebook is not null and (?2 is null or who = ?2)`,
        )
        .get(id, who)
    : undefined) as NotebookPage | undefined;
const pagesOf = (notebook: number) =>
  db
    .prepare(`select ${PAGE_COLUMNS} from book_pages where notebook = ? order by pos, id`)
    .all(notebook) as NotebookPage[];
// Whether a page's own content is read-only: it's sending or sent
export const shut = (p: NotebookPage) => p.send_at !== null;
// Whether a page sent has gone: its seconds are up, or a sheet of its has been delivered already
export const gone = (p: NotebookPage) =>
  p.send_at !== null &&
  (p.send_at <= Date.now() ||
    !!db
      .prepare(
        `select 1 from notebook_groups g join book_notes n on n.id = g.note join book_sheets s on s.id = n.sheet
        where g.page = ? and g.parent is null and s.status != 'sending' limit 1`,
      )
      .get(p.id));
const notebookOf = (n: Notebook) => ({
  id: n.id,
  name: n.name,
  kind: n.kind,
  archived: !!n.archived,
  created: n.created,
  updated: n.updated,
  pages: (
    db.prepare('select count(*) n from book_pages where notebook = ? and archived = 0').get(n.id) as { n: number }
  ).n,
});
// What the shelf and a notebook's page grid read of a page. sending: in its seconds to undo; sent: when it went.
// picture: the page drawn whole, groups and all (bookpicture.ts).
export function pageOf(p: NotebookPage) {
  const went = gone(p),
    { n } = db
      .prepare('select count(*) n from notebook_groups where page = ? and parent is null and deleted is null')
      .get(p.id) as { n: number };
  return {
    id: p.id,
    notebook: p.notebook,
    kind: p.kind,
    title: p.label,
    archived: !!p.archived,
    sending: p.send_at !== null && !went,
    sent: went ? new Date(p.send_at!).toISOString() : null,
    created: p.created,
    updated: p.updated,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    groups: n,
    picture: `/api/book/picture?id=${p.id}&v=${encodeURIComponent(p.updated)}`,
  };
}
