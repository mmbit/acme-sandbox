// Every size a work job was given besides the estimate tool's own (its stored prediction, predictions.ts): the sizer's
// (sizer.ts, by its model) and an agent's (hq estimate set), each with when, the done jobs it stands on, why, and which
// version of the job's brief it sized. The latest counts (predictions.ts latestSizes); the earlier ones stay, so a miss
// can be traced to whoever sized the job.
import { createHash } from 'node:crypto';
import { db, redacted } from './db.ts';
import { ceo } from './company.ts';
import { findThread, ownerOf } from './projects.ts';
import { ORIGIN, type JobOrigin } from './matching.ts';
import { MODEL as SIZER } from './smallmodel.ts';
import { duration } from '../../worker/hq/waits.ts';

// by: the sizer's model ('haiku') or an agent's id. low_ms and high_ms: none for an agent's one number. brief: the hash
// of the prompt it sized (briefOf), so a brief changed by hq extend is due to be sized again.
db.exec(`create table if not exists sizes (id integer primary key, job integer not null, at text not null, by text not null,
  agent_ms real not null, low_ms real, high_ms real, refs text not null, why text not null, brief text not null);
  create index if not exists sizes_job on sizes (job)`);
redacted('sizes', 'why');

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
};
type Row = Omit<GivenSize, 'refs'> & { refs: string };

export const briefOf = (prompt: string) => createHash('sha256').update(prompt).digest('hex').slice(0, 16);

export function record(size: Omit<GivenSize, 'at'>, now = Date.now()) {
  db.prepare(
    'insert into sizes (job, at, by, agent_ms, low_ms, high_ms, refs, why, brief) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
});

// hq estimate set #n <time> ["why"]: the CEO, the job's queuer, its thread's owner or its own agent (once the work
// outgrows its brief: the worker's briefing asks it) re-sizes a queued or running
// work job, one number of agent time. The answer is the size, or why not with its status.
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
  // (its thread's owner: its project's.)
  const thread = found.thread ? findThread(found.thread) : undefined;
  const owner = thread && ownerOf(thread);
  if (![ceo(), found.queued_by, owner, found.agent].includes(by))
    return refused(403, `only the CEO, whoever queued #${job}, its thread's owner or its own agent re-sizes it`);
  const size = { job, by, agent_ms: agentMs, low_ms: null, high_ms: null, refs: [], why: oneLine(why, WHY_MAX) };
  record({ ...size, brief: briefOf(found.prompt) }, now);
  return size;
}

// A size shared by hq estimate set and hq when.
export function readSize(time: string, field: 'time' | 'size' = 'time') {
  const ms = durationOf(time);
  if (ms === null) return `can't read the ${field} "${time.slice(0, 40)}": give agent time as 90m, 2h or 1h30m`;
  if (ms > MOST_MS) return 'a size is at most 48 h of agent time: split the work into jobs';
  return ms;
}

// A claimed work job its agent may re-size (hq estimate set: work an agent queued, not a fix or a merge), with the size
// the play counts and whose it is: its briefing asks the agent to re-size it once the work outgrows its brief, and an
// agent that doesn't know its size can't tell. `size` is null while the job has none yet.
//
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
  !given
    ? 'the estimate tool, on done jobs like it'
    : given.by === SIZER
      ? 'the sizer'
      : `${given.by}, with hq estimate set`;

const refused = (status: 400 | 403 | 404 | 409, why: string): [number, string] => [status, why];

// 90m, 2h or 1h30m, in ms; null for anything else, or none at all.
function durationOf(text: string) {
  const parts = /^(?:(\d{1,2})h)?(?:(\d{1,4})m)?$/i.exec(text.trim());
  if (!parts || !(parts[1] || parts[2])) return null;
  const ms = (Number(parts[1] ?? 0) * 60 + Number(parts[2] ?? 0)) * 60_000;
  return ms > 0 ? ms : null;
}

export const oneLine = (text: string, most: number) => text.replace(/\s+/g, ' ').trim().slice(0, most);
