// One explicitly armed memory inspection attempt, two write-once receipts and one terminal disposition.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { COMMIT } from './config.ts';
import { infra } from './company.ts';
import { db, inOneStep, afterStep } from './db.ts';
import { inspectWorkerRecords, workerRecordSource, sameSession, STALE_MS } from './roomretention.ts';
import { beginNoticeObservation, inspectNoticeReceipt } from './noticeinterval.ts';
import { inspectPressure } from './pressureinspection.ts';
import type { WorkerRecords } from '../../worker/src/roomrecords.ts';

const inspectionCoordinator = () => ({ pid: process.pid, startedAt: performance.timeOrigin, revision: COMMIT });
type Adoption = {
  coordinator: ReturnType<typeof inspectionCoordinator>;
  worker: WorkerRecords['source'];
  workerDigest: string;
  verifiedAt: number;
  authority: string;
};
type Arm = Adoption & { id: string; armedAt: number; acceptedAt: number; closesAt: number; by: string };
type Population = 'notice' | 'pressure';
type Receipt = { inspectedAt: number; adoption: Arm; agesAtInspection: Record<string, unknown>; inspection: unknown };
type Disposition = {
  kind: 'complete' | 'expired' | 'interrupted';
  at: number;
  reason: string;
  missing: Population[];
  gaps: Record<string, string>;
};
type Attempt = { arm: Arm; notice: Receipt | null; pressure: Receipt | null; terminal: Disposition | null };
type Stored = { arm: string; notice: string | null; pressure: string | null; terminal: string | null };
let expiry: NodeJS.Timeout | undefined;
let observing = false;

// A singleton prevents a new name from replacing or rearming the separately authorized attempt.
db.exec(`create table if not exists memory_inspection (
  singleton integer primary key check(singleton = 1), arm text not null,
  notice text, pressure text, terminal text)`);

// Only the coordinator starts this lifetime. Other database users may import the report modules.
export function startInspection() {
  const prior = load();
  if (prior && !prior.terminal && !isDeepStrictEqual(prior.arm.coordinator, inspectionCoordinator()))
    finish(
      'interrupted',
      'Coordinator lifetime changed. The actual exit instant and missing populations are unknown.',
      Date.now(),
    );
  process.once('exit', code => interruptInspection(`Coordinator process exited with code ${code}.`));
}

export function inspectionBinding() {
  return {
    coordinator: inspectionCoordinator(),
    worker: workerRecordSource(),
    existingAttempt: storedArm()?.id ?? null,
  };
}

export function armInspection(given: Record<string, unknown>, by: string, now = Date.now()) {
  if (!given || typeof given !== 'object' || Array.isArray(given)) return 'Supply an adoption binding object.';
  if (storedArm()) return 'The one inspection attempt already exists. Read its handoff. Rearming is not permitted.';
  const problem = armProblem(given, now);
  if (problem) return problem;
  const { coordinator, worker, workerDigest, verifiedAt, authority, armedAt, closesAt } = given;
  const arm = {
    coordinator,
    worker,
    workerDigest,
    verifiedAt,
    authority,
    armedAt,
    closesAt,
    id: randomUUID(),
    acceptedAt: now,
    by,
  } as Arm;
  db.prepare('insert into memory_inspection (singleton, arm) values (1, ?)').run(JSON.stringify(arm));
  afterStep(() => {
    beginNoticeObservation(arm.armedAt);
    observing = true;
    expiry = setTimeout(() => expireInspection(), arm.closesAt - Date.now());
    expiry.unref();
  });
  return { arm };
}

function armProblem(given: Record<string, unknown>, now: number) {
  const budgetMs = Number(infra().MEMORY_INSPECTION_BUDGET_MS ?? 0);
  if (budgetMs === 0)
    return 'No observation budget is authorized. Configure MEMORY_INSPECTION_BUDGET_MS before arming.';
  // Node timers cannot represent a delay beyond a signed 32-bit integer.
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 0 || budgetMs > 2_147_483_647)
    throw new Error('company/infra.env MEMORY_INSPECTION_BUDGET_MS must be an integer from 0 to 2147483647.');
  const { armedAt, closesAt, coordinator, worker, workerDigest, verifiedAt, authority } = given;
  if (!Number.isSafeInteger(armedAt)) return 'Supply armedAt as an integer Unix epoch millisecond timestamp.';
  if (!Number.isSafeInteger(closesAt)) return 'Supply closesAt as an integer Unix epoch millisecond timestamp.';
  if (Number(closesAt) - Number(armedAt) !== budgetMs)
    return `Record closesAt exactly ${budgetMs} ms after armedAt before arming.`;
  if (Number(armedAt) > now) return 'armedAt is in the future. Submit the binding inside its recorded bounds.';
  if (Number(closesAt) <= now) return 'closesAt has passed. Stop this attempt without rearming.';
  if (!Number.isSafeInteger(verifiedAt)) return 'Supply verifiedAt as an integer Unix epoch millisecond timestamp.';
  if (Number(verifiedAt) > now) return 'verifiedAt is in the future. Verify adoption using the actual current time.';
  if (now - Number(verifiedAt) > STALE_MS)
    return `verifiedAt is ${now - Number(verifiedAt)} ms old. Adoption must be verified within ${STALE_MS} ms.`;
  if (typeof authority !== 'string' || !authority.trim()) return 'Supply the released authority in authority.';
  if (typeof workerDigest !== 'string' || !/^[a-f0-9]{64}$/.test(workerDigest))
    return 'Supply workerDigest as the verified 64-character lowercase hexadecimal SHA-256 digest.';
  if (!isDeepStrictEqual(coordinator, inspectionCoordinator()) || COMMIT === 'dev')
    return 'The verified coordinator revision and PID/start must match this released coordinator.';
  const current = workerRecordSource();
  if (!current || !isDeepStrictEqual(worker, current))
    return 'The verified worker PID/start/random session must match the naturally reporting worker.';
  return null;
}

// This runs only after both notice decisions and retained worker updates for the natural report have finished.
export function inspectReportBoundary(current: WorkerRecords['source'] | undefined, now = Date.now()) {
  if (!observing) return;
  const attempt = load();
  if (!attempt || attempt.terminal) return;
  if (now >= attempt.arm.closesAt) {
    expireInspection(now);
    return;
  }
  if (current && !sameSession(attempt.arm.worker, current)) {
    finish('interrupted', 'Worker lifetime changed. Missing populations remain unknown.', now);
    return;
  }
  if (now < attempt.arm.acceptedAt || !current) return;
  const notice = !attempt.notice && inspectNoticeReceipt(attempt.arm.armedAt, now);
  const pressure =
    !attempt.pressure &&
    inspectPressure(inspectWorkerRecords(now).pressure, attempt.arm.worker, attempt.arm.armedAt, now);
  if (!notice && !pressure) return;
  inOneStep(() => {
    if (notice) preserve('notice', notice, attempt.arm, now);
    if (pressure) preserve('pressure', pressure, attempt.arm, now);
    const saved = load()!;
    if (saved.notice && saved.pressure) finish('complete', 'Both authorized inspections are preserved.', now);
  });
}

function preserve(
  population: Population,
  inspection: { ages: Record<string, unknown> },
  arm: Arm,
  inspectedAt: number,
) {
  const receipt: Receipt = { inspectedAt, adoption: arm, agesAtInspection: inspection.ages, inspection };
  const statement =
    population === 'notice'
      ? 'update memory_inspection set notice = ? where singleton = 1 and notice is null and terminal is null'
      : 'update memory_inspection set pressure = ? where singleton = 1 and pressure is null and terminal is null';
  db.prepare(statement).run(JSON.stringify(receipt));
}

export function expireInspection(now = Date.now()) {
  const attempt = load();
  if (attempt && !attempt.terminal && now >= attempt.arm.closesAt)
    finish('expired', 'The finite observation budget closed. No extension or replacement is permitted.', now);
}

export function interruptInspection(reason: string, now = Date.now()) {
  const attempt = load();
  if (!attempt || attempt.terminal) return;
  if (now >= attempt.arm.closesAt) expireInspection(now);
  else finish('interrupted', reason, now);
}

function finish(kind: Disposition['kind'], reason: string, at: number) {
  const attempt = load()!;
  const missing = (['notice', 'pressure'] as const).filter(population => !attempt[population]);
  const gaps = Object.fromEntries(
    missing.map(population => [
      population,
      'No qualifying authorized inspection preserved. Opportunity, stale inputs, nonqualification, supersession, loss and untransmitted work remain unknown.',
    ]),
  );
  const terminal: Disposition = { kind, at, reason, missing, gaps };
  db.prepare('update memory_inspection set terminal = ? where singleton = 1 and terminal is null').run(
    JSON.stringify(terminal),
  );
  afterStep(() => {
    clearTimeout(expiry);
    observing = false;
  });
}

export function readInspection(id: unknown, now = Date.now()) {
  let attempt = load();
  if (!attempt || attempt.arm.id !== id) return null;
  if (!attempt.terminal && now >= attempt.arm.closesAt) {
    expireInspection(now);
    attempt = load()!;
  }
  const describe = (receipt: Receipt | null) =>
    receipt && {
      ...receipt,
      agesAtRetrieval: laterAges(receipt.agesAtInspection, now - receipt.inspectedAt),
      retrieval: {
        at: now,
        historical: true,
        elapsedSinceInspectionMs: now - receipt.inspectedAt,
        currentSessionRoom: false,
        qualificationAtInspection: true,
      },
    };
  return {
    arm: attempt.arm,
    notice: describe(attempt.notice),
    pressure: describe(attempt.pressure),
    terminal: attempt.terminal,
  };
}

function laterAges(ages: unknown, elapsedMs: number): unknown {
  if (typeof ages === 'number') return ages + elapsedMs;
  if (Array.isArray(ages)) return ages.map(age => laterAges(age, elapsedMs));
  if (ages && typeof ages === 'object')
    return Object.fromEntries(Object.entries(ages).map(([key, age]) => [key, laterAges(age, elapsedMs)]));
  return ages;
}

function storedArm(): Arm | null {
  const row = db.prepare('select arm from memory_inspection where singleton = 1').get() as { arm: string } | undefined;
  return row ? JSON.parse(row.arm) : null;
}

function load(): Attempt | null {
  const row = db.prepare('select arm, notice, pressure, terminal from memory_inspection where singleton = 1').get() as
    Stored | undefined;
  if (!row) return null;
  return {
    arm: JSON.parse(row.arm),
    notice: row.notice && JSON.parse(row.notice),
    pressure: row.pressure && JSON.parse(row.pressure),
    terminal: row.terminal && JSON.parse(row.terminal),
  };
}
