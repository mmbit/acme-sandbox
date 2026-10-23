// Done jobs like a piece of work, the ones an estimate stands on: jobs of the same origin by the same agent, the words
// of its title deciding which, each word weighed by how rare it is among past titles. A scheduled job stands on its own
// schedule entry's runs first.
import { db } from './db.ts';
import { workBranch } from './jobs.ts';
import { mean, wholeSeconds } from './arithmetic.ts';

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
// The runs summed by job first, then each one's job by its id: `cross join` keeps that order. Stale statistics
// (pragma optimize reads a table again only once it grew tenfold) otherwise let the planner scan every job row and sum
// the runs again for each.
const past =
  () => `select j.id, j.agent, j.title, j.engine, ${ORIGIN} origin, j.created, coalesce(j.finished, r.last) finished,
    r.agent_ms, r.runs, r.rebuilt, (julianday(coalesce(j.finished, r.last)) - julianday(r.first)) * 86400000 wall_ms,
    coalesce(u.cost, u.tokens) spend, iif(u.cost is null, 'tokens', '$') unit,
    p.number pr, p.status pr_status, p.merged_at, coalesce(p.files, '[]') files, p.added, p.removed, j.thread, ${RUN_COLUMNS}
  from jobs j
  join (select job, count(*) runs, sum(ended_as = 'rebuilt' or seat is null) rebuilt, min(started) first, max(ended) last,
    sum((julianday(ended) - julianday(started)) * 86400000) agent_ms from runs group by job) r on r.job = j.id
  left join (select job, sum(cost) cost, sum(input + cache_write + cache_read + output) tokens from usage group by job) u
    on u.job = j.id
  left join (select branch, max(number) number from prs group by branch) b on b.branch = ${workBranch('j')}
  left join prs p on p.number = b.number
  ${RUN_JOIN}
  where j.kind = 'work' and j.status = 'done' and not exists (select 1 from runs o where o.job = j.id and o.ended is null)`;

export const pastJobs = () => db.prepare(past()).all() as PastJob[];

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
  return runsLike(work, pool) ?? matched(work, pool);
}
function matched(work: Work, pool: PastJob[]) {
  const sameOrigin = pool.filter(j => j.origin === work.origin);
  const own = work.agent ? sameOrigin.filter(j => j.agent === work.agent) : sameOrigin;
  const among = own.length >= FEWEST ? own : sameOrigin.length >= FEWEST ? sameOrigin : pool;
  const basis = { kind: among === pool ? null : work.origin, agent: among === own ? (work.agent ?? null) : null };
  const terms = [...new Set(wordsFor(work))];
  const found = ranked(among, terms);
  const words = terms.filter(t => found.some(j => titleWords(j).some(w => alike(w, t))));
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
export function scores(lists: string[][], terms: string[]) {
  const vocabulary = [...new Set(lists.flat())];
  const found = terms.map(t => {
    const near = new Set(vocabulary.filter(w => alike(w, t)));
    return lists.map(words => words.some(w => near.has(w)));
  });
  const weight = found.map(hits => rarity(hits.filter(Boolean).length, lists.length));
  return lists.map((_, i) => found.reduce((sum, hits, k) => sum + (hits[i] ? weight[k] : 0), 0));
}

// The pool's jobs that share a word with the terms, most alike first (then the newest)
export function ranked(pool: PastJob[], terms: string[]) {
  const titles = pool.map(j => titleWords(j));
  const jobScores = scores(titles, terms);
  return pool
    .map((j, i) => ({ j, s: jobScores[i] }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || b.j.id - a.j.id)
    .map(x => x.j);
}
