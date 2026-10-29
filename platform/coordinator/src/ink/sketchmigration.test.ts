// node --test src/ink/sketchmigration.test.ts (uses the harness's throwaway company and DATA_DIR).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { harness } from '../harness.ts';

await harness('guest-sketch-migration');
const people = await import('./sketchpeople.ts');
const book = await import('./book.ts');
const guests = await import('../notebookguests.ts');
const notebook = await import('../notebook.ts');
const groups = await import('../notebookgroups.ts');
const { inventory, migrateSketch } = await import('./sketchmigration.ts');
const { DIR, keepScrap } = await import('../pagescraps.ts');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAF0lEQVQI12P8z4AALKsZQrFzGBkYEAoBe+gECZtuXNMAAAAASUVORK5CYII=',
  'base64',
);
const stroke = { color: '#223344', size: 4, points: [[20, 30, 0.5, 0]] };

function invited(name: string) {
  const created = guests.createInvitedNotebook({
    name,
    people: [{ name, email: `${name.toLowerCase()}@example.org` }],
  }) as { notebook: { id: number; pages: { id: number }[] } };
  return { page: created.notebook.pages[0].id, who: people.whoOf(people.grantOf(name)!) };
}
function sketch(who: string) {
  return (book.createPage({ kind: 'free', w: 800, h: 600 }, who) as { id: number }).id;
}

function readGroups(page: number, who: string) {
  const read = groups.listGroups({ page }, who);
  assert.ok(typeof read !== 'number');
  return read.groups;
}

test('the operator copies a chosen guest drawing and pictures once, keeping the original and existing destination work', () => {
  const target = invited('Mila');
  const source = sketch(target.who);
  const file = keepScrap(source, { type: 'image/png', clean: PNG });
  book.savePage(
    {
      id: source,
      ink: [stroke],
      texts: [{ x: 30, y: 50, w: 200, text: 'My drawing', color: '#223344' }],
      scraps: [{ file, x: 100, y: 100, w: 40, h: 40, tilt: 0 }],
    },
    target.who,
  );
  groups.createGroup({ page: target.page, ink: [stroke] }, target.who);
  assert.ok(inventory().some(p => p.source === source && p.targets.some(t => t.page === target.page)));
  const command = new URL('../../scripts/guest-sketches.ts', import.meta.url).pathname;
  const inspected = JSON.parse(execFileSync(process.execPath, [command, 'inventory'], { encoding: 'utf8' }));
  assert.ok(inspected.some((page: { source: number }) => page.source === source));
  assert.equal(readGroups(target.page, target.who).length, 1, 'inventory only reads');
  const migrated = migrateSketch(source, target.page);
  assert.equal(migrated.copied, true);
  const shown = readGroups(target.page, target.who);
  assert.equal(shown.length, 2);
  const copied = shown.find(g => g.id === migrated.group)!;
  assert.equal(copied.ink.length, 1);
  assert.equal(copied.texts.length, 1);
  assert.equal(copied.pictures.length, 1);
  assert.match(copied.pictures[0].file, new RegExp(`^${target.page}-g-`));
  assert.deepEqual(readFileSync(`${DIR}/${copied.pictures[0].file}`), PNG);
  assert.ok(copied.box!.y > shown[0].box!.y + shown[0].box!.h);
  assert.deepEqual(JSON.parse(book.drawnOf(source).ink), [stroke]);
  assert.ok(existsSync(`${DIR}/${file}`));
  assert.equal(migrateSketch(source, target.page).copied, false);
  assert.equal(readGroups(target.page, target.who).length, 2);
  const another = invited('Mila');
  assert.throws(() => migrateSketch(source, another.page), /already copied/);
  book.savePage({ id: source, ink: [stroke, stroke], scraps: [] }, target.who);
  assert.throws(() => migrateSketch(source, target.page), /already copied/);
});

test('the operator refuses another person, managed sources and read-only destinations, and handles already carried drawings', () => {
  const first = invited('Sina');
  const second = invited('Tove');
  const source = sketch(first.who);
  book.savePage({ id: source, ink: [stroke], scraps: [] }, first.who);
  assert.throws(() => migrateSketch(source, second.page), /same guest grant/);
  assert.throws(() => migrateSketch(first.page, first.page), /legacy guest sketch/);
  notebook.archivePage({ id: first.page, archived: true }, first.who);
  assert.throws(() => migrateSketch(source, first.page), /read-only/);
  notebook.archivePage({ id: first.page, archived: false }, first.who);
  notebook.mine(first.who);
  assert.equal(JSON.parse(book.drawnOf(source).ink).length, 0);
  assert.equal(migrateSketch(source, first.page).copied, true);
  assert.equal(readGroups(first.page, first.who)[0].ink.length, 1);
  assert.equal(readGroups(source, first.who)[0].ink.length, 1);
});
