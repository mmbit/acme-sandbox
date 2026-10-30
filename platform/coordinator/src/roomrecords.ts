// Read-only access to retained worker room, notice and run records.
import { db } from './db.ts';
import { REBUILT_RUN } from './timing.ts';
import { inspectRoom } from './room.ts';
import { inspectMemory } from './lowmemory.ts';
import { inspectWorkerRecords } from './roomretention.ts';

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
  const decision = retained.decision?.record;
  return {
    inspectedAt: Date.now(),
    coordinator: { pid: process.pid, startedAt: performance.timeOrigin },
    room: inspectRoom(),
    notices: inspectMemory(),
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
      noticeToMeasurement: null,
    },
    missing: {
      sharedMeasurement: null,
      historicalRecords: null,
      noticeToMeasurement: null,
      historicalClaimToJob: null,
      calmMeasurementIdentity: null,
      reason:
        'Retained records contain only the latest room report and latest select-claim decision, each with its own sequential source reads. No atomic room measurement or historical reconstruction is available. Only a matching latest claim answer can supply a job identity. A claimed job is not proof that its process started. Chat and held-seat selection bypass memory reads. Calm baseline identity and notice-history joins remain unavailable. Replacement can lose a natural pressure case before inspection. Missing raw fields stay null.',
    },
  };
}
