// node --test src/roomrecords.test.ts
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { splitPlatform } from './fixture.ts';
import { roomRecords, workerSource } from '../../worker/src/roomrecords.ts';
import { memoryFixture } from '../../worker/src/memory.fixture.ts';

const h = await harness('roomrecords', {
  before: repo => {
    splitPlatform(repo);
  },
});
const memory = await import('./lowmemory.ts');
const { reportRoom } = await import('./room.ts');

test('Process reads current reports with explicit missing measurements and decision joins', async () => {
  const reader = await h.start({ agent: 'bolt' });
  const at = Date.now();
  const capacity = reportLowRoom(reader.id, at);
  const first = (await h.agent('room/records', reader.token)).body;
  assert.deepEqual(first.room.capacity, { at, reading: capacity });
  assert.equal(first.room.report.at, at);
  assert.equal(first.room.reportStale, false);
  assert.equal(first.room.capacityStale, false);
  assert.deepEqual(first.notices.latest, { at, low: true, freeMb: 1000, reasons: ['CPU pressure'] });
  assert.equal(first.notices.stale, false);
  assert.equal(first.missing.sharedMeasurement, null);
  assert.equal(first.joins.measurementToDecision, null);
  const spell = first.rows.at(-1);
  assert.deepEqual(
    [spell.began, spell.ended, spell.free_mb, spell.cause, spell.took_mb, spell.cause_free_mb],
    [new Date(at).toISOString(), null, 1000, reader.id, 3000, 5000],
  );
  memory.report({ verdict: 'calm', reasons: [] }, 4000, at + 1);
});

test('inspection leaves pressure notices and their all-clears available to the notice hook', async () => {
  const reader = await h.start({ agent: 'bolt' });
  const at = Date.now();
  reportLowRoom(reader.id, at);
  const read = async () => (await h.agent('room/records', reader.token)).body;
  const first = await read();
  const spell = first.rows.at(-1);
  assert.deepEqual((await read()).rows, first.rows);
  const deliveries = (await h.agent('room/records?population=deliveries', reader.token)).body.rows;
  assert.equal(
    deliveries.some((row: any) => row.spell === spell.id),
    false,
  );
  assert.ok(memory.take(reader.id, false, at).length, 'inspection left the first notice available');
  const delivered = await h.hq(reader, 'room', 'deliveries');
  assert.equal(delivered.code, 0, delivered.out);
  const delivery = JSON.parse(delivered.out).rows.find((row: any) => row.spell === spell.id);
  assert.deepEqual([delivery.spell, delivery.job, delivery.back, delivery.spell_found], [spell.id, reader.id, 0, 1]);
  memory.report({ verdict: 'calm', reasons: [] }, 4000, at + 1);
  assert.equal((await read()).rows.at(-1).ended, new Date(at + 1).toISOString());
  const cleared = (await h.agent('room/records?population=deliveries', reader.token)).body.rows;
  assert.equal(cleared.find((row: any) => row.spell === spell.id).back, 0);
  assert.ok(memory.take(reader.id, false, at + 1).length, 'inspection left the all-clear available');
});

test('the route exposes stale reports and their retained values', async () => {
  const reader = await h.start({ agent: 'bolt' });
  const at = Date.now() - 5 * 60_000;
  const capacity = reportLowRoom(reader.id, at);
  const stale = (await h.agent('room/records', reader.token)).body;
  assert.equal(stale.room.reportStale, true);
  assert.equal(stale.room.capacityStale, true);
  assert.deepEqual(stale.room.capacity, { at, reading: capacity });
  assert.equal(stale.room.report.at, at);
  assert.equal(stale.notices.stale, true);
  assert.equal(stale.notices.latest.at, at);
  memory.report({ verdict: 'calm', reasons: [] }, 4000);
});

test('hq room runs exposes recorded starts and labels reconstructed history', async () => {
  const reader = await h.start({ agent: 'bolt' });
  const at = Date.now();
  const cli = await h.hq(reader, 'room', 'runs');
  assert.equal(cli.code, 0, cli.out);
  assert.equal(JSON.parse(cli.out).population, 'runs');
  const run = JSON.parse(cli.out).rows.find((row: any) => row.job === reader.id);
  assert.ok(run.started);
  assert.equal(run.ended, null);
  assert.equal(run.provenance, 'recorded run start');
  const reconstructed = h.pastJob({
    runs: [
      { started: at - 5000, ended: at - 4000, seat: null },
      { started: at - 3000, ended: at - 2000, outcome: 'rebuilt' },
    ],
  });
  const history = (await h.agent('room/records?population=runs', reader.token)).body.rows;
  assert.deepEqual(
    history.filter((row: any) => row.job === reconstructed).map((row: any) => row.provenance),
    ['reconstructed', 'reconstructed'],
  );
});

test('history pages reach every spell and delivery without changing either table', async () => {
  const reader = await h.start({ agent: 'bolt' });
  for (let i = 0; i < 102; i++) {
    const at = Date.now() + i * 2;
    memory.report({ verdict: 'low', reasons: ['room'] }, 100, at);
    memory.take(reader.id, false, at);
    memory.report({ verdict: 'calm', reasons: [] }, 4000, at + 1);
  }
  const stored = () => ({
    spells: h.db.prepare('select * from memory_spells order by id').all(),
    deliveries: h.db.prepare('select spell, job, back from memory_told order by spell, job').all(),
  });
  const before = stored();
  for (const population of ['spells', 'deliveries']) {
    let after: string | null = population === 'spells' ? '0' : '0.0';
    const rows: any[] = [];
    let pages = 0;
    while (after !== null) {
      const reply = await h.agent(`room/records?population=${population}&after=${after}`, reader.token);
      assert.equal(reply.status, 200);
      rows.push(...reply.body.rows);
      after = reply.body.next;
      pages++;
    }
    assert.ok(pages > 1);
    const expected = population === 'spells' ? before.spells : before.deliveries;
    assert.equal(rows.length, expected.length);
    assert.equal(
      new Set(rows.map(row => (population === 'spells' ? row.id : `${row.spell}.${row.job}`))).size,
      rows.length,
    );
  }
  assert.deepEqual(stored(), before);
});

test('the CLI preserves route refusals for unknown histories and invalid cursors', async () => {
  const reader = await h.start({ agent: 'bolt' });
  for (const [population, after] of [
    ['unknown', '0'],
    ['deliveries', '1'],
  ]) {
    const route = await h.agent(`room/records?${new URLSearchParams({ population, after })}`, reader.token);
    const cli = await h.hq(reader, 'room', population, '--after', after);
    assert.equal(route.status, 400);
    assert.notEqual(cli.code, 0);
    assert.ok(cli.out.includes(route.body.error), cli.out);
  }
});

test('only authenticated Process jobs read the fixed populations', async () => {
  const reader = await h.start({ agent: 'bolt' });
  const other = await h.start({ agent: 'chime' });
  assert.equal((await h.agent('room/records', other.token)).status, 403);
  assert.equal((await h.agent('room/records', 'invalid')).status, 401);
  const call = (await h.voice('call-context?agent=bolt')).body;
  assert.equal((await h.agent('room/records', call.token)).status, 403);
  assert.equal((await h.board('/api/agent/room/records')).status, 401);
  for (const query of [
    'population=jobs',
    'after=-1',
    'after=1.2',
    'after=9007199254740992',
    'population=deliveries&after=1',
  ]) {
    assert.equal((await h.agent(`room/records?${query}`, reader.token)).status, 400, query);
  }
  assert.equal((await h.agent('room/records', reader.token, {})).status, 404);
  assert.notEqual((await h.hq(other, 'room')).code, 0);
  assert.notEqual((await h.hq(reader, 'room', '--after')).code, 0);
});

test('Process inspection keeps two independent source records, original receipts and session gaps', async t => {
  const reader = await h.start({ agent: 'bolt' });
  const other = await h.start({ agent: 'chime' });
  const { memory, reading, write, pressure: measurePressure } = memoryFixture(t);
  const records = roomRecords();
  reading(8e9, 7.28e9, 5.45e9, 9.7e9);
  const allowed = memory.inspect(() => memory.room());
  records.decision({
    action: 'select claim',
    outcome: 'claim selected',
    slot: 'ordinary',
    claim: { seat: 'codex', engine: 'codex', kind: null, room: null },
    job: null,
    inputs: allowed.inputs,
  });
  const pressure = measurePressure({ freeMb: 5000, room: true, uses: new Map() });
  records.room({ report: { short: false }, pressure, inputs: allowed.inputs });
  const at = Date.now() - 4 * 60_000;
  const first = records.latest();
  reportRoom({ records: first }, at);
  const read = async () => (await h.agent('room/records', reader.token)).body;
  const response = await read();
  const inspected = response.retained;
  assert.deepEqual(response.joins.measurementToDecision, {
    decision: inspected.decision.record.identity,
    measurements: allowed.inputs.map(input => input.measurement.identity),
  });
  assert.equal(inspected.room.receivedAt, at);
  assert.equal(inspected.room.receiptStale, true);
  assert.equal(inspected.room.measurementStale, true);
  assert.equal(inspected.decision.record.inputs[0].measurement.raw.active_file, null);
  assert.equal(inspected.decision.record.inputs[0].value, true);
  assert.equal(inspected.decision.previousSession, false);
  assert.equal((await h.agent('room/records', other.token)).status, 403);
  reportRoom({ records: first });
  assert.equal((await read()).retained.decision.receivedAt, at, 'resending an identity does not freshen it');
  write('memory.pressure', 'some avg10=12.50 avg60=4.00 avg300=1.00 total=100');
  const blocked = memory.inspect(() => memory.room());
  records.room({ report: { short: true }, pressure, inputs: blocked.inputs });
  reportRoom({ records: records.latest() });
  const later = (await read()).retained;
  assert.notDeepEqual(later.room.record.identity, inspected.room.record.identity);
  assert.equal(later.room.record.inputs[0].value, false);
  assert.deepEqual(later.decision, inspected.decision);
  const restarted = { ...workerSource, session: randomUUID() };
  const replacement = structuredClone(records.latest().room!);
  replacement.identity = { ...restarted, sequence: 1 };
  replacement.sourceAt = Date.now() - 4 * 60_000;
  reportRoom({ records: { source: restarted, room: replacement, decision: null } });
  replacement.report.short = false;
  const previous = (await read()).retained;
  assert.equal(previous.room.record.report.short, true);
  assert.equal(previous.room.previousSession, false);
  assert.equal(previous.room.sourceStale, true);
  assert.equal(previous.room.receiptStale, false);
  assert.equal(previous.decision.previousSession, true);
  assert.deepEqual(previous.decision.record, inspected.decision.record);
});

function reportLowRoom(job: number, at = Date.now()) {
  const capacity = {
    slots: { codex: 4 },
    seatRuns: {},
    room: 0,
    memory: {
      at: at - 500,
      availableMb: 1000,
      freeReserveMb: 1500,
      defaultRunMb: 700,
      totalSlots: 4,
      heldSlots: 1,
      heldMb: 400,
      starting: [{ until: at + 60_000, mb: 700 }],
      runningMb: {},
    },
  };
  reportRoom(
    {
      free: 1000,
      short: true,
      capacity,
      memory: {
        verdict: 'low',
        reasons: ['CPU pressure'],
        cause: { job: job, tookMb: 3000, freeMb: 5000 },
      },
    },
    at,
  );
  return capacity;
}
