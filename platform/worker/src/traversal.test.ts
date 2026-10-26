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
    if (use.accountingError) throw new Error(use.accountingError);
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
    let swapping = true;
    const swap = () => {
      if (!swapping) return;
      renameSync(directory, held);
      symlinkSync(outside, directory);
      setImmediate(() => {
        rmSync(directory);
        renameSync(held, directory);
        if (swapping) setImmediate(swap);
      });
    };
    swap();
    try {
      for (let i = 0; i < 8; i++) {
        try {
          assert.ok((await measure()) < 4 * 1024 * 1024, 'racing symlink does not add the outside tree');
        } catch (failure) {
          assert.match(String(failure), /replaced|ENOENT|ENOTDIR|ELOOP|changes lost/);
        }
      }
    } finally {
      swapping = false;
      await new Promise<void>(resolve => setImmediate(resolve));
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
  assert.match(replaced.accountingError!, /ENOTDIR|ELOOP/);
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
    assert.match(denied.accountingError!, /EACCES/);
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
    assert.match(block.accountingError!, /EACCES/);
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
