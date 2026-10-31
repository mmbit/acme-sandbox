// node --test src/inspection.test.ts (throwaway DATA_DIR, real Process routes and process exits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { harness } from './harness.ts';

const h = await harness('inspection', {
  env: { GIT_COMMIT: 'inspection-revision' },
  before: repo => writeFileSync(`${repo}/company/infra.env`, 'MEMORY_INSPECTION_BUDGET_MS=1200000\n'),
});
const inspection = await import('./inspection.ts');
const { cacheReports } = await import('./noticeinterval.fixture.ts');
const notices = await import('./lowmemory.ts');
const { reportRoom } = await import('./room.ts');
const { workerSource } = await import('../../worker/src/roomrecords.ts');
const { publishPressure } = await import('./pressureinspection.fixture.ts');

function binding(now = Date.now()) {
  return {
    authority: 'synthetic released authority',
    armedAt: now,
    closesAt: now + 1200_000,
    verifiedAt: now,
    coordinator: inspection.inspectionBinding().coordinator,
    worker: workerSource,
    workerDigest: 'a'.repeat(64),
  };
}

test('an absent budget forbids arming and malformed company budgets fail loudly', () => {
  const path = `${h.repo}/company/infra.env`;
  try {
    writeFileSync(path, '');
    assert.equal(typeof inspection.armInspection(binding(), 'synthetic owner'), 'string');
    for (const budget of ['NaN', '-1', '1.5', '2147483648']) {
      writeFileSync(path, `MEMORY_INSPECTION_BUDGET_MS=${budget}\n`);
      assert.throws(() => inspection.armInspection(binding(), 'synthetic owner'));
    }
  } finally {
    writeFileSync(path, 'MEMORY_INSPECTION_BUDGET_MS=1200000\n');
  }
});

test('Process arms once with its company budget, preserves independent immutable receipts, and delayed review stays historical', async t => {
  const reader = await h.start({ agent: 'bolt' });
  const other = await h.start({ agent: 'spark' });
  const reports = cacheReports(t);
  reports.send();
  reports.send();
  assert.equal(inspection.readInspection('missing'), null, 'natural work never arms');
  const metadata = await h.hq(reader, 'room', 'binding');
  assert.equal(metadata.code, 0, metadata.out);
  assert.deepEqual(JSON.parse(metadata.out).worker, workerSource);
  assert.equal(JSON.parse(metadata.out).existingAttempt, null);
  assert.equal((await h.agent('room/inspection/binding', other.token)).status, 403);
  const arm = binding();
  assert.equal((await h.agent('room/inspection/arm', other.token, arm)).status, 403);
  assert.equal((await h.agent('room/inspection/arm', reader.token, { ...arm, coordinator: {} })).status, 400);
  assert.equal(
    (await h.agent('room/inspection/arm', reader.token, { ...arm, closesAt: arm.closesAt + 1 })).status,
    400,
  );
  const file = `${h.dataDir}/binding.json`;
  writeFileSync(file, JSON.stringify(arm));
  const armed = await h.hq(reader, 'room', 'arm', file);
  assert.equal(armed.code, 0, armed.out);
  const id = JSON.parse(armed.out).arm.id;
  assert.equal((await h.agent(`room/inspection?id=${id}`, other.token)).status, 403);
  notices.report({ verdict: 'low', reasons: [], cause: { job: other.id, tookMb: 3000, freeMb: 5000 } }, 1000);
  reports.send();
  reports.send();
  assert.equal(inspection.readInspection(id)!.notice, null, 'an old completed span cannot cross the arm boundary');
  assert.equal(notices.take(other.id, false).length, 1, 'the actual delayed cause-only warning breaks the interval');
  reports.send();
  assert.equal(inspection.readInspection(id)!.notice, null);
  notices.report({ verdict: 'low', reasons: ['CPU'] }, 1000);
  assert.equal(notices.take(reader.id, false).length, 1, 'a current warning also breaks the interval');
  reports.send();
  reports.send();
  assert.equal(inspection.readInspection(id)!.notice, null);
  reports.send();
  const notice = inspection.readInspection(id)!.notice!;
  assert.ok(notice);
  assert.equal((notice.inspection as any).observedReportCount, 2);
  assert.equal((notice.inspection as any).noActualWarnings, true);
  reports.send();
  assert.deepEqual(inspection.readInspection(id)!.notice!.inspection, notice.inspection, 'no hunt for better evidence');
  publishPressure(t);
  const read = await h.hq(reader, 'room', 'inspection', id);
  assert.equal(read.code, 0, read.out);
  const saved = JSON.parse(read.out);
  assert.ok(saved.pressure);
  assert.equal(saved.terminal.kind, 'complete');
  assert.deepEqual(saved.terminal.missing, []);
  assert.deepEqual(saved.pressure.adoption, saved.arm);
  const later = inspection.readInspection(id, Date.now() + 86400_000)!;
  assert.deepEqual(later.notice!.inspection, saved.notice.inspection);
  assert.equal(later.notice!.retrieval.historical, true);
  assert.equal(later.notice!.retrieval.currentSessionRoom, false);
  assert.ok((later.notice!.agesAtRetrieval as any).first.sourceMs > 180_000);
  assert.equal(later.notice!.agesAtInspection.first !== undefined, true);
  reportRoom({ records: { source: { ...workerSource, session: randomUUID() }, room: null, decision: null } });
  assert.deepEqual(inspection.readInspection(id)!.terminal, saved.terminal);
  assert.equal((await h.agent('room/inspection/arm', reader.token, binding())).status, 400);
});

test('normal exits preserve receipts and terminal gaps, expiry needs no later report, and replacement cannot resume', () => {
  const scenarios = {
    complete: { terminal: 'complete', notice: true, pressure: true },
    'pressure-first': { terminal: 'complete', notice: true, pressure: true },
    'exit-pressure': { terminal: 'interrupted', notice: false, pressure: true },
    'expiry-notice': { terminal: 'expired', notice: true, pressure: false },
    'late-expiry': { terminal: 'expired', notice: false, pressure: false },
    'late-read-expiry': { terminal: 'expired', notice: false, pressure: false },
    'exit-empty': { terminal: 'interrupted', notice: false, pressure: false },
    'exit-error': { terminal: 'interrupted', notice: false, pressure: false },
    'operator-import': { terminal: 'interrupted', notice: true, pressure: false },
    'exit-notice': { terminal: 'interrupted', notice: true, pressure: false },
    expiry: { terminal: 'expired', notice: false, pressure: false },
    'worker-change': { terminal: 'interrupted', notice: true, pressure: false },
    'stale-first': { terminal: 'interrupted', notice: false, pressure: false },
    late: { terminal: 'interrupted', notice: false, pressure: false },
    'write-failure': { terminal: 'interrupted', notice: false, pressure: false },
    replacement: { terminal: 'interrupted', notice: true, pressure: false },
  };
  for (const [scenario, expected] of Object.entries(scenarios)) {
    const directory = mkdtempSync(`${tmpdir()}/inspection-${scenario}-`);
    const path = new URL('./inspection.fixture.ts', import.meta.url).pathname;
    const run = (mode: string) =>
      execFileSync(process.execPath, [path, mode], {
        env: { ...process.env, DATA_DIR: directory },
        encoding: 'utf8',
      });
    if (scenario === 'replacement') {
      assert.throws(() => run(scenario), { signal: 'SIGKILL' });
    } else if (scenario === 'exit-error') {
      assert.throws(() => run(scenario), { status: 7 });
    } else run(scenario);
    const saved = JSON.parse(run('read'));
    assert.equal(saved.terminal.kind, expected.terminal, scenario);
    assert.equal(Boolean(saved.notice), expected.notice, scenario);
    assert.equal(saved.terminal.missing.includes('pressure'), !expected.pressure, scenario);
    assert.equal(Boolean(saved.pressure), expected.pressure, scenario);
    if (scenario === 'exit-empty') assert.deepEqual(saved.terminal.missing, ['notice', 'pressure']);
    if (scenario === 'exit-error') assert.match(saved.terminal.reason, /code 7/);
    assert.equal(saved.arm.workerDigest, 'b'.repeat(64));
    assert.equal(saved.notice?.retrieval.historical ?? true, true);
  }
});
