// Bounded observed cache-only report decisions, invalidated by actual warning emissions.
import { isDeepStrictEqual } from 'node:util';
import { memoryAvailability } from '../../worker/src/availability.ts';
import { reservationCapacity } from '../../worker/src/reserve.ts';
import { quietAdmission } from '../../worker/src/gateevidence.ts';
import { STALE_MS, sameSession } from './roomretention.ts';
import { timestampAges, freshAges } from './inspectiontimes.ts';
import type { NoticeReport } from './lowmemory.ts';
import type { WorkerRecords, RecordIdentity, RoomRecord } from '../../worker/src/roomrecords.ts';
import type { AdmissionInput } from '../../worker/src/admission.ts';

type Source = WorkerRecords['source'];
type Interval = {
  coordinator: { pid: number; startedAt: number };
  source: Source;
  first: NoticeReport;
  last: NoticeReport;
  observedReportCount: number;
};
let source: Source | null = null;
let lastSequence = 0;
let lastSourceAt = 0;
let active: Interval | null = null;
let completed: Interval | null = null;
let boundaryAt = -Infinity;
let processedOrder = 0;
let firstOrder = 0;
let lastOrder = 0;

// A new authorized observation segments endpoints without resetting replay or qualification rules.
export function beginNoticeObservation(at: number) {
  active = null;
  completed = null;
  boundaryAt = at;
}

export function inspectNoticeReceipt(armedAt: number, now: number) {
  const interval = inspectNoticeInterval(now).active;
  if (!interval || interval.observedReportCount < 2 || interval.previousSession) return null;
  if (interval.first.receivedAt < armedAt || boundaryAt !== armedAt) return null;
  if (![interval.first, interval.last].every(qualifies) || !freshAges(interval.ages)) return null;
  return {
    ...interval,
    boundaryAt,
    order: { first: firstOrder, last: lastOrder },
    noActualWarnings: true,
    flags: { endpointsFresh: true, requiredInputsFresh: true, currentSession: true, qualifiedAtOriginalReceipts: true },
  };
}

export function observeNoticeReport(report: NoticeReport | null, current?: Source, record?: RoomRecord | null) {
  const order = ++processedOrder;
  let preceding = active;
  active = null;
  const worker = report?.worker ?? record;
  if (!current) {
    if (worker && sameSession(source, worker.identity)) {
      lastSequence = Math.max(lastSequence, worker.identity.sequence);
      lastSourceAt = Math.max(lastSourceAt, worker.sourceAt);
    }
    return;
  }
  if (!sameSession(source, current)) {
    preceding = null;
    if (source && current.startedAt <= source.startedAt) return;
    source = structuredClone(current);
    lastSequence = 0;
    lastSourceAt = 0;
  }
  const freshIdentity = worker && sameSession(source, worker.identity) && worker.identity.sequence > lastSequence;
  const ordered =
    freshIdentity &&
    worker.sourceAt >= lastSourceAt &&
    (!preceding || !report || report.receivedAt >= preceding.last.receivedAt);
  const originalInputs = worker && worker.inputs.every(input => input.measurement.identity.sequence > lastSequence);
  if (freshIdentity) {
    lastSequence = worker.identity.sequence;
    lastSourceAt = Math.max(lastSourceAt, worker.sourceAt);
  }
  if (!report || report.receivedAt < boundaryAt || !ordered || !originalInputs || !qualifies(report)) {
    return;
  }
  if (!preceding) firstOrder = order;
  lastOrder = order;
  const endpoint = structuredClone(report);
  active = {
    coordinator: preceding?.coordinator ?? { pid: process.pid, startedAt: performance.timeOrigin },
    source: structuredClone(current),
    first: preceding?.first ?? endpoint,
    last: endpoint,
    observedReportCount: (preceding?.observedReportCount ?? 0) + 1,
  };
  if (active.observedReportCount >= 2) completed = structuredClone(active);
}

export function emittedWarning() {
  processedOrder++;
  active = null;
}

export function inspectNoticeInterval(now = Date.now()) {
  const inspect = (interval: Interval | null) =>
    interval && {
      ...structuredClone(interval),
      previousSession: !sameSession(source, interval.source),
      ages: { first: endpointAges(interval.first, now), last: endpointAges(interval.last, now) },
    };
  return { active: inspect(active), completed: inspect(completed) };
}

function endpointAges(report: NoticeReport, now: number) {
  const worker = report.worker!;
  const inputTimestamps = worker.inputs.map(input => ({
    inputStartMs: input.readStartedAt,
    inputEndMs: input.readEndedAt,
    measurementStartMs: input.measurement.readStartedAt,
    measurementEndMs: input.measurement.readEndedAt,
    quietFirstStartMs: input.measurement.quietPredecessor!.first.readStartedAt,
    quietFirstEndMs: input.measurement.quietPredecessor!.first.readEndedAt,
    quietLastStartMs: input.measurement.quietPredecessor!.last.readStartedAt,
    quietLastEndMs: input.measurement.quietPredecessor!.last.readEndedAt,
  }));
  const pressureStartedAt = worker.pressure.inputs.readStartedAt;
  const pressureEndedAt = worker.pressure.inputs.readEndedAt;
  const readStarts = inputTimestamps.flatMap(input => [input.inputStartMs, input.measurementStartMs]);
  const readEnds = inputTimestamps.flatMap(input => [input.inputEndMs, input.measurementEndMs]);
  const timestamps = {
    sourceMs: worker.sourceAt,
    receiptMs: report.receivedAt,
    measurementStartMs: Math.min(pressureStartedAt, ...readStarts),
    measurementEndMs: Math.max(pressureEndedAt, ...readEnds),
    pressureStartMs: pressureStartedAt,
    pressureEndMs: pressureEndedAt,
    inputs: inputTimestamps,
  };
  return timestampAges(timestamps, now);
}

function qualifies(report: NoticeReport) {
  const worker = report.worker;
  if (!worker || !isDeepStrictEqual(report.memory, worker.pressure)) return false;
  const pressure = worker.pressure;
  const inputs = pressure.inputs;
  const free = inputs.source?.free;
  const room = inputs.source?.room;
  if (!free || !room || !worker.inputs.length) return false;
  const calm =
    pressure.verdict === 'calm' &&
    !pressure.reasons.length &&
    !pressure.cause &&
    inputs.memoryVerdict === 'calm' &&
    !inputs.cpuBusy &&
    inputs.room &&
    report.transition.kind === 'none' &&
    report.transition.spell === null;
  if (!calm) return false;
  const anchored =
    free.operation === 'freeMb' &&
    !free.young &&
    room.operation === 'room' &&
    room.young &&
    worker.inputs.some(input => anchoredInput(input, free)) &&
    worker.inputs.some(input => anchoredInput(input, room));
  if (!anchored) return false;
  const fresh =
    worker.inputs.every(input => validInput(input, worker.identity, worker.sourceAt, report.receivedAt)) &&
    within(inputs.readStartedAt, inputs.readEndedAt, worker.sourceAt, report.receivedAt) &&
    inputs.readStartedAt >= Math.max(free.readEndedAt, room.readEndedAt);
  if (!fresh || !quietAdmission(worker.inputs)) return false;
  if (inputs.freeMb !== free.value || inputs.freeMb < inputs.clearMb) return false;
  if (
    room.value !== true ||
    !reservationCapacity(room.measurement.availableBytes / 2 ** 20, room.reserves, room.young).room
  )
    return false;
  const cacheOnly =
    rawFreeMb(free) < inputs.lowMb ||
    !reservationCapacity(rawAvailable(room) / 2 ** 20, room.reserves, room.young).room;
  return cacheOnly;
}

const anchoredInput = (input: AdmissionInput, anchor: AdmissionInput) =>
  isDeepStrictEqual({ ...input, phase: undefined }, { ...anchor, phase: undefined });

function validInput(input: AdmissionInput, identity: RecordIdentity, at: number, receivedAt: number) {
  const measurement = input.measurement;
  const quiet = measurement.quietPredecessor;
  const raw = measurement.raw;
  if (raw.active_file === null || !sameSession(identity, measurement.identity)) return false;
  if (measurement.identity.sequence >= identity.sequence) return false;
  if (!within(input.readStartedAt, input.readEndedAt, at, receivedAt)) return false;
  if (!within(measurement.readStartedAt, measurement.readEndedAt, at, receivedAt)) return false;
  if (measurement.readStartedAt < input.readStartedAt || measurement.readEndedAt > input.readEndedAt) return false;
  if (measurement.newOomEvent || !quiet) return false;
  if (!sameSession(identity, quiet.first.identity) || !sameSession(identity, quiet.last.identity)) return false;
  if (quiet.last.readEndedAt > measurement.readStartedAt) return false;
  const availability = memoryAvailability(measurement, measurement.hostAvailableBytes, measurement.underPressure);
  if (availability.reclaimableFileBytes <= 0) return false;
  if (measurement.reclaimableFileBytes !== availability.reclaimableFileBytes) return false;
  if (measurement.heldBytes !== availability.heldBytes) return false;
  if (measurement.availableBytes !== availability.availableBytes) return false;
  if (input.operation === 'freeMb' && !input.young && input.value !== measurement.availableBytes / 2 ** 20)
    return false;
  return true;
}

const rawAvailable = (input: AdmissionInput) => {
  const measurement = input.measurement;
  const cap = measurement.memoryMaxBytes === 'max' ? Infinity : Number(measurement.memoryMaxBytes);
  return Math.min(measurement.hostAvailableBytes, cap - measurement.memoryCurrentBytes);
};
const rawFreeMb = (input: AdmissionInput) => rawAvailable(input) / 2 ** 20;
const within = (start: number, end: number, at: number, receivedAt: number) =>
  start <= end && end <= at && at <= receivedAt && receivedAt - start <= STALE_MS;
