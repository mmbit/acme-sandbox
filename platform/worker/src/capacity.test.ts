// node --test platform/worker/src/capacity.test.ts
// Capacity rows keep job identity, memory measures and private content separate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capacityCapture, capacitySample } from './capacity.ts';
import { memoryFixture } from './memory.fixture.ts';
import { memoryMeter, QUIET_MS } from './memory.ts';
import { procStat } from './detached.ts';
import type { JobUse, ProcessSnapshot } from './shares.ts';

const occupant = {
  job: 42,
  slot: 'slot2',
  uid: 1502,
  seat: 'codex-1',
  engine: 'codex',
  kind: 'work',
  cliPid: process.pid,
};
const look = {
  at: Date.now(),
  intervalMs: 15_010,
  occupants: [occupant],
  uses: new Map<number, JobUse>(),
  seats: [
    {
      id: 'codex-1',
      engine: 'codex',
      occupiedOrHeld: 2,
      limit: 2,
      state: 'ready' as const,
      windowUsed: 0.5,
      eligible: false,
    },
  ],
  starting: 1,
  held: 0,
  reservationMb: 700,
  host: { availableBytes: 1024, swapInPages: 0, swapOutPages: 0 },
};

test('a claimed job with no readable processes stays present with unknown memory', () => {
  const sample = capacitySample(look, readKernel, memoryMeter(readKernel));
  assert.equal(sample.jobs.length, 1);
  assert.equal(sample.jobs[0].accountedMb, null);
  assert.equal(sample.jobs[0].rssMb, null);
  assert.equal(sample.jobs[0].cliPresent, false);
});

test('partial PSS and summed RSS stay distinct, and metadata cannot bring customer content into the diagnostic', () => {
  const proc = {
    ...procStat(process.pid)!,
    pid: process.pid,
    uid: 1502,
    memoryMb: 10,
    rssMb: 20,
    memoryMeasure: 'pss' as const,
  };
  const fallback: ProcessSnapshot = { ...proc, pid: process.pid + 1, memoryMb: 30, rssMb: 30, memoryMeasure: 'rss' };
  const uses = new Map([[1502, { uid: 1502, memoryMb: 40, cores: 0.2, processes: [proc, fallback] }]]);
  const privateOccupant = { ...occupant, prompt: 'private-content' };
  const sample = capacitySample({ ...look, uses, occupants: [privateOccupant] }, readKernel, memoryMeter(readKernel));
  assert.equal(sample.jobs[0].pssMb, 10);
  assert.equal(sample.jobs[0].pssProcesses, 1);
  assert.equal(sample.jobs[0].processes, 2);
  assert.equal(sample.jobs[0].rssMb, 50);
  assert.equal(sample.jobs[0].accountedMb, 40);
  assert.equal(sample.jobs[0].largest?.measure, 'rss');
  assert.equal(sample.jobs[0].cliPresent, true);
  assert.equal(JSON.stringify(sample).includes('private-content'), false);
});

const readKernel = (name: string) => readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim();

test('a missing or malformed required kernel measurement prevents a capacity sample', () => {
  for (const field of ['memory.current', 'memory.swap.current']) {
    for (const invalid of ['', 'not-a-number']) {
      const read = (name: string) => (name === field ? invalid : readKernel(name));
      assert.throws(() => capacitySample(look, read, memoryMeter(read)));
    }
  }
  const read = (name: string) => (name === 'memory.stat' ? 'anon 1024' : readKernel(name));
  assert.throws(() => capacitySample(look, read, memoryMeter(read)));
});

test('capacity reports the same reclaim-aware availability that admission uses', t => {
  const { reading, memory, read, measure } = memoryFixture(t);
  reading(8e9, 7.28e9, 5.45e9, 9.7e9);
  const measured = capacitySample({ ...look, host: { ...look.host, availableBytes: 9.7e9 } }, read, measure);
  assert.equal(measured.availableBytes / 2 ** 20, memory.availableMb());
  assert.equal(measured.heldBytes, 1.83e9);
  assert.equal(measured.reclaimableFileBytes, 5.45e9);
});

test('pressure first read by capacity also holds admission until the shared quiet window ends', t => {
  const { reading, memory, read, measure, write, advance } = memoryFixture(t);
  reading(8e9, 7.28e9, 5.45e9, 9.7e9);
  const sample = () => capacitySample({ ...look, host: { ...look.host, availableBytes: 9.7e9 } }, read, measure);
  assert.equal(sample().underPressure, false);
  assert.equal(memory.room(), true);
  write('memory.events', 'oom 3\noom_kill 1');
  assert.equal(sample().underPressure, true);
  assert.equal(memory.room(), false);
  assert.equal(memory.claimMb(), 0);
  assert.equal(sample().underPressure, true);
  advance(QUIET_MS);
  assert.equal(memory.room(), true);
  assert.equal(sample().underPressure, false);
});

test('a bounded trial writes readable samples and its completion log beside them', t => {
  const parent = mkdtempSync(join(tmpdir(), 'capacity-test-'));
  t.after(() => rmSync(parent, { recursive: true }));
  const trial = capacityCapture(2, () => {}, parent);
  trial.record(() => capacitySample(look));
  trial.record(() => capacitySample(look));
  trial.record(() => {
    throw new Error('A finished trial must not sample again');
  });
  const rows = readFileSync(join(parent, 'samples.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.equal(statSync(parent).mode & 0o777, 0o755);
  assert.equal(rows[0].jobs[0].job, occupant.job);
  assert.equal(rows[1].jobs[0].accountedMb, null);
  assert.equal(statSync(join(parent, 'samples.jsonl')).mode & 0o777, 0o644);
  assert.equal(statSync(join(parent, 'capture.log')).mode & 0o777, 0o644);
  assert.match(readFileSync(join(parent, 'capture.log'), 'utf8'), /2\/2 samples/);
});

test('an ordinary worker creates no capture file and takes no diagnostic sample', t => {
  const parent = mkdtempSync(join(tmpdir(), 'capacity-test-'));
  t.after(() => rmSync(parent, { recursive: true }));
  const trial = capacityCapture(
    0,
    () => {
      throw new Error('An inactive trial must not log');
    },
    parent,
  );
  trial.record(() => {
    throw new Error('An inactive trial must not sample');
  });
  assert.deepEqual(readdirSync(parent), []);
});

test('a required read failure reaches the watcher and consumes a bounded trial attempt', t => {
  const parent = mkdtempSync(join(tmpdir(), 'capacity-test-'));
  t.after(() => rmSync(parent, { recursive: true }));
  const trial = capacityCapture(1, () => {}, parent);
  const failure = new Error('Required kernel read failed');
  assert.throws(
    () =>
      trial.record(() =>
        capacitySample(look, () => {
          throw failure;
        }),
      ),
    error => error === failure,
  );
  trial.record(() => {
    throw new Error('A failed trial must not continue sampling');
  });
  assert.equal(readFileSync(join(parent, 'samples.jsonl'), 'utf8'), '');
  const journal = readFileSync(join(parent, 'capture.log'), 'utf8');
  assert.match(journal, /Required kernel read failed/);
  assert.match(journal, /0\/1 samples/);
});

test('a reload preserves earlier rows and records the interrupted capture', t => {
  const parent = mkdtempSync(join(tmpdir(), 'capacity-test-'));
  t.after(() => rmSync(parent, { recursive: true }));
  const first = capacityCapture(2, () => {}, parent);
  first.record(() => capacitySample(look));
  first.note('Job #42: stopped its process');
  first.end('worker reloading');
  first.record(() => {
    throw new Error('An interrupted capture must not sample');
  });
  const next = capacityCapture(1, () => {}, parent);
  next.record(() => capacitySample(look));
  const rows = readFileSync(join(parent, 'samples.jsonl'), 'utf8').trim().split('\n');
  assert.equal(rows.length, 2);
  const journal = readFileSync(join(parent, 'capture.log'), 'utf8');
  assert.match(journal, /Job #42: stopped its process/);
  assert.match(journal, /worker reloading/);
  assert.match(journal, /1\/2 samples/);
  assert.match(journal, /1\/1 samples/);
  const off = capacityCapture(0, () => {}, parent);
  off.record(() => {
    throw new Error('The switched-off worker must not capture again');
  });
  off.note('Must not append after switch-off');
  assert.equal(readFileSync(join(parent, 'capture.log'), 'utf8'), journal);
  assert.equal(readFileSync(join(parent, 'samples.jsonl'), 'utf8').trim().split('\n').length, 2);
});
