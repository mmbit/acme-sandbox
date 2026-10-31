// Disposable process scenarios for the bounded inspection's durable handoff checks.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { roomRecords, workerSource } from '../../worker/src/roomrecords.ts';
import { reportRoom } from './room.ts';
import { cacheReports } from './noticeinterval.fixture.ts';
import { publishPressure } from './pressureinspection.fixture.ts';
import * as inspection from './inspection.ts';
import { db } from './db.ts';
import { execFileSync } from 'node:child_process';

const scenario = process.argv[2];
const idFile = `${process.env.DATA_DIR}/attempt.txt`;
if (scenario !== 'operator-read') inspection.startInspection();
if (scenario === 'read' || scenario === 'operator-read') {
  console.log(JSON.stringify(inspection.readInspection(readFileSync(idFile, 'utf8'))));
} else if (scenario === 'replacement') {
  const id = begin();
  const reports = cacheReports({ after: () => {} });
  reports.send();
  reports.send();
  assert.ok(inspection.readInspection(id)!.notice);
  // A forced exit skips exit handlers. The next process must interrupt, never resume.
  process.kill(process.pid, 'SIGKILL');
} else if (scenario === 'exit-error') {
  begin();
  process.exit(7);
} else {
  runScenario(scenario);
}

function begin() {
  const records = roomRecords();
  reportRoom({ records: records.latest() });
  const now = Date.now();
  const answer = inspection.armInspection(
    {
      authority: 'synthetic authority',
      armedAt: now,
      closesAt: now + 1200_000,
      verifiedAt: now,
      coordinator: inspection.inspectionBinding().coordinator,
      worker: workerSource,
      workerDigest: 'b'.repeat(64),
    },
    'synthetic owner',
  );
  assert.equal(typeof answer, 'object');
  if (typeof answer === 'string') throw new Error(answer);
  writeFileSync(idFile, answer.arm.id);
  return answer.arm.id;
}

function runScenario(mode: string) {
  if (['expiry', 'expiry-notice', 'late-expiry', 'late-read-expiry', 'stale-first'].includes(mode))
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const id = begin();
  const reports = cacheReports({ after: () => {} });
  if (mode === 'expiry' || mode === 'expiry-notice') {
    checkExpiry(id, reports, mode === 'expiry-notice');
  } else if (mode === 'late-read-expiry') {
    mock.timers.setTime(inspection.readInspection(id)!.arm.closesAt + 1);
    assert.equal(inspection.readInspection(id)!.terminal!.kind, 'expired');
  } else if (mode === 'late-expiry') {
    mock.timers.setTime(inspection.readInspection(id)!.arm.closesAt + 1);
    reportRoom({ records: { source: { ...workerSource, session: randomUUID() }, room: null, decision: null } });
    assert.equal(inspection.readInspection(id)!.terminal!.kind, 'expired');
  } else if (mode === 'exit-pressure' || mode === 'pressure-first') {
    publishPressure({ after: () => {} });
    assert.ok(inspection.readInspection(id)!.pressure);
    if (mode === 'pressure-first') {
      reports.send();
      reports.send();
      assert.equal(inspection.readInspection(id)!.terminal!.kind, 'complete');
    }
  } else if (mode === 'operator-import') {
    checkOperatorImport(id, reports);
  } else if (mode === 'complete' || mode === 'exit-notice' || mode === 'worker-change') {
    checkNoticeClose(id, reports, mode);
  } else if (mode === 'stale-first') {
    reports.send();
    reports.fixture.advance(181_000);
    mock.timers.tick(181_000);
    reports.send();
    assert.equal(inspection.readInspection(id)!.notice, null);
  } else if (mode === 'late') {
    const late = reports.next();
    late.records.room!.sourceAt -= 181_000;
    reportRoom(late);
    reportRoom(late);
    reports.send();
    assert.equal(inspection.readInspection(id)!.notice, null, 'late transport and duplicates cannot add endpoints');
  } else if (mode === 'write-failure') {
    reports.send();
    db.exec('pragma query_only = on');
    try {
      assert.throws(() => reports.send());
      assert.equal(inspection.readInspection(id)!.notice, null);
    } finally {
      db.exec('pragma query_only = off');
    }
  } else assert.equal(mode, 'exit-empty');
}

function checkOperatorImport(id: string, reports: ReturnType<typeof cacheReports>) {
  reports.send();
  reports.send();
  const pending = inspection.readInspection(id)!;
  assert.ok(pending.notice);
  assert.equal(pending.terminal, null);
  const path = new URL('./inspection.fixture.ts', import.meta.url).pathname;
  const imported = execFileSync(process.execPath, [path, 'operator-read'], { encoding: 'utf8' });
  assert.equal(JSON.parse(imported).terminal, null);
  assert.equal(
    inspection.readInspection(id)!.terminal,
    null,
    'an operator import and exit cannot end the coordinator attempt',
  );
}

function checkExpiry(id: string, reports: ReturnType<typeof cacheReports>, withNotice: boolean) {
  if (withNotice) {
    reports.send();
    reports.send();
    assert.ok(inspection.readInspection(id)!.notice);
  }
  mock.timers.tick(1200_000);
  const terminal = inspection.readInspection(id)!.terminal;
  assert.equal(terminal!.kind, 'expired');
  reports.send();
  assert.deepEqual(inspection.readInspection(id)!.terminal, terminal);
  assert.equal(Boolean(inspection.readInspection(id)!.notice), withNotice);
}

function checkNoticeClose(id: string, reports: ReturnType<typeof cacheReports>, mode: string) {
  reports.send();
  reports.send();
  assert.ok(inspection.readInspection(id)!.notice);
  if (mode === 'complete') {
    publishPressure({ after: () => {} });
    assert.equal(inspection.readInspection(id)!.terminal!.kind, 'complete');
  }
  if (mode === 'worker-change') {
    reportRoom({ records: { source: { ...workerSource, session: randomUUID() }, room: null, decision: null } });
    assert.equal(inspection.readInspection(id)!.terminal!.kind, 'interrupted');
  }
}
