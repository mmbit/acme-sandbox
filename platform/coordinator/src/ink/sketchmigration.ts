// Explicit operator migration of legacy guest drawings onto a chosen managed Notebook page.
import { readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { db, inOneStep, onUndo } from '../db.ts';
import * as people from './sketchpeople.ts';
import * as book from './book.ts';
import * as notebook from '../notebook.ts';
import * as groups from '../notebookgroups.ts';
import * as guests from '../notebookguests.ts';
import { managedPage } from '../notebookaccess.ts';
import { keepPicture } from '../notebookpictures.ts';
import { boxOf, joined, shifted, type Parts } from '../notebookparts.ts';
import { DIR, typeOf, type Scrap } from '../pagescraps.ts';
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
    const box = boxOf(original);
    if (!box) throw new Error('The source sketch has no drawing to copy.');
    const parts = copyPictures(targetId, original);
    const occupied = groups.groupsBox(targetId);
    const placed = occupied ? shifted(parts, occupied.x - box.x, occupied.y + occupied.h + 32 - box.y) : parts;
    const copied = groups.insertGroup(target, 'drawing', source.who, placed, {});
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
