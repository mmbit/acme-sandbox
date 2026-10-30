// Two latest immutable worker records, lost on replacement or process exit.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AdmissionInput } from './admission.ts';
import type { Pressure } from './overload.ts';

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
  slot: string;
  claim: { seat: string; engine: string; kind: string | null; room: number | null } | null;
  job: number | null;
  meeting: number | null;
  inputs: AdmissionInput[];
};
export type WorkerRecords = { source: typeof workerSource; room: RoomRecord | null; decision: DecisionRecord | null };

export function roomRecords() {
  let room: RoomRecord | null = null;
  let decision: DecisionRecord | null = null;
  return {
    room: (record: Omit<RoomRecord, 'identity' | 'sourceAt'>) => {
      room = immutable({ ...record, identity: recordIdentity(), sourceAt: Date.now() });
    },
    decision: (record: Omit<DecisionRecord, 'identity' | 'sourceAt' | 'meeting'>) => {
      decision = immutable({ ...record, meeting: null, identity: recordIdentity(), sourceAt: Date.now() });
      return decision.identity;
    },
    answered(
      identity: RecordIdentity,
      answer: { id?: number; held?: { meeting: number; job: number } } | null,
      failed = false,
    ) {
      if (!decision || !isDeepStrictEqual(decision.identity, identity)) return;
      const outcome = failed
        ? 'claim request failed'
        : answer?.held
          ? 'meeting held'
          : answer?.id
            ? 'job claimed'
            : 'empty claim';
      decision = immutable({
        ...decision,
        identity: recordIdentity(),
        selectedAt: decision.sourceAt,
        sourceAt: Date.now(),
        outcome,
        job: answer?.id ?? answer?.held?.job ?? null,
        meeting: answer?.held?.meeting ?? null,
      });
    },
    latest: (): WorkerRecords => ({ source: workerSource, room, decision }),
  };
}

function immutable<Value>(value: Value): Value {
  const copy = structuredClone(value);
  const freeze = (part: any) => {
    if (part && typeof part === 'object') {
      for (const child of Object.values(part)) freeze(child);
      Object.freeze(part);
    }
  };
  freeze(copy);
  return copy;
}
