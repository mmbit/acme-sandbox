// node --test src/db.test.ts   (a throwaway DATA_DIR holding a write-ahead database)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// WAL mode makes the erasure check cover journal files.
const dir = mkdtempSync(join(tmpdir(), 'care-db-'));
const old = new DatabaseSync(join(dir, 'care.db'));
old.exec('pragma journal_mode = wal; create table kept (x);');
old.close();

process.env.DATA_DIR = dir;
// (net() and its test live in shared/net)
const { db } = await import('./db.ts');

test("an erased case and conversation are in no file under DATA_DIR, even in a database that was write-ahead before", async () => {
  const { erase } = await import('./hq.ts');
  const id = Number(db.prepare("insert into cases (app, kind, checked, words, created) values ('shop', 'person', 'email', 'ERASE-ME-CASE', 1)").run().lastInsertRowid);
  const conv = Number(db.prepare("insert into conversations (shop, created, last) values ('shop', 1, 1)").run().lastInsertRowid);
  db.prepare("insert into messages (conversation, at, who, text) values (?, 1, 'customer', 'ERASE-ME-MESSAGE')").run(conv);
  assert.equal(erase([`H-${1000 + id}`]), 1);
  db.prepare('delete from conversations where id = ?').run(conv);
  db.exec('pragma wal_checkpoint(full)'); // nothing to do on a rollback journal; under write-ahead the text would still be in -wal
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter(f => f.isFile()).map(f => join(f.parentPath, f.name));
  assert.ok(files.some(f => f.endsWith('care.db')), files.join(', '));
  for (const f of files) for (const marker of ['ERASE-ME-CASE', 'ERASE-ME-MESSAGE']) assert.ok(!readFileSync(f).includes(marker), `${marker} in ${f}`);
});

test("a write-ahead database another process holds open stops the start, rather than erasing into care.db-wal", () => {
  const held = mkdtempSync(join(tmpdir(), 'care-db-held-'));
  const other = new DatabaseSync(join(held, 'care.db'));
  other.exec("pragma journal_mode = wal; create table kept (x); insert into kept values (1);");
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/db.ts')"], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, DATA_DIR: held }, encoding: 'utf8' });
  other.close();
  assert.notEqual(run.status, 0, 'the start went on');
  assert.match(run.stderr, /database is locked/);
});
