// The book: one per person (who: the board's 'board', an invited person's 'guest:<grant>', sketchpeople.ts), a row of
// pages a day. The coordinator is its only writer; the book's screens, the Pencil, sheets, slips, calls and pairing all
// go through its routes (book.ts for pages, booknotes.ts for sheets and notes, bookslips.ts for slips).
//   - Four kinds of page: a sheet's page (an HQ page, at its url, owned by the agent whose work it shows: its notes go
//     on that agent's sheet), a free page (scraps, pictures and sketches, nobody's), a call's page (what was drawn on
//     a call, its call) and a guest's notes. A page grows downward (h) as it's written on; New page starts the next.
//   - A page is its ink (shared/review/ink.js strokes in the page's CSS px) and its scraps (pictures taped on), kept
//     in the data volume, never the repo: book/<id>-s-<random>.png|jpg (0700/0600). Its picture is drawn here
//     (bookrender.ts), once a change, and kept until the next: book/<id>-<random>.png.
//   - A picture waiting on a free page until the board places it (fromReview, waiting) has no route today: review
//     mode's send to the first Sketchbook is gone (job #18524). One never reaches a page's picture, an agent or a call
//     before the board has seen it.
//   - Any job reads every page (hq sketches, hq sketch <id>), and a board call's agent one by number or label words
//     (bookreads.ts): the board shares its book with the whole team. An invited person's are theirs, outside text.
//   - The Sketchbook's screens and an invited person's room read and write their sketches, the free pages,
//     through sketchbook.ts.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db.ts';
import { companyDay } from './company.ts';
import { findAgent } from './jobs.ts';
import * as pictures from './pictures.ts';
import { keepFile, refuse, reply } from './uploads.ts';
import { readBody } from '../../../shared/routes/routes.ts';
import { render } from './bookrender.ts';
import { grownTo, inkOf, isRefused, labelOf, pageSide, type Refused } from './pagechecks.ts';
import {
  DIR,
  WAITING_MAX,
  type Scrap,
  full,
  isScrap,
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
db.exec(`create table if not exists book_pages (id integer primary key autoincrement, who text not null default 'board',
  day text not null, kind text not null, owner text, url text, call integer, label text not null default '',
  archived integer not null default 0, created text not null, updated text not null, w integer not null, h integer not null,
  ink text not null default '[]', strokes integer not null default 0, scraps text not null default '[]', picture text,
  sent text, opened text, waiting text not null default '[]');
  create index if not exists book_pages_day on book_pages (who, day)`);

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
  w: number;
  h: number;
  strokes: number;
  scraps: string;
  picture: string | null;
  sent: string | null;
};
// Every column but the ink, which only a drawing reads
export const COLUMNS =
  'id, who, day, kind, owner, url, call, label, archived, created, updated, w, h, strokes, scraps, picture, sent';
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
  const { ink } = db.prepare('select ink from book_pages where id = ?').get(p.id) as { ink: string };
  db.prepare('update book_pages set opened = ? where id = ?').run(new Date().toISOString(), p.id);
  const url = (file: string) => scrapUrl(p.id, file, base);
  return {
    ...summary(p),
    ink: JSON.parse(ink),
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
// POST /api/book/page/save { id, ink, scraps, h? }: the whole ink and the scraps placed on it, and its height once it
// has grown. Its picture is drawn again when it's next read. Those placed leave waiting; scrap files nothing names go
// once they're a day old.
export function savePage(b: any, who = BOARD) {
  const p = row(Number(b?.id), who);
  if (!p) return 404;
  const ink = inkOf(b.ink);
  if (isRefused(ink)) return ink;
  const scraps = scrapsOf(b.scraps, p.id);
  if (isRefused(scraps)) return scraps;
  const h = grownTo(b.h, p.h);
  if (isRefused(h)) return h;
  if (who !== BOARD && bookFull(who)) return [413, BOOK_FULL] as Refused;
  const placed = new Set(scraps.map(c => c.file)),
    waiting = waitingOf(p.id).filter(c => !placed.has(c.file)),
    taken = new Date();
  db.prepare(
    'update book_pages set ink = ?, strokes = ?, scraps = ?, waiting = ?, h = ?, picture = null, updated = ? where id = ?',
  ).run(JSON.stringify(ink), ink.length, JSON.stringify(scraps), JSON.stringify(waiting), h, taken.toISOString(), p.id);
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

// GET /api/book/picture?id=: the page as a picture, drawn here (an image or nothing, never kept in a cache)
export async function servePicture(req: IncomingMessage, res: ServerResponse, who: string | null = BOARD) {
  const p = row(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('id')), who);
  const file = p && (await pictureOf(p));
  if (!file) return notFound(res);
  serveFile(res, file);
}
// The page's picture's file in DIR: the one kept since its last change, or drawn now and kept. null: the page was
// deleted while it was drawn.
export async function pictureOf(p: Page): Promise<string | null> {
  if (p.picture && existsSync(`${DIR}/${p.picture}`)) return p.picture;
  const { ink } = db.prepare('select ink from book_pages where id = ?').get(p.id) as { ink: string };
  const png = await render({ w: p.w, h: p.h, ink: JSON.parse(ink), scraps: JSON.parse(p.scraps) }, DIR);
  const name = `${p.id}-${randomBytes(4).toString('hex')}.png`;
  keepFile(`${DIR}/${name}`, png);
  // (a change while it was drawn: that one's picture is drawn when it's read, and this one goes)
  if (
    !db.prepare('update book_pages set picture = ? where id = ? and updated = ?').run(name, p.id, p.updated).changes
  ) {
    rmSync(`${DIR}/${name}`, { force: true });
    const now = row(p.id, null);
    return now ? pictureOf(now) : null;
  }
  return name;
}
// One of DIR's pictures as the answer: an image or nothing, never kept in a cache (a snip's and a slip's too)
export function serveFile(res: ServerResponse, file: string) {
  res.writeHead(200, {
    'content-type': typeOf(file),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
  });
  res.end(readFileSync(`${DIR}/${file}`));
}
export const notFound = (res: ServerResponse) => {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
};

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

// A picture waiting on a free page of the board's until the board places it (no route sends one today: see the
// header): on the free page the board opened last ('last', not archived, with room for it), or a new one ('new', or
// none). What sent it could be a product page's own script, so WAITING_MAX wait in the whole book at most.
// { id, fresh }: fresh, a page made for it.
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
// (who null, any book's: the board's eyes and the agents')
export const row = (id: number, who: string | null = BOARD) =>
  (Number.isInteger(id) && id > 0
    ? who === null
      ? db.prepare(`select ${COLUMNS} from book_pages where id = ?`).get(id)
      : db.prepare(`select ${COLUMNS} from book_pages where id = ? and who = ?`).get(id, who)
    : undefined) as Page | undefined;
// What HQ and the agents read of a page. withPicture: HQ's address for its picture (v: its last change, so no browser
// shows an old one). pictures: how many are taped on it. A call's page has the call's summary on top: what the call's
// follow-up wrote for the board (calls.reply), null until then.
export function summary(p: Page, withPicture = true) {
  const { id, kind, owner, url, call, label, created, updated, w, h, strokes, sent } = p;
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
    w,
    h,
    strokes,
    pictures: placed,
    sent,
    ...(kind === 'call' ? { summary: callSummary(call) } : {}),
  };
  return withPicture ? { ...shown, picture: `${BASE}/picture?id=${id}&v=${encodeURIComponent(updated)}` } : shown;
}
const callSummary = (call: number | null) =>
  (db.prepare('select reply from calls where id = ?').get(call) as { reply: string | null } | undefined)?.reply ?? null;
export const typeOf = (file: string) => (file.endsWith('.png') ? 'image/png' : 'image/jpeg');
