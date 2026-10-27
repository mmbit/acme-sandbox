// A disposable watcher pass with real command stops and a priority helper interrupted by shares.trace.py.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DiskShares } from './disk.ts';
import { procStat } from './detached.ts';
import { ids, limits, shareFixture, type Command } from './sharefixture.ts';
import type { DiskUse } from './disk.ts';
import type { JobUse } from './shares.ts';
import { sampleWrites } from './diskwrites.ts';

const [mode] = process.argv.slice(2);
const passLimits = { ...limits, mostMb: 2560, shareMb: 1536, cores: 4, processes: 400 };
if (mode === 'memory') await memorySurvivor();
else await deferredDisk();

async function memorySurvivor() {
  const fixture = shareFixture();
  const memory = fixture.track(spawn('sleep', ['300'], { detached: true }));
  const survivor = fixture.track(spawn('sleep', ['300'], { detached: true }));
  try {
    await Promise.all([once(memory.child, 'spawn'), once(survivor.child, 'spawn')]);
    // Measured overuse avoids allocating gigabytes or occupying five cores in the helper.
    const procs = (await fixture.snapshots()).map(p => ({
      ...p,
      memoryMb: p.pid === memory.child.pid ? 2700 : 20,
      nice: 0,
      group: undefined,
    }));
    const previous = procs.map(p => ({ ...p, ticks: p.ticks - (p.pid === memory.child.pid ? 300 : 500) }));
    await fixture.pass(procs, previous, { limits: passLimits });
    assert.deepEqual(
      fixture.receipts.map(r => [r.measure, r.used, r.share]),
      [
        ['memory', 2720, 2560],
        ['cores', 5, 4],
      ],
      'a dead memory command cannot hide the surviving live CPU use',
    );
    assert.equal(memory.stopped.length, 1);
    assert.equal(survivor.stopped.length, 1);
    assert.equal((await memory.ended)[1], 'SIGKILL');
    assert.equal((await survivor.ended)[1], 'SIGKILL');
  } finally {
    await fixture.close();
  }
}

async function deferredDisk() {
  const fixture = shareFixture();
  const work = mkdtempSync(join(tmpdir(), 'priority-pass-'));
  const root = join(work, 'jobs', '1');
  mkdirSync(root, { recursive: true });
  const cache = join(root, 'cache');
  const shares = new DiskShares(work);
  const cpu = fixture.track(spawn('sleep', ['300'], { detached: true }));
  const writer = fixture.track(spawnWriter(cache));
  try {
    await Promise.all([once(cpu.child, 'spawn'), once(writer.child.stdout, 'data')]);
    const previous = await sampleWrites(await fixture.snapshots(), [ids]);
    const owners = [{ job: 1, ...ids }];
    const budget = { freeBytes: 0, reserveBytes: 1024 * 1024 };
    await shares.measure(owners, budget);
    shares.warned(1);
    await write(writer.child);
    const procs = (await fixture.snapshots()).map(p => ({ ...p, memoryMb: 20, nice: 0, group: undefined }));
    const before = procs.map(p => ({
      ...previous.find(b => b.pid === p.pid)!,
      ticks: p.ticks - (p.pid === cpu.child.pid ? 500 : 0),
    }));
    const readings: Map<number, DiskUse>[] = [];
    const disk = async (uses: Map<number, JobUse>) => {
      const measuredWriter = uses.get(ids.uid)!.processes.find(p => p.pid === writer.child.pid)!;
      assert.ok(measuredWriter.writableFiles?.length, 'descriptor sampling continues after the CPU stop');
      assert.ok(measuredWriter.writtenCallBytes! > 0, 'write accounting continues after the CPU stop');
      const reading = await measuredDisk(shares, owners, budget, cache);
      readings.push(reading);
      return reading;
    };
    await fixture.pass(procs, before, { limits: passLimits, disk });
    assert.deepEqual(
      fixture.receipts.map(r => [r.measure, r.used, r.share]),
      [['cores', 5, 4]],
    );
    checkHeldDisk(readings);
    assert.equal(fixture.hotSince.has(ids.uid), false, 'the CPU stop resets its timer');
    assert.equal(cpu.stopped.length, 1);
    assert.equal((await cpu.ended)[1], 'SIGKILL');
    assert.equal(writer.stopped.length, 0);
    assert.equal(procStat(writer.child.pid!)?.start, procs.find(p => p.pid === writer.child.pid)!.start);
    await stopWriter(fixture, writer, disk);
    assert.equal(readings.length, 2, 'disk accounting runs in every pass');
  } finally {
    await fixture.close();
    shares.close();
    rmSync(work, { recursive: true, force: true });
  }
}

function spawnWriter(cache: string) {
  return spawn(
    process.execPath,
    [
      '-e',
      `
    const fs = require('fs');
    const fd = fs.openSync(process.argv[1], 'a');
    process.on('SIGUSR1', () => { fs.writeSync(fd, Buffer.alloc(65536)); console.log('wrote'); });
    console.log('ready');
    setInterval(() => {}, 1000);
  `,
      cache,
    ],
    { detached: true },
  );
}

async function write(child: ReturnType<typeof spawnWriter>) {
  const written = once(child.stdout, 'data');
  child.kill('SIGUSR1');
  await written;
}

async function measuredDisk(
  shares: DiskShares,
  owners: { job: number; uid: number; gid: number }[],
  budget: { freeBytes: number; reserveBytes: number },
  cache: string,
) {
  let reading = await shares.measure(owners, budget);
  const allocated = statSync(cache).blocks * 512;
  while (reading.get(ids.uid)!.used! < allocated) {
    await sleep(10);
    reading = await shares.measure(owners, budget);
  }
  return reading;
}

function checkHeldDisk(readings: Map<number, DiskUse>[]) {
  assert.equal(readings.length, 1, 'disk accounting runs in a pass with a priority stop');
  const use = readings[0].get(ids.uid)!;
  assert.equal(use.accountingError, undefined);
  assert.equal(use.warned, true);
  assert.ok(use.used! > use.share, 'the disk stop is eligible');
}

async function stopWriter(
  fixture: ReturnType<typeof shareFixture>,
  writer: Command,
  disk: (uses: Map<number, JobUse>) => Promise<Map<number, DiskUse>>,
) {
  const before = await sampleWrites(await fixture.snapshots(), [ids]);
  await write(writer.child);
  await fixture.pass(await fixture.snapshots(), before, { limits: passLimits, disk });
  assert.deepEqual(
    fixture.receipts.map(r => r.measure),
    ['cores', 'disk'],
    'the next eligible pass stops the writer',
  );
  const receipt = fixture.receipts.at(-1)!;
  assert.ok(Number(receipt.used) > Number(receipt.share));
  assert.equal(writer.stopped.length, 1);
  assert.equal((await writer.ended)[1], 'SIGKILL');
}
