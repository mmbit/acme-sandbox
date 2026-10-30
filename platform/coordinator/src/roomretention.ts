// Volatile latest worker record copies for Process inspection only.
import { isDeepStrictEqual } from 'node:util';
import type { WorkerRecords, RoomRecord, DecisionRecord, RecordIdentity } from '../../worker/src/roomrecords.ts';

type Received<Value> = { receivedAt: number; record: Value };
let source: WorkerRecords['source'] | null = null;
let room: Received<RoomRecord> | null = null;
let decision: Received<DecisionRecord> | null = null;
const STALE_MS = 3 * 60_000;

export function reportWorkerRecords(records: WorkerRecords | undefined, receivedAt: number) {
  if (!records) return;
  source = structuredClone(records.source);
  if (records.room && !isDeepStrictEqual(room?.record.identity, records.room.identity))
    room = { receivedAt, record: structuredClone(records.room) };
  if (records.decision && !isDeepStrictEqual(decision?.record.identity, records.decision.identity))
    decision = { receivedAt, record: structuredClone(records.decision) };
}

export function inspectWorkerRecords(now = Date.now()) {
  const inspect = <Value extends RoomRecord | DecisionRecord>(received: Received<Value> | null) =>
    received
      ? {
          ...structuredClone(received),
          receiptStale: now - received.receivedAt > STALE_MS,
          sourceStale: now - received.record.sourceAt > STALE_MS,
          measurementStale: received.record.inputs.length
            ? received.record.inputs.some(input => now - input.readEndedAt > STALE_MS)
            : null,
          previousSession: !sameSession(source, received.record.identity),
        }
      : null;
  return { source: structuredClone(source), room: inspect(room), decision: inspect(decision) };
}

const sameSession = (left: WorkerRecords['source'] | null, right: RecordIdentity) =>
  left?.pid === right.pid && left.startedAt === right.startedAt && left.session === right.session;
