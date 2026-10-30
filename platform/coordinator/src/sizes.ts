// Task estimates saved when queued, their evidence, and the CEO's explicit revisions.
// The scheduler's terms and their relationships are defined at the top of eta.ts.
import { createHash } from 'node:crypto';
import { columnsOf, db, once, redacted } from './db.ts';
import { ceo } from './company.ts';
import { ORIGIN, cleanPastJobs, pastJobs, type JobOrigin } from './matching.ts';
import { MODEL as SIZER } from './smallmodel.ts';
import { duration } from '../../worker/hq/waits.ts';

// by: the sizer's model ('haiku') or an agent's id. low_ms and high_ms: none for an agent's one number. brief: the hash
// of the prompt it sized (briefOf), kept as evidence when the brief changes. revised: the CEO's revision of a job under
// way (setSize), made with its progress in view, not a guess at queue time.
db.exec(`create table if not exists sizes (id integer primary key, job integer not null, at text not null, by text not null,
  agent_ms real not null, low_ms real, high_ms real, refs text not null, why text not null, brief text not null,
  revised integer not null default 0);
  create index if not exists sizes_job on sizes (job)`);
redacted('sizes', 'why');
once('2026-10-26-sizes-revised', () => {
  if (columnsOf('sizes').includes('revised')) return;
  db.exec('alter table sizes add column revised integer not null default 0');
  // (before it, only setSize gave a job a second size)
  db.exec('update sizes set revised = 1 where id not in (select min(id) from sizes group by job)');
});

export type GivenSize = {
  job: number;
  at: string;
  by: string;
  agent_ms: number;
  low_ms: number | null;
  high_ms: number | null;
  refs: number[];
  why: string;
  brief: string;
  revised?: boolean;
};
type Row = Omit<GivenSize, 'refs' | 'revised'> & { refs: string; revised: number };

export const briefOf = (prompt: string) => createHash('sha256').update(prompt).digest('hex').slice(0, 16);

export type QueuedSize = { agent_ms: number; refs: number[]; why: string };
export function readQueuedSize(given: { size?: unknown; refs?: unknown; why?: unknown }): QueuedSize | string {
  if (typeof given.size !== 'string')
    return 'inspect hq estimate for comparable scopes, then give --size and --why when queueing the work';
  const agentMs = readSize(given.size);
  if (typeof agentMs === 'string') return agentMs;
  if (typeof given.why !== 'string' || !given.why.trim())
    return 'give --why: how the scope compares with the past jobs, or why none is comparable';
  const refs = given.refs ?? [];
  if (!Array.isArray(refs) || refs.some(id => !Number.isSafeInteger(id) || id <= 0))
    return '--refs takes the comparable done job numbers';
  // only the references are read: the check needs no other past job.
  const clean = new Set(refs.length ? cleanPastJobs(pastJobs(refs)).map(j => j.id) : []);
  if (refs.some(id => !clean.has(id))) return 'each estimate reference must be a done job with clean recorded time';
  return { agent_ms: agentMs, refs: [...new Set(refs)], why: given.why.trim() };
}

export function recordQueued(job: number, by: string, prompt: string, size: QueuedSize) {
  record({ job, by, brief: briefOf(prompt), low_ms: null, high_ms: size.agent_ms, ...size });
}

export function record(size: Omit<GivenSize, 'at'>, now = Date.now()) {
  db.prepare(
    'insert into sizes (job, at, by, agent_ms, low_ms, high_ms, refs, why, brief, revised) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    size.job,
    new Date(now).toISOString(),
    size.by,
    size.agent_ms,
    size.low_ms,
    size.high_ms,
    JSON.stringify(size.refs),
    size.why,
    size.brief,
    size.revised ? 1 : 0,
  );
}

// Each job's latest given size, or these jobs' only.
export function latestGiven(jobs?: number[]) {
  const rows = (jobs
    ? db
        .prepare(
          'select * from sizes where id in (select max(id) from sizes where job in (select value from json_each(?)) group by job)',
        )
        .all(JSON.stringify(jobs))
    : db.prepare('select * from sizes where id in (select max(id) from sizes group by job)').all()) as unknown as Row[];
  return new Map(rows.map(r => [r.job, shown(r)]));
}

// A job's latest given size, the one that counts over the tool's (predictions.ts latestSizes). None: the tool's size
// counts.
export function latestOf(job: number) {
  const row = db.prepare('select * from sizes where job = ? order by id desc limit 1').get(job) as Row | undefined;
  return row && shown(row);
}

// A job's given sizes, the latest first.
export function history(job: number) {
  const rows = db.prepare('select * from sizes where job = ? order by id desc').all(job) as unknown as Row[];
  return rows.map(shown);
}

const shown = ({ id: _id, ...row }: Row & { id?: number }): GivenSize => ({
  ...row,
  refs: JSON.parse(row.refs) as number[],
  revised: !!row.revised,
});

// Only the CEO revises a saved estimate when a task slips. Earlier estimates remain in history.
const WHY_MAX = 300,
  MOST_MS = 48 * 3_600_000;
export function setSize(job: number, time: string, why: string, by: string, now = Date.now()) {
  const agentMs = readSize(time);
  if (typeof agentMs === 'string') return refused(400, agentMs);
  const found = db
    .prepare(
      `select j.id, j.agent, j.status, j.queued_by, j.thread, j.prompt, ${ORIGIN} origin from jobs j where j.id = ?
      and j.kind = 'work'`,
    )
    .get(job) as
    | {
        id: number;
        agent: string;
        status: string;
        queued_by: string | null;
        thread: string | null;
        prompt: string;
        origin: string;
      }
    | undefined;
  if (!found) return refused(404, `there's no work job #${job}`);
  if (found.status !== 'queued' && found.status !== 'running')
    return refused(409, `job #${job} is ${found.status}: only a queued or running job is re-sized`);
  if (found.origin !== 'work')
    return refused(409, `job #${job} is HQ's own (a fix or a merge): the play sizes it from history`);
  if (by !== ceo()) return refused(403, 'only the CEO changes a saved estimate when work slips');
  if (!why.trim()) return refused(400, 'give the reason the saved estimate needs changing');
  const size = { job, by, agent_ms: agentMs, low_ms: null, high_ms: agentMs, refs: [], why: oneLine(why, WHY_MAX) };
  record({ ...size, brief: briefOf(found.prompt), revised: true }, now);
  return size;
}

// A size shared by hq estimate set and hq when.
export function readSize(time: string, field: 'time' | 'size' = 'time') {
  const ms = durationOf(time);
  if (ms === null) return `can't read the ${field} "${time.slice(0, 40)}": give agent time as 90m, 2h or 1h30m`;
  if (ms > MOST_MS) return 'a size is at most 48 h of agent time: split the work into jobs';
  return ms;
}

// The saved estimate and its author for a claimed task's briefing.
export function withSize<T extends { id: number; kind: string } | null>(job: T) {
  if (job?.kind !== 'work') return job;
  const row = db
    .prepare(`select ${ORIGIN} origin, p.agent_ms from jobs j left join predictions p on p.job = j.id where j.id = ?`)
    .get(job.id) as { origin: JobOrigin; agent_ms: number | null };
  if (row.origin !== 'work') return job;
  const given = latestOf(job.id),
    ms = given?.agent_ms ?? row.agent_ms;
  return {
    ...job,
    resize: { size: ms === null ? null : `${duration(ms / 60_000)} of agent time, by ${sizedBy(given)}` },
  };
}

const sizedBy = (given: GivenSize | undefined) =>
  !given ? 'the estimate tool, on done jobs like it' : given.by === SIZER ? 'the sizer' : given.by;

const refused = (status: 400 | 403 | 404 | 409, why: string): [number, string] => [status, why];

// 90m, 2h or 1h30m, in ms; null for anything else, or none at all.
function durationOf(text: string) {
  const parts = /^(?:(\d{1,2})h)?(?:(\d{1,4})m)?$/i.exec(text.trim());
  if (!parts || !(parts[1] || parts[2])) return null;
  const ms = (Number(parts[1] ?? 0) * 60 + Number(parts[2] ?? 0)) * 60_000;
  return ms > 0 ? ms : null;
}

export const oneLine = (text: string, most: number) => text.replace(/\s+/g, ' ').trim().slice(0, most);
