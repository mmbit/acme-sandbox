// Runs that have done nothing for an hour, and what each waits on, read from what HQ already has: the run's last step
// in its log (log.ts), its push's checks and the worker's tests turn (the worker's room report, room.ts), and its hq run
// offloads (runs.ts). A session that waits on none of them is dead: its heartbeat ends it (jobs.ts beat), and its job
// goes back to the queue for a fresh session in its kept clone, told why in its briefing (jobs.ts handBack, claimed).
// The CEO's summary says each idle run with its cause, and a dead session HQ ended for an hour after (threats.ts).
import { db } from './db.ts';
import { publish } from './events.ts';
import { nameOf, type Named } from './jobs.ts';
import { plannerCapacity } from './room.ts';
import { clock } from './windows.ts';
import { age } from '../../worker/hq/waits.ts';

export const IDLE_MS = 60 * 60_000;
// An ended dead session shows in the summary this long.
const ENDED_SHOWN_MS = 60 * 60_000;
// The kinds whose sessions make a step every few minutes while they work (hq wait answers within ~9 min). The intercom
// and a call wait on the board.
const SESSION_KINDS = ['work', 'review', 'consolidate'];

db.exec(`create table if not exists dead_sessions (job integer not null, run integer not null, idle_since text not null,
  last text, asked text not null, ended text, primary key (job, run))`);

type IdleCause =
  | { on: 'turn'; holder: number }
  | { on: 'holding'; waiting: number }
  | { on: 'run'; id: number; kind: string | null; taken: string | null; checks: boolean }
  | { on: 'checks' }
  | { on: 'unread' }
  | { on: 'nothing' };
type Quiet = { run: number; since: number; last: string | null };
type Listed = Named & { id: number; agent: string };

// The summary's lines: each running session idle IDLE_MS or more, the longest first, with what it waits on, then the
// dead sessions HQ ended lately.
export function idleLines(now = Date.now()) {
  const running = db
    .prepare(
      `select id, agent, title, step, round from jobs where status = 'running'
      and kind in (${SESSION_KINDS.map(() => '?').join(', ')}) order by id`,
    )
    .all(...SESSION_KINDS) as Listed[];
  const idle = running.flatMap(job => {
    const quiet = quietOf(job.id);
    return quiet && now - quiet.since >= IDLE_MS ? [{ job, quiet, wait: waitOf(job.id, now) }] : [];
  });
  return [
    ...idle
      .sort((a, b) => a.quiet.since - b.quiet.since)
      .map(
        i =>
          `${named(i.job)} has done nothing for ${age(now - i.quiet.since)}: ${causeWords(i.wait, i.quiet.last, now)}`,
      ),
    ...endedLines(now),
  ];
}

// Ends running job `id`'s session if it's dead (idle IDLE_MS and waiting on nothing), saying whether it did. Kept once a
// run, so its hand-back starts it afresh (startAfresh), and said in HQ's feed.
export function endIfDead(id: number, kind: string, now = Date.now()) {
  if (!SESSION_KINDS.includes(kind)) return false;
  const quiet = quietOf(id);
  if (!quiet || now - quiet.since < IDLE_MS || waitOf(id, now).on !== 'nothing') return false;
  const added = db
    .prepare('insert or ignore into dead_sessions (job, run, idle_since, last, asked) values (?, ?, ?, ?, ?)')
    .run(id, quiet.run, iso(quiet.since), quiet.last, iso(now));
  if (added.changes) {
    const { agent } = db.prepare('select agent from jobs where id = ?').get(id) as { agent: string };
    publish({
      type: 'log',
      agent,
      job: id,
      text: `Ending #${id}'s session: ${age(now - quiet.since)} idle, waiting on nothing`,
    });
  }
  return true;
}

// A job handed back to the queue: whether this hand-back ended the dead session HQ asked to end (jobs.ts handBack then
// clears its session, and its next run starts a new one in its kept clone: restartedWords).
export function startAfresh(id: number, now = Date.now()) {
  return !!db
    .prepare(
      `update dead_sessions set ended = ? where job = ? and ended is null
      and run = (select max(id) from runs where job = ?) returning job`,
    )
    .get(iso(now), id, id);
}

// The words a run starts with after HQ ended its job's dead session, until it has a session of its own (jobs.ts claimed,
// as a hand-up's run is told: the worker's restarted), for a session ended after `after` (claimed: its hand-up's time).
export function restartedWords(job: { id: number; session: string | null }, after = '') {
  if (job.session) return undefined;
  const ended = db
    .prepare(
      `select idle_since, last, ended from dead_sessions where job = ? and ended is not null
      and ended > ? order by run desc`,
    )
    .get(job.id, after) as { idle_since: string; last: string | null; ended: string } | undefined;
  return (
    ended &&
    `HQ ended your last session on this job: it had done nothing for ${age(Date.parse(ended.ended) - Date.parse(ended.idle_since))} ` +
      `and waited on nothing (${lastWords(ended.last)}). This is a new session in the same clone, its files and commits ` +
      'as that session left them: read `git status` and `git log` to see how far it got, and go on from there.'
  );
}

// The job's current run, and when it last did anything: its latest step (a team member's too, and what an agent said,
// whose words are the board's alone: log.ts), or the run's start when it made none since.
function quietOf(job: number): Quiet | undefined {
  const run = db.prepare('select id, started from runs where job = ? order by id desc limit 1').get(job) as
    { id: number; started: string } | undefined;
  if (!run) return undefined;
  const step = db.prepare('select ts, text from job_log where job = ? order by id desc limit 1').get(job) as
    { ts: string; text: string } | undefined;
  // (a run it sent finishing is activity too: its session collects the result at its next poll, then steps on)
  const { helped } = db.prepare('select max(ended) helped from helper_runs where job = ?').get(job) as {
    helped: string | null;
  };
  const started = Date.parse(run.started),
    current = step && Date.parse(step.ts) >= started ? step : undefined;
  return {
    run: run.id,
    since: Math.max(started, current ? Date.parse(current.ts) : 0, helped ? Date.parse(helped) : 0),
    last: current ? current.text || 'a message' : null,
  };
}

// What an idle run waits on: its push's checks (behind the tests turn, holding it, on a run or on their own), a run it
// sent (hq run), nothing, or what the worker hasn't reported lately.
function waitOf(job: number, now: number): IdleCause {
  const capacity = plannerCapacity(now),
    checking = capacity?.memory?.checks;
  if (!checking) return { on: 'unread' };
  const checks = checking.includes(job),
    turns = (capacity.resourceWaits ?? []).filter(edge => edge.resource === 'tests');
  const holder = turns.find(edge => edge.job === job)?.on,
    waiting = turns.filter(edge => edge.on === job).length;
  if (checks && holder) return { on: 'turn', holder };
  if (checks && waiting) return { on: 'holding', waiting };
  const run = db
    .prepare(
      "select id, kind, taken from helper_runs where job = ? and state in ('waiting', 'running') order by id limit 1",
    )
    .get(job) as { id: number; kind: string | null; taken: string | null } | undefined;
  if (run) return { on: 'run', ...run, checks };
  return checks ? { on: 'checks' } : { on: 'nothing' };
}

function causeWords(wait: IdleCause, last: string | null, now: number) {
  const ended = "its session ended, and its push's";
  if (wait.on === 'turn') return `${ended} tests wait for the worker's tests turn, which #${wait.holder}'s push holds`;
  if (wait.on === 'holding')
    return `${ended} tests hold the worker's tests turn, ${wait.waiting === 1 ? '1 push waits' : `${wait.waiting} pushes wait`} behind them`;
  if (wait.on === 'run') {
    const where = wait.taken ? `on a helper since ${clock(Date.parse(wait.taken), now)}` : 'which no helper has taken';
    return `${wait.checks ? `${ended} checks wait` : 'its session waits'} on run #${wait.id}${wait.kind ? ` (${wait.kind})` : ''}, ${where}`;
  }
  if (wait.on === 'checks') return `${ended} checks are still running`;
  if (wait.on === 'unread') return "what it waits on isn't known: the worker hasn't reported its push checks lately";
  return `its session waits on nothing (${lastWords(last)}). HQ ends it at its next heartbeat, and a fresh session takes the job`;
}

// The dead sessions HQ ended in the last ENDED_SHOWN_MS.
function endedLines(now: number) {
  const rows = db
    .prepare(
      `select d.idle_since, d.last, d.ended, j.id, j.agent, j.title, j.step, j.round from dead_sessions d
      join jobs j on j.id = d.job where d.ended > ? order by d.ended`,
    )
    .all(iso(now - ENDED_SHOWN_MS)) as (Listed & { idle_since: string; last: string | null; ended: string })[];
  return rows.map(r => {
    const idle = age(Date.parse(r.ended) - Date.parse(r.idle_since));
    return `${named(r)}: HQ ended its session at ${clock(Date.parse(r.ended), now)}, idle ${idle} and waiting on nothing (${lastWords(r.last)}). A fresh session takes the job`;
  });
}

const lastWords = (last: string | null) => (last ? `its last step: ${last}` : 'no step since its run started');
const named = (j: Listed) => `#${j.id} (${j.agent}: ${nameOf(j)})`;
const iso = (ms: number) => new Date(ms).toISOString();
