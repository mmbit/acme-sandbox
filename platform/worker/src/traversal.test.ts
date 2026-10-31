// node --test platform/worker/src/traversal.test.ts (real slot-owned scans and racing directory replacements).
import { test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { chmodSync, chownSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskShares } from './disk.ts';
import { processesFor, tally, overShare } from './shares.ts';

function fixture(context: any) {
  const work = mkdtempSync(join(tmpdir(), 'disk-traversal-'));
  const root = join(work, 'jobs', '1');
  for (const folder of ['jobs', 'homes', 'tests']) mkdirSync(join(work, folder, '1'), { recursive: true });
  const shares = new DiskShares(work);
  const ids = { uid: process.getuid!(), gid: process.getgid!() };
  context.after(() => {
    shares.close();
    rmSync(work, { recursive: true, force: true });
  });
  const measure = async () => {
    const use = (await shares.measure([{ job: 1, ...ids }], { freeBytes: 0, reserveBytes: 0 })).get(ids.uid)!;
    if (use.accountingError) throw new Error(use.accountingError.message);
    return use.used!;
  };
  return { work, root, shares, ids, measure };
}

for (const replacement of ['descendant', 'root'])
  test(`a replacement ${replacement} symlink never lets a disk scan count or watch its outside target`, async context => {
    const { work, root, measure } = fixture(context);
    const outside = join(work, 'outside');
    const directory = replacement === 'root' ? root : join(root, 'directory');
    const held = join(work, 'held');
    mkdirSync(outside);
    writeFileSync(join(outside, 'large'), Buffer.alloc(8 * 1024 * 1024));
    if (replacement !== 'root') mkdirSync(directory);
    for (let i = 0; i < 128; i++) {
      mkdirSync(join(directory, String(i)));
      writeFileSync(join(directory, String(i), 'small'), 'inside');
    }
    symlinkSync(outside, join(root, 'outside'));
    const baseline = await measure();
    assert.ok(baseline < 4 * 1024 * 1024, 'static symlink does not add the outside tree');
    // Each measurement races a fixed batch so a slow scan cannot generate more filesystem work for itself.
    const swap = async () => {
      for (let i = 0; i < 8; i++) {
        renameSync(directory, held);
        symlinkSync(outside, directory);
        await new Promise<void>(resolve => setImmediate(resolve));
        rmSync(directory);
        renameSync(held, directory);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    };
    for (let i = 0; i < 8; i++) {
      const swapping = swap();
      try {
        assert.ok((await measure()) < 4 * 1024 * 1024, 'racing symlink does not add the outside tree');
      } catch (failure) {
        assert.match(String(failure), /replaced|ENOENT|ENOTDIR|ELOOP|changes lost/);
      } finally {
        await swapping;
      }
    }
    assert.equal(await measure(), baseline);
    writeFileSync(join(outside, 'later'), Buffer.alloc(1024 * 1024));
    assert.equal(await measure(), baseline, 'outside changes do not enter the cached scan');
  });

test('root paths reject intermediate symlinks and scans use the slot filesystem permissions', async context => {
  const { work, root, shares, ids } = fixture(context);
  const relocated = join(work, 'relocated');
  renameSync(join(work, 'jobs'), relocated);
  symlinkSync(relocated, join(work, 'jobs'));
  const replaced = (await shares.measure([{ job: 1, ...ids }], { freeBytes: 0, reserveBytes: 0 })).get(ids.uid)!;
  assert.equal(replaced.used, null);
  assert.match(replaced.accountingError!.message, /ENOTDIR|ELOOP/);
  rmSync(join(work, 'jobs'));
  renameSync(relocated, join(work, 'jobs'));
  shares.close();
  const privateDirectory = join(root, 'private');
  mkdirSync(privateDirectory);
  writeFileSync(join(privateDirectory, 'hidden'), Buffer.alloc(4096));
  chmodSync(privateDirectory, 0);
  const slot = ids.uid === 0 ? { uid: 65534, gid: 65534 } : ids;
  if (ids.uid === 0) {
    chmodSync(work, 0o755);
    for (const folder of ['jobs', 'homes', 'tests']) chownSync(join(work, folder, '1'), slot.uid, slot.gid);
  }
  const restricted = new DiskShares(work);
  try {
    const denied = (await restricted.measure([{ job: 1, ...slot }], { freeBytes: 0, reserveBytes: 0 })).get(slot.uid)!;
    assert.equal(denied.used, null);
    assert.match(denied.accountingError!.message, /EACCES/);
    assert.equal(denied.accountingError!.reason, 'job-tree');
    const command = spawn('sleep', ['300'], slot);
    context.after(() => command.kill('SIGKILL'));
    await new Promise<void>((resolve, reject) => {
      command.once('spawn', resolve);
      command.once('error', reject);
    });
    const procs = (await processesFor([slot])).filter(p => p.pid === command.pid);
    const disk = new Map([[slot.uid, denied]]);
    const limits = {
      mostMb: Infinity,
      shareMb: Infinity,
      cores: Infinity,
      processes: Infinity,
      starved: false,
      workerSessionId: 0,
      disk,
    };
    const block = overShare(tally(procs, procs, 1000), new Set(), limits).block!;
    assert.equal(block.root.pid, command.pid);
    assert.equal(block.measure, 'disk');
    assert.equal(block.used, null);
    assert.match(block.accountingError!.message, /EACCES/);
    assert.equal(block.accountingError!.reason, 'job-tree');
  } finally {
    restricted.close();
    chmodSync(privateDirectory, 0o700);
  }
});

test('slot commands cannot signal the scanner that applies their filesystem permissions', async context => {
  if (process.getuid!() !== 0) return context.skip('needs the production root worker identity');
  const { work, shares } = fixture(context);
  const ids = { uid: 65534, gid: 65534 };
  chmodSync(work, 0o755);
  for (const folder of ['jobs', 'homes', 'tests']) chownSync(join(work, folder, '1'), ids.uid, ids.gid);
  const measure = () => shares.measure([{ job: 1, ...ids }], { freeBytes: 0, reserveBytes: 0 });
  const before = (await measure()).get(ids.uid)!.used;
  const pid = [...shares.scanners()][0];
  const code = `
    try { process.kill(Number(process.argv[1]), 'SIGKILL'); process.exit(1); }
    catch (failure) { if (failure.code !== 'EPERM') throw failure; }
  `;
  execFileSync(process.execPath, ['-e', code, String(pid)], { ...ids, env: { PATH: '/usr/bin:/bin' } });
  assert.equal((await measure()).get(ids.uid)!.used, before);
});

test('disk scans traverse private shared parents without listing them and tolerate an absent tests folder', async context => {
  const { work, root, shares, ids, measure } = fixture(context);
  const slot = ids.uid === 0 ? { uid: 65534, gid: 65534 } : ids;
  // Without root, the owner must also lose read permission to exercise traverse-only access.
  const permissions = ids.uid === 0 ? 0o711 : 0o111;
  rmSync(join(work, 'tests', '1'), { recursive: true });
  writeFileSync(join(root, 'small'), Buffer.alloc(4096));
  if (ids.uid === 0) chownSync(join(root, 'small'), slot.uid, slot.gid);
  try {
    chmodSync(work, permissions);
    for (const folder of ['jobs', 'homes', 'tests']) {
      if (ids.uid === 0 && folder !== 'tests') chownSync(join(work, folder, '1'), slot.uid, slot.gid);
      chmodSync(join(work, folder), permissions);
    }
    const use = (await shares.measure([{ job: 1, ...slot }], { freeBytes: 2 ** 30, reserveBytes: 0 })).get(slot.uid)!;
    assert.equal(use.accountingError, undefined);
    assert.ok(use.used! >= 4096);
    assert.ok(use.used! < 65536);
    const tests = join(work, 'tests', '1');
    chmodSync(join(work, 'tests'), 0o700);
    mkdirSync(tests);
    writeFileSync(join(tests, 'later'), Buffer.alloc(8192));
    if (ids.uid === 0) {
      chownSync(tests, slot.uid, slot.gid);
      chownSync(join(tests, 'later'), slot.uid, slot.gid);
    }
    chmodSync(join(work, 'tests'), permissions);
    const created = (await shares.measure([{ job: 1, ...slot }], { freeBytes: 2 ** 30, reserveBytes: 0 })).get(
      slot.uid,
    )!;
    assert.equal(created.accountingError, undefined);
    assert.ok(created.used! >= use.used! + 8192, 'a later tests tree is measured too');
    if (ids.uid !== 0) assert.equal(await measure(), created.used);
  } finally {
    chmodSync(work, 0o700);
    for (const folder of ['jobs', 'homes', 'tests']) chmodSync(join(work, folder), 0o700);
  }
});

test('an inaccessible worker-owned ancestor is an infrastructure failure, not a slot tree denial', async context => {
  const { work, shares, ids } = fixture(context);
  const slot = ids.uid === 0 ? { uid: 65534, gid: 65534 } : ids;
  try {
    chmodSync(work, ids.uid === 0 ? 0o700 : 0);
    const use = (await shares.measure([{ job: 1, ...slot }], { freeBytes: 4096, reserveBytes: 0 })).get(slot.uid)!;
    assert.equal(use.used, null);
    assert.equal(use.accountingError!.reason, 'worker-ancestor');
    assert.match(use.accountingError!.message, /EACCES/);
  } finally {
    chmodSync(work, 0o700);
  }
});
