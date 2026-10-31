// Read-only access to retained worker room, notice and run records.
import { db } from './db.ts';
import { REBUILT_RUN } from './timing.ts';
import { inspectRoom } from './room.ts';
import { inspectMemory } from './lowmemory.ts';
import { inspectWorkerRecords } from './roomretention.ts';
import { inspectNoticeInterval } from './noticeinterval.ts';

// Bound each response's database work and payload. Cursors leave every later row accessible.
const PAGE_ROWS = 100;
type RecordRow = Record<string, string | number | null>;

const histories = {
  spells: {
    start: '0',
    keys: ['id'],
    query: `select id, began, ended, free_mb, cause, took_mb, cause_free_mb
      from memory_spells where id > ? order by id limit ?`,
  },
  deliveries: {
    start: '0.0',
    keys: ['spell', 'job'],
    query: `select t.spell, t.job, t.back, s.began, s.ended,
      case when s.id is null then 0 else 1 end as spell_found
      from memory_told t left join memory_spells s on s.id = t.spell
      where (t.spell, t.job) > (?, ?) order by t.spell, t.job limit ?`,
  },
  runs: {
    start: '0',
    keys: ['id'],
    query: `select id, job, seat, started, ended, ended_as,
      case when ${REBUILT_RUN} then 'reconstructed' else 'recorded run start' end as provenance from runs
      where id > ? order by id limit ?`,
  },
};

export function getRoomRecords(population: unknown = 'spells', after?: unknown) {
  if (typeof population !== 'string' || !Object.hasOwn(histories, population)) return null;
  const history = histories[population as keyof typeof histories];
  const parts = String(after ?? history.start).split('.');
  if (parts.length !== history.keys.length) return null;
  if (!parts.every(part => /^\d+$/.test(part) && Number.isSafeInteger(Number(part)))) return null;
  const rows = db.prepare(history.query).all(...parts.map(Number), PAGE_ROWS + 1) as RecordRow[];
  const page = rows.slice(0, PAGE_ROWS);
  const last = page.at(-1);
  const next = rows.length <= PAGE_ROWS ? null : history.keys.map(key => last![key]).join('.');
  const retained = inspectWorkerRecords();
  const notices = inspectMemory();
  const decision = retained.decision?.record;
  return {
    inspectedAt: Date.now(),
    coordinator: { pid: process.pid, startedAt: performance.timeOrigin },
    room: inspectRoom(),
    notices,
    noticeInterval: inspectNoticeInterval(),
    retained,
    population,
    rows: page,
    next,
    joins: {
      deliveryToSpell: 'spell = memory_spells.id',
      measurementToDecision: decision?.inputs.length
        ? { decision: decision.identity, measurements: decision.inputs.map(input => input.measurement.identity) }
        : null,
      roomToDecision: null,
      noticeToMeasurement: noticeMeasurementJoin(notices),
    },
    missing: {
      sharedMeasurement: null,
      historicalRecords: null,
      noticeToMeasurement: null,
      historicalClaimToJob: null,
      calmMeasurementIdentity: null,
      reason:
        'Retained records contain the two latest records, one quiet ordinary admission and one eligible ordinary pressure gate. All inputs are sequential. The latest emitted notice retains its original report and baseline anchors when available. The notice interval retains only first/last qualifying report decisions and their observed count. Every intervening processed report must qualify and actual warning emissions break the active summary. Its bounds exclude later events, including events in the same millisecond. It proves no actual warning within those observed decision bounds, not continuous kernel calm, notification of all users or absence of reports lost before transmission. Coordinator exit loses both summaries. None supplies complete report history, a named queued-job rejection or process start. Separately recorded runs and launch linkage are required for starts. Missing raw fields and historical joins stay null.',
    },
  };
}

function noticeMeasurementJoin(notices: ReturnType<typeof inspectMemory>) {
  const noticeWorker = notices.notice?.report?.worker;
  return noticeWorker
    ? {
        report: noticeWorker.identity,
        measurements: noticeWorker.inputs.map(input => input.measurement.identity),
        spell: notices.notice!.spell,
        job: notices.notice!.job,
        kind: notices.notice!.kind,
      }
    : null;
}
