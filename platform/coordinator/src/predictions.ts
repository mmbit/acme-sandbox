// What HQ predicted for each piece of work as it was queued, kept as made: its agent time from done jobs
// like it (matching.ts), which jobs those were and what they matched on, and when the queue's play (eta.ts) said it
// would start, end and merge. The play runs again from these stored sizes whenever it's asked, with no agent involved,
// and hq estimate --accuracy sets each prediction against what happened.
import { columnsOf, db, once } from './db.ts';
import { OPEN_JOBS } from './jobs.ts';
import {
  ORIGIN,
  pastJobs,
  picksFor,
  runOf,
  RUN_COLUMNS,
  RUN_JOIN,
  sizeOf,
  type Basis,
  type JobOrigin,
  type PastJob,
  type Run,
  type Work,
} from './matching.ts';
import { play, type Outlook, type Planned, type QueuedJob, type Size, type Snapshot } from './eta.ts';
import { snapshot } from './backlog.ts';
import { playOrder } from './simulation.ts';
import { loopSizes, SLOW_SHARE, type Pace } from './reviewtime.ts';
import { fitIn, wholeSeconds } from './arithmetic.ts';
import { history, latestGiven } from './sizes.ts';
import { corrected } from './sizerbias.ts';
import * as threadorder from './threadorder.ts';
import * as pastpool from './pastpool.ts';

// slow_agent_ms: the slow size, the one a time told holds to. A row without one gets it from its picks
// (storedSizes).
db.exec(`create table if not exists predictions (job integer primary key, made text not null, agent_ms real not null,
  picks text not null, basis text not null, guessed integer not null default 0, start integer,
  done integer, eta integer, slow_agent_ms real, outlook_saved integer not null default 0)`);
once('2026-10-23-queued-outlooks', () => {
  if (!columnsOf('predictions').includes('outlook_saved')) {
    db.exec('alter table predictions add column outlook_saved integer not null default 0');
    db.exec('update predictions set outlook_saved = 1');
  }
});

// With fewer than a few done jobs of its origin to go on (a new company), a first guess, and the basis says so. A slow
// size with too few picks to measure it (a guess, or a stored row whose picks left the record) is half as long again.
const GUESS: Size = { agent_ms: 30 * 60_000 },
  SLOW_GUESS = 1.5;

// size: the mean of the picks', the work's usual time. slow: the time four in five of them fit in (reviewtime.ts
// SLOW_SHARE), which a time told should hold to: the summary's late lines' (windows.ts).
export type Prediction = { size: Size; slow: Size; picks: PastJob[]; basis: Basis; guessed: boolean };

// A piece of work's size from the done jobs like it.
export function predict(work: Work, pool = pastJobs()): Prediction {
  const { picks, basis } = picksFor(work, pool);
  const size = sizeOf(picks);
  return { size: size ?? GUESS, slow: slowOf(picks, size ?? GUESS), picks, basis, guessed: !size };
}
// (never below the usual size: a mean over one very long job can be past four in five of them)
function slowOf(picks: PastJob[], usual: Size): Size {
  if (!sizeOf(picks)) return { agent_ms: usual.agent_ms * SLOW_GUESS };
  const at = (values: number[], least: number) => Math.max(wholeSeconds(fitIn(values, SLOW_SHARE) ?? 0), least);
  return {
    agent_ms: at(
      picks.map(j => j.agent_ms),
      usual.agent_ms,
    ),
  };
}

type Row = Size & { job: number; picks: string; basis: string; guessed: number; slow_agent_ms: number | null };

export function recordQueued(job: number, now = Date.now(), schedule?: Run) {
  const work = db
    .prepare(
      `select j.agent, j.title, ${ORIGIN} origin from jobs j where j.id = ? and j.kind = 'work'
      and not exists(select 1 from predictions p where p.job = j.id)`,
    )
    .get(job) as Work | undefined;
  if (!work) return;
  const given = latestGiven([job]).get(job);
  const predicted = given ? undefined : predict({ ...work, ...(schedule ?? runOf(job)) });
  const agentMs = given?.agent_ms ?? predicted!.size.agent_ms;
  db.prepare(
    `insert or ignore into predictions (job, made, agent_ms, picks, basis, guessed, slow_agent_ms)
    values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job,
    new Date(now).toISOString(),
    agentMs,
    JSON.stringify(given?.refs ?? predicted!.picks.map(j => j.id)),
    JSON.stringify(predicted?.basis ?? { kind: work.origin, agent: work.agent, words: [] }),
    predicted?.guessed ? 1 : 0,
    given ? (given.high_ms ?? given.agent_ms) : predicted!.slow.agent_ms,
  );
}
// A job's prediction as it was stored: its size, the done jobs it compared against (those still on record) and on what.
export function stored(job: number, pool = pastJobs()): Prediction | undefined {
  const row = db.prepare('select * from predictions where job = ?').get(job) as Row | undefined;
  if (!row) return undefined;
  const byId = new Map(pool.map(j => [j.id, j]));
  const picks = (JSON.parse(row.picks) as number[]).flatMap(id => byId.get(id) ?? []);
  const size = { agent_ms: row.agent_ms };
  const guessed = row.guessed === 1;
  return { size, slow: storedSizes([job]).get(job)!.slow, picks, basis: JSON.parse(row.basis) as Basis, guessed };
}

// The minute's sweep stores missing sizes, then saves each open job's first outlook from that minute's play.
// Saved queue-time sizes stay fixed. Legacy work gets its default once before the play.
export function sweep(now = Date.now(), played: (now: number) => Map<number, Outlook> = outlook) {
  const missing = db
    .prepare(
      `select j.id, j.agent, j.title, ${ORIGIN} origin, ${RUN_COLUMNS} from jobs j ${RUN_JOIN} where j.kind = 'work'
      and j.status in ${OPEN_JOBS} and not exists (select 1 from predictions p where p.job = j.id)`,
    )
    .all() as ({ id: number; agent: string; title: string; origin: JobOrigin } & Run)[];
  if (!missing.length) return recordFirstOutlooks(now, played);
  const pool = pastJobs();
  const insert = db.prepare(`insert into predictions (job, made, agent_ms, picks, basis, guessed,
    slow_agent_ms) values (?, ?, ?, ?, ?, ?, ?)`);
  for (const job of missing) {
    const { size, slow, picks, basis, guessed } = predict(job, pool);
    const picked = JSON.stringify(picks.map(p => p.id));
    const made = new Date(now).toISOString();
    insert.run(job.id, made, size.agent_ms, picked, JSON.stringify(basis), guessed ? 1 : 0, slow.agent_ms);
  }
  recordFirstOutlooks(now, played);
}

function recordFirstOutlooks(now: number, played: (now: number) => Map<number, Outlook>) {
  const unplayed = db
    .prepare(
      `select p.job from predictions p join jobs j on j.id = p.job
    where p.outlook_saved = 0 and j.status in ${OPEN_JOBS}`,
    )
    .all() as { job: number }[];
  if (!unplayed.length) return;
  const outlooks = played(now);
  // (the column eta holds the outlook's merge time, as hq estimate --accuracy reads it)
  const first = db.prepare('update predictions set start = ?, done = ?, eta = ?, outlook_saved = 1 where job = ?');
  for (const { job } of unplayed) {
    const seen = outlooks.get(job);
    first.run(seen?.start ?? null, seen?.done ?? null, seen?.merged ?? null, job);
  }
}

// ---- the play on the stored sizes

// Every open job's outlook now, from the stored sizes, and planned work's as if queued now.
export function outlook(now = Date.now(), planned: SizedPlan[] = []) {
  return outlooks(now, planned, ['usual']).usual;
}
// Both plays on one snapshot: the usual sizes give the ETA, the slow ones the time a promise should hold to.
type SizedPlan = Planned & { slow?: Size };
export function outlooks(now = Date.now(), planned: SizedPlan[] = [], paces: Pace[] = ['usual', 'slow']) {
  const { usual, slow } = played(now, planned, paces);
  return { usual, slow };
}
// The same, with what they played on: the snapshot and each pace's sizes (forecast.ts keeps them; the prediction log
// stores them, so a later play can be scored on them).
export function played(now = Date.now(), planned: SizedPlan[] = [], paces: Pace[] = ['usual', 'slow']) {
  const { snapshot: queue, sizes, sizedBy } = prepared(now, planned, paces);
  const empty = new Map<number, Outlook>();
  // (the order the work goes in rests on the queue's planning sizes alone: worked out once for both paces)
  const order = playOrder(queue, sizes.slow);
  return {
    snapshot: queue,
    sizes,
    sizedBy,
    usual: paces.includes('usual') ? play(queue, sizes.usual, { pace: 'usual', order }) : empty,
    slow: paces.includes('slow') ? play(queue, sizes.slow, { pace: 'slow', order }) : empty,
  };
}
// The snapshot and each pace's sizes, ready to play: hq when plays them several ways (when.ts).
export function prepared(now = Date.now(), given: SizedPlan[] = [], paces: Pace[] = ['usual', 'slow']) {
  // (a drawn thread with no task yet plays as one, sized on its name and "done when": threadorder.ts placeholders.)
  const placeholders = threadorder.placeholders();
  const queue = snapshot(now, [...given, ...placeholders]);
  const record = recordFor(queue.now, queue.jobs);
  const drawn = placeholders.map(p => {
    const { size, slow } = record.drawn(p);
    return { ...p, size, slow };
  });
  const planned = [...given, ...drawn];
  const sized = (pace: Pace) => {
    const sizes = sizesFor(queue, pace, record);
    for (const p of planned) sizes.set(p.id, pace === 'slow' ? (p.slow ?? p.size) : p.size);
    return sizes;
  };
  const none = new Map<number, Size>();
  const sizes = {
    usual: paces.includes('usual') ? sized('usual') : none,
    slow: paces.includes('slow') ? sized('slow') : none,
  };
  queue.planningSizes = [...(paces.includes('slow') ? sizes.slow : sized('slow'))];
  // (who gave each job's size, for the prediction log: predictionlog.ts.)
  const sizedBy = new Map([...record.latest].map(([job, size]) => [job, size.by]));
  return { snapshot: queue, sizes, sizedBy };
}

// The time a promise holds to, as the summary's late line gives it (windows.ts) and hq estimate shows it: the slow play's
// merge, never sooner than the usual one's, on the next five minutes. None while the usual play doesn't merge it.
const ROUND_TO_MS = 5 * 60_000;
export function heldTo(usual: Outlook, slow: Outlook) {
  if (usual.merged === null) return null;
  const merged = Math.max(slow.merged ?? usual.merged, usual.merged);
  return Math.ceil(merged / ROUND_TO_MS) * ROUND_TO_MS;
}

// Each play reads saved task sizes and measured review times. Legacy tasks without a prediction get one persisted
// default at first use. Drawn threads have no task yet, so their provisional sizes are made once for each pool of done
// work: for the hour while the server keeps it (pastpool.ts), else for this read.
type FromRecord = ReturnType<typeof recordFor>;
const spotMade = new WeakMap<PastJob[], Map<string, Prediction>>();
export function recordFor(now: number, jobs: Pick<QueuedJob, 'id'>[]) {
  const ids = jobs.flatMap(job => (job.id > 0 ? [job.id] : []));
  const saved = storedSizes(ids);
  let read: PastJob[] | undefined;
  const pool = () => (read ??= pastpool.pool(now));
  const kept = (key: string, work: () => Work) => {
    const past = pool(),
      made = spotMade.get(past) ?? new Map<string, Prediction>();
    spotMade.set(past, made);
    if (!made.has(key)) made.set(key, predict(work(), past));
    return made.get(key)!;
  };
  const predicted = (job: QueuedJob) => {
    recordQueued(job.id, now);
    return stored(job.id, pool())!;
  };
  // (by its owner and words: its placeholder's number moves as other threads are drawn or get a task.)
  const drawn = (p: { agent: string; title: string }) =>
    kept(`drawn\n${p.agent}\n${p.title}`, () => ({ title: p.title, origin: 'work', agent: p.agent }));
  return { stored: saved, latest: asPlayed(latestSizes(ids, saved), now), loop: loopSizes(now), predicted, drawn };
}

// A size an agent (or a model) gave plays at what that sizer's sizes have lately come to (sizerbias.ts); the tool's,
// which stand on done jobs already, and the CEO's revision of work under way, made with its progress in view, as they
// are.
function asPlayed(latest: Map<number, JobSize>, now: number) {
  for (const [job, size] of latest) {
    if (size.by === 'tool' || size.revised) continue;
    const { agent_ms, high_ms } = corrected(size.agent_ms, size.by, now);
    latest.set(job, { ...size, agent_ms, high_ms });
  }
  return latest;
}

// The play's per-job hours: a work job's stored prediction (work older than the predictions, or one the sweep hasn't
// reached, sized on the spot) with the agent time of its latest size (latestSizes), a review run's or check's measured
// time (reviewtime.ts loopSizes).
export function sizesFor(queue: Pick<Snapshot, 'jobs'>, pace: Pace, { stored, latest, loop, predicted }: FromRecord) {
  const sizes = new Map<number, Size>();
  for (const job of queue.jobs) {
    if (job.id < 0) continue;
    if (job.kind !== 'work') sizes.set(job.id, { agent_ms: loop(job.kind, pace) });
    else {
      const kept = stored.get(job.id)?.[pace];
      const sized = kept ? undefined : predicted(job);
      const size = kept ?? (pace === 'slow' ? sized!.slow : sized!.size);
      const counts = latest.get(job.id);
      sizes.set(job.id, counts ? { ...size, agent_ms: pace === 'slow' ? counts.high_ms : counts.agent_ms } : size);
    }
  }
  return sizes;
}

// Every stored prediction's usual and slow size, or these jobs' only. A row without a slow one gets it from its picks,
// once.
function storedSizes(jobs?: number[]) {
  const rows = (
    jobs
      ? db.prepare('select * from predictions where job in (select value from json_each(?))').all(JSON.stringify(jobs))
      : db.prepare('select * from predictions').all()
  ) as (Row & { made: string })[];
  const missing = rows.filter(r => r.slow_agent_ms === null);
  if (missing.length) {
    const byId = new Map(pastJobs().map(j => [j.id, j]));
    const keep = db.prepare('update predictions set slow_agent_ms = ? where job = ?');
    for (const row of missing) {
      const picks = (JSON.parse(row.picks) as number[]).flatMap(id => byId.get(id) ?? []);
      const slow = slowOf(row.guessed ? [] : picks, row);
      row.slow_agent_ms = slow.agent_ms;
      keep.run(row.slow_agent_ms, row.job);
    }
  }
  return new Map(
    rows.map(r => [
      r.job,
      {
        made: r.made,
        picks: JSON.parse(r.picks) as number[],
        usual: { agent_ms: r.agent_ms },
        slow: { agent_ms: r.slow_agent_ms! },
      },
    ]),
  );
}

// ---- who sized each job

// A job's size as it counts now, and who gave it: the sizer's model ('haiku'), an agent (hq estimate set), or the
// estimate tool ('tool': its stored prediction). high_ms is the agent time the slow play takes: the sizer's high, never
// below its middle; for an agent's one number, that number at its prediction's slow share; the tool's slow size. low_ms:
// none for the tool's or an agent's.
export type JobSize = {
  agent_ms: number;
  low_ms: number | null;
  high_ms: number;
  by: string;
  at: string;
  revised?: boolean; // (the CEO's revision: sizes.ts)
};

// Every job's latest size, or these jobs' only: the latest one given (sizes.ts), else the tool's.
export function latestSizes(jobs?: number[], stored = storedSizes(jobs)) {
  const latest = new Map<number, JobSize>();
  for (const [job, p] of stored)
    latest.set(job, { agent_ms: p.usual.agent_ms, low_ms: null, high_ms: p.slow.agent_ms, by: 'tool', at: p.made });
  for (const [job, given] of latestGiven(jobs)) {
    const tool = stored.get(job);
    const share = tool ? tool.slow.agent_ms / tool.usual.agent_ms : SLOW_GUESS;
    const high = Math.max(given.high_ms ?? wholeSeconds(given.agent_ms * share), given.agent_ms);
    const { by, at, revised } = given;
    latest.set(job, { agent_ms: given.agent_ms, low_ms: given.low_ms, high_ms: high, by, at, revised });
  }
  return latest;
}
export const latest = (job: number) => latestSizes([job]).get(job);

// A job's sizes, the latest first and the tool's last, each with the done jobs it stands on and why (hq estimate #n).
export function sizeHistory(job: number) {
  const tool = storedSizes([job]).get(job);
  const given = history(job).map(({ job: _job, brief: _brief, ...size }) => size);
  if (!tool) return given;
  const usual = tool.usual.agent_ms;
  return [
    ...given,
    {
      by: 'tool',
      at: tool.made,
      agent_ms: usual,
      low_ms: null,
      high_ms: tool.slow.agent_ms,
      refs: tool.picks,
      why: '',
    },
  ];
}
