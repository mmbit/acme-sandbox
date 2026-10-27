// Done jobs like a piece of work, the ones an estimate stands on: jobs of the same origin by the same agent, the words
// of its title deciding which, each word weighed by how rare it is among past titles. A scheduled job stands on its own
// schedule entry's runs first.
import { db, inStep, onUndo, prepared } from './db.ts';
// (the runs table, which the pool is read from and counted on)
import './agenttime.ts';
import { keysCondition } from './chat.ts';
import { workBranch } from './jobs.ts';
import { mean, wholeSeconds } from './arithmetic.ts';
import { timingFlags, type TimingEvidence, type TimingFlag } from './timing.ts';

// A work job's origin, how it was made: work an agent queued (or a pull request's re-land), the author's fixes for a
// review or the board's notes, a pull request only brought up to date with main, or a job HQ made on its own (the
// board's answer, a message, a notice).
export type JobOrigin = 'work' | 'fix' | 'merge' | 'hq';
export const ORIGIN = `case when j.stage = 'feedback' or j.stage = 'fix' and j.round is not null then 'fix'
  when j.stage = 'fix' then 'merge' when j.queued_by is not null or j.pr is not null then 'work' else 'hq' end`;

export type PastJob = {
  id: number;
  agent: string;
  title: string;
  engine: string;
  origin: JobOrigin;
  created: string;
  finished: string;
  agent_ms: number;
  wall_ms: number | null;
  runs: number;
  rebuilt: number;
  spend: number | null;
  unit: '$' | 'tokens';
  pr: number | null;
  pr_status: string | null;
  merged_at: string | null;
  files: string;
  // the lines its pull request added and removed once merged (merged.ts), null when unknown
  added: number | null;
  removed: number | null;
  thread: string | null;
  timing_flags?: TimingFlag[];
  customers?: number;
  about_keys?: number;
} & Run;

// A scheduled job's run (schedule.ts schedule_runs): its entry, the entry's routine, and the slot run() puts at the end
// of its title. None of them for any other job.
export type Run = { entry: string | null; routine: string | null; slot: string | null };
const RUN = 'select id entry, routine, slot from schedule_runs where job = ?';
export const runOf = (job: number): Run =>
  (db.prepare(RUN).get(job) as Run | undefined) ?? { entry: null, routine: null, slot: null };
export const RUN_COLUMNS = 's.id entry, s.routine, s.slot',
  RUN_JOIN = 'left join schedule_runs s on s.job = j.id';

// Done work with its runs: agent time, start to finish (waits included), its seat spend (the API-equivalent price
// where the engine reports one, tokens where it doesn't; none where no usage was reported) and its latest pull request.
// (made at its first use: jobs.ts, whose workBranch it reads, imports the deadline clock that reads this)
// The runs summed by job first, then each one's job by its id through db.ts jobs_history: `cross join` keeps that order
// whatever the planner's statistics say. Without it, with stale statistics (pragma optimize reads a table again only
// once it grew tenfold), the planner scans every done job and sums the runs again for each, for minutes, and a
// just-queued job is sized on the spot (predictions.ts recordQueued).
// Credential-call follow-ups include transcripts, even when no tool marked them as holding keys. With `only`, just
// those jobs (an estimate's references: sizes.ts), their runs and usage read by job instead of every one; without, the
// runs and usage of done work only.
// Whether a job replaces another is read from the replacement links as one set (`in`), so no job's row is fetched for it..
const past = (only = false) => {
  const of = only
    ? 'where job in (select value from json_each(:only))'
    : `where job in (select id from jobs indexed by jobs_history where kind = 'work' and status = 'done')`;
  return `select j.id, j.agent, j.title, j.engine, ${ORIGIN} origin, j.created, coalesce(j.finished, r.last) finished,
    r.agent_ms, r.runs, r.rebuilt, (julianday(coalesce(j.finished, r.last)) - julianday(r.first)) * 86400000 wall_ms,
    coalesce(u.cost, u.tokens) spend, iif(u.cost is null, 'tokens', '$') unit,
    p.number pr, p.status pr_status, p.merged_at, coalesce(p.files, '[]') files, p.added, p.removed, j.thread, ${RUN_COLUMNS}, r.outcomes, r.invalid_runs, r.unknown_seats, j.customers,
    (j.about_keys or exists(select 1 from calls c where c.job = j.id and ${keysCondition()})) about_keys,
    j.id in (select job from job_replacement_links) is_replacement
  from (select job, count(*) runs, sum(ended_as = 'rebuilt' or seat is null) rebuilt, min(started) first, max(ended) last,
    sum((julianday(ended) - julianday(started)) * 86400000) agent_ms,
    group_concat(distinct coalesce(ended_as, 'unknown')) outcomes, sum(seat is null) unknown_seats,
    sum(julianday(ended) is null or julianday(started) is null or julianday(ended) <= julianday(started)) invalid_runs
    from runs ${of} group by job) r
  cross join jobs j indexed by jobs_history on j.id = r.job
  left join (select job, sum(cost) cost, sum(input + cache_write + cache_read + output) tokens from usage ${of} group by job) u
    on u.job = j.id
  left join (select branch, max(number) number from prs group by branch) b on b.branch = ${workBranch('j')}
  left join prs p on p.number = b.number
  ${RUN_JOIN}
  where j.kind = 'work' and j.status = 'done' and not exists (select 1 from runs o where o.job = j.id and o.ended is null)
  order by r.job`;
};

export const pastJobs = (only?: number[]): PastJob[] => (only ? readPast(only) : keptPool());
function readPast(only?: number[]) {
  const sql = past(only !== undefined),
    rows = (only ? db.prepare(sql).all({ only: JSON.stringify(only) }) : db.prepare(sql).all()) as unknown as (PastJob &
      TimingEvidence)[];
  return rows.map(({ outcomes, invalid_runs, unknown_seats, is_replacement, ...job }) => ({
    ...job,
    timing_flags: timingFlags({ outcomes, invalid_runs, unknown_seats, is_replacement, runs: job.runs }),
  }));
}

// Every done job is kept as one pool, and only the jobs whose rows changed are read again: each new work job is sized
// on it (predictions.ts recordQueued), and so are the minute's sweep, the play and hq estimate, and reading it whole for
// each took 0.2 s warm and seconds cold. Triggers note each change to what it's read from in past_changes, with its job:
// a done work job's columns here, a run or usage row of one, a pull request of its branch, a new call of it, a
// scheduled run, a replacement link. A change to a call, or a credential request, that a call's chain of resumes may
// reach notes no job: the pool is read whole again. The notes keep the latest KEPT_CHANGES; a pool older than those is
// read whole too. A pool read in a step goes once the step is undone; one read in any other transaction isn't kept, so
// a change rolled back never leaves it standing. Callers share the pool: they never change it.
let kept: { seen: number; pool: PastJob[] } | undefined;
function keptPool() {
  const changes = kept
    ? (prepared('select id, job from past_changes where id > ? order by id').all(kept.seen) as Change[])
    : [];
  if (kept && !changes.length) return kept.pool;
  const seen = changes.at(-1)?.id ?? lastChange(),
    jobs = new Set(changes.map(c => c.job)),
    pool =
      kept && !jobs.has(null) && noneLost(kept.seen)
        ? [...kept.pool.filter(j => !jobs.has(j.id)), ...readPast([...jobs] as number[])].sort((a, b) => a.id - b.id)
        : readPast();
  if (!db.isTransaction || inStep()) {
    kept = { seen, pool };
    onUndo(() => (kept = undefined));
  }
  return pool;
}
type Change = { id: number; job: number | null };
const KEPT_CHANGES = 10_000;
// (autoincrement: a note's number is never given again, even once the notes before it are gone)
db.exec('create table if not exists past_changes (id integer primary key autoincrement, job integer)');
const lastChange = () => (prepared('select max(id) n from past_changes').get() as { n: number | null }).n ?? 0;
// (whether every change after `seen` is still noted)
const noneLost = (seen: number) =>
  ((prepared('select min(id) n from past_changes').get() as { n: number | null }).n ?? 0) <= seen + 1;
const DONE = (row: string) => `${row}.kind = 'work' and ${row}.status = 'done'`,
  OF_DONE = (row: string) => `exists (select 1 from jobs d where d.id = ${row}.job and ${DONE('d')})`,
  ON_BRANCH = (row: string) =>
    `select id from jobs indexed by jobs_work_branch where kind = 'work' and coalesce(branch, 'job/' || id) = +${row}.branch`,
  KEYS = (row: string) => `${row}.kind = 'credential' or ${row}.secrets is not null`,
  PAST_COLUMNS = `id, agent, title, engine, created, finished, stage, round, queued_by, pr, branch, thread, customers,
    about_keys, kind, status, instead_of`;
// (the trigger's event, the jobs it notes and when it counts: always unless said)
const NOTED: [name: string, on: string, jobs: string, when?: string][] = [
  ['job_added', 'insert on jobs', 'values (new.id)', DONE('new')],
  ['job_changed', `update of ${PAST_COLUMNS} on jobs`, 'values (old.id), (new.id)', `${DONE('old')} or ${DONE('new')}`],
  ['job_removed', 'delete on jobs', 'values (old.id)', DONE('old')],
  ['run_added', 'insert on runs', 'values (new.job)', OF_DONE('new')],
  ['run_changed', 'update on runs', 'values (old.job), (new.job)', `${OF_DONE('old')} or ${OF_DONE('new')}`],
  ['run_removed', 'delete on runs', 'values (old.job)', OF_DONE('old')],
  ['usage_added', 'insert on usage', 'values (new.job)', OF_DONE('new')],
  ['usage_changed', 'update on usage', 'values (old.job), (new.job)', `${OF_DONE('old')} or ${OF_DONE('new')}`],
  ['usage_removed', 'delete on usage', 'values (old.job)', OF_DONE('old')],
  ['pr_added', 'insert on prs', ON_BRANCH('new')],
  [
    'pr_changed',
    'update of number, branch, status, merged_at, files, added, removed on prs',
    `${ON_BRANCH('old')} union ${ON_BRANCH('new')}`,
  ],
  ['pr_removed', 'delete on prs', ON_BRANCH('old')],
  ['call_added', 'insert on calls', 'values (new.job)', 'new.job is not null'],
  ['call_changed', 'update of job, resumes, request on calls', 'values (null)'],
  ['call_removed', 'delete on calls', 'values (null)'],
  ['request_added', 'insert on requests', 'values (null)', KEYS('new')],
  ['request_changed', 'update of kind, secrets on requests', 'values (null)'],
  ['request_removed', 'delete on requests', 'values (null)', KEYS('old')],
  ['schedule_run_added', 'insert on schedule_runs', 'values (new.job)', 'new.job is not null'],
  ['schedule_run_changed', 'update on schedule_runs', 'values (old.job), (new.job)'],
  ['schedule_run_removed', 'delete on schedule_runs', 'values (old.job)'],
  ['replacement_added', 'insert on job_replacements', 'values (new.job)'],
  ['replacement_removed', 'delete on job_replacements', 'values (old.job)'],
];
for (const [name, on, jobs, when] of NOTED)
  db.exec(`create trigger if not exists past_${name} after ${on} ${when ? `for each row when ${when}` : ''} begin
    insert into past_changes (job) ${jobs};
    delete from past_changes where id <= (select max(id) from past_changes) - ${KEPT_CHANGES};
  end`);

export const cleanPastJobs = (pool: PastJob[] = pastJobs()) =>
  pool.filter(job => !job.timing_flags?.length && !job.customers && !job.about_keys);
export function timingAudit(pool: PastJob[] = pastJobs()) {
  const reasons: Partial<Record<TimingFlag, number>> = {};
  for (const job of pool) for (const reason of job.timing_flags ?? []) reasons[reason] = (reasons[reason] ?? 0) + 1;
  const clean = pool.filter(job => !job.timing_flags?.length).length;
  return { total: pool.length, excluded: pool.length - clean, clean, reasons };
}

// The piece of work to match: its title, its origin, its agent when known (any agent's work matches otherwise), and
// for a scheduled job its run.
export type Work = { title: string; origin: JobOrigin; agent?: string } & Partial<Run>;
// What the picks have in common with the work: its origin and its agent, unless too few of those were done, and the
// title's words that found them (none: the latest of their origin). `kind` is the origin's name where the basis is
// stored (predictions.ts) and shown (hq estimate). A scheduled job's: the runs of its entry (`entry`), or of its
// routine's entries (`routine`), instead.
export type Basis = { kind: JobOrigin | null; agent: string | null; words: string[]; entry?: string; routine?: string };

// The jobs an estimate takes the mean of (a mean holds the few long jobs that dominate a sum of agent time): the PICKS
// best matched by their title's words, else those and the latest, LATEST in all. Agent and origin narrow the pool first,
// each only where FEWEST or more done jobs share it. hq estimate --accuracy replays the matching with these counts on
// the work done lately, which is where a change to them is measured.
export const PICKS = 8,
  LATEST = 20,
  FEWEST = 3;
export function picksFor(work: Work, pool: PastJob[]): { picks: PastJob[]; basis: Basis } {
  return rawPicksFor(work, cleanPool(pool));
}
// Historical baseline only. Candidate comparisons always use picksFor.
export function rawPicksFor(work: Work, pool: PastJob[]): { picks: PastJob[]; basis: Basis } {
  return runsLike(work, pool) ?? matched(work, pool);
}
const cleanPools = new WeakMap<PastJob[], PastJob[]>();
function cleanPool(pool: PastJob[]) {
  if (!cleanPools.has(pool)) cleanPools.set(pool, cleanPastJobs(pool));
  return cleanPools.get(pool)!;
}
function matched(work: Work, pool: PastJob[]) {
  const sameOrigin = groupOf(pool, work.origin);
  const own = work.agent ? groupOf(pool, work.origin, work.agent) : sameOrigin;
  const among = own.length >= FEWEST ? own : sameOrigin.length >= FEWEST ? sameOrigin : pool;
  const basis = { kind: among === pool ? null : work.origin, agent: among === own ? (work.agent ?? null) : null };
  const terms = [...new Set(wordsFor(work))];
  const { found, words } = rankedIn(among, terms);
  if (found.length >= FEWEST) return { picks: found.slice(0, PICKS), basis: { ...basis, words } };
  const latest = [...among].sort((a, b) => b.id - a.id).filter(j => !found.includes(j));
  return { picks: [...found, ...latest].slice(0, LATEST), basis: { ...basis, words } };
}

// A scheduled job is the same work each time, whatever HQ's title matching makes of it: it stands on the latest PICKS
// done runs of its own entry, by whoever ran them (an entry can change hands). With fewer than FEWEST of those, on the
// runs of every entry sharing its routine, its own entry's first; with fewer of those too, on the matching.
function runsLike(work: Work, pool: PastJob[]) {
  if (!work.entry) return null;
  const newest = (jobs: PastJob[]) => [...jobs].sort((a, b) => b.id - a.id);
  const own = newest(pool.filter(j => j.entry === work.entry));
  const basis = { kind: work.origin, agent: null, words: [] };
  if (own.length >= FEWEST) return { picks: own.slice(0, PICKS), basis: { ...basis, entry: work.entry } };
  const others = work.routine ? newest(pool.filter(j => j.routine === work.routine && j.entry !== work.entry)) : [];
  if (own.length + others.length < FEWEST) return null;
  return { picks: [...own, ...others].slice(0, PICKS), basis: { ...basis, routine: work.routine! } };
}

// The work's agent time: the mean of its picks. None with fewer than FEWEST picks.
export function sizeOf(picks: PastJob[]) {
  if (picks.length < FEWEST) return null;
  return {
    agent_ms: wholeSeconds(mean(picks.map(j => j.agent_ms))!),
  };
}

// Small words (English, Dutch and German: the board's languages, language.ts, which the plan's titles are written in)
// match too much to say two jobs are alike. (German)
const STOP = new Set(
  `a about after an and are as at be but by can do for from has have how if in into is it its no not of
  on once or our so than that the their then this to up was we what when which who why will with without you aan als bij
  dan dat de die dit door een en er het hoe in is je maar met na naar niet nog of om ook op over te tot uit van voor wat
  we aber auf aus bis das dass dem den der des du ein eine einem einen einer es für ich im ist mit nach nicht noch nur
  oder sich sie sind um und vom von vor wie wir zu zum zur`.split(/\s+/),
);
export const wordsOf = (title: string) =>
  (title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => !STOP.has(w));
// The words of a job's own title. HQ names the jobs it makes itself with what they do first ("Message from <agent>: "),
// the same on every such job, which says nothing of the work; the review loop's carry the work's own title, their step
// and round apart (jobs.step). A scheduled job's slot, "(2026-10-17)", is its
// run's (Run), not words: it would match every title of the month.
const HQ_NAMING = /^[^:#]{1,40}: /;
// (kept: every estimate reads every past title, and hq estimate --accuracy hundreds of times over)
const titleWordsByKey = new Map<string, string[]>();
type Titled = { title: string; origin: JobOrigin; slot?: string | null };
function wordsFor(j: Titled) {
  const slot = j.slot ? ` (${j.slot})` : null;
  const title = slot && j.title.endsWith(slot) ? j.title.slice(0, -slot.length) : j.title;
  return wordsOf(j.origin === 'hq' ? title.replace(HQ_NAMING, '') : title);
}
function titleWords(j: Titled) {
  const key = `${j.origin}\n${j.slot ?? ''}\n${j.title}`;
  if (!titleWordsByKey.has(key)) titleWordsByKey.set(key, wordsFor(j));
  return titleWordsByKey.get(key)!;
}
// seat and seats, refund and refunds (outlooks.ts findOutlooks compares a call's words the same)
export const alike = (a: string, b: string) =>
  a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

// A word's weight by how few of the n it's matched against have it
const rarity = (hits: number, n: number) => Math.log(1 + n / Math.max(hits, 1));

// Each word list's score against the terms: the weights of the terms it has a word alike to, a rare term weighing more
// than a common one. Each term is matched against the lists' words once, not against every list. (outlooks.ts
// findOutlooks scores a call's words with it)
export const scores = (lists: string[][], terms: string[]) => scored(indexed(lists), terms).sums;

// The lists' words, each with the lists that have it: what scoring reads of the lists, whatever the terms.
type Indexed = { lists: number; having: [string, number[]][] };
function indexed(lists: string[][]): Indexed {
  const having = new Map<string, number[]>();
  lists.forEach((words, i) => {
    for (const w of new Set(words)) {
      const has = having.get(w);
      if (has) has.push(i);
      else having.set(w, [i]);
    }
  });
  return { lists: lists.length, having: [...having] };
}
// Each list's score, and how many lists have each term: of the first n lists only, with n (a prefix, scored as if it
// were all of them: each word's lists are in order).
function scored({ lists, having }: Indexed, terms: string[], n = lists) {
  const sums = Array.from({ length: n }, () => 0);
  const hits = terms.map(t => {
    const near = new Set(having.flatMap(([w, has]) => (alike(w, t) ? has.filter(i => i < n) : [])));
    const weight = rarity(near.size, n);
    for (const i of near) sums[i] += weight;
    return near.size;
  });
  return { sums, hits };
}

// What matching reads of a pool, once for all the work matched against it (a play sizes every unsized job against the
// same pastJobs()): its jobs of each origin, or origin and agent, and each such group's title words indexed. Kept by
// the array, which a caller never changes once matched against (each makes a new one).
const groups = new WeakMap<PastJob[], Map<string, PastJob[]>>();
const titlesIndexed = new WeakMap<PastJob[], Indexed>();
function groupOf(pool: PastJob[], origin: JobOrigin, agent?: string) {
  const byKey = groups.get(pool) ?? groups.set(pool, new Map()).get(pool)!;
  const key = agent === undefined ? origin : `${origin}\n${agent}`;
  if (!byKey.has(key))
    byKey.set(
      key,
      pool.filter(j => j.origin === origin && (agent === undefined || j.agent === agent)),
    );
  return byKey.get(key)!;
}
function rankedIn(pool: PastJob[], terms: string[], n = pool.length) {
  const index = titlesIndexed.get(pool) ?? titlesIndexed.set(pool, indexed(pool.map(j => titleWords(j)))).get(pool)!;
  const { sums, hits } = scored(index, terms, n);
  const found = pool
    .slice(0, n)
    .map((j, i) => ({ j, s: sums[i] }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || b.j.id - a.j.id)
    .map(x => x.j);
  return { found, words: terms.filter((_, k) => hits[k] > 0) };
}

// The pool's jobs that share a word with the terms, most alike first (then the newest)
export const ranked = (pool: PastJob[], terms: string[]) => rankedIn(pool, terms).found;
// The same for the pool's first n jobs, on the pool's one index: hq estimate --accuracy ranks a prefix of the same pool
// for each job it replays.
export const rankedFirst = (pool: PastJob[], n: number, terms: string[]) => rankedIn(pool, terms, n).found;
