// Contemporaneous inspection of the retained ordinary gate and its exact pressure causation.
import { isDeepStrictEqual } from 'node:util';
import { memoryAvailability, pressureReading, QUIET_MS } from '../../worker/src/availability.ts';
import { pressureBlocked } from '../../worker/src/gateevidence.ts';
import { immutable } from '../../worker/src/immutable.ts';
import { timestampAges, freshAges } from './inspectiontimes.ts';
import type { PressureTrigger } from '../../worker/src/memory.ts';
import { reservationCapacity, reservationInputs, STARTING_MS, JOB_MB } from '../../worker/src/reserve.ts';
import type { AdmissionInput } from '../../worker/src/admission.ts';
import type { DecisionRecord, WorkerRecords } from '../../worker/src/roomrecords.ts';
import { inspectWorkerRecords, sameSession } from './roomretention.ts';

type ReceivedPressure = ReturnType<typeof inspectWorkerRecords>['pressure'];
type Source = WorkerRecords['source'];

export function inspectPressure(received: ReceivedPressure, source: Source, armedAt: number, inspectedAt: number) {
  if (!received || inspectedAt < armedAt) return null;
  if (received.previousSession || received.receiptStale || received.sourceStale || received.measurementStale !== false)
    return null;
  const record = received.record;
  const gate = record.gate;
  if (!sameSession(source, record.identity) || !pressureBlocked(gate ?? null) || !gate) return null;
  if (record.sourceAt > received.receivedAt || record.action !== 'select claim') return null;
  if (!record.inputs.length || !record.inputs.every(input => validInput(input, record, received.receivedAt)))
    return null;
  if (!anchored(record.inputs, gate.room) || gate.room.operation !== 'room' || !gate.room.young) return null;
  if (!gate.ready.length || !gate.ready.every(seat => seat.state === 'ready' && !seat.check)) return null;
  if (!completePaths(record)) return null;
  const ages = pressureAges(received, inspectedAt);
  if (!freshAges(ages)) return null;
  return pressureSnapshot(received, inspectedAt, ages);
}

function pressureAges(received: NonNullable<ReceivedPressure>, inspectedAt: number) {
  const timestamps = {
    sourceMs: received.record.sourceAt,
    receiptMs: received.receivedAt,
    inputs: received.record.inputs.map(inputTimestamps),
  };
  return timestampAges(timestamps, inspectedAt);
}

function pressureSnapshot(
  received: NonNullable<ReceivedPressure>,
  inspectedAt: number,
  ages: ReturnType<typeof pressureAges>,
) {
  const record = received.record;
  const gate = record.gate!;
  return immutable({
    received,
    inspectedAt,
    ages: {
      ...ages,
      inputs: ages.inputs.map((inputAges, index) => ({
        ...inputAges,
        ...inputLabels(record.inputs[index]),
      })),
    },
    flags: {
      sourceFresh: true,
      receiptFresh: true,
      inputsFresh: true,
      triggersFresh: true,
      currentSession: true,
      eligibleOrdinarySeat: true,
      ordinarySelected: false,
      shortOrdinarySucceeded: false,
      incidentFallback: record.claim?.kind === 'incident',
    },
    joins: {
      decision: record.identity,
      room: gate.room.measurement.identity,
      paths: gate.shortClaims.map(claim => ({
        engine: claim.engine,
        throttled: claim.throttled,
        underPressure: claim.input.measurement.underPressure,
        availableBytes: claim.input.measurement.availableBytes,
        measurement: claim.input.measurement.identity,
        trigger: claim.input.measurement.lastPressureTrigger!.identity,
      })),
    },
  });
}

function inputLabels(input: AdmissionInput) {
  const measurement = input.measurement;
  const trigger = measurement.lastPressureTrigger!;
  return {
    triggerKind: trigger.psiThreshold ? 'threshold' : 'new OOM',
    liveHold: measurement.underPressure && !isDeepStrictEqual(trigger.identity, measurement.identity),
  };
}

function completePaths(record: DecisionRecord) {
  const gate = record.gate!;
  if (gate.shortClaims.length !== gate.ready.length) return false;
  if (!gate.ready.every(seat => gate.shortClaims.filter(claim => claim.engine === seat.engine).length === 1))
    return false;
  return gate.shortClaims.every(claim => {
    const input = claim.input;
    if (!input || !anchored(record.inputs, input) || input.operation !== 'claimMb' || !input.young) return false;
    if (claim.throttled) return claim.exclusion === 'throttled';
    return claim.exclusion === 'nonpositive room' && input.value === 0;
  });
}

function validInput(input: AdmissionInput, record: DecisionRecord, receivedAt: number) {
  const measurement = input.measurement;
  if (!sameSession(record.identity, measurement.identity)) return false;
  if (measurement.identity.sequence >= record.identity.sequence) return false;
  if (!within(input.readStartedAt, input.readEndedAt, record.sourceAt)) return false;
  if (!within(measurement.readStartedAt, measurement.readEndedAt, input.readEndedAt)) return false;
  if (measurement.readStartedAt < input.readStartedAt || record.sourceAt > receivedAt) return false;
  const trigger = measurement.lastPressureTrigger;
  if (!trigger || !validTrigger(trigger, measurement)) return false;
  const availability = memoryAvailability(measurement, measurement.hostAvailableBytes, measurement.underPressure);
  if (availability.reclaimableFileBytes !== measurement.reclaimableFileBytes) return false;
  if (availability.heldBytes !== measurement.heldBytes || availability.availableBytes !== measurement.availableBytes)
    return false;
  if (!isDeepStrictEqual(input.reserves, reservationInputs(input.reserves.starting, input.reserves.heldSlots)))
    return false;
  if (!validReserves(input)) return false;
  const capacity = reservationCapacity(measurement.availableBytes / 2 ** 20, input.reserves, input.young);
  if (input.operation === 'room') return input.value === capacity.room;
  if (input.operation === 'claimMb') return input.value === capacity.claimMb;
  return false;
}

function validReserves(input: AdmissionInput) {
  const reserves = input.reserves;
  if (!Number.isInteger(reserves.heldSlots) || reserves.heldSlots < 0) return false;
  if (!input.young) return reserves.starting === null;
  return (
    reserves.starting !== null &&
    reserves.starting.every(
      entry =>
        entry.mb === JOB_MB &&
        entry.until > input.measurement.readEndedAt &&
        entry.until <= input.readEndedAt + STARTING_MS,
    )
  );
}

function validTrigger(trigger: PressureTrigger, measurement: AdmissionInput['measurement']) {
  if (!sameSession(measurement.identity, trigger.identity)) return false;
  if (trigger.identity.sequence > measurement.identity.sequence) return false;
  if (!within(trigger.readStartedAt, trigger.readEndedAt, measurement.readEndedAt)) return false;
  if (trigger.pressureUntil !== trigger.readEndedAt + QUIET_MS) return false;
  if (measurement.pressureUntil !== trigger.pressureUntil) return false;
  if (measurement.underPressure !== measurement.readEndedAt < trigger.pressureUntil) return false;
  const triggerReading = pressureReading(trigger.memoryPressure, trigger.memoryEvents, trigger.previousOomEvents);
  const currentReading = pressureReading(
    measurement.memoryPressure,
    measurement.memoryEvents,
    measurement.previousOomEvents,
  );
  if (trigger.someAvg10 !== triggerReading.someAvg10 || trigger.psiThreshold !== triggerReading.psiThreshold)
    return false;
  if (!isDeepStrictEqual(trigger.oomEvents, triggerReading.oomEvents)) return false;
  if (currentReading.oomEvents.some((count, index) => count < triggerReading.oomEvents[index])) return false;
  if (trigger.newOomEvent !== triggerReading.newOomEvent) return false;
  if (!triggerReading.psiThreshold && !triggerReading.newOomEvent) return false;
  if (measurement.newOomEvent !== currentReading.newOomEvent) return false;
  const originalTrigger = isDeepStrictEqual(trigger.identity, measurement.identity);
  const triggeredNow = currentReading.newOomEvent || currentReading.psiThreshold;
  if (originalTrigger !== triggeredNow) return false;
  if (!originalTrigger) return trigger.readEndedAt <= measurement.readStartedAt;
  return (
    trigger.readStartedAt === measurement.readStartedAt &&
    trigger.readEndedAt === measurement.readEndedAt &&
    trigger.memoryEvents === measurement.memoryEvents &&
    trigger.memoryPressure === measurement.memoryPressure &&
    isDeepStrictEqual(trigger.previousOomEvents, measurement.previousOomEvents)
  );
}

function inputTimestamps(input: AdmissionInput) {
  const measurement = input.measurement;
  const trigger = measurement.lastPressureTrigger!;
  return {
    inputStartMs: input.readStartedAt,
    inputEndMs: input.readEndedAt,
    measurementStartMs: measurement.readStartedAt,
    measurementEndMs: measurement.readEndedAt,
    triggerStartMs: trigger.readStartedAt,
    triggerEndMs: trigger.readEndedAt,
  };
}

const anchored = (inputs: AdmissionInput[], input: AdmissionInput) =>
  inputs.some(candidate => isDeepStrictEqual(candidate, input));
const within = (start: number, end: number, latest: number) => start <= end && end <= latest;
