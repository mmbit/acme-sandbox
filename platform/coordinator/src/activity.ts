// hq activity: a job's or an agent's recent activity, line by line as HQ's agent card words it (the shell's
// world.js logged): each step, its status, the messages it sent, a post, and for an agent the messages sent to it. Read
// back from the events table (events.ts), so it's text, what agents can read: a step's kind and what it names (a file,
// a host), never a command's own words or what the agent said between steps, which are the board's alone (the worker's
// steps.ts). Events from before they carried their job are the board's alone too: a job's customer mark (set before
// 31 Oct only) can't be checked for them (db.ts events_job_from, job #24913).
import { db, setting } from './db.ts';
import { redact } from './events.ts';
import { alumnus, findAgent } from './jobs.ts';

// The card shows an agent's newest 30; a --since read gives up to MAX
const NEWEST = 30,
  MAX = 300;
const STATUS = { working: 'Working', waiting: 'Queuing for a seat', sleeping: 'Went to sleep', idle: 'Idle' } as Record<
  string,
  string
>;

type Row = {
  id: number;
  ts: string;
  type: string;
  agent: string | null;
  to: string | null;
  text: string | null;
  state: string | null;
  job: number | null;
};
export type Line = { ts: string; agent: string | null; job: number | null; text: string };
export type Activity = {
  job?: { id: number; agent: string; title: string; status: string; started: string | null };
  agent?: string;
  lines: Line[];
};

// for: whose card a line is on (an agent's own, or the one a message went to)
function lineOf(r: Row, of?: string): string | null {
  const text = redact(r.text ?? '')?.trim() ?? '';
  if (r.type === 'status') return `${STATUS[r.state ?? ''] ?? r.state ?? 'Status'}${text ? `: ${text}` : ''}`;
  if (r.type === 'chat') {
    const said = text ? `: ${text}` : '';
    return of && r.to === of && r.agent !== of ? `From ${r.agent}${said}` : `To ${r.to ?? 'everyone'}${said}`;
  }
  if (r.type === 'post') return `Published “${text}”`;
  return r.type === 'log' && text ? text : null;
}

// One job's (its lead's and team members' lines), or one agent's (as on its card: its own lines and the messages
// sent to it). since: an ISO time, the lines after it; else the newest. Oldest first.
export function activity(q: { job?: number; agent?: string; since?: string; limit?: number }): Activity | string {
  const since = q.since ? Date.parse(q.since) : NaN;
  if (q.since && Number.isNaN(since)) return 'since is a time, like 2026-11-05T08:00Z';
  const limit = Math.min(Math.max(1, Math.trunc(q.limit ?? 0) || (q.since ? MAX : NEWEST)), MAX),
    after = q.since ? new Date(since).toISOString() : '';
  const from = Number(setting('events_job_from') ?? 0),
    kept = 'ts > $after and id >= $from',
    kinds = `type in ('status', 'chat', 'post', 'log') and ${kept}`;
  if (q.job) {
    const job = db
      .prepare('select id, agent, title, status, started from jobs where id = ?')
      .get(q.job) as Activity['job'];
    if (!job) return `no job #${q.job}`;
    const rows = db
      .prepare(`select * from events where job = $job and ${kinds} order by id desc limit $n`)
      .all({ job: q.job, after, from, n: limit }) as Row[];
    return { job: { ...job, title: redact(job.title)! }, lines: linesOf(rows) };
  }
  if (!q.agent) return 'name a job or an agent';
  // (a team member is no agent of the org's, but its lines are there)
  if (!findAgent(q.agent) && !alumnus(q.agent) && !db.prepare('select 1 from events where agent = ?').get(q.agent))
    return `no agent ${q.agent}`;
  // (each side by its own index: an agent's lines, and the messages sent to it)
  const rows = db
    .prepare(
      `select * from (select * from events where agent = $a and ${kinds} order by id desc limit $n)
       union select * from (select * from events where "to" = $a and type = 'chat' and ${kept} order by id desc limit $n)
       order by id desc limit $n`,
    )
    .all({ a: q.agent, after, from, n: limit }) as Row[];
  return { agent: q.agent, lines: linesOf(rows, q.agent) };
}

const linesOf = (rows: Row[], of?: string) =>
  rows.reverse().flatMap(r => {
    const text = lineOf(r, of);
    return text ? [{ ts: r.ts, agent: r.agent, job: r.job, text }] : [];
  });
