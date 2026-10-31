// node --test platform/worker/src/roomrecords.test.ts
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { memoryFixture } from './memory.fixture.ts';
import { roomRecords, workerSource } from './roomrecords.ts';
import { FREE_MB, JOB_MB, SEAT_MB, STARTING_MS } from './reserve.ts';
import { ordinaryGate, type GateEvaluation } from './gateevidence.ts';
import { roomTurns } from './roomturns.ts';
import { shortClaimRoom } from './shortclaim.ts';
import type { DecisionRecord } from './roomrecords.ts';

test('latest records preserve their own reads and replace only their own kind', t => {
  const { memory, reading, write, advance, pressure: measurePressure } = memoryFixture(t);
  const records = roomRecords();
  assert.deepEqual(records.latest(), {
    source: workerSource,
    room: null,
    decision: null,
    ordinary: null,
    pressure: null,
  });
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

test('quiet admission keeps its exact request pairing through chat and replaces only on a successful ordinary answer', t => {
  const fixture = memoryFixture(t);
  fixture.reading(8e9, 7.28e9, 5.45e9, 9.7e9, 'active_file 4000000000\n');
  fixture.memory.room();
  fixture.advance(10_000);
  fixture.memory.room();
  const records = roomRecords();
  const identity = records.decision(gateSelection(fixture.memory));
  const context = records.claimSelection(identity)!;
  assert.ok(context);
  records.decision({
    action: 'select claim',
    outcome: 'claim selected',
    slot: 'chat',
    claim: { seat: 'chat', engine: 'claude', kind: 'chat', room: null },
    job: null,
    inputs: [],
  });
  const chat = records.latest().decision;
  records.answered({ ...identity, sequence: identity.sequence + 100 }, { id: 9 }, false, context);
  assert.equal(records.latest().ordinary, null);
  records.answered(identity, { id: 42 }, false, context);
  const witness = records.latest().ordinary!;
  assert.deepEqual(records.latest().decision, chat);
  assert.deepEqual(witness.selectionIdentity, identity);
  assert.equal(witness.selectedAt, context.sourceAt);
  assert.ok(witness.sourceAt >= witness.selectedAt!);
  assert.equal(witness.job, 42);
  assert.deepEqual(witness.inputs, context.inputs);
  assert.equal(witness.inputs[0].measurement.raw.active_file, 4e9);
  assert.equal(witness.inputs[0].measurement.raw.file, 5.45e9);
  for (const answer of [null, { held: { job: 5, meeting: 7 } }]) {
    records.answered(records.decision(gateSelection(fixture.memory)), answer);
    assert.deepEqual(records.latest().ordinary, witness);
  }
  records.answered(records.decision(gateSelection(fixture.memory)), null, true);
  const incident = gateSelection(fixture.memory);
  incident.claim!.kind = 'incident';
  records.answered(records.decision(incident), { id: 44 });
  assert.deepEqual(records.latest().ordinary, witness);
  records.answered(records.decision(gateSelection(fixture.memory)), { id: 45 });
  assert.equal(records.latest().ordinary!.job, 45);
  assert.equal(records.latest().pressure, null);
  assert.equal(roomRecords().latest().ordinary, null);
});

test('pressure witness requires an eligible unthrottled gate blocked by the actual meter and survives unrelated selection', t => {
  const fixture = memoryFixture(t);
  fixture.reading(8e9, 7.28e9, 5.45e9, 9.7e9);
  fixture.write('memory.pressure', 'some avg10=10.00 avg60=0 avg300=0 total=100');
  const records = roomRecords();
  for (const [ready, throttled] of [
    [false, false],
    [true, true],
  ] as const) {
    records.decision(gateSelection(fixture.memory, ready, throttled));
    assert.equal(records.latest().pressure, null);
  }
  const selection = gateSelection(fixture.memory);
  selection.claim = { seat: 'incident', engine: 'claude', kind: 'incident', room: null };
  selection.outcome = 'claim selected';
  records.decision(selection);
  const witness = records.latest().pressure!;
  assert.ok(witness);
  assert.equal(witness.gate!.ordinarySelected, false);
  assert.equal(witness.gate!.room.value, false);
  assert.equal(witness.gate!.room.measurement.availableBytes, 0);
  assert.equal(witness.gate!.room.measurement.lastPressureTrigger!.someAvg10, 10);
  assert.equal(witness.gate!.shortClaims[0].input.value, 0);
  assert.equal(witness.gate!.shortClaims[0].throttled, false);
  assert.deepEqual(witness.gate!.room.reserves, witness.inputs[0].reserves);
  fixture.write('memory.pressure', 'some avg10=0.00 avg60=0 avg300=0 total=100');
  fixture.advance(1);
  records.decision(gateSelection(fixture.memory));
  const held = records.latest().pressure!;
  assert.equal(held.gate!.room.measurement.underPressure, true);
  assert.deepEqual(
    held.gate!.room.measurement.lastPressureTrigger,
    witness.gate!.shortClaims[0].input.measurement.lastPressureTrigger,
  );
  fixture.advance(10_000);
  records.decision(gateSelection(fixture.memory));
  assert.deepEqual(records.latest().pressure, held);
  fixture.write('memory.events', 'low 0\nhigh 0\nmax 42\noom 3\noom_kill 1\n');
  records.decision(gateSelection(fixture.memory));
  const oom = records.latest().pressure!.gate!.room.measurement;
  assert.equal(oom.underPressure, true);
  assert.equal(oom.lastPressureTrigger!.psiThreshold, false);
  assert.equal(oom.lastPressureTrigger!.newOomEvent, true);
});

test('empty, reserve-only and CPU-only no-claim cases cannot create a pressure or quiet witness', t => {
  const fixture = memoryFixture(t);
  const records = roomRecords();
  fixture.reading(8e9, 7.9e9, 0, 9.7e9);
  records.decision(gateSelection(fixture.memory));
  assert.equal(records.latest().pressure, null);
  fixture.reading(8e9, 7.28e9, 5.45e9, 9.7e9);
  const first = records.decision(gateSelection(fixture.memory));
  assert.equal(records.claimSelection(first), undefined, 'missing quiet predecessor');
  records.answered(first, { id: 1 });
  assert.equal(records.latest().ordinary, null);
  fixture.write('cpu.pressure', 'some avg10=80.00 avg60=0 avg300=0 total=100');
  assert.equal(fixture.pressure({ freeMb: 4000, room: true, uses: new Map() }).inputs.cpuBusy, true);
  records.decision(gateSelection(fixture.memory, false));
  assert.equal(records.latest().pressure, null);
  assert.equal(records.latest().ordinary, null);
});

function gateSelection(
  memory: ReturnType<typeof memoryFixture>['memory'],
  ready = true,
  throttled = false,
): Omit<DecisionRecord, 'identity' | 'sourceAt' | 'meeting'> {
  const evaluation: GateEvaluation = {
    ready: ready ? [{ seat: 'seat', engine: 'codex', state: 'ready', check: false }] : [],
    shortClaims: [],
    ordinarySelected: false,
  };
  const selection = memory.inspect(() => {
    const roomy = memory.room();
    const next = roomTurns().next<GateEvaluation['ready'][number] & { room?: number }>(
      evaluation.ready,
      roomy,
      engine => {
        return shortClaimRoom(engine, memory.claimMb(), throttled, evaluation);
      },
    );
    evaluation.ordinarySelected = !!next;
    return next;
  });
  return {
    action: 'select claim',
    outcome: selection.value ? 'claim selected' : 'no claim',
    slot: 'ordinary',
    claim: selection.value ? { seat: 'seat', engine: 'codex', kind: null, room: selection.value.room ?? null } : null,
    job: null,
    inputs: selection.inputs,
    gate: ordinaryGate(evaluation, selection.inputs),
  };
}
