// node --test src/pressureinspection.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { memoryFixture } from '../../worker/src/memory.fixture.ts';
import { ordinaryGate, type GateEvaluation } from '../../worker/src/gateevidence.ts';
import { roomRecords, type DecisionRecord } from '../../worker/src/roomrecords.ts';
import { roomTurns } from '../../worker/src/roomturns.ts';
import { shortClaimRoom } from '../../worker/src/shortclaim.ts';
import { reportWorkerRecords, inspectWorkerRecords } from './roomretention.ts';
import { inspectPressure } from './pressureinspection.ts';

test('the inspection preserves exact threshold and live-hold causation without requiring a new OOM', t => {
  const population = pressurePopulation(t);
  const threshold = population.publish();
  const inspectedAt = Date.now();
  const receipt = inspectPressure(threshold, population.source, inspectedAt - 1, inspectedAt)!;
  assert.ok(receipt);
  assert.deepEqual(receipt.received, threshold);
  assert.equal(receipt.ages.inputs[0].triggerKind, 'threshold');
  assert.equal(receipt.ages.inputs[0].liveHold, false);
  assert.equal(receipt.received.record.inputs[0].measurement.newOomEvent, false);
  population.fixture.write('memory.pressure', 'some avg10=0.00 avg60=0 avg300=0 total=100');
  population.fixture.advance(1);
  const held = population.publish();
  const heldReceipt = inspectPressure(held, population.source, inspectedAt - 1, Date.now())!;
  assert.ok(heldReceipt);
  assert.equal(heldReceipt.ages.inputs[0].liveHold, true);
  assert.deepEqual(
    heldReceipt.joins.paths[0].trigger,
    receipt.received.record.gate!.shortClaims[0].input.measurement.lastPressureTrigger!.identity,
  );
  assert.throws(() => {
    receipt.received.record.slot = 'changed';
  }, TypeError);
  assert.equal(inspectPressure(threshold, population.source, inspectedAt - 1, inspectedAt + 180_001), null);
});

test('new OOM and incident fallback remain attributed separately from the ordinary block', t => {
  const population = pressurePopulation(t);
  population.publish();
  population.fixture.write('memory.pressure', 'some avg10=0.00 avg60=0 avg300=0 total=100');
  population.fixture.write('memory.events', 'low 0\nhigh 0\nmax 42\noom 3\noom_kill 1\n');
  population.fixture.advance(1);
  const received = population.publish(selection => {
    selection.claim = { seat: 'incident', engine: 'claude', kind: 'incident', room: null };
    selection.outcome = 'claim selected';
  });
  const receipt = inspectPressure(received, population.source, 0, Date.now())!;
  assert.ok(receipt);
  assert.equal(receipt.flags.incidentFallback, true);
  assert.equal(receipt.flags.ordinarySelected, false);
  assert.equal(receipt.ages.inputs[0].triggerKind, 'new OOM');
});

test('late transport, future input, previous sessions and expired triggers cannot qualify', t => {
  const population = pressurePopulation(t);
  const received = population.publish()!;
  const now = Date.now();
  assert.equal(inspectPressure(received, population.source, now + 1, now), null);
  assert.equal(inspectPressure(received, { ...population.source, session: randomUUID() }, 0, now), null);
  for (const flag of ['previousSession', 'receiptStale', 'sourceStale', 'measurementStale'] as const) {
    const flagged = structuredClone(received);
    flagged[flag] = true;
    assert.equal(inspectPressure(flagged, population.source, 0, now), null);
  }
  const late = structuredClone(received);
  late.receivedAt = received.record.sourceAt + 180_001;
  assert.equal(inspectPressure(late, population.source, 0, late.receivedAt), null);
  const future = structuredClone(received);
  future.record.inputs[0].readStartedAt = now + 1;
  assert.equal(inspectPressure(future, population.source, 0, now), null);
  const expired = structuredClone(received);
  const trigger = expired.record.inputs[0].measurement.lastPressureTrigger!;
  trigger.readStartedAt -= 180_001;
  trigger.readEndedAt -= 180_001;
  assert.equal(inspectPressure(expired, population.source, 0, now), null);
  const previous = structuredClone(received);
  previous.record.inputs[0].measurement.lastPressureTrigger!.identity.session = randomUUID();
  assert.equal(inspectPressure(previous, population.source, 0, now), null);
});

test('storage eligibility alone does not prove complete short paths or actual reserve computations', t => {
  const population = pressurePopulation(t);
  const received = population.publish()!;
  const now = Date.now();
  const changes: ((record: DecisionRecord) => void)[] = [
    record => {
      record.gate!.shortClaims.push({ ...record.gate!.shortClaims[0], engine: 'claude' });
    },
    record => {
      record.gate!.shortClaims[0].exclusion = null;
    },
    record => {
      record.gate!.shortClaims[0].input.value = 4;
    },
    record => {
      record.gate!.room.reserves.freeReserveMb = 0;
    },
    record => {
      record.gate!.room.measurement.reclaimableFileBytes = 0;
    },
    record => {
      record.gate!.room.measurement.lastPressureTrigger!.psiThreshold = false;
    },
    record => {
      record.gate!.room.measurement.pressureUntil += 1;
    },
    record => {
      record.gate!.ready = [];
    },
    record => {
      record.gate!.shortClaims[0].throttled = true;
    },
    record => {
      record.gate!.ordinarySelected = true;
    },
    record => {
      record.gate!.room.measurement.underPressure = false;
    },
  ];
  for (const change of changes) {
    const candidate = structuredClone(received);
    change(candidate.record);
    assert.equal(inspectPressure(candidate, population.source, 0, now), null);
  }
});

test('a later throttled path keeps its own calm measurement after the pressure hold expires', t => {
  const population = pressurePopulation(t);
  const received = population.publish(undefined, true)!;
  const receipt = inspectPressure(received, population.source, 0, Date.now())!;
  assert.ok(receipt);
  assert.equal(receipt.joins.paths.length, 2);
  const ordinaryPath = receipt.joins.paths.find(path => path.engine === 'codex')!;
  const throttledPath = receipt.joins.paths.find(path => path.engine === 'claude')!;
  assert.equal(ordinaryPath.underPressure, true);
  assert.equal(throttledPath.throttled, true);
  assert.equal(throttledPath.underPressure, false);
  assert.ok(throttledPath.availableBytes > 0);
});

test('CPU-only, reserve-only, no-seat and all-throttled populations leave pressure missing', t => {
  const population = pressurePopulation(t);
  population.fixture.reading(8e9, 7.9e9, 0, 9.7e9);
  population.fixture.write('cpu.pressure', 'some avg10=80.00 avg60=0 avg300=0 total=100');
  assert.equal(population.publish(), null);
  population.fixture.reading(8e9, 7.28e9, 5.45e9, 9.7e9);
  population.fixture.write('memory.pressure', 'some avg10=10.00 avg60=0 avg300=0 total=100');
  assert.equal(
    population.publish(selection => {
      selection.gate!.ready = [];
    }),
    null,
  );
  assert.equal(
    population.publish(selection => {
      selection.gate!.shortClaims[0].throttled = true;
    }),
    null,
  );
});

function pressurePopulation(t: Parameters<typeof memoryFixture>[0]) {
  const fixture = memoryFixture(t);
  const records = roomRecords();
  fixture.advance(Date.now() - 20_000);
  fixture.reading(8e9, 7.28e9, 5.45e9, 9.7e9, 'active_file 4000000000\n');
  fixture.write('memory.pressure', 'some avg10=10.00 avg60=0 avg300=0 total=100');
  return {
    fixture,
    source: records.latest().source,
    publish(
      change?: (selection: Omit<DecisionRecord, 'identity' | 'sourceAt' | 'meeting'>) => void,
      laterThrottled = false,
    ) {
      const evaluation: GateEvaluation = {
        ready: [{ seat: 'ordinary', engine: 'codex', state: 'ready', check: false }],
        ordinarySelected: false,
        shortClaims: [],
      };
      if (laterThrottled) evaluation.ready.push({ seat: 'later', engine: 'claude', state: 'ready', check: false });
      const captured = fixture.memory.inspect(() =>
        roomTurns().next(evaluation.ready, fixture.memory.room(), engine => {
          if (engine === 'claude') {
            fixture.write('memory.pressure', 'some avg10=0.00 avg60=0 avg300=0 total=100');
            fixture.advance(10_000);
          }
          return shortClaimRoom(engine, fixture.memory.claimMb(), engine === 'claude', evaluation);
        }),
      );
      const selection = {
        action: 'select claim' as const,
        outcome: 'no claim' as DecisionRecord['outcome'],
        slot: 'ordinary',
        claim: null as DecisionRecord['claim'],
        job: null,
        inputs: captured.inputs,
        gate: ordinaryGate(evaluation, captured.inputs),
      };
      change?.(selection);
      records.decision(selection);
      if (!records.latest().pressure) return null;
      reportWorkerRecords(records.latest(), Date.now(), null);
      return inspectWorkerRecords().pressure;
    },
  };
}
