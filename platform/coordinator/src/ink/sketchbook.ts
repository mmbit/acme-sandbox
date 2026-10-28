// The Sketchbook (HQ's sketchbook app, and an invited person's own on the guest desk: sketchpeople.ts openRoom) on the
// book: a sketch is a free page (book.ts), under the same number, read and written through the book's own functions at
// the Sketchbook's addresses and in its shape. HQ draws a sketch's picture as it saves; the book draws its own
// (bookrender.ts), so a save's picture is left aside.
//   - Send puts a copy of the page's picture on the intercom as a line from the board (chat.ts say), a picture of its own
//     (pictures.ts), so the line stays whole once the page is deleted; an invited person's is their own line
//     (sketchpeople.ts sendAsGuest), outside text.
//   - The sketches the Sketchbook kept before the book were folded in once, at the server's start (foldSketches).
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { db, once } from '../db.ts';
import { DATA_DIR } from '../config.ts';
import { companyDay } from '../company.ts';
import * as chat from '../chat.ts';
import * as pictures from '../pictures.ts';
import * as book from './book.ts';
import { BOARD, type Page } from './book.ts';
import { pictureOf, servePicture } from './bookpicture.ts';
import { isRefused, SAVE_MAX, type Refused } from '../pagechecks.ts';
import { DIR, MAX_SCRAPS, type Scrap } from '../pagescraps.ts';
import { books, openRoom, sendAsGuest } from './sketchpeople.ts';
import { managedPage } from '../notebookguests.ts';

// HQ's addresses for the board's routes
const HQ_BASE = '/api/sketches';
type Answer = number | Refused | { id: number };

// GET /api/sketches: the board's sketches, newest drawn first, archived ones too (HQ sorts them apart), and the
// invited people's, each person's on a shelf of their own ({ name, on: whether they have it now, sketches })
export const listSketches = () => ({
  sketches: listed(BOARD).map(p => sketchOf(p)),
  guests: books().map(b => ({ name: b.name, on: b.on, sketches: listed(b.who).map(p => sketchOf(p)) })),
});
// GET /api/sketches/ink?id=: one with its strokes, its scraps and those waiting to be placed (book.ts getPage)
export function getSketch(id: number, who = BOARD, base = HQ_BASE) {
  const p = book.getPage(id, who, base);
  if (typeof p === 'number') return p;
  return { ...sketchOf(book.row(id, who)!, base), ink: p.ink, scraps: p.scraps, waiting: p.waiting };
}
// POST /api/sketches/create { label?, w, h }, save { id, ink, scraps, picture, since? }, label { id, label }, archive
// { id, archived }: the book's, a free page, answered as a sketch (since: book.ts savePage's.)
export const createSketch = (b: any, who = BOARD, base = HQ_BASE) =>
  asSketch(book.createPage({ kind: 'free', w: b?.w, h: b?.h, label: b?.label }, who), who, base);
export const saveSketch = (b: any, who = BOARD, base = HQ_BASE) =>
  asSketch(book.savePage({ id: b?.id, ink: b?.ink, scraps: b?.scraps, since: b?.since }, who), who, base);
export const labelSketch = (b: any, who = BOARD, base = HQ_BASE) => asSketch(book.labelPage(b, who), who, base);
export const archiveSketch = (b: any, who = BOARD, base = HQ_BASE) => asSketch(book.archivePage(b, who), who, base);
// POST /api/sketches/send { id }: the sketch to the CEO, as the board's line on the intercom with a copy of its picture
// (an invited person's as their own line)
export async function sendSketch(id: number, who = BOARD) {
  const p = book.row(id, who);
  if (!p) return 404;
  if (!drawn(p)) return [409, "nothing's drawn on this sketch yet"] as Refused;
  const file = await pictureOf(p);
  if (!file) return 404;
  // (the board reads the line in its intercom too: the CEO finds hq sketch in hq's help)
  const name = p.label ? `“${p.label}” (sketch #${p.id})` : `sketch #${p.id}`,
    picture = readFileSync(`${DIR}/${file}`);
  const copy = who === BOARD ? pictures.keep(picture).id : sendAsGuest(who, p, name, picture);
  if (isRefused(copy)) return copy;
  if (who === BOARD) chat.say(`From the Notebook: ${name}.`, undefined, undefined, [copy]);
  const sent = new Date().toISOString();
  db.prepare('update book_pages set sent = ? where id = ?').run(sent, p.id);
  return { sent, line: pictures.lineOf(copy), picture: copy };
}

// An invited person's page on the guest desk: the same, for their own book at its addresses
openRoom({
  hasSketch: (id, who) => !!book.row(id, who) && !managedPage(id),
  list: (who, base) => ({ sketches: listed(who).map(p => sketchOf(p, base)) }),
  get: getSketch,
  picture: servePicture,
  scrap: book.serveScrap,
  upload: book.uploadScrap,
  acts: {
    'POST create': createSketch,
    'POST save': saveSketch,
    'POST label': labelSketch,
    'POST archive': archiveSketch,
    'POST delete': (b, who) => book.deletePage(Number(b?.id), who),
    'POST send': (b, who) => sendSketch(Number(b?.id), who),
  },
  saveMax: SAVE_MAX,
});

// ---------------------------------------------------------------- the sketches before the book, folded in
// Once, at the server's start: every sketch (the Sketchbook's old table) becomes a free page under its own number, its
// ink, scraps, picture and the pictures review mode sent it kept; their files move from sketches/ to the book's folder,
// under the same names. A scrap or waiting picture whose file is gone is left out (counted in the log), so no page
// names a file it hasn't got. The old table goes; its count carries over, so a deleted sketch's number is never a
// new page's. The number folded in.
export function foldSketches() {
  if (!db.prepare("select 1 from sqlite_master where type = 'table' and name = 'sketches'").get()) return 0;
  const old = `${DATA_DIR}/sketches`;
  if (existsSync(old)) {
    for (const file of readdirSync(old)) renameSync(`${old}/${file}`, `${DIR}/${file}`);
    rmSync(old, { recursive: true, force: true });
  }
  const sketches = db.prepare('select * from sketches order by id').all() as any[];
  const add = db.prepare(`insert or ignore into book_pages (id, who, day, kind, label, archived, created, updated, w, h,
    ink, strokes, scraps, picture, sent, opened, waiting) values (?, ?, ?, 'free', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let gone = 0;
  const kept = <T extends { file: string }>(list: T[]) => {
    const there = list.filter(c => existsSync(`${DIR}/${c.file}`));
    gone += list.length - there.length;
    return there;
  };
  for (const s of sketches) {
    const scraps = JSON.parse(s.scraps ?? '[]') as Scrap[],
      placed = kept(scraps).slice(0, MAX_SCRAPS);
    // (a sketch that lost a scrap is drawn again, without it)
    const picture =
      placed.length === scraps.length && s.picture && existsSync(`${DIR}/${s.picture}`) ? s.picture : null;
    if (!picture && s.picture) rmSync(`${DIR}/${s.picture}`, { force: true });
    add.run(
      s.id,
      s.who,
      companyDay(Date.parse(s.created)),
      s.label,
      s.archived,
      s.created,
      s.updated,
      s.w,
      s.h,
      s.ink,
      s.strokes,
      JSON.stringify(placed),
      picture,
      s.sent,
      s.opened ?? null,
      JSON.stringify(kept(JSON.parse(s.waiting ?? '[]') as { file: string }[])),
    );
  }
  carryCount();
  db.exec('drop table sketches');
  if (gone) console.error(`book: ${gone} of the old sketches' pictures had no file, left out of their pages`);
  return sketches.length;
}
// The old table's count, the book's from now on (if it's ahead)
function carryCount() {
  const last =
    (db.prepare("select seq from sqlite_sequence where name = 'sketches'").get() as { seq: number } | undefined)?.seq ??
    0;
  if (!db.prepare("update sqlite_sequence set seq = max(seq, ?) where name = 'book_pages'").run(last).changes && last)
    db.prepare("insert into sqlite_sequence (name, seq) values ('book_pages', ?)").run(last);
}
once('2026-10-25-sketches-to-book', () => void foldSketches());

// ---------------------------------------------------------------- shared
// A person's sketches (who), newest drawn first
const listed = (who: string) =>
  db
    .prepare(
      `select ${book.COLUMNS} from book_pages where who = ? and kind = 'free'
      and not exists (select 1 from notebook_guests where notebook = book_pages.notebook)
      order by updated desc, id desc`,
    )
    .all(who) as Page[];
const drawn = (p: Page) => p.strokes > 0 || JSON.parse(p.scraps).length > 0;
// A page as the Sketchbook shows a sketch. picture: its address (v: its last change, so no browser shows an old one),
// null while nothing's on it. base: the routes' addresses, HQ's or a person's on the guest desk.
function sketchOf(p: Page, base = HQ_BASE) {
  const { id, label, archived, created, updated, w, h, strokes, pictures: placed, sent } = book.summary(p, false);
  const picture = drawn(p) ? `${base}/picture?id=${id}&v=${encodeURIComponent(updated)}` : null;
  return { id, label, archived, created, updated, w, h, strokes, pictures: placed, sent, picture };
}
// A book function's answer as a sketch's
const asSketch = (r: Answer, who: string, base: string) =>
  typeof r === 'number' || isRefused(r) ? r : sketchOf(book.row(r.id, who)!, base);
