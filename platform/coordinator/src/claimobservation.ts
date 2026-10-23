// A configured, one-shot claim-plan cohort, with every call summarized by its refresh reason.
import { COMMIT } from './config.ts';
import { yamlFile } from './company.ts';
import { db } from './db.ts';

const TARGET_MS = 100;
export const SLOW_PLAY_MS = 300;

export type Reason = 'start' | 'new_job' | 'hq_log' | 'hq_status' | 'expiry' | 'kept';
type Summary = {
  count: number;
  errors: number;
  failures: number;
  under300: number;
  failures_under300: number;
  wall_ms: number;
  max_ms: number | null;
  cpu_user_ms: number;
  cpu_system_ms: number;
  cpu_max_ms: number | null;
};
type Cohort = {
  id: string;
  revision: string;
  started_at: number;
  ends_at: number;
  state: 'collecting' | 'complete' | 'interrupted';
  last_at: number | null;
  summary: Record<Reason, Summary>;
};
let active: Cohort | undefined;
const reasons: Reason[] = ['start', 'new_job', 'hq_log', 'hq_status', 'expiry', 'kept'];
const empty = (): Summary => ({
  count: 0,
  errors: 0,
  failures: 0,
  under300: 0,
  failures_under300: 0,
  wall_ms: 0,
  max_ms: null,
  cpu_user_ms: 0,
  cpu_system_ms: 0,
  cpu_max_ms: null,
});

db.exec('create table if not exists claim_observations (id text primary key, cohort text not null)');

export function start() {
  const configured = yamlFile('company/observations.yaml').claim_plans;
  if (!configured || active) return;
  const { id, duration_ms: durationMs } = configured;
  if (
    typeof id !== 'string' ||
    !id.trim() ||
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs > 2 ** 31 - 1
  )
    throw new Error('claim_plans needs an id and duration_ms within the timer range (1 to 2147483647)');
  const prior = db.prepare('select cohort from claim_observations where id = ?').get(id) as
    { cohort: string } | undefined;
  if (prior) {
    const cohort: Cohort = JSON.parse(prior.cohort);
    if (cohort.state === 'collecting') {
      cohort.state = 'interrupted';
      save(cohort);
    }
    return;
  }
  const at = Date.now();
  active = {
    id,
    revision: COMMIT,
    started_at: at,
    ends_at: at + durationMs,
    state: 'collecting',
    last_at: null,
    summary: Object.fromEntries(reasons.map(reason => [reason, empty()])) as Record<Reason, Summary>,
  };
  save(active);
  setTimeout(finish, durationMs).unref();
}

// Membership uses the actual entry clock, not current(now)'s planner clock. A call entering before the end belongs
// even if its synchronous play finishes after it. No event-loop turn can close the cohort during that play.
export function begin() {
  if (!active) return;
  const at = Date.now();
  if (at >= active.ends_at) return;
  return { at, wall: performance.now(), cpu: process.cpuUsage() };
}

export function record(started: ReturnType<typeof begin>, reason: Reason, error = false) {
  if (!started || !active) return;
  const wallMs = performance.now() - started.wall;
  const cpu = process.cpuUsage(started.cpu);
  const summary = active.summary[reason];
  summary.count++;
  summary.errors += +error;
  summary.failures += +(wallMs >= TARGET_MS);
  summary.under300 += +(wallMs < SLOW_PLAY_MS);
  summary.failures_under300 += +(wallMs >= TARGET_MS && wallMs < SLOW_PLAY_MS);
  summary.wall_ms += wallMs;
  summary.max_ms = Math.max(summary.max_ms ?? 0, wallMs);
  summary.cpu_user_ms += cpu.user / 1000;
  summary.cpu_system_ms += cpu.system / 1000;
  summary.cpu_max_ms = Math.max(summary.cpu_max_ms ?? 0, (cpu.user + cpu.system) / 1000);
  active.last_at = started.at;
  save(active);
}

function finish() {
  if (!active) return;
  active.state = 'complete';
  save(active);
  active = undefined;
}

function save(cohort: Cohort) {
  db.prepare(
    'insert into claim_observations (id, cohort) values (?, ?) on conflict(id) do update set cohort = excluded.cohort',
  ).run(cohort.id, JSON.stringify(describe(cohort)));
}

export function listCohorts() {
  const cohorts = db.prepare('select cohort from claim_observations order by rowid').all() as { cohort: string }[];
  return cohorts.map(row => describe(JSON.parse(row.cohort)));
}

function describe(cohort: Cohort) {
  const fresh = empty();
  for (const reason of reasons.filter(reason => reason !== 'kept')) {
    const summary = cohort.summary[reason];
    for (const key of [
      'count',
      'errors',
      'failures',
      'under300',
      'failures_under300',
      'wall_ms',
      'cpu_user_ms',
      'cpu_system_ms',
    ] as const)
      fresh[key] += summary[key];
    if (summary.max_ms !== null) fresh.max_ms = Math.max(fresh.max_ms ?? 0, summary.max_ms);
    if (summary.cpu_max_ms !== null) fresh.cpu_max_ms = Math.max(fresh.cpu_max_ms ?? 0, summary.cpu_max_ms);
  }
  return {
    ...cohort,
    fresh,
    kept: cohort.summary.kept,
    dropped: cohort.state === 'complete' ? 0 : null,
    coverage: cohort.state === 'complete' ? 'full interval' : 'incomplete interval',
    missing_fresh_reasons: reasons.filter(reason => reason !== 'kept' && cohort.summary[reason].count === 0),
    target_ms: TARGET_MS,
  };
}
