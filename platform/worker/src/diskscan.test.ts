// node --test platform/worker/src/diskscan.test.ts (a real probe process over a real tree)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskScan } from './diskscan.ts';
import { PROBE_OLD_SPACE_MB } from './disktree.ts';

// Each job keeps a probe alive and the worker's admission counts what it holds against every start. Over a tree of
// ~23,000 files in ~1,600 folders, a probe with V8's default young generation holds ~96 MB of its own, and ~50-58 MB
// with the small one diskscan.ts sets.
test("a job's disk probe holds little more than its tree, so the room it takes from starts stays small", async context => {
  const root = mkdtempSync(join(tmpdir(), 'disk-probe-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (let d = 0; d < 1600; d++) {
    const folder = join(root, `folder-${d % 40}`, `module-${d}`);
    mkdirSync(folder, { recursive: true });
    for (let f = 0; f < 14; f++) writeFileSync(join(folder, `file-${f}.ts`), 'x');
  }
  const scan = new DiskScan([root], { uid: process.getuid!(), gid: process.getgid!() });
  context.after(() => scan.close());
  for (let i = 0; i < 3; i++) assert.ok((await scan.measure()) > 0);
  const status = readFileSync(`/proc/${scan.pid}/status`, 'utf8');
  const anonMb = Number(status.match(/^RssAnon:\s+(\d+) kB/m)![1]) / 1024;
  assert.ok(anonMb < 75, `the probe holds ${Math.round(anonMb)} MB of its own`);
});

// A job's folders while its push's tests run: its own clone (~23,000 entries), the tests' clone with its installs
// (~23,500) and the base's checkout they compare with (~12,700), ~60,000 entries in ~4,700 folders, under a 40-character
// commit folder. They fit a probe with half the old space, so the live one's bound has room to spare.
test("a job's tree through its push tests is accounted with room to spare", async context => {
  const work = mkdtempSync(join(tmpdir(), 'disk-tests-tree-'));
  context.after(() => rmSync(work, { recursive: true, force: true }));
  const commit = 'c'.repeat(40);
  const parts = [
    ['jobs/1', 1600, 14],
    [`tests/1/${commit}/repo`, 1700, 13],
    [`tests/1/${commit}/tmp/tests-checkout-x`, 1400, 9],
  ] as const;
  for (const [part, folders, files] of parts)
    for (let d = 0; d < folders; d++) {
      const folder = join(work, part, `folder-${d % 40}`, `module-${d}`);
      mkdirSync(folder, { recursive: true });
      for (let f = 0; f < files; f++) writeFileSync(join(folder, `file-${f}.ts`), 'x');
    }
  const roots = ['jobs', 'homes', 'tests'].map(folder => join(work, folder, '1'));
  const scan = new DiskScan(roots, { uid: process.getuid!(), gid: process.getgid!() }, PROBE_OLD_SPACE_MB / 2);
  context.after(() => scan.close());
  assert.ok((await scan.measure()) > 0);
});
