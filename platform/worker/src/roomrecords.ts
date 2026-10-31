// Latest immutable reports and bounded population witnesses, lost on process exit.
import { randomUUID } from 'node:crypto';
import { immutable } from './immutable.ts';
import { isDeepStrictEqual } from 'node:util';
import type { AdmissionInput } from './admission.ts';
import type { Pressure } from './overload.ts';
import { pressureBlocked, quietAdmission, type OrdinaryGate } from './gateevidence.ts';

export const workerSource = Object.freeze({
  pid: process.pid,
  startedAt: performance.timeOrigin,
  session: randomUUID(),
});
let sequence = 0;
export const recordIdentity = () => ({ ...workerSource, sequence: ++sequence });
export type RecordIdentity = ReturnType<typeof recordIdentity>;
export type RoomRecord = {
  identity: RecordIdentity;
  sourceAt: number;
  inputs: AdmissionInput[];
  report: Record<string, unknown>;
  pressure: Pressure;
};
export type DecisionRecord = {
  identity: RecordIdentity;
  sourceAt: number;
  action: 'select claim';
  outcome: 'claim selected' | 'no claim' | 'job claimed' | 'meeting held' | 'empty claim' | 'claim request failed';
  selectedAt?: number;
  selectionIdentity?: RecordIdentity;
  slot: string;
  claim: { seat: string; engine: string; kind: string | null; room: number | null } | null;
  job: number | null;
  meeting: number | null;
  inputs: AdmissionInput[];
  gate?: OrdinaryGate | null;
};
export type WorkerRecords = {
  source: typeof workerSource;
  room: RoomRecord | null;
  decision: DecisionRecord | null;
  ordinary?: DecisionRecord | null;
  pressure?: DecisionRecord | null;
};

export function roomRecords() {
  let room: RoomRecord | null = null;
  let decision: DecisionRecord | null = null;
  let ordinary: DecisionRecord | null = null;
  let pressure: DecisionRecord | null = null;
  return {
    room: (record: Omit<RoomRecord, 'identity' | 'sourceAt'>) => {
      room = immutable({ ...record, identity: recordIdentity(), sourceAt: Date.now() });
    },
    decision: (record: Omit<DecisionRecord, 'identity' | 'sourceAt' | 'meeting'>) => {
      decision = immutable({ ...record, meeting: null, identity: recordIdentity(), sourceAt: Date.now() });
      if (pressureBlocked(decision.gate ?? null)) pressure = decision;
      return decision.identity;
    },
    claimSelection: (identity: RecordIdentity) =>
      decision && isDeepStrictEqual(decision.identity, identity) && ordinarySelection(decision) ? decision : undefined,
    answered(
      identity: RecordIdentity,
      answer: { id?: number; held?: { meeting: number; job: number } } | null,
      failed = false,
      selection?: DecisionRecord,
    ) {
      const original = decision && isDeepStrictEqual(decision.identity, identity) ? decision : selection;
      if (!original || !isDeepStrictEqual(original.identity, identity)) return;
      const answered = answerRecord(original, answer, failed);
      if (decision && isDeepStrictEqual(decision.identity, identity)) decision = answered;
      if (ordinaryAnswer(answered)) ordinary = answered;
    },
    latest: (): WorkerRecords => ({ source: workerSource, room, decision, ordinary, pressure }),
  };
}

function answerRecord(
  original: DecisionRecord,
  answer: { id?: number; held?: { meeting: number; job: number } } | null,
  failed: boolean,
): DecisionRecord {
  const outcome = failed
    ? 'claim request failed'
    : answer?.held
      ? 'meeting held'
      : answer?.id
        ? 'job claimed'
        : 'empty claim';
  return immutable({
    ...original,
    identity: recordIdentity(),
    selectionIdentity: original.identity,
    selectedAt: original.sourceAt,
    sourceAt: Date.now(),
    outcome,
    job: answer?.id ?? answer?.held?.job ?? null,
    meeting: answer?.held?.meeting ?? null,
  });
}

function ordinaryAnswer(record: DecisionRecord) {
  return record.outcome === 'job claimed' && ordinarySelection(record);
}

function ordinarySelection(record: DecisionRecord) {
  return (
    record.claim?.kind === null &&
    !!record.gate?.ordinarySelected &&
    record.gate.ready.some(seat => seat.state === 'ready' && !seat.check && seat.seat === record.claim?.seat) &&
    quietAdmission(record.inputs)
  );
}
