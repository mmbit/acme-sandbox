// node --test platform/worker/src/disk.test.ts (real files, command processes and HQ HTTP routes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync,
  chmodSync,
  chownSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  lstatSync,
  linkSync,
  symlinkSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { sampleWrites } from './diskwrites.ts';
import { DiskShares } from './disk.ts';
import { TREE_ENTRY_LIMIT } from './disktree.ts';
import { warnDisk } from './diskwarnings.ts';
import { processesFor, tally, overShare } from './shares.ts';
import { Reload } from './reload.ts';
import { harness } from '../../coordinator/src/harness.ts';

process.env.DEPLOY_BUILD_RESERVE_GB = '25';
const h = await harness('disk-shares');
const ids = { uid: process.getuid!(), gid: process.getgid!() };
// the tests that measure a writer need the kernel's per-process I/O counters, which a lent tests helper's kernel lacks
const noIoCounters =
  !existsSync('/proc/self/io') && 'needs per-process I/O counters (task_io_accounting) in the kernel';
const limits = {
  mostMb: Infinity,
  shareMb: Infinity,
  cores: Infinity,
  processes: Infinity,
  starved: false,
  workerSessionId: 0,
};

function temporary(context: any) {
  const work = mkdtempSync(join(tmpdir(), 'disk-job-'));
  context.after(() => rmSync(work, { recursive: true, force: true }));
  return work;
}

const allocated = (roots: string[]) =>
  execFileSync('du', ['-s', '-B1', ...roots], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .reduce((bytes, line) => bytes + Number(line.split('\t')[0]), 0);

async function settled(measure: () => Promise<number>, expected: () => number, signal: AbortSignal) {
  while ((await measure()) !== expected()) await sleep(10, undefined, { signal });
}

test('allocated use follows writes, truncation, links, directory moves and root replacement across all three folders', async context => {
  const work = temporary(context);
  const roots = ['jobs', 'homes', 'tests'].map(folder => join(work, folder, '1'));
  roots.forEach(root => mkdirSync(root, { recursive: true }));
  const shares = new DiskShares(work);
  const measure = async () =>
    (await shares.measure([{ job: 1, ...ids }], { freeBytes: 0, reserveBytes: 0 })).get(ids.uid)!.used!;
  context.after(() => shares.close());
  writeFileSync(join(roots[0], 'cache'), Buffer.alloc(32 * 1024));
  linkSync(join(roots[0], 'cache'), join(roots[1], 'same'));
  symlinkSync(work, join(roots[2], 'outside'));
  assert.equal(await measure(), allocated(roots), 'hardlinks once, symlink contents excluded');
  appendFileSync(join(roots[1], 'same'), Buffer.alloc(16 * 1024));
  await settled(measure, () => allocated(roots), context.signal);
  mkdirSync(join(roots[2], 'node_modules', 'package'), { recursive: true });
  writeFileSync(join(roots[2], 'node_modules', 'package', 'index'), Buffer.alloc(20 * 1024));
  await settled(measure, () => allocated(roots), context.signal);
  renameSync(join(roots[2], 'node_modules'), join(roots[1], 'dependencies'));
  await settled(measure, () => allocated(roots), context.signal);
  writeFileSync(join(roots[0], 'cache'), 'small');
  rmSync(join(roots[1], 'same'));
  await settled(measure, () => allocated(roots), context.signal);
  rmSync(roots[1], { recursive: true });
  mkdirSync(roots[1]);
  writeFileSync(join(roots[1], 'new'), Buffer.alloc(8192));
  await settled(measure, () => allocated(roots), context.signal);
});

// The worker's /work/jobs, homes and tests are root's and 0711 (worker.ts): a slot passes through, never lists. Its
// scanner holds those ancestors without reading them.
test(
  "a slot's scan measures its job under the worker's 0711 folders",
  { skip: process.getuid!() !== 0 && 'needs root' },
  async context => {
    // (under /tmp: the harness's own temp folder is root's 0700, which no slot passes)
    const work = mkdtempSync('/tmp/disk-slot-');
    context.after(() => rmSync(work, { recursive: true, force: true }));
    chmodSync(work, 0o755);
    const slot = { uid: 1501, gid: 1501 };
    const roots = ['jobs', 'homes', 'tests'].map(folder => join(work, folder, '7'));
    for (const root of roots) {
      mkdirSync(root, { recursive: true });
      chmodSync(join(root, '..'), 0o711);
      chownSync(root, slot.uid, slot.gid);
    }
    writeFileSync(join(roots[0], 'cache'), Buffer.alloc(48 * 1024));
    const shares = new DiskShares(work);
    context.after(() => shares.close());
    const use = (await shares.measure([{ job: 7, ...slot }], { freeBytes: 0, reserveBytes: 0 })).get(slot.uid)!;
    assert.equal(use.accountingError, undefined);
    assert.equal(use.used, allocated(roots));
  },
);

// A deploy cuts a run off and HQ hands the job to another slot, its folders with it (worker.ts own): the next look
// measures it as that slot. Without root, the first slot is one the scan can't become, so its look fails as an
// unreadable tree would.
test('a job taken up again in another slot is measured as that slot', async context => {
  const rootWorker = process.getuid!() === 0;
  // (as root under /tmp, as the 0711 test above; without root, /tmp may not be writable: the run's own temp folder)
  const work = mkdtempSync(rootWorker ? '/tmp/disk-moved-' : join(tmpdir(), 'disk-moved-'));
  context.after(() => rmSync(work, { recursive: true, force: true }));
  chmodSync(work, 0o755);
  const [first, next] = rootWorker
    ? [
        { uid: 65001, gid: 65001 },
        { uid: 65002, gid: 65002 },
      ]
    : [{ uid: ids.uid + 1, gid: ids.gid }, ids];
  const roots = ['jobs', 'homes', 'tests'].map(folder => join(work, folder, '7'));
  const hand = (slot: typeof first) => {
    if (rootWorker) for (const root of roots) execFileSync('chown', ['-R', `${slot.uid}:${slot.gid}`, root]);
  };
  for (const root of roots) {
    mkdirSync(root, { recursive: true });
    chmodSync(join(root, '..'), 0o711);
    chmodSync(root, 0o700);
  }
  writeFileSync(join(roots[0], 'cache'), Buffer.alloc(48 * 1024));
  const shares = new DiskShares(work);
  context.after(() => shares.close());
  const look = async (slot: typeof first) =>
    (await shares.measure([{ job: 7, ...slot }], { freeBytes: 0, reserveBytes: 0 })).get(slot.uid)!;
  hand(first);
  const before = await look(first);
  if (rootWorker) assert.equal(before.accountingError, undefined);
  hand(next);
  const after = await look(next);
  assert.equal(after.accountingError, undefined);
  assert.equal(after.used, allocated(roots));
});

test('the server reserve uses the actual database size and keeps room for a deploy build', async () => {
  const { body, status } = await h.worker('disk');
  assert.equal(status, 200);
  assert.equal(body.databaseBytes, lstatSync(join(process.env.DATA_DIR!, 'hq.db')).size);
  assert.equal(body.buildBytes, 25 * 2 ** 30);
  assert.equal(body.reserveBytes, body.buildBytes + 2 * body.databaseBytes);
});

test('a job hears disk cleanup instructions before its continued writer is stopped, leaving another job and cleanup running', async context => {
  if (noIoCounters) return context.skip(noIoCounters);
  const work = temporary(context);
  const hog = await h.start({ agent: 'bolt' });
  const other = await h.start({ agent: 'rook' });
  const owners = [
    { job: hog.id, ...ids },
    { job: other.id, uid: ids.uid + 1, gid: ids.gid },
  ];
  for (const job of [hog, other])
    for (const folder of ['jobs', 'homes', 'tests']) mkdirSync(join(work, folder, String(job.id)), { recursive: true });
  const cache = join(work, 'homes', String(hog.id), 'cache');
  writeFileSync(cache, Buffer.alloc(512 * 1024));
  const shares = new DiskShares(work);
  context.after(() => shares.close());
  const roots = ['jobs', 'homes', 'tests'].map(folder => join(work, folder, String(hog.id)));
  const measure = () =>
    shares.measure([owners[0]], {
      freeBytes: 1024 * 1024 + 256 * 1024 - allocated(roots),
      reserveBytes: 1024 * 1024,
    });
  const backgroundOutput = join(work, 'background-output');
  const backgroundFd = openSync(backgroundOutput, 'a');
  const background = spawn('sleep', ['300'], { stdio: ['ignore', 'ignore', backgroundFd] });
  closeSync(backgroundFd);
  context.after(() => background.kill('SIGKILL'));
  const output = join(work, 'output');
  const fd = openSync(output, 'a');
  const writer = spawn(
    process.execPath,
    [
      '-e',
      `const fs = require('fs'); let cacheFd = fs.openSync(process.argv[1], 'a'); process.on('SIGUSR1', () => { fs.writeSync(cacheFd, Buffer.alloc(65536)); console.log('wrote'); }); process.on('SIGTERM', () => { fs.writeFileSync(process.argv[1] + '.lock', Buffer.alloc(4096)); fs.truncateSync(process.argv[1], 384 * 1024); fs.closeSync(cacheFd); cacheFd = fs.openSync(process.argv[1], 'a'); console.log('cleaned'); }); process.on('SIGUSR2', () => console.log('talked')); console.log('ready'); setInterval(() => {}, 1000);`,
      cache,
    ],
    { stdio: ['ignore', 'pipe', fd] },
  );
  closeSync(fd);
  let progress = '';
  writer.stdout!.on('data', bytes => {
    progress += bytes;
  });
  const reader = spawn('sleep', ['300']);
  const cleanup = spawn('sh', ['-c', 'read -r answer; rm -- "$1"', 'sh', cache], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  context.after(() => {
    writer.kill('SIGKILL');
    reader.kill('SIGKILL');
    cleanup.kill('SIGKILL');
  });

  while (!progress.includes('ready')) await sleep(10, undefined, { signal: context.signal });
  const snapshots = async () =>
    (await sampleWrites(await processesFor([ids]), [ids]))
      .filter(p => p.pid === background.pid || p.pid === writer.pid || p.pid === reader.pid || p.pid === cleanup.pid)
      .map(p => (p.pid === reader.pid ? { ...p, uid: owners[1].uid } : p));
  const baseline = await snapshots();
  writer.kill('SIGUSR1');
  while (!progress.includes('wrote')) await sleep(10, undefined, { signal: context.signal });
  let before = await snapshots();
  // The kernel's room is an external reading. Keep this fixture independent of other jobs' disk activity.
  let disk = await measure();
  let uses = tally(before, baseline, 1000);
  assert.ok((uses.get(ids.uid)!.processes.find(p => p.pid === writer.pid)!.writtenCallBytes ?? 0) > 0);
  const cli = new Set<number>();
  assert.equal(overShare(uses, cli, { ...limits, disk }).block, undefined, 'overage is warned first');
  const ask = async (body: Record<string, unknown>) => {
    const reply = await h.worker('blocked', body);
    assert.equal(reply.status, 200);
    return reply.body;
  };
  await warnDisk([owners[0]], disk, uses, cli, shares, ask);
  const warning = readFileSync(output, 'utf8');
  for (const folder of ['jobs', 'homes', 'tests']) assert.ok(warning.includes(`/work/${folder}/${hog.id}`));
  assert.match(warning, /Clear disposable caches/);
  assert.match(readFileSync(backgroundOutput, 'utf8'), /Clear disposable caches/);
  assert.equal(
    (h.db.prepare('select count(*) n from blocks where job = ?').get(hog.id) as any).n,
    0,
    'warning is not a strike',
  );
  const beforeCleanup = disk.get(ids.uid)!.used!;
  writer.kill('SIGTERM');
  while (!progress.includes('cleaned')) await sleep(10, undefined, { signal: context.signal });
  const shrinking = await snapshots();
  do {
    disk = await measure();
    if (disk.get(ids.uid)!.used! >= beforeCleanup) await sleep(10, undefined, { signal: context.signal });
  } while (disk.get(ids.uid)!.used! >= beforeCleanup);
  assert.ok(disk.get(ids.uid)!.used! > disk.get(ids.uid)!.share, 'cleanup leaves the job over its share');
  assert.equal(
    overShare(tally(shrinking, before, 1000), cli, { ...limits, disk }).block,
    undefined,
    'cleanup may write a replacement file while it frees more disk',
  );
  before = shrinking;
  writer.kill('SIGUSR2');
  while (!progress.includes('talked')) await sleep(10, undefined, { signal: context.signal });
  const talking = await snapshots();
  assert.ok(
    (tally(talking, before, 1000)
      .get(ids.uid)!
      .processes.find(p => p.pid === writer.pid)!.writtenCallBytes ?? 0) > 0,
  );
  disk = await measure();
  assert.equal(disk.get(ids.uid)!.grew, false);
  assert.equal(
    overShare(tally(talking, before, 1000), cli, { ...limits, disk }).block,
    undefined,
    'read-only and cleanup commands remain available after the warning',
  );
  before = talking;
  writer.kill('SIGUSR1');
  while ((progress.match(/^wrote$/gm) ?? []).length < 2) await sleep(10, undefined, { signal: context.signal });
  const now = await snapshots();
  do {
    disk = await measure();
    if (!disk.get(ids.uid)!.grew) await sleep(10, undefined, { signal: context.signal });
  } while (!disk.get(ids.uid)!.grew);
  uses = tally(now, before, 1000);
  const block = overShare(uses, cli, { ...limits, disk }).block!;
  assert.equal(block.measure, 'disk');
  assert.equal(block.root.pid, writer.pid);
  assert.equal(block.uid, owners[0].uid);
  const reasons: string[] = [];
  const closed = once(writer, 'close');
  await new Reload().block(owners[0], block, now, {
    ask,
    checking: new Map([[writer.pid!, { stopped: reasons }]]),
    stopped: () => {},
  });
  assert.equal((await closed)[1], 'SIGKILL');
  assert.equal(reasons.length, 1, 'push checks retain stop attribution');
  assert.match(readFileSync(output, 'utf8'), /HQ's worker stopped this command/);
  assert.equal((h.db.prepare('select count(*) n from blocks where job = ?').get(hog.id) as any).n, 1);
  assert.equal((h.db.prepare('select count(*) n from blocks where job = ?').get(other.id) as any).n, 0);
  assert.equal(reader.exitCode, null);
  assert.equal(reader.signalCode, null, 'other job keeps running');
  assert.equal(cleanup.signalCode, null, 'cleanup command remains alive');
  const cleaned = once(cleanup, 'close');
  cleanup.stdin!.end('clear\n');
  assert.equal((await cleaned)[0], 0);
  do {
    await sleep(10, undefined, { signal: context.signal });
    disk = await measure();
  } while (disk.get(owners[0].uid)!.used! > disk.get(owners[0].uid)!.share);
  assert.ok(disk.get(owners[0].uid)!.used! <= disk.get(owners[0].uid)!.share);
  assert.equal(disk.get(owners[0].uid)!.warned, false, 'cleanup restores the warning grace');
});

test('closed command stderr cannot prevent a recorded session warning or continued-write enforcement', async context => {
  const work = temporary(context);
  const job = await h.start({ agent: 'bolt' });
  const owners = [{ job: job.id, ...ids }];
  for (const folder of ['jobs', 'homes', 'tests']) mkdirSync(join(work, folder, String(job.id)), { recursive: true });
  const cache = join(work, 'jobs', String(job.id), 'cache');
  writeFileSync(cache, Buffer.alloc(65536));
  const writer = spawn(
    process.execPath,
    [
      '-e',
      `
    const fs = require('fs');
    const fd = fs.openSync(process.argv[1], 'a');
    process.on('SIGUSR1', () => { fs.writeSync(fd, Buffer.alloc(65536)); console.log('wrote'); });
    console.log('starting'); setInterval(() => {}, 1000);
    fs.closeSync(2); console.log('ready');
  `,
      cache,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  context.after(() => writer.kill('SIGKILL'));
  let progress = '';
  writer.stdout!.on('data', bytes => {
    progress += bytes;
  });
  while (!progress.includes('ready')) await sleep(10, undefined, { signal: context.signal });
  const shares = new DiskShares(work);
  context.after(() => shares.close());
  const snapshots = async () =>
    (await sampleWrites(await processesFor([ids]), [ids])).filter(p => p.pid === writer.pid);
  assert.throws(() => lstatSync(`/proc/${writer.pid}/fd/2`), { code: 'ENOENT' }, 'stderr remains closed');
  const budget = { freeBytes: 0, reserveBytes: 1024 * 1024 };
  let disk = await shares.measure(owners, budget);
  const before = await snapshots();
  const ask = async (body: Record<string, unknown>) => {
    const reply = await h.worker('blocked', body);
    assert.equal(reply.status, 200);
    return reply.body;
  };
  await warnDisk(owners, disk, tally(before, before, 1000), new Set(), shares, ask);
  disk = await shares.measure(owners, budget);
  assert.equal(disk.get(ids.uid)!.warned, true, 'grace ends after worker-owned recording, even with closed stderr');
  const inbox = await h.hq(job, 'inbox', '--hook');
  assert.equal(inbox.code, 0);
  const contextWords = JSON.parse(inbox.out).hookSpecificOutput.additionalContext;
  assert.match(contextWords, /Clear disposable caches/);
  for (const folder of ['jobs', 'homes', 'tests']) assert.ok(contextWords.includes(`/work/${folder}/${job.id}`));
  assert.doesNotMatch(contextWords, /from a colleague/);
  assert.equal((await h.hq(job, 'inbox', '--hook')).out, '', 'the session acknowledges the warning');
  writer.kill('SIGUSR1');
  while (!progress.includes('wrote')) await sleep(10, undefined, { signal: context.signal });
  const now = await snapshots();
  do {
    disk = await shares.measure(owners, budget);
    if (!disk.get(ids.uid)!.grew) await sleep(10, undefined, { signal: context.signal });
  } while (!disk.get(ids.uid)!.grew);
  const block = overShare(tally(now, before, 1000), new Set(), { ...limits, disk }).block!;
  assert.equal(block.root.pid, writer.pid);
  const closed = once(writer, 'close');
  await new Reload().block(owners[0], block, now, { ask, checking: new Map(), stopped: () => {} });
  assert.equal((await closed)[1], 'SIGKILL');
});

test('a recorded disk warning survives a lost reply and lost hook acknowledgment without crossing jobs', async context => {
  const job = await h.start({ agent: 'bolt' });
  const other = await h.start({ agent: 'rook' });
  const warning = {
    event: '11391000-0000-4000-8000-000000000001',
    job: job.id,
    measure: 'disk',
    used: 65536,
    share: 0,
    warning: true,
  };
  assert.equal((await h.worker('blocked', warning)).status, 200);
  assert.equal((await h.worker('blocked', warning)).status, 200, 'a lost worker reply may repeat the same record');
  const inbox = await h.agent('inbox', job.token, { stopping: false });
  const disk = inbox.body.filter((entry: any) => entry.disk);
  assert.equal(disk.length, 1);
  assert.match(disk[0].text, /Clear disposable caches/);
  assert.equal(
    (await h.agent('inbox', other.token, { stopping: false })).body.filter((entry: any) => entry.disk).length,
    0,
  );
  await h.agent('inbox-ack', other.token, { ids: [], disk: [warning.event] });
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  context.mock.timers.tick(60_001);
  assert.equal(
    (await h.agent('inbox', job.token, { stopping: true })).body.filter((entry: any) => entry.disk).length,
    0,
  );
  assert.equal(
    (await h.agent('inbox', job.token, { stopping: false })).body.filter((entry: any) => entry.disk).length,
    1,
  );
  await h.agent('inbox-ack', job.token, { ids: [], disk: [warning.event] });
  context.mock.timers.tick(60_001);
  assert.equal(
    (await h.agent('inbox', job.token, { stopping: false })).body.filter((entry: any) => entry.disk).length,
    0,
  );
});

test('a failed job scan stops only its own command and leaves a warned writer measured and enforceable', async context => {
  if (noIoCounters) return context.skip(noIoCounters);
  const rootWorker = process.getuid!() === 0;
  const work = mkdtempSync(join(tmpdir(), 'disk-failure-'));
  chmodSync(work, 0o755);
  const jobs = [await h.start({ agent: 'bolt' }), await h.start({ agent: 'rook' })];
  const owners = jobs.map((job, i) => ({
    job: job.id,
    uid: rootWorker ? 65001 + i : ids.uid + 1 - i,
    gid: rootWorker ? 65001 + i : ids.gid,
  }));
  context.after(() => {
    const privateDirectory = join(work, 'jobs', String(jobs[0].id), 'private');
    try {
      chmodSync(privateDirectory, 0o700);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
    }
    rmSync(work, { recursive: true, force: true });
  });
  const commands: ChildProcess[] = [];
  for (const owner of owners) {
    for (const folder of ['jobs', 'homes', 'tests']) {
      const root = join(work, folder, String(owner.job));
      mkdirSync(root, { recursive: true });
      if (rootWorker) chownSync(root, owner.uid, owner.gid);
    }
    const command = spawn(
      process.execPath,
      [
        '-e',
        `
      const fs = require('node:fs');
      const root = process.argv[1];
      const fd = fs.openSync(root + '/cache', 'w');
      fs.writeSync(fd, Buffer.alloc(65536));
      process.stdin.on('data', bytes => {
        if (String(bytes).trim() === 'deny') {
          fs.mkdirSync(root + '/private'); fs.chmodSync(root + '/private', 0);
        } else fs.writeSync(fd, Buffer.alloc(65536));
        console.log('done');
      });
      console.log('ready');
    `,
        join(work, 'jobs', String(owner.job)),
      ],
      rootWorker ? owner : ids,
    );
    commands.push(command);
    context.after(() => command.kill('SIGKILL'));
    await once(command.stdout!, 'data');
  }
  const shares = new DiskShares(work);
  context.after(() => shares.close());
  const budget = { freeBytes: 0, reserveBytes: 1024 * 1024 };
  const snapshots = async () =>
    sampleWrites(
      (await processesFor(rootWorker ? owners : [ids]))
        .filter(p => commands.some(c => c.pid === p.pid))
        .map(p => ({ ...p, uid: owners[commands.findIndex(c => c.pid === p.pid)].uid })),
      rootWorker ? owners : [ids],
    );
  const before = await snapshots();
  const cli = new Set<number>();
  const ask = async (body: Record<string, unknown>) => {
    const reply = await h.worker('blocked', body);
    assert.equal(reply.status, 200);
    return reply.body;
  };
  await warnDisk(owners, await shares.measure(owners, budget), tally(before, before, 1000), cli, shares, ask);
  for (const [i, text] of ['deny', 'write'].entries()) {
    const changed = once(commands[i].stdout!, 'data');
    commands[i].stdin!.write(text);
    await changed;
  }
  let disk;
  do {
    disk = await shares.measure(owners, budget);
    if (!disk.get(owners[0].uid)!.accountingError) await sleep(10, undefined, { signal: context.signal });
  } while (!disk.get(owners[0].uid)!.accountingError);
  assert.equal(disk.size, 2);
  assert.equal(disk.get(owners[0].uid)!.used, null);
  assert.match(disk.get(owners[0].uid)!.accountingError!.message, rootWorker ? /EACCES/ : /scanner exited/);
  const healthy = disk.get(owners[1].uid)!;
  assert.ok(healthy.used! >= 131072);
  assert.equal(healthy.warned, true);
  assert.equal(healthy.grew, true);
  const now = await snapshots();
  const uses = tally(now, before, 1000);
  const failed = overShare(uses, cli, { ...limits, disk }).block!;
  assert.equal(failed.uid, owners[0].uid);
  assert.equal(failed.used, null);
  assert.ok(failed.accountingError);
  const reloader = new Reload();
  const closed = once(commands[0], 'close');
  await reloader.block(rootWorker ? owners[0] : { ...owners[0], ...ids }, failed, now, {
    ask,
    checking: new Map(),
    stopped: () => {},
  });
  assert.equal((await closed)[1], 'SIGKILL');
  assert.equal(commands[1].signalCode, null);
  const receipt = h.db.prepare('select used, report, count from blocks where job = ?').get(jobs[0].id) as any;
  assert.equal(receipt.used, null, 'unknown usage survives storage');
  assert.equal(receipt.count, rootWorker ? 1 : 0, 'only a denial inside the slot tree adds a strike');
  assert.equal(failed.accountingError!.reason, rootWorker ? 'job-tree' : 'worker-scanner');
  assert.match(receipt.report, /Disk accounting is unavailable/);
  assert.doesNotMatch(receipt.report, /this job used/);
  const wroteAgain = once(commands[1].stdout!, 'data');
  commands[1].stdin!.write('write');
  await wroteAgain;
  const later = await snapshots();
  const continuedUses = tally(later, now, 1000);
  continuedUses.delete(owners[0].uid);
  disk = await shares.measure(owners, budget);
  const continued = overShare(continuedUses, cli, { ...limits, disk }).block!;
  assert.equal(continued.uid, owners[1].uid);
  assert.equal(continued.accountingError, undefined);
  const writerClosed = once(commands[1], 'close');
  await reloader.block(owners[1], continued, now, { ask, checking: new Map(), stopped: () => {} });
  assert.equal((await writerClosed)[1], 'SIGKILL');
  const writerReceipt = h.db.prepare('select count from blocks where job = ?').get(jobs[1].id) as any;
  assert.equal(writerReceipt.count, 1, 'the other job still receives its measured overuse strike');
});

test('a tree beyond the scanner bound reaches the three-strike stop through production accounting', async context => {
  const work = temporary(context);
  const job = await h.start({ agent: 'bolt' });
  const other = await h.start({ agent: 'rook' });
  const owners = [
    { job: job.id, ...ids },
    { job: other.id, uid: ids.uid + 1, gid: ids.gid },
  ];
  // Paths over 3,584 characters cost more than eight 1 KiB entries each, so fewer files exhaust the same budget.
  const root = join(work, 'jobs', String(job.id), ...Array(15).fill('d'.repeat(240)));
  mkdirSync(root, { recursive: true });
  for (let i = 0; i <= Math.ceil(TREE_ENTRY_LIMIT / 8); i++) closeSync(openSync(join(root, String(i)), 'w'));
  const shares = new DiskShares(work);
  context.after(() => shares.close());
  const ask = async (body: Record<string, unknown>) => {
    const reply = await h.worker('blocked', body);
    assert.equal(reply.status, 200);
    assert.deepEqual((await h.worker('blocked', body)).body, reply.body, 'a lost reply adds no strike');
    return reply.body;
  };
  for (const count of [1, 2, 3]) {
    const disk = await shares.measure([owners[0]], { freeBytes: 2 ** 30, reserveBytes: 0 });
    const use = disk.get(ids.uid)!;
    assert.equal(use.used, null);
    assert.equal(use.accountingError?.reason, 'job-tree');
    const command = spawn('sleep', ['300']);
    context.after(() => command.kill('SIGKILL'));
    await once(command, 'spawn');
    const procs = (await processesFor([ids])).filter(p => p.pid === command.pid);
    const block = overShare(tally(procs, procs, 1000), new Set(), { ...limits, disk }).block!;
    assert.equal(block.root.pid, command.pid);
    assert.equal(block.used, null);
    assert.equal(block.accountingError?.reason, 'job-tree');
    const closed = once(command, 'close');
    await new Reload().block(owners[0], block, procs, { ask, checking: new Map(), stopped: () => {} });
    assert.equal((await closed)[1], 'SIGKILL');
    const receipt = h.db.prepare('select used, count from blocks where job = ? order by id desc').get(job.id) as any;
    assert.equal(receipt.used, null);
    assert.equal(receipt.count, count);
    if (count < 3) assert.equal((await h.heartbeat(job)).body.stop, undefined);
  }
  assert.match((await h.heartbeat(job)).body.stop!, /blocked 3 times/);
  assert.equal((await h.heartbeat(other)).body.stop, undefined);
});
