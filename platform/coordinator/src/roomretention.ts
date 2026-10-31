// Worker record retention, session identity and freshness for live room, notice and Process inspection.
import { isDeepStrictEqual } from 'node:util';
import type { WorkerRecords, RoomRecord, DecisionRecord } from '../../worker/src/roomrecords.ts';
import type { NoticeReport } from './lowmemory.ts';

type Received<Value> = { receivedAt: number; record: Value };
let source: WorkerRecords['source'] | null = null;
let room: (Received<RoomRecord> & { notice: NoticeReport | null }) | null = null;
let decision: Received<DecisionRecord> | null = null;
let ordinary: Received<DecisionRecord> | null = null;
let pressure: Received<DecisionRecord> | null = null;
// The worker reports every minute. After three report periods, its readings no longer describe current room.
export const STALE_MS = 3 * 60_000;

export function reportWorkerRecords(
  records: WorkerRecords | undefined,
  receivedAt: number,
  notice: NoticeReport | null,
) {
  if (!records) return;
  source = structuredClone(records.source);
  if (records.room && !isDeepStrictEqual(room?.record.identity, records.room.identity))
    room = {
      receivedAt,
      record: structuredClone(records.room),
      notice: structuredClone(notice),
    };
  if (records.decision && !isDeepStrictEqual(decision?.record.identity, records.decision.identity))
    decision = { receivedAt, record: structuredClone(records.decision) };
  if (records.ordinary && !isDeepStrictEqual(ordinary?.record.identity, records.ordinary.identity))
    ordinary = { receivedAt, record: structuredClone(records.ordinary) };
  if (records.pressure && !isDeepStrictEqual(pressure?.record.identity, records.pressure.identity))
    pressure = { receivedAt, record: structuredClone(records.pressure) };
}

export const workerRecordSource = () => structuredClone(source);

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
  return {
    source: structuredClone(source),
    room: inspect(room),
    decision: inspect(decision),
    ordinary: inspect(ordinary),
    pressure: inspect(pressure),
  };
}

export const sameSession = (left: WorkerRecords['source'] | null, right: WorkerRecords['source']) =>
  left?.pid === right.pid && left.startedAt === right.startedAt && left.session === right.session;
