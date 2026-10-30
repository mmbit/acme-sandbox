// The Notebook: a person's notebooks on a shelf (and its archive), each a row of pages in its own order. A page is an
// endless canvas of groups (notebookgroups.ts); new groups land on the notebook's current page, the newest one not sent,
// archived or a try's versions page (notebookstack.js), made when there's none. A page is sent whole (notebooksend.ts),
// and stays, read-only, marked sent.
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
import { titleLater } from './notebooktitles.ts';
import { landingPage } from '../../hq/shell/ink/notebookstack.js';
import { chapterOf as chapterIn, inChapters } from '../../hq/shell/ink/notebookchapters.js';
import { SCREEN_SHAPES } from '../../hq/shell/ink/booklayout.js';
import { ZOOM_KEPT } from '../../hq/shell/ink/bookrow.js';
import { shownCard } from './shown.ts';
import { MY_JOURNAL, seenNotebook, shelfColumns, shelfOf } from './notebookshelf.ts';
import { roundSummary } from './notebookrounds.ts';

// kind: 'mine' (a person's own, where pins and their notes go, and a call's notes page: ink/callnotes.ts), 'round' (a
// guest review round's book: notebookrounds.ts), 'invited' (one the board made for someone it invited) or 'project' (a project's book, the CEO
// makes: its design asks land on its Asks page, ink/askpages.ts). name: what the shelf shows. project: a project
// book's project. (project) cover: the picture the board gave its cover, a file
// in DIR; seen: when the board last read it, its answers since are new (notebookshelf.ts.)
db.exec(`create table if not exists notebooks (id integer primary key autoincrement, who text not null, kind text not null,
  name text not null default '', archived integer not null default 0, created text not null, updated text not null,
  project text, cover text, seen text);
  create index if not exists notebooks_who on notebooks (who)`);
if (lacks('notebooks', 'project')) db.exec('alter table notebooks add column project text');
shelfColumns();
// (tries, tries_note: the group or old book's note a versions page was for, before a try's versions came under their
// note: such a page is listed no more.)
for (const column of [
  'notebook integer',
  'pos real',
  'send_at integer',
  'fresh integer',
  'tries integer',
  'tries_note integer',
  "title_by text not null default ''",
  "title_seen text not null default ''",
  "zooms text not null default '{}'",
  'handed integer not null default 0',
  'followed integer',
])
  if (lacks('book_pages', column.split(' ')[0])) db.exec(`alter table book_pages add column ${column}`);
db.exec('create index if not exists book_pages_notebook on book_pages (notebook, pos)');

export const KINDS = ['mine', 'round', 'invited', 'project'] as const;
export type Notebook = {
  id: number;
  who: string;
  kind: (typeof KINDS)[number];
  name: string;
  archived: number;
  created: string;
  updated: string;
  project: string | null;
  cover: string | null;
  seen: string | null;
};
// Who set the title. An empty value means nobody has named the page.
export type TitleBy = '' | 'board' | 'agent' | 'model';
export type NotebookPage = Page & {
  notebook: number;
  pos: number;
  send_at: number | null;
  fresh: number | null;
  tries: number | null;
  // The board's title, including a deliberately empty one, takes precedence over agents and models.
  title_by: TitleBy;
  // SHA-256 of the ordered groups' ink, texts, pictures and words last checked by the title model. Empty until checked.
  title_seen: string;
  // The zoom the board left the page at, by the book's shape on the screen (booklayout.js shapeOf): JSON, { wide: 0.72 }.
  zooms: string;
  // How many changes someone else's hand has made on it (byHand): a screen's read that finds more takes what it brings
  // as a step of its own
  handed: number;
  // A call's notes page: when its call's follow-up handed out what's on it, its Sent stamp (ink/callnotes.ts followed)
  followed: number | null;
};
const PAGE_COLUMNS = `${COLUMNS}, notebook, pos, send_at, fresh, tries, title_by, title_seen, zooms, handed, followed`;
// The size a new page starts at: it grows every way as it's drawn on
const NEW_PAGE = { w: 1200, h: 1600 };

// ---------------------------------------------------------------- the shelf
// GET /api/notebooks: the shelf (My journal first) and the archive
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
// POST /api/notebooks/archive { id, archived }: a notebook onto the archive or back on the shelf (My journal stays)
export function archiveNotebook(b: any, who = BOARD) {
  const n = notebookRow(Number(b?.id), who);
  if (!n) return 404;
  if (typeof b.archived !== 'boolean') return [400, 'archived is true or false'] as Refused;
  if (n.kind === 'mine') return [409, `${MY_JOURNAL} stays on the shelf`] as Refused;
  db.prepare('update notebooks set archived = ?, updated = ? where id = ?').run(
    Number(b.archived),
    new Date().toISOString(),
    n.id,
  );
  return notebookOf(notebookRow(n.id, who)!);
}
// A person's own notebook, made the first time it's asked for, with their old book carried in (and any old page since)
export function mine(who = BOARD) {
  const found = findOwnNotebook(who);
  if (found && !uncarried(who)) return notebookRow(found, who)!;
  return inOneStep(() => {
    const id = ownNotebook(who);
    // (notes written the old way since land on the current page: every screen showing it reads it again.)
    const late = carryInto(id, who, endOf(id), () => currentPage(id));
    if (late) changed(id, late);
    return notebookRow(id, who)!;
  });
}
// A person's own notebook's id, made if there's none, their old book not carried in (a call's notes page takes it so:
// ink/callnotes.ts.)
export function ownNotebook(who: string) {
  return findOwnNotebook(who) ?? makeNotebook(who, 'mine', MY_JOURNAL);
}
// A person's own notebook's id, or undefined before it's made
export const findOwnNotebook = (who: string) =>
  (db.prepare("select id from notebooks where who = ? and kind = 'mine'").get(who) as { id: number } | undefined)?.id;
export function makeNotebook(who: string, kind: Notebook['kind'], name: string) {
  const now = new Date().toISOString();
  return Number(
    db
      .prepare('insert into notebooks (who, kind, name, created, updated) values (?, ?, ?, ?, ?)')
      .run(who, kind, name, now, now).lastInsertRowid,
  );
}

// ---------------------------------------------------------------- a notebook's pages
// GET /api/notebooks/pages?notebook=: its pages in their order (one made in a notebook with none), then those archived.
// A page sent stays where it is, the last too: no page is made after it (the board's call 170); new groups make the current page as they land (currentPage).
export function listPages(b: any, who = BOARD) {
  const n = notebookRow(Number(b?.notebook), who);
  if (!n) return 404;
  if (n.kind === 'mine') mine(who);
  if (!pagesOf(n.id).some(p => !p.archived)) currentPage(n.id);
  const pages = pagesOf(n.id);
  for (const p of pages) titleLater(p.id);
  seenNotebook(n.id);
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
  db.prepare("update book_pages set label = ?, title_by = 'board' where id = ?").run(title, p.id);
  changed(p.notebook, p.id);
  return pageOf(pageRow(p.id, who)!);
}
// POST /api/notebooks/pages/zoom { id, shape, zoom }: the zoom the board left the page at on a screen of that shape,
// which it opens at there again. Not a change to the page: its picture and other screens read it as they were.
export function zoomPage(b: any, who = BOARD) {
  const p = pageRow(Number(b?.id), who),
    zoom = Number(b?.zoom);
  if (!p) return 404;
  if (!SCREEN_SHAPES.includes(b?.shape)) return [400, `shape is one of ${SCREEN_SHAPES.join(', ')}`] as Refused;
  if (!(zoom >= ZOOM_KEPT.least && zoom <= ZOOM_KEPT.most))
    return [400, `zoom is a number from ${ZOOM_KEPT.least} to ${ZOOM_KEPT.most}`] as Refused;
  db.prepare("update book_pages set zooms = json_set(zooms, '$.' || ?, ?) where id = ?").run(
    b.shape,
    Math.round(zoom * 1000) / 1000,
    p.id,
  );
  return pageOf(pageRow(p.id, who)!);
}

// The page new groups land on (notebookstack.js), made if there's none
export function currentPage(notebook: number) {
  return openPageOf(notebook) ?? newPage(notebook);
}
// The current page if the notebook has one (review mode's count reads it: ink/bookreview.ts)
export function openPageOf(notebook: number) {
  const pages = db
    .prepare('select id, kind, created, archived, send_at, tries from book_pages where notebook = ?')
    .all(notebook) as Pick<NotebookPage, 'id' | 'kind' | 'created' | 'archived' | 'send_at' | 'tries'>[];
  return landingPage(pages, (p: (typeof pages)[number]) => p.send_at !== null)?.id ?? null;
}
export function newPage(notebook: number) {
  const n = db.prepare('select who from notebooks where id = ?').get(notebook) as { who: string },
    now = new Date().toISOString();
  const id = Number(
    db
      .prepare(
        "insert into book_pages (who, day, kind, label, created, updated, w, h, notebook, pos) values (?, ?, 'free', '', ?, ?, ?, ?, ?, ?)",
      )
      .run(n.who, companyDay(Date.now()), now, now, NEW_PAGE.w, NEW_PAGE.h, notebook, endOf(notebook)).lastInsertRowid,
  );
  changed(notebook, id);
  return id;
}
// The place after a notebook's last page
export function endOf(notebook: number) {
  const { last } = db.prepare('select max(pos) last from book_pages where notebook = ?').get(notebook) as {
    last: number | null;
  };
  return (last ?? -1) + 1;
}
// A page has changed: its box grows round its groups, its picture is drawn again when next read, its notebook moves up
// the shelf, and every screen showing it reads it again: as a step its Undo takes back when someone else's hand made it
// (byHand)
export function changed(notebook: number, page: number | null) {
  if (hand && page) db.prepare('update book_pages set handed = handed + 1 where id = ?').run(page);
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
  if (page) titleLater(page);
}
// A change someone else makes on the board's page (a call's agent's: ink/callpage.ts), counted on the page (handed), so
// each screen showing the page takes it as a step of its own, which the board's Undo takes back like its own: a count
// read with the page, not the change's event, as a read another event started may bring it first
let hand: string | null = null;
export function byHand<T>(who: string, act: () => T): T {
  hand = who;
  try {
    return act();
  } finally {
    hand = null;
  }
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
// In their chapters' order. (a try's versions page from before they came under
// their note is no page any more)
const pagesOf = (notebook: number): NotebookPage[] =>
  inChapters(
    kindOf(notebook),
    db.prepare(`select ${PAGE_COLUMNS} from book_pages where notebook = ? and tries is null`).all(notebook),
  );
const kindOf = (notebook: number | null) =>
  (db.prepare('select kind from notebooks where id = ?').get(notebook) as { kind: string } | undefined)?.kind;
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
  project: n.project,
  archived: !!n.archived,
  created: n.created,
  updated: n.updated,
  pages: (
    db.prepare('select count(*) n from book_pages where notebook = ? and archived = 0').get(n.id) as { n: number }
  ).n,
  asks: asksCount(n.id),
  ...shelfOf(n), // (its cover and its new answers)
  // (a round's state, guests and open asks for its cover.)
  ...(n.kind === 'round' && { round: roundSummary(n.id) }),
});
// A page's chapter, its bookmark (notebookchapters.js): in a round's book a guest's page (with whose), its Asks or its
// Advice; in every other its Sketch, Asks or Calls
function chapterOf(p: NotebookPage) {
  const chapter = chapterIn(p.kind, kindOf(p.notebook));
  if (chapter !== 'guests') return { chapter };
  const g = db.prepare('select guest from notebook_guests where page = ?').get(p.id) as { guest: string } | undefined;
  return { chapter, guest: g?.guest ?? null };
}
// The design asks in a notebook (ink/askpages.ts), as its cover on the shelf counts them: open, the cards still waiting
// on the board (red), of all (grey once none waits). One whose card was withdrawn isn't counted, as it isn't shown.
export const asksCount = (notebook: number) => {
  const c = db
    .prepare(
      `select count(*) total, coalesce(sum(r.status = 'open'), 0) open from notebook_groups g
      join book_pages p on p.id = g.page join requests r on r.id = g.request
      where p.notebook = $notebook and g.deleted is null
        and (r.status = 'answered' or r.status = 'open' and ${shownCard('r', '$now')})`,
    )
    .get({ notebook, now: new Date().toISOString() }) as { total: number; open: number };
  return { open: c.open, all: c.total };
};
// What the shelf and a notebook's page grid read of a page. sending: in its seconds to undo; sent: when it went.
// picture: the page drawn whole, groups and all (bookpicture.ts).
// A call's notes page is never sending: it's sent once its call's follow-up has handed out what's on it (ink/callnotes.ts.
export function pageOf(p: NotebookPage) {
  const call = p.kind === 'call',
    went = !call && gone(p),
    sent = call ? p.followed : went ? p.send_at : null,
    { n } = db
      .prepare('select count(*) n from notebook_groups where page = ? and parent is null and deleted is null')
      .get(p.id) as { n: number };
  return {
    id: p.id,
    notebook: p.notebook,
    kind: p.kind,
    title: p.label,
    zooms: JSON.parse(p.zooms),
    day: p.day,
    archived: !!p.archived,
    sending: !call && p.send_at !== null && !went,
    sent: sent === null ? null : new Date(sent).toISOString(),
    ...(call && shut(p) && { readonly: true }), // (ended, with its follow-up or sent)
    created: p.created,
    updated: p.updated,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    groups: n,
    picture: `/api/book/picture?id=${p.id}&v=${encodeURIComponent(p.updated)}`,
    ...chapterOf(p),
  };
}
