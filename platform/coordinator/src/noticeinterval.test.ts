// node --test src/noticeinterval.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness } from './harness.ts';
import { workerSource, recordIdentity, type WorkerRecords } from '../../worker/src/roomrecords.ts';

const h = await harness('noticeinterval');
const { cacheReports } = await import('./noticeinterval.fixture.ts');
const { reportRoom } = await import('./room.ts');
const memoryNotices = await import('./lowmemory.ts');

const readInterval = async (token: string) => (await h.agent('room/records', token)).body.noticeInterval;

// The existing Process route is the consumer, with real metered files and the actual notice hook.
test('two causal reports retain original endpoints and counts without freshening on inspection or replay', async t => {
  const reader = await h.start({ agent: 'bolt' });
  const reports = cacheReports(t);
  memoryNotices.report({ verdict: 'calm', reasons: [] }, 6000);
  const firstReport = reports.send();
  const first = await readInterval(reader.token);
  assert.equal(first.active.observedReportCount, 1);
  const secondReport = reports.send();
  const second = await readInterval(reader.token);
  assert.equal(second.completed.observedReportCount, 2);
  assert.deepEqual(second.completed.first.worker.identity, firstReport.records.room!.identity);
  assert.deepEqual(second.completed.last.worker.identity, secondReport.records.room!.identity);
  assert.deepEqual(second.completed.first.worker.pressure, firstReport.memory);
  assert.deepEqual(second.completed.coordinator, { pid: process.pid, startedAt: performance.timeOrigin });
  assert.equal(second.completed.previousSession, false);
  const again = await readInterval(reader.token);
  assert.equal(again.completed.first.receivedAt, second.completed.first.receivedAt);
  assert.ok(again.completed.ages.first.receiptMs >= second.completed.ages.first.receiptMs);
  const thirdReport = reports.send();
  const third = await readInterval(reader.token);
  assert.equal(third.completed.observedReportCount, 3);
  assert.deepEqual(third.completed.first, second.completed.first);
  thirdReport.records.room!.pressure.inputs.cpuBusy = true;
  assert.deepEqual((await readInterval(reader.token)).completed.last, third.completed.last);
  reportRoom(secondReport);
  const replay = await readInterval(reader.token);
  assert.equal(replay.active, null);
  assert.deepEqual(replay.completed.first, third.completed.first);
  assert.deepEqual(replay.completed.last, third.completed.last);
  reports.send();
  const restarted = await readInterval(reader.token);
  assert.equal(restarted.active.observedReportCount, 1);
  assert.deepEqual(restarted.completed.last, third.completed.last);
  const recycledInputs = structuredClone(secondReport);
  recycledInputs.records.room!.identity = recordIdentity();
  recycledInputs.records.room!.sourceAt = Date.now();
  reportRoom(recycledInputs);
  assert.equal((await readInterval(reader.token)).active, null);
});

test('every nonqualifying or unanchored processed report breaks the active interval and preserves its bounded witness', async t => {
  const reader = await h.start({ agent: 'bolt' });
  const reports = cacheReports(t);
  const breakers: ((report: ReturnType<typeof reports.next>) => void)[] = [
    report => {
      report.memory.verdict = 'between';
    },
    report => {
      report.memory.reasons.push('arbitrary reason');
    },
    report => {
      report.memory.inputs.cpuBusy = true;
    },
    report => {
      report.memory.inputs.room = false;
    },
    report => {
      report.records.room!.inputs[0].measurement.raw.active_file = null;
    },
    report => {
      report.records.room!.inputs[0].measurement.raw.file_dirty = 5.45e9;
    },
    report => {
      report.records.room!.sourceAt -= 4 * 60_000;
    },
    report => {
      report.records.room!.inputs[0].measurement.readEndedAt -= 4 * 60_000;
    },
    report => {
      report.records.room!.identity.session = randomUUID();
    },
    report => {
      report.records.room = null;
    },
    report => {
      delete (report as { records?: WorkerRecords }).records;
    },
    report => {
      delete (report as { memory?: unknown }).memory;
    },
  ];
  for (const breakReport of breakers) {
    reports.send();
    reports.send();
    const before = await readInterval(reader.token);
    assert.ok(before.completed.observedReportCount >= 2);
    const broken = reports.next();
    breakReport(broken);
    reportRoom(broken);
    const after = await readInterval(reader.token);
    assert.equal(after.active, null);
    assert.deepEqual(after.completed.first, before.completed.first);
    assert.deepEqual(after.completed.last, before.completed.last);
    assert.equal(after.completed.observedReportCount, before.completed.observedReportCount);
  }
});

test('dirty cache can qualify only with excluded dirty pages, actual reserves and a changed raw warning or room result', async t => {
  const reader = await h.start({ agent: 'bolt' });
  const reports = cacheReports(t);
  reports.fixture.write(
    'memory.stat',
    'file 5450000000\nactive_file 4000000000\nshmem 100000000\nfile_dirty 200000000\nfile_writeback 50000000\nunevictable 10000000\n',
  );
  reports.fixture.memory.holding.set('meeting', 'held seat');
  reports.fixture.memory.take();
  const dirty = reports.send();
  assert.equal((await readInterval(reader.token)).active.observedReportCount, 1);
  const input = dirty.memory.inputs.source!.room!;
  assert.equal(input.measurement.reclaimableFileBytes, 5.09e9);
  assert.equal(input.reserves.heldMb, 400);
  assert.equal(input.reserves.starting!.length, 1);
  reports.send();
  const completed = (await readInterval(reader.token)).completed;
  reports.fixture.reading(8e9, 2e9, 5e8, 9e9, 'active_file 400000000\n');
  reports.send();
  const rawAlreadyCalm = await readInterval(reader.token);
  assert.equal(rawAlreadyCalm.active, null);
  assert.deepEqual(rawAlreadyCalm.completed.first, completed.first);
  reports.fixture.reading(8e9, 7.28e9, 5.45e9, 9e9, 'active_file 4000000000\n');
  reports.fixture.write('memory.pressure', 'some avg10=10.00 avg60=0 avg300=0 total=100');
  reports.send();
  assert.equal((await readInterval(reader.token)).active, null);
  memoryNotices.report({ verdict: 'calm', reasons: [] }, 6000);
});

test('a delayed cause-only warning breaks calm observations while empty hooks and all-clears leave them intact', async t => {
  const reader = await h.start({ agent: 'bolt' });
  const cause = await h.start({ agent: 'juno' });
  const reports = cacheReports(t);
  memoryNotices.report({ verdict: 'low', reasons: [], cause: { job: cause.id, tookMb: 3000, freeMb: 5000 } }, 1000);
  assert.equal(memoryNotices.take(reader.id, false).length, 1);
  reports.send(); // Clears the spell and cannot start an interval.
  assert.equal((await readInterval(reader.token)).active, null);
  reports.send();
  reports.send();
  const before = await readInterval(reader.token);
  assert.equal(memoryNotices.take(reader.id, false).length, 1);
  assert.equal(memoryNotices.inspectMemory().notice!.kind, 'all-clear');
  assert.equal((await readInterval(reader.token)).active.observedReportCount, 2);
  assert.deepEqual(memoryNotices.take(reader.id, false), []);
  assert.deepEqual(memoryNotices.take(cause.id, true), []);
  assert.equal((await readInterval(reader.token)).active.observedReportCount, 2);
  assert.equal(memoryNotices.take(cause.id, false).length, 1);
  assert.equal(memoryNotices.inspectMemory().notice!.pressureLine, false);
  const after = await readInterval(reader.token);
  assert.equal(after.active, null);
  assert.deepEqual(after.completed.first, before.completed.first);
  assert.deepEqual(after.completed.last, before.completed.last);
  reports.send();
  assert.equal((await readInterval(reader.token)).active.observedReportCount, 1);
});

test('replacement ends the active interval, labels earlier evidence and rejects previous-session inputs', async t => {
  const reader = await h.start({ agent: 'bolt' });
  const reports = cacheReports(t);
  reports.send();
  reports.send();
  const completed = (await readInterval(reader.token)).completed;
  const replacement = { ...workerSource, pid: workerSource.pid + 1, startedAt: Date.now(), session: randomUUID() };
  reportRoom({ records: { source: replacement, room: null, decision: null } });
  const after = await readInterval(reader.token);
  assert.equal(after.active, null);
  assert.equal(after.completed.previousSession, true);
  assert.deepEqual(after.completed.first, completed.first);
  reports.send();
  assert.equal((await readInterval(reader.token)).active, null);
});
