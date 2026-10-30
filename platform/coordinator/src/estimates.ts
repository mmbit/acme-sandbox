// Scope evidence for caller estimates, saved task sizes, and timing-quality counts.
import { db } from './db.ts';
import { isOpenJob } from './jobs.ts';
import {
  ORIGIN,
  pastJobs,
  cleanPastJobs,
  timingAudit,
  RUN_COLUMNS,
  RUN_JOIN,
  type JobOrigin,
  type PastJob,
  type Run,
  type Work,
} from './matching.ts';
import { median } from './arithmetic.ts';
import { taskTimes } from './tasktime.ts';
import { seatHeadroom } from './headroom.ts';
import * as predictions from './predictions.ts';
import * as forecast from './forecast.ts';
import type { Outlook } from './eta.ts';

export type Ask = {
  q?: unknown;
  agent?: unknown;
  path?: unknown;
  limit?: unknown;
};

export function audit(pool = pastJobs()) {
  const measured = timingAudit(pool);
  const missing = db
    .prepare(
      `select count(*) total,
    sum(not exists(select 1 from runs r where r.job = j.id)) missing_runs,
    sum(exists(select 1 from runs r where r.job = j.id and r.ended is null)) open_runs
    from jobs j where j.kind = 'work' and j.status = 'done'`,
    )
    .get() as { total: number; missing_runs: number | null; open_runs: number | null };
  return {
    ...measured,
    total: missing.total,
    excluded: missing.total - measured.clean,
    reasons: { ...measured.reasons, missing_runs: missing.missing_runs ?? 0, open_runs: missing.open_runs ?? 0 },
  };
}

export function estimate(ask: Ask) {
  const asked = readAsk(ask);
  if (typeof asked === 'number') return asked;
  const { q, agent, path, limit } = asked;
  const inFolder = (j: PastJob) => !path || (JSON.parse(j.files) as string[]).some(f => f.startsWith(path));
  const past = pastJobs();
  const measureTask = taskTimes();
  const quality = audit(past);
  const pool = cleanPastJobs(past).filter(inFolder);
  const like = q.match(/^#(\d+)$/)?.[1];
  if (!q) {
    const latest = pool.filter(j => !agent || j.agent === agent).sort((a, b) => b.id - a.id);
    return { jobs: latest.slice(0, limit).map(j => shown(j, pool, measureTask)), quality, seats: seatHeadroom() };
  }
  const job = like ? jobOf(Number(like)) : undefined;
  if (like && !job) return 404;
  const work: Work = job ?? { title: q, origin: 'work', agent: agent || undefined };
  const own = job && past.find(j => j.id === job.id);
  // a queued job's own: the prediction stored as it was queued, which its outlook plays too
  const sized =
    (job?.open && predictions.stored(job.id, past)) ||
    predictions.predict(
      work,
      pool.filter(j => j !== own),
    );
  const saved = job?.open ? predictions.sizeHistory(job.id)[0] : undefined;
  const compared = saved ? past.filter(j => !j.customers && !j.about_keys && saved.refs.includes(j.id)) : sized.picks;
  return {
    quality,
    ...(own ? { job: shown(own, pool, measureTask) } : {}),
    jobs: compared.slice(0, limit).map(j => shown(j, pool, measureTask)),
    ...(job?.open
      ? {
          estimate: {
            agent_minutes: minutes(saved?.agent_ms ?? sized.size.agent_ms),
            compared: compared.length,
            basis: sized.basis,
            guessed: sized.guessed,
          },
        }
      : {}),
    // a queued job's outlook, and its sizes, the one that counts first (predictions.ts sizeHistory)
    ...(job?.open ? { outlook: openOutlook(job.id), sizes: predictions.sizeHistory(job.id).map(shownSize) } : {}),
    typical: typical(compared),
    seats: seatHeadroom(),
  };
}

// The ask, read and checked: a bad one is a 400.
type Asked = { q: string; agent: string; path: string; limit: number };
function readAsk(ask: Ask): Asked | 400 {
  const q = String(ask.q ?? '').trim(),
    agent = String(ask.agent ?? '').trim(),
    path = String(ask.path ?? '').trim();
  const limit = Math.min(20, Math.max(1, Math.round(Number(ask.limit)) || 8));
  if (q.length > 500 || path.length > 200 || (path && !/^[\w./-]+$/.test(path))) return 400;
  return { q, agent, path, limit };
}

// Job #n as work to size: its title, origin, agent and run (a scheduled job's),
// and whether it's open (its outlook is the queue's own then).
function jobOf(id: number) {
  const row = db
    .prepare(
      `select j.id, j.title, j.agent, j.status, ${ORIGIN} origin, ${RUN_COLUMNS} from jobs j ${RUN_JOIN} where j.id = ?`,
    )
    .get(id) as ({ id: number; title: string; agent: string; status: string; origin: JobOrigin } & Run) | undefined;
  return row && { ...row, open: isOpenJob(row) };
}

// A job queued already: its outlook from its stored size, and the size too where it has one. Read from HQ's latest play
// (forecast.ts current), never played for the asking: a play holds HQ for seconds.
function openOutlook(id: number) {
  const { usual, slow } = forecast.current();
  const seen = usual.get(id);
  return seen ? shownOutlook(seen, slow.get(id)) : null;
}

// held: the time a promise holds to, the one the summary's late line gives (predictions.heldTo)
const shownOutlook = (o: Outlook, slow?: Outlook) => ({
  ...o,
  left_minutes: minutes(o.left_ms),
  held: slow ? predictions.heldTo(o, slow) : null,
});
const minutes = (ms: number) => Math.round(ms / 60_000);
const shownSize = (s: ReturnType<typeof predictions.sizeHistory>[number]) => ({
  by: s.by,
  at: s.at,
  agent_minutes: minutes(s.agent_ms),
  low_minutes: s.low_ms === null ? null : minutes(s.low_ms),
  high_minutes: s.high_ms === null ? null : minutes(s.high_ms),
  refs: s.refs,
  why: s.why,
});

// A job whose seat spend per agent hour is under a third of its engine's usual took its hours mostly waiting on tools
// that use no tokens (renders, long test suites): its hours and its spend are judged apart.
function shown(j: PastJob, pool: PastJob[], measureTask: ReturnType<typeof taskTimes>) {
  const scope = db.prepare('select prompt, result, customers from jobs where id = ?').get(j.id) as {
    prompt: string;
    result: string | null;
    customers: number;
  };
  const usual = median(
    pool
      .filter(priced)
      .filter(o => o.engine === j.engine && o.unit === j.unit && o.agent_ms >= 10 * 60_000)
      .map(rate),
  );
  const files = (JSON.parse(j.files) as string[]).length;
  return {
    id: j.id,
    agent: j.agent,
    title: j.title,
    engine: j.engine,
    origin: j.origin,
    finished: j.finished,
    agent_minutes: minutes(j.agent_ms),
    whole: measureTask(j),
    wall_minutes: j.wall_ms === null ? null : minutes(j.wall_ms),
    runs: j.runs,
    rebuilt: j.rebuilt > 0,
    spend: j.spend === null ? null : Math.round(j.spend * 100) / 100,
    unit: j.unit,
    files,
    // Customer details and credential-call scopes never become comparison material.
    brief: scope.customers || j.about_keys ? null : scope.prompt,
    report: scope.customers || j.about_keys ? null : scope.result,
    changed_files: JSON.parse(j.files) as string[],
    added: j.added,
    removed: j.removed,
    timing_quality: j.timing_flags ?? [],
    pr: j.pr === null ? null : { number: j.pr, status: j.pr_status, merged_at: j.merged_at },
    tool_bound: usual !== null && priced(j) && j.agent_ms >= 10 * 60_000 && rate(j) < usual / 3,
  };
}
const priced = (j: PastJob): j is PastJob & { spend: number } => j.spend !== null;
const rate = (j: PastJob & { spend: number }) => j.spend / Math.max(j.agent_ms, 60_000);

// The spread of the picks' agent time, and their usual seat spend.
function typical(jobs: PastJob[]) {
  if (jobs.length < 3) return null;
  const sorted = jobs.map(j => j.agent_ms / 60_000).sort((a, b) => a - b);
  const at = (share: number) => Math.round(sorted[Math.floor(share * (sorted.length - 1))]);
  const reported = jobs.filter(priced);
  const units = new Set(reported.map(j => j.unit));
  const spend = units.size === 1 ? median(reported.map(j => j.spend)) : null;
  return { agent_minutes: at(0.5), low: at(0.25), high: at(0.75), spend, unit: spend === null ? null : [...units][0] };
}
