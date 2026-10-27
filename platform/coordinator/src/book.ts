// The book: one per person (who: the board's 'board', an invited person's 'guest:<grant>', sketchpeople.ts), a row of
// pages a day. The coordinator is its only writer; the book's screens, the Pencil, sheets, slips, calls and pairing all
// go through its routes (book.ts for pages, booknotes.ts for sheets and notes, bookslips.ts for slips).
//   - Four kinds of page: a sheet's page (an HQ page, at its url, owned by the agent whose work it shows: its notes go
//     on that agent's sheet), a free page (scraps, pictures and sketches, nobody's), a call's page (what was drawn on
//     a call, its call) and a guest's notes. A page grows any way as it's written on (x, y, w, h); New page starts the next.
//   - A page is its ink (shared/review/ink.js strokes in the page's CSS px) and its scraps (pictures taped on), kept
//     in the data volume, never the repo: book/<id>-s-<random>.png|jpg (0700/0600). Its picture is drawn here
//     (bookpicture.ts), once a change, and kept until the next: book/<id>-<random>.png.
//   - A picture can wait on a free page until the board places it (fromReview, waiting): it reaches no page's picture,
//     agent or call before the board has seen it. Nothing sends one but fromReview's test; HQ's tray shows those
//     still waiting.
//   - Any job reads every page (hq sketches, hq sketch <id>), and a board call's agent one by number or label words
//     (bookreads.ts): the board shares its book with the whole team. An invited person's are theirs, outside text.
//   - The Sketchbook's screens and an invited person's room read and write their sketches, the free pages,
//     through sketchbook.ts.
import { existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db, lacks, once } from './db.ts';
import { companyDay } from './company.ts';
import { findAgent } from './jobs.ts';
import * as pictures from './pictures.ts';
import { refuse, reply } from './uploads.ts';
import { readBody } from '../../../shared/routes/routes.ts';
import { PAGE, cornerOf, grownTo, inkOf, isRefused, labelOf, pageSide, textsOf, type Refused } from './pagechecks.ts';
import {
  DIR,
  WAITING_MAX,
  type Scrap,
  full,
  isScrap,
  notFound,
  serveFile,
  keepScrap,
  scrapFiles,
  scrapUrl,
  scrapsOf,
  sweep,
  tooBig,
} from './pagescraps.ts';
import { BOOK_FULL, bookFull } from './sketchpeople.ts';
import { throwAway } from './bookcalls.ts';

export const BOARD = 'board';
mkdirSync(DIR, { recursive: true, mode: 0o700 });
// (autoincrement: a page's number in a line, a job or a call never comes to mean another one once it's deleted)
// day: the company's day it was made. owner: a sheet's page's agent. url: its HQ page. call: a call's page's.
// picture: its drawn picture's file in DIR, null until it's drawn again after a change. sent: a sketch's last send
// (sketchbook.ts). waiting: review mode's pictures on it, not placed yet ([{ file }]). opened: when HQ last read it whole.
// texts: the words typed on it ([{ x, y, w, text, color }], pagechecks.ts textsOf.)
// x, y: its top-left, 0,0 (its heading) until it grows up or left, w × h its size from there
db.exec(`create table if not exists book_pages (id integer primary key autoincrement, who text not null default 'board',
  day text not null, kind text not null, owner text, url text, call integer, label text not null default '',
  archived integer not null default 0, created text not null, updated text not null, w integer not null, h integer not null,
  ink text not null default '[]', strokes integer not null default 0, scraps text not null default '[]', picture text,
  sent text, opened text, waiting text not null default '[]', texts text not null default '[]',
  x integer not null default 0, y integer not null default 0);
  create index if not exists book_pages_day on book_pages (who, day)`);
once('2026-10-26-book-page-texts', () => {
  if (lacks('book_pages', 'texts')) db.exec("alter table book_pages add column texts text not null default '[]'");
});
once('2026-10-27-book-page-corner', () => {
  if (!lacks('book_pages', 'x')) return;
  db.exec('alter table book_pages add column x integer not null default 0');
  db.exec('alter table book_pages add column y integer not null default 0');
});

export const KINDS = ['sheet', 'free', 'call', 'guest'] as const;
type Kind = (typeof KINDS)[number];
export type Page = {
  id: number;
  who: string;
  day: string;
  kind: Kind;
  owner: string | null;
  url: string | null;
  call: number | null;
  label: string;
  archived: number;
  created: string;
  updated: string;
  x: number;
  y: number;
  w: number;
  h: number;
  strokes: number;
  scraps: string;
  picture: string | null;
  sent: string | null;
};
// Every column but the ink, which only a drawing reads
export const COLUMNS =
  'id, who, day, kind, owner, url, call, label, archived, created, updated, x, y, w, h, strokes, scraps, picture, sent';
// HQ's addresses for the board's routes
export const BASE = '/api/book';

// ---------------------------------------------------------------- the board's (HQ session, HQ's own Origin)
// GET /api/book?day=YYYY-MM-DD: that day's pages (today's without), and every day with pages, newest first
export function listPages(q: { day?: string }, who = BOARD) {
  const today = companyDay(Date.now()),
    asked = typeof q.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.day) ? q.day : today;
  const pages = db
    .prepare(`select ${COLUMNS} from book_pages where who = ? and day = ? order by id`)
    .all(who, asked) as Page[];
  const days = db
    .prepare('select day, count(*) pages from book_pages where who = ? group by day order by day desc')
    .all(who) as { day: string; pages: number }[];
  return { day: asked, today, days, pages: pages.map(p => summary(p)) };
}
// GET /api/book/page?id=: one page with its strokes and scraps, to draw on again, and the pictures waiting to be
// placed on it (the book's tray). base: the routes' addresses, HQ's or a person's on the guest desk (sketchbook.ts).
export function getPage(id: number, who = BOARD, base = BASE) {
  const p = row(id, who);
  if (!p) return 404;
  const { ink, texts } = drawnOf(p.id);
  db.prepare('update book_pages set opened = ? where id = ?').run(new Date().toISOString(), p.id);
  const url = (file: string) => scrapUrl(p.id, file, base);
  return {
    ...summary(p),
    ink: JSON.parse(ink),
    texts: JSON.parse(texts),
    scraps: (JSON.parse(p.scraps) as Scrap[]).map(c => ({ ...c, url: url(c.file) })),
    waiting: waitingOf(p.id).map(c => ({ file: c.file, url: url(c.file) })),
  };
}
// POST /api/book/page/new { kind, w, h, label?, owner? (an agent), url? (the HQ page), call? }: a blank page, today's
export function createPage(b: any, who = BOARD) {
  const w = pageSide(b?.w),
    h = pageSide(b?.h),
    label = labelOf(b?.label ?? '');
  if (isRefused(w)) return w;
  if (isRefused(h)) return h;
  if (isRefused(label)) return label;
  const kind = b?.kind as Kind;
  if (!KINDS.includes(kind)) return [400, `a page's kind is ${KINDS.join(', ')}`] as Refused;
  const owned = kind === 'sheet' || kind === 'guest';
  if (owned && !(typeof b.owner === 'string' && findAgent(b.owner)))
    return [400, "a sheet's page has an owner: the agent whose work it shows"] as Refused;
  if (owned && !(typeof b.url === 'string' && /^\/[^\s]{0,1999}$/.test(b.url)))
    return [400, "a sheet's page has its HQ page's address: a path on HQ"] as Refused;
  if (kind === 'call' && !db.prepare('select 1 from calls where id = ?').get(Number(b.call)))
    return [400, "a call's page names its call"] as Refused;
  // (an invited person's book, the board drawing in it too, has their sketches only.)
  if (who !== BOARD && kind !== 'free') return [400, "a person's own book has free pages only"] as Refused;
  if (who !== BOARD && bookFull(who)) return [413, BOOK_FULL] as Refused;
  const now = new Date().toISOString();
  const id = Number(
    db
      .prepare(
        'insert into book_pages (who, day, kind, owner, url, call, label, created, updated, w, h) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        who,
        companyDay(Date.now()),
        kind,
        owned ? b.owner : null,
        owned ? b.url : null,
        kind === 'call' ? Number(b.call) : null,
        label,
        now,
        now,
        w,
        h,
      ).lastInsertRowid,
  );
  return summary(row(id, who)!);
}
// Today's sheet page for an owner in the board's book, whatever its url (one a day: its notes keep their own pages in
// their anchors), or a new one at url, which may be a product preview's whole https address: the coordinator's way to
// a page for review mode's notes on a preview (bookreview.ts), where the route takes only HQ's paths. w and h: the
// screen it was seen on, brought within a page's sides (a page is no bigger than PAGE, whatever the screen).
export function sheetPageFor(owner: string, url: string, w: number, h: number) {
  const day = companyDay(Date.now()),
    found = db
      .prepare(
        `select ${COLUMNS} from book_pages where who = ? and day = ? and kind = 'sheet' and owner = ? and archived = 0 order by id limit 1`,
      )
      .get(BOARD, day, owner) as Page | undefined;
  if (found) return found;
  const side = (v: number) => Math.min(PAGE.max, Math.max(PAGE.min, Math.round(v) || PAGE.min)),
    now = new Date().toISOString();
  const id = Number(
    db
      .prepare(
        "insert into book_pages (who, day, kind, owner, url, label, created, updated, w, h) values (?, ?, 'sheet', ?, ?, '', ?, ?, ?, ?)",
      )
      .run(BOARD, day, owner, url, now, now, side(w), side(h)).lastInsertRowid,
  );
  return row(id)!;
}
// POST /api/book/page/save { id, ink, scraps, texts?, x?, y?, w?, h?, since? }: the whole ink, the scraps placed on it,
// the words typed on it (none sent: those it has stay) and its box once grown (x, y); its picture is drawn again when next read.
// Those placed leave waiting; scrap files nothing names go once a day old. since: the page's updated as the saver last
// read or saved it; one saved since by someone else (the person whose book it is, two screens) is refused, and the
// saver merges (pagemerge.js).
export const CHANGED = 'this page changed since it was read: read it again';
export function savePage(b: any, who = BOARD) {
  const p = row(Number(b?.id), who);
  if (!p) return 404;
  if (typeof b.since === 'string' && b.since !== p.updated) return [409, CHANGED] as Refused;
  const ink = inkOf(b.ink);
  if (isRefused(ink)) return ink;
  const scraps = scrapsOf(b.scraps, p.id);
  if (isRefused(scraps)) return scraps;
  const h = grownTo(b.h, p.h),
    w = grownTo(b.w, p.w),
    x = cornerOf(b.x, p.x),
    y = cornerOf(b.y, p.y),
    texts = textsOf(b.texts);
  if (isRefused(h)) return h;
  if (isRefused(w)) return w;
  if (isRefused(x)) return x;
  if (isRefused(y)) return y;
  if (isRefused(texts)) return texts;
  if (who !== BOARD && bookFull(who)) return [413, BOOK_FULL] as Refused;
  const placed = new Set(scraps.map(c => c.file)),
    waiting = waitingOf(p.id).filter(c => !placed.has(c.file)),
    taken = new Date();
  db.prepare(
    'update book_pages set ink = ?, strokes = ?, scraps = ?, waiting = ?, h = ?, picture = null, updated = ? where id = ?',
  ).run(JSON.stringify(ink), ink.length, JSON.stringify(scraps), JSON.stringify(waiting), h, taken.toISOString(), p.id);
  const typed = texts ? JSON.stringify(texts) : null;
  const sides = db.prepare('update book_pages set x = ?, y = ?, w = ?, texts = coalesce(?, texts) where id = ?');
  sides.run(x, y, w, typed, p.id);
  if (p.picture) rmSync(`${DIR}/${p.picture}`, { force: true });
  // A scrap this save takes off gets its day from now, not its upload's: undo in an open page may place it again
  for (const c of JSON.parse(p.scraps) as Scrap[])
    if (!placed.has(c.file) && existsSync(`${DIR}/${c.file}`)) utimesSync(`${DIR}/${c.file}`, taken, taken);
  sweep(p.id, [...placed, ...waiting.map(c => c.file)]);
  return summary(row(p.id, who)!);
}
// POST /api/book/page/label { id, label }, /archive { id, archived }
export function labelPage(b: any, who = BOARD) {
  const p = row(Number(b?.id), who),
    label = labelOf(b?.label);
  if (!p) return 404;
  if (isRefused(label)) return label;
  db.prepare('update book_pages set label = ? where id = ?').run(label, p.id);
  return summary(row(p.id, who)!);
}
export function archivePage(b: any, who = BOARD) {
  const p = row(Number(b?.id), who);
  if (!p) return 404;
  if (typeof b.archived !== 'boolean') return [400, 'archived is true or false'] as Refused;
  db.prepare('update book_pages set archived = ? where id = ?').run(Number(b.archived), p.id);
  return summary(row(p.id, who)!);
}
// POST /api/book/page/delete { id }: the page, its picture and its scraps, gone; a page with notes keeps them on their
// sheets (refused while one is open: send it or wipe its notes first). A call's page goes with its notes, which no
// sheet sends (bookcalls.ts).
export function deletePage(id: number, who = BOARD) {
  const p = row(id, who);
  if (!p) return 404;
  if (p.kind === 'call') throwAway(p.id);
  else if (db.prepare("select 1 from book_notes where page = ? and status = 'open'").get(p.id))
    return [409, 'this page has notes on an open sheet: send the sheet or wipe its notes first'] as Refused;
  if (p.picture) rmSync(`${DIR}/${p.picture}`, { force: true });
  for (const file of scrapFiles(p.id)) rmSync(`${DIR}/${file}`, { force: true });
  db.prepare('delete from book_pages where id = ?').run(p.id);
  return { ok: true };
}

// POST /api/book/scrap?id=<page>: one picture as the body (pictures.ts upload's way), one of the page's scraps once a
// save places it: { file, url }. (base as getPage's; open: whether a person's book is still theirs past the await)
export async function uploadScrap(
  req: IncomingMessage,
  res: ServerResponse,
  who = BOARD,
  base = BASE,
  open: () => Refused | null = () => null,
) {
  const id = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('id'));
  if (!row(id, who)) return refuse(req, res, 404, 'no such page');
  if (who !== BOARD && bookFull(who)) return refuse(req, res, 413, BOOK_FULL);
  if (full(id)) return refuse(req, res, 429, TOO_MANY_UPLOADS);
  const type = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (type !== 'image/jpeg' && type !== 'image/png') return refuse(req, res, 415, 'a JPEG or PNG only');
  const raw = await readBody(req, pictures.MAX_BYTES);
  if (!raw) return refuse(req, res, 413, 'too large');
  const p = pictures.picture(raw);
  if (!p) return reply(res, 400, { error: 'not a picture we can read' }, true);
  const big = tooBig(p.clean);
  if (big) return reply(res, big[0], { error: big[1] }, true);
  // Again, past the await: the page may have been deleted, or filled from another tab, while the body came in
  const shut = open();
  if (shut) return reply(res, shut[0], { error: shut[1] }, true);
  if (!row(id, who)) return reply(res, 404, { error: 'no such page' }, true);
  if (full(id)) return reply(res, 429, { error: TOO_MANY_UPLOADS }, true);
  const file = keepScrap(id, p);
  return reply(res, 200, { file, url: scrapUrl(id, file, base) });
}
// GET /api/book/scrap?id=<page>&file=<file>
export function serveScrap(req: IncomingMessage, res: ServerResponse, who: string | null = BOARD) {
  const query = new URL(req.url ?? '/', 'http://x').searchParams;
  const p = row(Number(query.get('id')), who),
    file = query.get('file') ?? '';
  if (!p || !isScrap(p.id, file) || !existsSync(`${DIR}/${file}`)) return notFound(res);
  serveFile(res, file);
}
const TOO_MANY_UPLOADS = 'too many uploads for this page today';

// A picture waiting on a free page of the board's until the board places it (only its test calls it: see the header):
// on the free page the board opened last ('last', not archived, with room for it), or a new one ('new', or none). A
// sender could be a product page's own script, so WAITING_MAX wait in the whole book at most. { id, fresh }: fresh, a
// page made for it.
const REVIEW_PAGE = { w: 1200, h: 800 };
export function fromReview(raw: Buffer, to: 'new' | 'last'): Refused | { id: number; fresh: boolean } {
  const p = pictures.picture(raw);
  if (!p) return [400, 'not a picture we can read'];
  const big = tooBig(p.clean);
  if (big) return big;
  const { n } = db
    .prepare('select coalesce(sum(json_array_length(waiting)), 0) n from book_pages where who = ?')
    .get(BOARD) as { n: number };
  if (n >= WAITING_MAX)
    return [429, `${WAITING_MAX} pictures are waiting in the book already: open their pages and place them first`];
  const last =
    to === 'last'
      ? (
          db
            .prepare(
              "select id from book_pages where who = ? and kind = 'free' and archived = 0 order by opened desc, updated desc, id desc",
            )
            .get(BOARD) as { id: number } | undefined
        )?.id
      : undefined;
  const fits = last !== undefined && !full(last);
  const id = fits ? last : (createPage({ kind: 'free', ...REVIEW_PAGE }) as { id: number }).id;
  db.prepare('update book_pages set waiting = ?, updated = ? where id = ?').run(
    JSON.stringify([...waitingOf(id), { file: keepScrap(id, p) }]),
    new Date().toISOString(),
    id,
  );
  return { id, fresh: !fits };
}
const waitingOf = (id: number) =>
  JSON.parse((db.prepare('select waiting from book_pages where id = ?').get(id) as { waiting: string }).waiting) as {
    file: string;
  }[];

// ---------------------------------------------------------------- shared
// A page's ink and typed words, what only a drawing reads
export const drawnOf = (id: number) =>
  db.prepare('select ink, texts from book_pages where id = ?').get(id) as { ink: string; texts: string };
// (who null, any book's: the board's eyes and the agents')
export const row = (id: number, who: string | null = BOARD) =>
  (Number.isInteger(id) && id > 0
    ? who === null
      ? db.prepare(`select ${COLUMNS} from book_pages where id = ?`).get(id)
      : db.prepare(`select ${COLUMNS} from book_pages where id = ? and who = ?`).get(id, who)
    : undefined) as Page | undefined;
// What HQ and the agents read of a page. withPicture: HQ's address for its picture (v: its last change, so no browser
// shows an old one). pictures: how many are taped on it. A call's page has the call's summary on top: what the call's
// follow-up wrote for the board (calls.reply), null until then; and its agent and when it started (calls.ts), the
// page's name in the book, null once the call is gone. went: a sheet with notes
// on it has been sent (its tick in the book's overview.).
export function summary(p: Page, withPicture = true) {
  const { id, kind, owner, url, call, label, created, updated, x, y, w, h, strokes, sent } = p;
  const placed = (JSON.parse(p.scraps) as unknown[]).length;
  const shown = {
    id,
    day: p.day,
    kind,
    owner,
    url,
    call,
    label,
    archived: !!p.archived,
    created,
    updated,
    x,
    y,
    w,
    h,
    strokes,
    pictures: placed,
    sent,
    went: wentOn(id),
    ...(kind === 'call' ? callOf(call) : {}),
  };
  return withPicture ? { ...shown, picture: `${BASE}/picture?id=${id}&v=${encodeURIComponent(updated)}` } : shown;
}
const wentOn = (page: number) =>
  !!db
    .prepare(
      "select 1 from book_notes n join book_sheets s on s.id = n.sheet where n.page = ? and s.status = 'sent' limit 1",
    )
    .get(page);
function callOf(call: number | null) {
  const found = db.prepare('select reply, agent, ts from calls where id = ?').get(call) as
    { reply: string | null; agent: string; ts: string } | undefined;
  return { summary: found?.reply ?? null, agent: found?.agent ?? null, started: found?.ts ?? null };
}
