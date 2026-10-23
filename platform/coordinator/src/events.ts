// The live feed: everything agents do is an event. HQ subscribes over Server-Sent Events.
import type { ServerResponse } from 'node:http';
import { afterStep, db } from './db.ts';
import * as secrets from './secrets.ts';

// lines: the lines an agent's job changes so far (add, del); tokens: the tokens it has written so far (total). Both to HQ
// only, kept on its status but not in the events table (tokens: the last TOKENS_KEPT_MS of readings, [ms, total], for
// Wire's chart of the work); a log line's tests: the tests a step passed (work.ts). board: a log line of a job holding
// a customer's details, the step itself (the worker's steps.ts shown), for the board's own HQ session alone: the feed
// gives it to HQ's pages, while the events table keeps text, the kind of step, like everything agents can read.
export type Event = {
  // (studio: the photo studio's darkroom, studio.ts office(), not kept in the events table either.)
  ts?: string; type: 'status' | 'chat' | 'post' | 'log' | 'lines' | 'tokens' | 'machines' | 'studio';
  agent?: string; to?: string; text?: string; state?: string;
  // job: the run an agent's own status or lines come from; jobs: on a status from its queue, every job it has running
  job?: number; jobs?: RunningJob[];
  // since: on a working status of a job's own, when that job started (jobs.started, kept across its runs), which its
  // clock counts from
  since?: string;
  add?: number; del?: number; tests?: number; total?: number; board?: string;
  machines?: unknown;   // (machines: each machine live, runs.ts listMachines(); not kept in the events table either)
  studio?: unknown;
};
// since: when it set to work on its task (as HQ's world counts it, so one opened mid-job knows too)
type Lines = { add: number; del: number };
type Status = { state: string; task?: string; since?: string; lines?: Lines; tokens?: [number, number][]; jobs?: RunningJob[] };
// One of an agent's running jobs as its HQ panel names it, newest first (jobs.ts runningJobs): its name or the status
// the agent last gave it, the project and thread it serves (none for a job outside every thread), when it started and
// the lines it changes so far.
export type RunningJob = { id: number; task: string; project?: string; thread?: string; since?: string; lines?: Lines };
const TOKENS_KEPT_MS = 16 * 60_000;

const clients = new Set<ServerResponse>();
export const status = new Map<string, Status>();

// Keys never reach the feed or the events table, whoever sends the text (same pattern as the worker's redact()).
// By shape: Anthropic/OpenAI sk-, Stripe sk_/rk_ (live and test) and whsec_, GitHub gh?_ and github_pat_ (each at a
// word start, so "desk-phone" stays), a password in a URL, Bearer and Basic headers (the payments token, Twilio's
// account:token, or bare after curl -u). Keys without a shape of their own (Twilio's auth token, PAYMENTS_TOKEN,
// HQ_TOKEN) by their name. And every saved key by its value, before the feed and the status map get it too
export const KEYS = /\b(sk-|sk_|rk_|whsec_|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}|(?<=\/\/)[^\s/@:]+:[^\s/@]+(?=@)|\b(Bearer|Basic) [A-Za-z0-9._~+/=-]{8,}|\bAC[0-9a-f]{32}:[0-9a-f]{32}\b/g;
const NAMED = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PIN))(["']?\s*[=:]\s*["']?)[^\s"'&;,]{6,}/g;
export const redact = (t?: string) => secrets.redact(t)?.replace(KEYS, '[redacted]').replace(NAMED, '$1$2[redacted]');

// Public running-job text follows the feed's credential policy
export const redactJob = (job: RunningJob): RunningJob => ({
  ...job, task: redact(job.task)!, project: redact(job.project), thread: redact(job.thread),
});

// an event as the events table keeps it
type Stored = Pick<Event, 'ts' | 'type' | 'agent' | 'to' | 'text' | 'state'>;
const insert = db.prepare('insert into events (ts, type, agent, "to", text, state) values (?, ?, ?, ?, ?, ?)');
// The board's lines of the latest events a page opens with (subscribe), by their row: in memory only, never stored,
// so after a restart those show their text.
const REPLAY = 50;
const boardLines = new Map<number, string>();

// by: who it comes from. An agent's own feed (its steps, status and chat, through its event route) changes nothing in
// HQ's state, so a listener after HQ's changes can leave it out.
export type Source = 'hq' | 'agent';
// (inside a step, once it's kept: db.ts afterStep.)
export function publish(event: Event, by: Source = 'hq') {
  const ts = event.ts ?? new Date().toISOString();
  afterStep(() => publishNow({ ...event, ts }, by));
}
function publishNow(event: Event & { ts: string }, by: Source) {
  const { board: rawBoard, ...e } = event, board = redact(rawBoard);
  e.text = redact(e.text);
  const s = e.agent ? status.get(e.agent) : undefined;
  // a status with the jobs it has running reads as the one it's of (job), in the words the feed last gave it
  if (e.type === 'status' && e.jobs) {
    e.jobs = carried(e.jobs, s?.jobs).map(redactJob);
    e.text = e.jobs.find(j => j.id === e.job)?.task ?? e.text;
  }
  if (e.type === 'lines') {
    if (s) s.lines = { add: e.add ?? 0, del: e.del ?? 0 };
    const running = s?.jobs?.find(j => j.id === e.job);
    if (running) running.lines = s!.lines;
  } else if (e.type === 'tokens') {
    if (s) s.tokens = [...(s.tokens ?? []).filter(([at]) => at > Date.parse(e.ts!) - TOKENS_KEPT_MS), [Date.parse(e.ts!), e.total ?? 0]];
  } else if (e.type !== 'machines' && e.type !== 'studio') {
    const row = Number(insert.run(e.ts, e.type, e.agent ?? null, e.to ?? null, e.text ?? null, e.state ?? null).lastInsertRowid);
    if (board) boardLines.set(row, board);
    if (boardLines.size > REPLAY) boardLines.delete(boardLines.keys().next().value!);
  }
  // a new status keeps the lines and tokens of the job still at work, and an agent's own the jobs it has running: then
  // the lines are those of the job it's of
  if (e.type === 'status' && e.agent) {
    const still = e.state === 'working' && s?.state === 'working';
    const since = e.state !== 'working' ? undefined : e.since ?? (still && s.task === e.text ? s.since : e.ts);
    const jobs = e.jobs ?? (still ? saidOf(s.jobs, e)?.map(redactJob) : undefined);
    const of = jobs?.find(j => j.id === e.job), lines = of ? of.lines : still ? s.lines : undefined;
    status.set(e.agent, { state: e.state ?? 'idle', task: e.text, since, ...(lines && { lines }), ...(still && s.tokens ? { tokens: s.tokens } : {}), ...(jobs && { jobs }) });
  }
  const line = `data: ${JSON.stringify(board ? { ...e, text: board } : e)}\n\n`;
  for (const res of clients) res.write(line);
  for (const heard of listeners) {
    try { heard(e, by); } catch (err) { console.error('An event listener failed:', err); }
  }
}

// A new list of an agent's running jobs keeps what the feed told of those still running: their words and lines
const carried = (jobs: RunningJob[], had: RunningJob[] = []) =>
  jobs.map(j => {
    const was = had.find(h => h.id === j.id);
    return was ? { ...j, task: was.task, ...(was.lines && { lines: was.lines }) } : j;
  });
// An agent's running jobs once it said what it's doing in one of them: that one reads its words
const saidOf = (jobs: RunningJob[] | undefined, e: Event) =>
  jobs?.map(j => (j.id === e.job && e.text ? { ...j, task: e.text } : j));

// What else hears each event as it's published: the forecast plays the queue again a moment after a change
// (forecast.ts).
const listeners = new Set<(e: Event, by: Source) => void>();
export function onPublish(heard: (e: Event, by: Source) => void) {
  listeners.add(heard);
  return () => listeners.delete(heard);
}

export function subscribe(res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const recent = db.prepare(`select id, ts, type, agent, "to", text, state from events order by id desc limit ${REPLAY}`).all() as (Stored & { id: number })[];
  // (history: what was, for the logs; the statuses after it are who's at work now, whole: the stored rows keep no jobs,
  // clocks or lines.)
  for (const { id, ...e } of recent.reverse()) res.write(`data: ${JSON.stringify({ ...e, text: redact(boardLines.get(id) ?? e.text) ?? null, history: true })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'statuses', statuses: Object.fromEntries(status) })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => { clients.delete(res); clearInterval(ping); });
}

// At a stop: every feed ends now, and HQ's EventSource reconnects to the next coordinator.
export function endAll() {
  for (const res of clients) res.end();
}
