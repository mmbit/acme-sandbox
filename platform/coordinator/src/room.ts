// The worker's room. A slot starts a job only while enough of the worker's memory
// is free (worker.ts room), so a job that fills it stalls every other. The worker reports its room every minute:
// short or not, since when, each job's share (memory and cores, all its processes counted), and the claims its free slots
// would make if memory allowed. Short for STARVED_MS while those claims would start work is starvation:
// the projects view, `hq jobs` and the CEO's summary (summary.ts) say so while it lasts, and HQ's feed once per spell.
// The CEO decides whether the board needs to know. A spell the worker's shares can't end goes outside HQ (jam.ts).
import { db, remember, setting } from './db.ts';
import { publish } from './events.ts';
import { readyOn, findAgent, seatReadyFor, type ReadySeat } from './jobs.ts';
import { ceo } from './company.ts';
import * as jam from './jam.ts';
import type { Memory } from './eta.ts';
import * as lowmemory from './lowmemory.ts';
import * as meetingroom from './meetingroom.ts';
import { roomReported } from './startholds.ts';
import { reportWorkerRecords, STALE_MS } from './roomretention.ts';
import { inspectReportBoundary } from './inspection.ts';
import type { WorkerRecords } from '../../worker/src/roomrecords.ts';

export const inspectRoom = (now = Date.now()) => ({
  report: lastReport ?? null,
  reportStale: lastReport ? now - lastReport.at > STALE_MS : null,
  capacity: capacity ?? null,
  capacityStale: capacity ? now - capacity.at > STALE_MS : null,
});

export const STARVED_MS = 5 * 60_000;
type Share = { job: number; mb: number; cores: number };
type Room = {
  at: number;
  short: boolean;
  since?: number;
  free: number;
  jobs: Share[];
  waiting: number;
  gathering: number | null;
};
// A free slot's claim as the worker would make it (its claimOn): the seat, its engine, and the weekly reset a paced seat
// takes only work due to start before (pacedUntil).
type Claim = { seat: string; engine: string; pacedUntil?: number };
let lastReport: Room | undefined;
export type PlannerCapacity = {
  slots: Record<string, number>;
  seatRuns: Record<string, number>;
  room: number;
  memory?: Memory;
};
let capacity: { at: number; reading: PlannerCapacity } | undefined;
export const plannerCapacity = (at = Date.now()) =>
  capacity && at - capacity.at <= STALE_MS ? capacity.reading : null;
const capacities = (value: unknown): Record<string, number> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([, count]) => typeof count !== 'number' || !Number.isInteger(count) || count < 0)) return null;
  return Object.fromEntries(entries);
};
function recordCapacity(report: unknown, at: number) {
  if (!report || typeof report !== 'object') return;
  const given = report as Record<string, unknown>,
    slots = capacities(given.slots),
    seatRuns = capacities(given.seatRuns);
  if (!slots || !seatRuns || !Number.isInteger(given.room) || Number(given.room) < 0) return;
  const memory = memoryReading(given.memory);
  capacity = { at, reading: { slots, seatRuns, room: Number(given.room), ...(memory ? { memory } : {}) } };
}

function memoryReading(value: unknown): Memory | null {
  if (!value || typeof value !== 'object') return null;
  const memory = value as Memory;
  const numbers = [
    memory.at,
    memory.freeReserveMb,
    memory.defaultRunMb,
    memory.totalSlots,
    memory.heldSlots,
    memory.heldMb,
  ];
  if (!numbers.every(number => typeof number === 'number' && Number.isFinite(number) && number >= 0)) return null;
  if (typeof memory.availableMb !== 'number' || !Number.isFinite(memory.availableMb)) return null;
  if (!Number.isInteger(memory.totalSlots) || !Number.isInteger(memory.heldSlots)) return null;
  if (
    !Array.isArray(memory.starting) ||
    memory.starting.some(
      reservation =>
        !reservation || !Number.isFinite(reservation.until) || !Number.isFinite(reservation.mb) || reservation.mb < 0,
    )
  )
    return null;
  if (!memory.runningMb || typeof memory.runningMb !== 'object' || Array.isArray(memory.runningMb)) return null;
  if (
    Object.entries(memory.runningMb).some(
      ([job, mb]) =>
        !Number.isInteger(Number(job)) || (mb !== null && (typeof mb !== 'number' || !Number.isFinite(mb) || mb < 0)),
    )
  )
    return null;
  return memory;
}

const nonnegativeNumber = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
// Answers how many jobs only memory keeps from starting, which the worker weighs before it stops anything: none unless
// it's short.
export function reportRoom(
  workerReport: {
    short?: unknown;
    since?: unknown;
    free?: unknown;
    jobs?: unknown;
    claims?: unknown;
    capacity?: unknown;
    memory?: unknown;
    gathering?: unknown;
    records?: WorkerRecords;
  },
  now = Date.now(),
) {
  recordCapacity(workerReport.capacity, now);
  const jobs = (Array.isArray(workerReport.jobs) ? workerReport.jobs : [])
    .slice(0, 64)
    .flatMap((j: Record<string, unknown>) =>
      Number.isInteger(j?.job)
        ? [
            {
              job: j.job as number,
              mb: Math.round(nonnegativeNumber(j.mb)),
              cores: Math.round(nonnegativeNumber(j.cores) * 10) / 10,
            },
          ]
        : [],
    );
  for (const j of jobs) keepPeak.run(j.mb, j.job);
  const short = workerReport.short === true,
    since =
      short && nonnegativeNumber(workerReport.since) ? Math.min(nonnegativeNumber(workerReport.since), now) : undefined;
  const waiting = short ? waitingOn(workerReport.claims) : 0;
  lastReport = {
    at: now,
    short,
    since,
    free: Math.round(nonnegativeNumber(workerReport.free)),
    jobs: jobs.sort((x, y) => y.mb - x.mb),
    waiting,
    gathering: gatheringCount(workerReport.gathering),
  };
  retainReports(workerReport, lastReport.free, now);
  roomReported(short, since, now);
  const s = starved(now);
  if (s && setting('room.told') !== String(s.since)) tell(s, now);
  jam.watch(s && { since: s.since, free: s.free, waiting: s.waiting, jobs: lastReport.jobs }, now);
  return { waiting, ...meetingStatus(now) };
}

function retainReports(workerReport: Parameters<typeof reportRoom>[0], freeMb: number, now: number) {
  const notice = lowmemory.report(
    workerReport.memory,
    freeMb,
    now,
    workerReport.records?.room,
    workerReport.records?.source,
  );
  reportWorkerRecords(workerReport.records, now, notice);
  inspectReportBoundary(workerReport.records?.source);
}

const gatheringCount = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

// The most memory each job's minute reports ever gave it (jobs.peak_mb), and what a job is measured to need: its own peak,
// else the median of its agent's last MEASURED_FROM done jobs of its kind that have one; null when neither has been
// measured. Below the worker's room line a job starts only when that fits the room its claim carries (jobs.ts claim).
const MEASURED_FROM = 20;
const keepPeak = db.prepare('update jobs set peak_mb = max(coalesce(peak_mb, 0), ?) where id = ?');
const ownPeak = db.prepare('select peak_mb, agent, kind from jobs where id = ?');
const agentPeaks = db.prepare(
  `select peak_mb from jobs where agent = ? and kind = ? and status = 'done' and peak_mb is not null
  order by id desc limit ${MEASURED_FROM}`,
);
export function measuredMb(job: number): number | null {
  const own = ownPeak.get(job) as { peak_mb: number | null; agent: string; kind: string };
  if (own.peak_mb !== null) return own.peak_mb;
  return typicalMemory(own.agent, own.kind);
}

// Reserve each successful pause group's release for its waiter before considering the next waiter.
export function pauseBudget(running: number[], at: number) {
  const memory = plannerCapacity(at)?.memory;
  const occupants = (
    db
      .prepare("select id from jobs where id in (select value from json_each(?)) and kind != 'chat' and off_worker = 0")
      .all(JSON.stringify(running)) as { id: number }[]
  ).map(r => r.id);
  const demand = (id: number) => measuredMb(id) ?? memory?.defaultRunMb ?? 0;
  let slots = memory ? memory.totalSlots - memory.heldSlots - occupants.length : Infinity;
  let freeMb = memory
    ? memory.availableMb -
      memory.freeReserveMb -
      memory.heldMb -
      memory.starting.reduce((sum, r) => sum + (r.until > at ? r.mb : 0), 0)
    : Infinity;
  if (memory) {
    for (const [id, mb] of Object.entries(memory.runningMb)) {
      const job = db.prepare('select status from jobs where id = ?').get(Number(id)) as { status: string } | undefined;
      if (!job) slots--;
      else if (!occupants.includes(Number(id))) freeMb += mb ?? demand(Number(id));
    }
    for (const id of occupants) if (!(id in memory.runningMb)) freeMb -= demand(id);
  }
  const release = (ids: number[]) => ids.reduce((sum, id) => sum + (memory?.runningMb[id] ?? demand(id)), 0);
  return {
    fits: (waiter: number, victims: number[]) =>
      slots + victims.length > 0 && freeMb + release(victims) >= demand(waiter),
    reserve: (waiter: number, victims: number[]) => {
      slots += victims.length - 1;
      freeMb += release(victims) - demand(waiter);
    },
  };
}

export function measuredMemories(rows: { id: number; agent: string; kind: string }[]) {
  const peaks = db
    .prepare('select id, peak_mb from jobs where id in (select value from json_each(?))')
    .all(JSON.stringify(rows.map(row => row.id))) as { id: number; peak_mb: number | null }[];
  const own = new Map(peaks.map(row => [row.id, row.peak_mb]));
  const typical = new Map<string, number | null>();
  return new Map(
    rows.map(row => {
      const key = `${row.agent}:${row.kind}`;
      if (own.get(row.id) != null) return [row.id, own.get(row.id)!];
      if (!typical.has(key)) typical.set(key, typicalMemory(row.agent, row.kind));
      return [row.id, typical.get(key)!];
    }),
  );
}

function typicalMemory(agent: string, kind: string): number | null {
  const peaks = (agentPeaks.all(agent, kind) as { peak_mb: number }[]).map(r => r.peak_mb).sort((a, b) => a - b);
  if (!peaks.length) return null;
  const mid = peaks.length >> 1;
  return peaks.length % 2 ? peaks[mid] : Math.round((peaks[mid - 1] + peaks[mid]) / 2);
}

// The work those claims would start, counted as the stall alarm counts an engine's (jobs.ts readyOn): neither the
// intercom's nor downtime work, which waits for spare capacity by design.
function waitingOn(claims: unknown) {
  const seats = new Map<string, ReadySeat[]>();
  for (const c of (Array.isArray(claims) ? claims : []).slice(0, 16) as Partial<Claim>[]) {
    if (typeof c?.seat !== 'string' || typeof c.engine !== 'string') continue;
    const cli = (
      db.prepare('select coalesce(cli, engine) cli from seats where id = ?').get(c.seat) as { cli: string } | undefined
    )?.cli;
    const pacedUntil = Number.isInteger(c.pacedUntil) && c.pacedUntil! > 0 ? c.pacedUntil! : null;
    seats.set(c.engine, [...(seats.get(c.engine) ?? []), { id: c.seat, cli: cli ?? c.engine, pacedUntil }]);
  }
  return [...seats].reduce((n, [engine, on]) => n + readyOn(engine, on), 0);
}

// The spell under way, if any: since when, the worker's free memory, the job holding the most, and the work it keeps waiting.
function starved(now = Date.now()) {
  if (
    !lastReport?.short ||
    !lastReport.since ||
    now - lastReport.at > STALE_MS ||
    now - lastReport.since < STARVED_MS ||
    !lastReport.waiting
  )
    return undefined;
  const top = lastReport.jobs[0];
  return {
    since: lastReport.since,
    free: lastReport.free,
    waiting: lastReport.waiting,
    top: top && { ...top, agent: agentOf(top.job) },
  };
}
const agentOf = (job: number) =>
  (db.prepare('select agent from jobs where id = ?').get(job) as { agent: string } | undefined)?.agent;

// What `hq jobs`, the CEO's summary and the projects view show while it lasts, in words: the job holding the most by
// its number, or for the board by its agent alone (ids off).
function starvedLine(now = Date.now(), { ids = true } = {}) {
  const s = starved(now);
  if (!s) return undefined;
  const top =
    s.top &&
    (ids
      ? `job #${s.top.job}${s.top.agent ? ` (${s.top.agent})` : ''}`
      : s.top.agent && `${findAgent(s.top.agent)!.name}'s job`);
  const mins = Math.round((now - s.since) / 60_000),
    mostly = top ? `, mostly from ${top}` : '';
  return `No new jobs can start: the worker has been short of memory for ${mins} min${mostly}. ${s.waiting} job${s.waiting === 1 ? '' : 's'} could start if memory allowed.`;
}

export const getRoom = ({ board = false } = {}) => {
  const status = meetingStatus();
  const line = [starvedLine(Date.now(), { ids: !board }), status.line].filter(Boolean).join(' ');
  return { ...status, line: line || null };
};

function meetingStatus(now = Date.now()) {
  const planned = meetingroom.current(now);
  const m = planned.find(m => m.at <= now && (m.rests ?? 0) <= now) ?? planned[0];
  if (!m) return { meeting: null, line: null };
  const queued = meetingroom.queuedSeats(m.id);
  const runnersReady = queued.every(s => seatReadyFor(s.job, now));
  const held = queued.filter(s => s.slot && seatReadyFor(s.job, now, s.runner)).length;
  const remaining = queued.length - held;
  const fresh = lastReport && now - lastReport.at <= STALE_MS && lastReport.gathering !== null;
  const ready = fresh ? lastReport!.gathering! >= remaining && runnersReady : null;
  const state = m.at > now ? 'scheduled' : (m.rests ?? 0) > now ? 'resting' : 'waiting';
  const meeting = {
    id: m.id,
    at: m.at,
    state,
    runnersReady,
    held,
    seats: queued.length,
    ready,
    until: state === 'resting' ? m.rests! : meetingroom.until(m),
  };
  const line =
    state === 'scheduled'
      ? `Next meeting: room ${ready === null ? 'unknown' : ready ? 'ready now' : 'not ready yet'} for ${queued.length} seats.`
      : state === 'resting'
        ? `A meeting could not gather within ${meetingroom.HOLD_MS / 60_000} min. New work may start during its ${meetingroom.REST_MS / 60_000} min rest.`
        : !runnersReady
          ? 'A due meeting is waiting for ready runners. Other work may start while its runners are unavailable.'
          : `A meeting is waiting for room: ${held} of ${queued.length} seats held. Freed room goes to it before new ordinary work, for up to ${Math.ceil((meeting.until - now) / 60_000)} min.`;
  return { meeting, line };
}

// HQ's feed says so once a spell.
function tell(s: NonNullable<ReturnType<typeof starved>>, now: number) {
  remember('room.told', String(s.since));
  publish({ type: 'log', agent: ceo(), text: starvedLine(now)! });
}
