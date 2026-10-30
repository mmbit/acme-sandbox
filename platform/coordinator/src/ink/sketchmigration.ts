// Old drawings carried into the book: an operator's explicit migration of legacy guest drawings onto a chosen managed
// Notebook page (scripts/guest-sketches.ts), and the Sketchbook's sketches from before the book, folded in once at the
// server's start (foldSketches).
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { db, inOneStep, once, onUndo } from '../db.ts';
import { DATA_DIR } from '../config.ts';
import { companyDay } from '../company.ts';
import * as people from './sketchpeople.ts';
import * as book from './book.ts';
import * as notebook from '../notebook.ts';
import * as groups from '../notebookgroups.ts';
import { type Parts } from '../notebookgroups.ts';
import * as guests from '../notebookguests.ts';
import { managedPage } from '../notebookaccess.ts';
import { keepPicture } from '../notebookpictures.ts';
import { joined } from '../../../hq/shell/ink/notebookparts.js';
import { unitOf } from '../../../hq/shell/ink/scrapunit.js';
import { boxOf } from '../../../hq/shell/ink/notebookstack.js';
import { DIR, MAX_SCRAPS, typeOf, type Scrap } from '../pagescraps.ts';
import { isRefused } from '../pagechecks.ts';
import { pictureSize } from '../../../../shared/pictures/size.ts';

type Migration = { source: number; target: number; fingerprint: string; group_id: number };
const migrationTable = () =>
  !!db.prepare("select 1 from sqlite_master where type = 'table' and name = 'guest_sketch_migrations'").get();
const migrations = () =>
  migrationTable() ? (db.prepare('select * from guest_sketch_migrations').all() as Migration[]) : [];

export function inventory() {
  const moved = migrations();
  const pages = db
    .prepare("select id, who from book_pages where who like 'guest:%' and kind = 'free' order by id")
    .all() as {
    id: number;
    who: string;
  }[];
  return pages
    .filter(p => !managedPage(p.id))
    .flatMap(p => {
      const source = sourceParts(p.id);
      if (!boxOf(source)) return [];
      return [
        {
          source: p.id,
          guest: people.ownerOf(p.who),
          ink: source.ink.length,
          texts: source.texts.length,
          pictures: source.pictures.length,
          migrated: moved.find(m => m.source === p.id)?.target ?? null,
          targets: guests.forGuest(people.ownerOf(p.who)!).map(m => ({ notebook: m.notebook, page: m.page })),
        },
      ];
    });
}

export function migrateSketch(sourceId: number, targetId: number) {
  return inOneStep(() => {
    const source = book.row(sourceId, null);
    const target = notebook.pageRow(targetId, null);
    if (!source || source.kind !== 'free' || managedPage(sourceId) || !people.grantBy(source.who))
      throw new Error('Choose a legacy guest sketch as the source.');
    const owner = people.ownerOf(source.who)!;
    const member = guests.pageMember(targetId, owner);
    if (!target || !member || target.who !== source.who || guests.whoOf(member) !== source.who)
      throw new Error('Choose an active managed page belonging to the same guest grant.');
    const original = sourceParts(sourceId);
    const fingerprint = createHash('sha256').update(JSON.stringify(original)).digest('hex');
    const before = migrations().find(m => m.source === sourceId);
    if (before) {
      if (before.target !== targetId || before.fingerprint !== fingerprint)
        throw new Error('This sketch was already copied. Inspect its recorded destination before changing anything.');
      return { source: sourceId, target: targetId, group: before.group_id, copied: false };
    }
    const open = groups.openPage(targetId, source.who);
    if (isRefused(open) || target.archived || notebook.notebookRow(target.notebook, book.BOARD)!.archived)
      throw new Error('The destination page is read-only. Reopen it before copying.');
    if (!boxOf(original)) throw new Error('The source sketch has no drawing to copy.');
    // (the page's last unit, as the person drew it.)
    const unit = unitOf(copyPictures(targetId, original));
    const copied = groups.insertGroup(target, 'drawing', source.who, unit.parts, { h: unit.h });
    record({ source: sourceId, target: targetId, fingerprint, group_id: copied.id });
    return { source: sourceId, target: targetId, group: copied.id, copied: true };
  });
}

function sourceParts(id: number) {
  const p = book.row(id, null)!;
  const drawing = book.drawnOf(id);
  const raw: Parts = { ink: JSON.parse(drawing.ink), texts: JSON.parse(drawing.texts), pictures: JSON.parse(p.scraps) };
  const waiting = db.prepare('select waiting from book_pages where id = ?').get(id) as { waiting: string };
  const parts = joined(raw, groups.drawnGroups(id));
  for (const picture of JSON.parse(waiting.waiting) as { file: string }[]) {
    const size = pictureSize(readFileSync(`${DIR}/${picture.file}`))!;
    const box = boxOf(parts);
    const w = Math.min(p.w, size.width);
    parts.pictures.push({
      file: picture.file,
      x: p.x,
      y: box ? box.y + box.h + 32 : p.y,
      w,
      h: Math.round((size.height * w) / size.width),
      tilt: 0,
    });
  }
  return parts;
}

function copyPictures(page: number, parts: Parts): Parts {
  const pictures = parts.pictures.map((picture: Scrap) => {
    const file = keepPicture(page, { type: typeOf(picture.file), clean: readFileSync(`${DIR}/${picture.file}`) });
    onUndo(() => rmSync(`${DIR}/${file}`, { force: true }));
    return { ...picture, file };
  });
  return { ...parts, pictures };
}

function record(m: Migration) {
  db.exec(`create table if not exists guest_sketch_migrations (source integer primary key, target integer not null,
    fingerprint text not null, group_id integer not null)`);
  db.prepare('insert into guest_sketch_migrations (source, target, fingerprint, group_id) values (?, ?, ?, ?)').run(
    m.source,
    m.target,
    m.fingerprint,
    m.group_id,
  );
}

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
