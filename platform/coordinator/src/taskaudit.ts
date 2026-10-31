// First saved estimates against own work and whole-task costs in an explicit completion window.
import { ORIGIN, PRIVATE, type JobOrigin } from './matching.ts';
import { db } from './db.ts';
import { workBranch } from './jobs.ts';
import { history, type GivenSize } from './sizes.ts';
import { isTask, taskTimes, type TaskTime } from './tasktime.ts';
import { INVALID_RUN, REBUILT_RUN, timingFlags } from './timing.ts';
import { spread, fractionalMinutes } from './arithmetic.ts';
import type { Turn } from './latency.ts';

const DAY_MS = 24 * 60 * 60_000;
export type AuditAsk = { days?: unknown; until?: unknown };
export function readWindow(ask: AuditAsk, now = Date.now()) {
  const days = ask.days === undefined ? 7 : Number(ask.days);
  if (ask.until !== undefined && (typeof ask.until !== 'string' || !INSTANT.test(ask.until))) return 400;
  const until = ask.until === undefined ? now : Date.parse(String(ask.until));
  if (!Number.isInteger(days) || days < 1 || days > 30 || !Number.isFinite(until) || until > now) return 400;
  return { days, since: new Date(until - days * DAY_MS).toISOString(), until: new Date(until).toISOString() };
}
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
type Window = Exclude<ReturnType<typeof readWindow>, number>;
type Candidate = {
  id: number;
  origin: JobOrigin;
  agent: string;
  title: string;
  created: string;
  finished: string;
  stage: string | null;
  round: number | null;
  kind: string;
  status: string;
  fix: number;
  preview: number;
  private: number;
  merged_at: string | null;
  has_pr: number;
  replacement: number;
};
type Run = {
  started: string;
  ended: string | null;
  ended_as: string | null;
  seat: string | null;
  rebuilt: number;
  invalid_time: number;
};
type Prediction = {
  job: number;
  made: string;
  agent_ms: number;
  slow_agent_ms: number | null;
  picks: string;
  basis: string;
  guessed: number;
  start: number | null;
  done: number | null;
  eta: number | null;
};
type EstimateTiming = 'before_work' | 'during_work' | 'after_completion' | 'unknown';
type Estimate = Partial<GivenSize> & {
  source: 'caller' | 'prediction';
  at: string;
  by: string;
  agent_ms: number;
  timing: EstimateTiming;
};
type AuditRow = Pick<Candidate, 'id' | 'origin' | 'agent' | 'title' | 'created' | 'finished'> & {
  role: 'original' | 'followup';
  first_estimate: Estimate | null;
  revisions: Estimate[];
  prediction: (Prediction & { timing: EstimateTiming }) | null;
  saved_sizes: GivenSize[];
  actual_work_ms: number | null;
  actual_work_minutes: number | null;
  whole: TaskTime;
  work_miss_minutes: number | null;
  overhead_minutes: number;
  timing_quality: string[];
  runs: Run[];
  unmerged: boolean;
};
export type TaskAudit = Awaited<ReturnType<typeof report>>;

export async function report(window: Window, turn: Turn) {
  const candidates = db.prepare(CANDIDATES).all(window.since, window.until) as Candidate[];
  await turn('the finished task cohort');
  const measureTask = taskTimes(Date.parse(window.until));
  const rows: AuditRow[] = [];
  for (const job of candidates) {
    if (!job.private) rows.push(readTask(job, measureTask, window.until));
    await turn('a task and its saved estimates');
  }
  return {
    window: { selection: 'own_completion' as const, since: window.since, until: window.until },
    ...summarize(candidates, rows),
    rows,
  };
}

// Own completion selects the cohort. The same exclusive cutoff bounds its observed reviews and fixes.
const CANDIDATES = `select j.id, ${ORIGIN} origin, j.agent, j.title, j.created, j.finished, j.stage, j.round, j.kind, j.status,
  exists(select 1 from review_fix_tasks f where f.job = j.id) fix,
  exists(select 1 from card_jobs c where c.job = j.id) preview,
  ${PRIVATE} private,
  exists(select 1 from prs p where p.branch = ${workBranch('j')}) has_pr,
  (select min(p.merged_at) from prs p where p.branch = ${workBranch('j')}
    and p.status = 'merged' and p.merged_at >= j.finished) merged_at,
  exists(select 1 from job_replacement_links l where l.job = j.id) replacement
  from jobs j indexed by jobs_history where j.kind = 'work' and j.status = 'done'
    and j.finished >= ? and j.finished < ? order by j.id`;

function readTask(job: Candidate, measureTask: ReturnType<typeof taskTimes>, until: string): AuditRow {
  const runs = db
    .prepare(
      `select started, ended, ended_as, seat, ${REBUILT_RUN} rebuilt,
    ${INVALID_RUN} invalid_time from runs where job = ? order by started`,
    )
    .all(job.id) as Run[];
  const estimates = savedEstimates(job, runs);
  const measuredRuns = runs.filter(r => r.ended && !r.invalid_time);
  const actualMs = measuredRuns.length
    ? measuredRuns.reduce(
        (sum, r) => sum + Math.max(0, Math.min(Date.parse(r.ended!), Date.parse(until)) - Date.parse(r.started)),
        0,
      )
    : null;
  const whole = measureTask(job);
  const { id, origin, agent, title, created, finished } = job;
  return {
    id,
    origin,
    agent,
    title,
    created,
    finished,
    role: isTask(job) ? 'original' : 'followup',
    ...estimates,
    actual_work_ms: actualMs,
    actual_work_minutes: actualMs === null ? null : fractionalMinutes(actualMs),
    whole,
    work_miss_minutes:
      estimates.first_estimate && actualMs !== null
        ? fractionalMinutes(actualMs - estimates.first_estimate.agent_ms)
        : null,
    overhead_minutes: fractionalMinutes((whole.agent_minutes - whole.split.work) * 60_000),
    timing_quality: quality(job, runs),
    runs,
    unmerged: !!job.has_pr && (!job.merged_at || job.merged_at >= until),
  };
}

function savedEstimates(job: Candidate, runs: Run[]) {
  const prediction = db
    .prepare(
      `select job, made, agent_ms, slow_agent_ms, picks, basis, guessed, start, done, eta
    from predictions where job = ?`,
    )
    .get(job.id) as Prediction | undefined;
  const timing = (at: string): EstimateTiming => {
    if (at >= job.finished) return 'after_completion';
    if (!runs.length) return 'unknown';
    return at <= runs[0].started ? 'before_work' : 'during_work';
  };
  const saved = history(job.id);
  const callers: Estimate[] = [...saved]
    .reverse()
    .map(size => ({ ...size, source: 'caller', timing: timing(size.at) }));
  const tool: Estimate[] = prediction
    ? [
        {
          source: 'prediction',
          at: prediction.made,
          by: 'tool',
          agent_ms: prediction.agent_ms,
          timing: timing(prediction.made),
        },
      ]
    : [];
  // At the same instant the caller's saved size takes precedence over the automatic prediction.
  const first = [...callers.filter(size => !size.revised), ...tool].sort((a, b) => a.at.localeCompare(b.at))[0] ?? null;
  return {
    first_estimate: first,
    revisions: callers.filter(size => size !== first),
    prediction: prediction ? { ...prediction, timing: timing(prediction.made) } : null,
    saved_sizes: saved,
  };
}

function quality(job: Candidate, runs: Run[]) {
  if (!runs.length) return ['missing_runs'];
  const flags: string[] = timingFlags({
    runs: runs.length,
    outcomes: [...new Set(runs.map(r => r.ended_as ?? 'unknown'))].join(','),
    invalid_runs: runs.filter(r => r.ended && r.invalid_time).length,
    unknown_seats: runs.filter(r => r.seat === null).length,
    is_replacement: job.replacement,
  });
  if (runs.some(r => !r.ended)) flags.push('open_runs');
  return flags;
}

function summarize(candidates: Candidate[], rows: AuditRow[]) {
  const originals = rows.filter(row => row.role === 'original');
  const scored = originals.filter(
    row => row.first_estimate?.timing === 'before_work' && !row.first_estimate.revised && !row.timing_quality.length,
  );
  const agents = scored.filter(row => row.origin !== 'carry');
  const carries = scored.filter(row => row.origin === 'carry');
  const complete = originals.filter(row => row.whole.complete);
  const split = { reviews: 0, fixes: 0, syncs: 0, previews: 0 };
  for (const row of complete)
    for (const phase of Object.keys(split) as (keyof typeof split)[]) split[phase] += row.whole.split[phase];
  const undated = db
    .prepare(
      `select count(*) count from jobs where kind = 'work' and status = 'done'
    and finished is null`,
    )
    .get() as { count: number };
  return {
    coverage: {
      finished: candidates.length,
      original_tasks: originals.length,
      followup_views: rows.length - originals.length,
      private_tasks: candidates.length - rows.length,
      missing_estimates: originals.filter(row => !row.first_estimate).length,
      missing_runs: originals.filter(row => row.timing_quality.includes('missing_runs')).length,
      incomplete_totals: originals.filter(row => !row.whole.complete).length,
      unmerged_tasks: originals.filter(row => row.unmerged).length,
      scored: agents.length,
      undated_completions: undated.count,
      timing_reasons: counts(originals.flatMap(row => row.timing_quality)),
      whole_timing_reasons: counts(originals.flatMap(row => row.whole.flags)),
      estimate_timing: counts(originals.map(row => row.first_estimate?.timing ?? 'missing')),
    },
    work_size: spread(agents.map(row => [row.first_estimate!.agent_ms, row.actual_work_ms!])),
    carry_checks: spread(
      carries.map(row => [row.first_estimate!.agent_ms, row.actual_work_ms!]),
      0,
    ),
    overhead: {
      tasks: complete.length,
      agent_minutes: fractionalMinutes(Object.values(split).reduce((sum, n) => sum + n, 0) * 60_000),
      split,
    },
  };
}

const counts = (reasons: string[]) =>
  Object.fromEntries([...Map.groupBy(reasons, reason => reason)].map(([reason, rows]) => [reason, rows.length]));
