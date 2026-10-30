// node --test platform/worker/src/roomrecords.test.ts
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { memoryFixture } from './memory.fixture.ts';
import { roomRecords, workerSource } from './roomrecords.ts';
import { FREE_MB, JOB_MB, SEAT_MB, STARTING_MS } from './reserve.ts';

test('latest records preserve their own reads and replace only their own kind', t => {
  const { memory, reading, write, advance, pressure: measurePressure } = memoryFixture(t);
  const records = roomRecords();
  assert.deepEqual(records.latest(), { source: workerSource, room: null, decision: null });
  reading(8e9, 7.28e9, 5.45e9, 9.7e9, 'active_file 4000000000\n');
  memory.take();
  memory.holding.set('meeting', 'seat');
  const selected = memory.inspect(() => memory.room());
  records.decision({
    action: 'select claim',
    outcome: selected.value ? 'claim selected' : 'no claim',
    slot: 'ordinary',
    claim: null,
    job: null,
    inputs: selected.inputs,
  });
  const decision = records.latest().decision!;
  const input = decision.inputs[0];
  assert.equal(input.value, true);
  assert.deepEqual(input.reserves, {
    starting: [{ until: STARTING_MS, mb: JOB_MB }],
    heldSlots: 1,
    heldMb: SEAT_MB,
    freeReserveMb: FREE_MB,
    defaultRunMb: JOB_MB,
  });
  assert.equal(input.measurement.raw.active_file, 4e9);
  assert.equal(input.measurement.raw.file, 5.45e9);
  assert.equal(input.measurement.heldBytes, 1.83e9);
  assert.equal(input.measurement.availableBytes, 6.17e9);
  assert.deepEqual(input.measurement.identity.session, workerSource.session);
  assert.equal(input.measurement.identity.pid, process.pid);
  assert.ok(input.measurement.readStartedAt <= input.measurement.readEndedAt);
  write('memory.pressure', 'some avg10=12.50 avg60=4.00 avg300=1.00 total=100');
  const blocked = memory.inspect(() => memory.room());
  write('cpu.pressure', 'some avg10=60.00 avg60=4.00 avg300=1.00 total=100');
  const pressure = measurePressure({ freeMb: 0, room: false, uses: new Map() });
  const reasons = [...pressure.reasons];
  records.room({ report: { short: true }, pressure, inputs: blocked.inputs });
  assert.deepEqual(records.latest().decision, decision);
  assert.equal(records.latest().room!.inputs[0].value, false);
  assert.equal(records.latest().room!.inputs[0].measurement.pressureUntil, 10000);
  assert.notDeepEqual(blocked.inputs[0].measurement.identity, input.measurement.identity);
  assert.equal(decision.inputs[0].measurement.availableBytes, 6.17e9);
  selected.inputs[0].measurement.raw.file = 1;
  pressure.reasons.push('later');
  assert.equal(input.measurement.raw.file, 5.45e9);
  assert.deepEqual(records.latest().room!.pressure.reasons, reasons);
  const firstRoom = records.latest().room;
  advance(1000);
  records.decision({
    action: 'select claim',
    outcome: 'no claim',
    slot: 'ordinary',
    claim: null,
    job: null,
    inputs: blocked.inputs,
  });
  assert.notDeepEqual(records.latest().decision, decision);
  assert.deepEqual(records.latest().room, firstRoom);
  records.room({ report: { short: false }, pressure, inputs: [] });
  assert.notDeepEqual(records.latest().room, firstRoom);
  assert.equal(roomRecords().latest().decision, null);
});

test('claim answers enrich only the matching latest decision and keep its original inputs', t => {
  const { memory, reading } = memoryFixture(t);
  const records = roomRecords();
  reading(8e9, 7.28e9, 5.45e9, 9.7e9);
  const selected = memory.inspect(() => memory.room());
  const select = () =>
    records.decision({
      action: 'select claim',
      outcome: 'claim selected',
      slot: 'ordinary',
      claim: { seat: 'seat', engine: 'codex', kind: null, room: null },
      job: null,
      inputs: selected.inputs,
    });
  const identity = select();
  const original = records.latest().decision!;
  for (const mismatched of [
    { ...identity, pid: identity.pid + 1 },
    { ...identity, startedAt: identity.startedAt + 1 },
    { ...identity, session: randomUUID() },
    { ...identity, sequence: identity.sequence + 1 },
  ]) {
    records.answered(mismatched, { id: 99 });
    assert.deepEqual(records.latest().decision, original);
  }
  records.answered(identity, { id: 42 });
  assert.equal(records.latest().decision!.outcome, 'job claimed');
  assert.equal(records.latest().decision!.job, 42);
  assert.deepEqual(records.latest().decision!.inputs, original.inputs);
  assert.equal(original.outcome, 'claim selected');
  const nextIdentity = select();
  const next = records.latest().decision;
  records.answered(identity, { id: 99 });
  assert.deepEqual(records.latest().decision, next, 'an overwritten selection cannot be recovered by a later answer');
  records.answered(nextIdentity, { held: { meeting: 7, job: 8 } });
  assert.equal(records.latest().decision!.outcome, 'meeting held');
  assert.equal(records.latest().decision!.meeting, 7);
  assert.equal(records.latest().decision!.job, 8);
  records.answered(select(), null);
  assert.equal(records.latest().decision!.outcome, 'empty claim');
  records.answered(select(), null, true);
  assert.equal(records.latest().decision!.outcome, 'claim request failed');
});

test('inspection of an unmetered selection performs no kernel read and leaves inputs empty', t => {
  const { memory } = memoryFixture(t);
  const records = roomRecords();
  const selection = memory.inspect(() => undefined);
  records.decision({
    action: 'select claim',
    outcome: 'no claim',
    slot: 'chat',
    claim: null,
    job: null,
    inputs: selection.inputs,
  });
  assert.deepEqual(records.latest().decision!.inputs, []);
});
