// What threatens the plan, for the CEO's summary (summary.ts): the windows missed and the threads giving, from the
// minute's forecast, then what makes work slip before it does (a job past its size, what's stuck, tests failing or slow,
// runs that timed out, the worker's room, a seat near its stop), then the owners' plans (a thread held by a need that
// misses, an inbox or a meeting ask left waiting, a project growing faster than it finishes). Most serious first, each
// line naming its cause.
import { db } from './db.ts';
import { ceo } from './company.ts';
import * as jobs from './jobs.ts';
import { stalled } from './stalls.ts';
import { getRoom, plannerCapacity } from './room.ts';
import { ownerOf } from './projects.ts';
import { findProject } from './projects.ts';
import { clock } from './windows.ts';
import { standing, undrawnWords, type Forecast, type ThreadOutlook } from './forecast.ts';
import { ORIGIN } from './matching.ts';
import { duration, waitWords } from '../../worker/hq/waits.ts';

const MINUTE_MS = 60_000,
  HOUR_MS = 60 * MINUTE_MS,
  DAY_MS = 24 * HOUR_MS;
// A running job shows once its agent time is this far past its size.
const OVER_SIZE_MS = 15 * MINUTE_MS;
// A review round's aim: a push's tests that take longer from claim to result leave it no time.
const ROUND_AIM_MS = 15 * MINUTE_MS;
// Failing tests and timed-out runs show this long, and an inbox or a meeting ask waiting longer shows.
const RECENT_MS = HOUR_MS;
// The worker's room shows when this few jobs fit, and a seat when it's this close to its stop (a share of its windows).
const ROOM_LOW = 2;
const SEAT_NEAR = 0.1;
// Failed work shows this long.
const FAILED_SHOWN_MS = DAY_MS;
// A project shows as sprawling once it drew and added more threads and tasks than it finished by more than this: a new
// thread with a couple of tasks in an hour is the plan going on.
const SPRAWL_SLACK = 3;

// The summary's part, its lines in that order.
export function lines(f: Forecast) {
  const open = openThreads(f);
  return [
    ...missed(open, f.now),
    ...giving(open, f.now),
    ...[...stalled(), ...[getRoom().line ?? []].flat(), ...roomLow(f.now), ...seatsNear(f)],
    ...[...tests(f.now), ...timedOut(f.now), ...pastSize(f)],
    ...[...stuckPrs(), ...failed(f.now)],
    ...[...heldByNeeds(open, f.now), ...inboxes(f.now), ...meetingAsks(f.now), ...sprawl(f.now)],
  ];
}

// ---- windows

type OpenThread = { id: string; name: string; project: string; deadline_by: string | null; outlook: ThreadOutlook };

// The open threads with open work, each with its outlook.
function openThreads(f: Forecast) {
  const rows = db
    .prepare("select id, name, project, deadline_by from threads where status = 'open' order by project, created")
    .all() as Omit<OpenThread, 'outlook'>[];
  return rows.flatMap(t => {
    const outlook = f.threads.get(t.id);
    return outlook ? [{ ...t, outlook }] : [];
  });
}

// Threads whose planned finish is past their deadline, or with none in sight, the furthest past first: by how much,
// who gave the time, and what holds them.
function missed(open: OpenThread[], now: number) {
  const late = open.filter(t => standing(t.outlook) === 'misses');
  // (none in sight is the furthest)
  const slack = (t: OpenThread) => t.outlook.slack ?? -Number.MAX_VALUE;
  return late
    .sort((a, b) => slack(a) - slack(b))
    .map(t => {
      const o = t.outlook;
      const setBy = t.deadline_by === ceo() ? 'you' : t.deadline_by;
      const deadline = `its deadline ${clock(o.deadline!, now)}${setBy ? `, set by ${setBy}` : ''}`;
      const where =
        o.finish === null
          ? `no finish in sight for ${deadline}`
          : `finish ${clock(o.finish, now)}, ${span(-o.slack!)} past ${deadline}`;
      return `${threadName(t)}: ${where}. Held by: ${causeOf(o, now)}`;
    });
}

// What holds a thread first: no task drawn, the earliest cause along the chain
// that sets its finish, else a wait on another thread's job, else nothing but its own work.
function causeOf(o: ThreadOutlook, now: number) {
  const undrawn = undrawnWords(o);
  if (undrawn) return undrawn;
  const link = [...o.chain].reverse().find(l => l.causes.length);
  if (link) return `${waitWords(link.causes[0], ms => clock(ms, now))} (at #${link.job})`;
  const other = o.waits.find(w => w.on === 'job');
  if (other?.on === 'job') return `job #${other.job}${other.thread ? ` in thread ${other.thread}` : ''}`;
  return `nothing but its own work, ${span(o.left_ms)} of agent time left`;
}

// Threads that finish past their aim, inside their deadline, the least slack first.
function giving(open: OpenThread[], now: number) {
  return open
    .filter(t => standing(t.outlook) === 'gives')
    .sort((a, b) => a.outlook.slack! - b.outlook.slack!)
    .map(t => {
      const o = t.outlook;
      const past = `${span(o.finish! - o.aim!)} past its aim ${clock(o.aim!, now)}`;
      return `${threadName(t)}: finish ${clock(o.finish!, now)}, ${past}, ${span(o.slack!)} of slack left to its deadline ${clock(o.deadline!, now)}`;
    });
}

// ---- before they slip

// The worker's memory fits only a couple of jobs at once, fewer than its slots.
function roomLow(now: number) {
  const capacity = plannerCapacity(now);
  const slots = Math.max(0, ...Object.values(capacity?.slots ?? {}));
  if (!capacity || capacity.room > ROOM_LOW || capacity.room >= slots) return [];
  const fit = capacity.room === 1 ? 'fits' : 'fit';
  return [`Only ${plural(capacity.room, 'job')} ${fit} in the worker's memory at once, of its ${slots} slots`];
}

// A ready seat within SEAT_NEAR of its stop in its five-hour window or its week.
function seatsNear(f: Forecast) {
  return f.snapshot.seats.flatMap(s => {
    const windows = [
      { name: 'five-hour window', used: s.fiveHour, resets: s.fiveHourResets },
      { name: 'week', used: s.week, resets: s.weekResets },
    ].filter(w => w.used >= s.stop - SEAT_NEAR && w.used < s.stop);
    if (s.state !== 'ready' || !windows.length) return [];
    const near = windows.map(
      w => `${percent(w.used)} of its ${w.name}${w.resets ? ` (resets ${clock(w.resets, f.now)})` : ''}`,
    );
    return [`seat ${s.id} (${s.engine}) is at ${near.join(' and ')}, its stop at ${percent(s.stop)}`];
  });
}

// Pushes' tests in the last RECENT_MS that failed, and those that took longer than a review round's aim from their
// claim to their result.
function tests(now: number) {
  const runs = db
    .prepare(
      `select t.job, j.agent, t.passed, t.began, t.at from test_results t join jobs j on j.id = t.job
      where t.passed is not null and t.at > ? order by t.at`,
    )
    .all(iso(now - RECENT_MS)) as { job: number; agent: string; passed: number; began: string | null; at: string }[];
  const failed = runs.filter(r => !r.passed).map(r => `#${r.job} (${r.agent})`);
  const slow = runs.flatMap(r => {
    const ms = r.began === null ? 0 : Date.parse(r.at) - Date.parse(r.began);
    return ms > ROUND_AIM_MS ? [`#${r.job}'s ${span(ms)}`] : [];
  });
  return [
    ...(failed.length
      ? [`tests failed on ${plural(failed.length, 'push', 'pushes')} in the last hour: ${failed.join(', ')}`]
      : []),
    ...(slow.length
      ? [`tests took longer than a ${span(ROUND_AIM_MS)} review round from claim to result: ${slow.join(', ')}`]
      : []),
  ];
}

// Runs (hq run) whose command hit its time limit in the last RECENT_MS.
function timedOut(now: number) {
  const runs = db
    .prepare(
      `select id, job, agent, kind, minutes, ended from helper_runs where timed_out = 1 and ended > ? order by ended`,
    )
    .all(iso(now - RECENT_MS)) as {
    id: number;
    job: number;
    agent: string;
    kind: string | null;
    minutes: number;
    ended: string;
  }[];
  return runs.map(
    r =>
      `run #${r.id}${r.kind ? ` (${r.kind})` : ''} of #${r.job} (${r.agent}) hit its ${r.minutes}-minute limit ${span(now - Date.parse(r.ended))} ago`,
  );
}

// Running jobs whose agent time is OVER_SIZE_MS or more past their size.
function pastSize(f: Forecast) {
  return f.snapshot.jobs.flatMap(j => {
    const size = f.sizes.usual.get(j.id)?.agent_ms;
    if (j.status !== 'running' || size === undefined || j.spentMs - size < OVER_SIZE_MS) return [];
    return [
      `#${j.id} (${j.agent}: ${jobs.nameOf(j)}) has run ${span(j.spentMs)} of agent time, ${span(j.spentMs - size)} past its size of ${span(size)}`,
    ];
  });
}

function stuckPrs() {
  const prs = db.prepare("select number, author, round, why from prs where status = 'stuck' order by number").all() as {
    number: number;
    author: string;
    round: number;
    why: string | null;
  }[];
  return prs.map(
    p => `pull request #${p.number} (${p.author}'s, round ${p.round}) is stuck${p.why ? `: ${p.why}` : ''}`,
  );
}

// Work that failed lately with nothing in its place.
function failed(now: number) {
  const rows = db
    .prepare(
      `select j.id, j.agent, j.title, j.step, j.round, j.finished from jobs j where j.kind = 'work' and j.status = 'failed'
      and j.finished > ? and not ${jobs.hasReplacement('j.id')} order by j.id`,
    )
    .all(iso(now - FAILED_SHOWN_MS)) as {
    id: number;
    agent: string;
    title: string;
    step: string | null;
    round: number | null;
    finished: string;
  }[];
  return rows.map(j => `#${j.id} (${j.agent}: ${jobs.nameOf(j)}) failed ${age(now - Date.parse(j.finished))} ago`);
}

// ---- the owners' plans

// Open threads that need a thread whose window is missed.
function heldByNeeds(open: OpenThread[], now: number) {
  const byId = new Map(open.map(t => [t.id, t]));
  const needs = db
    .prepare(
      `select n.thread, n.needs from thread_needs n join threads t on t.id = n.thread where t.status = 'open'
      order by n.thread, n.needs`,
    )
    .all() as { thread: string; needs: string }[];
  return needs.flatMap(n => {
    const [held, need] = [findOpen(n.thread), byId.get(n.needs)];
    if (!held || !need || standing(need.outlook) !== 'misses') return [];
    const o = need.outlook;
    const finish = o.finish === null ? 'no finish in sight' : `finish ${clock(o.finish, now)}`;
    return [
      `${threadName(held)} needs thread ${need.id}, which misses its deadline ${clock(o.deadline!, now)}: ${finish}`,
    ];
  });
}

// (a thread waiting on its needs may have no open work yet)
const findOpen = (id: string) =>
  db.prepare("select id, name, project from threads where id = ? and status = 'open'").get(id) as
    Pick<OpenThread, 'id' | 'name' | 'project'> | undefined;

// Each owner whose proposals have waited over RECENT_MS since they reached them.
function inboxes(now: number) {
  const waiting = db
    .prepare(
      `select id, project, coalesce(heard_at, created) since from proposals where status = 'open'
      and coalesce(heard_at, created) < ? order by since`,
    )
    .all(iso(now - RECENT_MS)) as { id: number; project: string | null; since: string }[];
  const byOwner = Map.groupBy(waiting, p => ownerOf(p));
  return [...byOwner].map(([owner, ps]) => {
    const whose = owner === ceo() ? 'Your' : `${owner}'s`;
    const which = ps.map(p => `#${p.id}`).join(', ');
    return `${whose} inbox has ${plural(ps.length, 'proposal')} waiting, the oldest ${age(now - Date.parse(ps[0].since))}: ${which}`;
  });
}

// Meetings asked for over RECENT_MS ago and not set.
function meetingAsks(now: number) {
  const asks = db
    .prepare(
      "select id, agent, topic, agents, created from meeting_asks where status = 'open' and created < ? order by id",
    )
    .all(iso(now - RECENT_MS)) as { id: number; agent: string; topic: string; agents: string; created: string }[];
  return asks.map(a => {
    const named = (JSON.parse(a.agents) as string[]).join(', ');
    return `meeting ask #${a.id} from ${a.agent} with ${named}, open ${age(now - Date.parse(a.created))} with no meeting set: ${a.topic}`;
  });
}

// The summary's "since the last check": when the last hourly check that recorded its verdict was queued, with the summary
// it read; an hour ago without one. (finished.ts too)
export function lastCheck(now: number) {
  const last = db.prepare('select max(created) at from followthrough_checks where verdict is not null').get() as {
    at: string | null;
  };
  return last.at ? Date.parse(last.at) : now - HOUR_MS;
}

// Each project that drew threads and added tasks (its agents' work, not HQ's review rounds) faster than it finished them,
// since the last check.
function sprawl(now: number) {
  const since = iso(lastCheck(now));
  const projects = db
    .prepare(
      `with drew as (select project, sum(created > $since) drawn, sum(done > $since) threads_done from threads
          group by project),
        tasks as (select t.project, sum(j.created > $since) added, sum(j.status = 'done' and j.finished > $since) tasks_done
          from jobs j join threads t on t.id = j.thread where j.id in (select id from jobs indexed by jobs_counts
            where created > $since or status = 'done' and finished > $since)
          and j.kind = 'work' and ${ORIGIN} = 'work' group by t.project)
      select p.id, coalesce(d.drawn, 0) drawn, coalesce(k.added, 0) added, coalesce(d.threads_done, 0) threads_done,
        coalesce(k.tasks_done, 0) tasks_done
      from projects p left join drew d on d.project = p.id left join tasks k on k.project = p.id
      where p.status = 'open' order by p.id`,
    )
    .all({ since }) as { id: string; drawn: number; added: number; threads_done: number; tasks_done: number }[];
  return projects
    .filter(p => p.drawn + p.added - p.threads_done - p.tasks_done > SPRAWL_SLACK)
    .map(p => {
      const grew = `${plural(p.drawn, 'thread')} drawn and ${plural(p.added, 'task')} added`;
      const done = `${plural(p.threads_done, 'thread')} and ${plural(p.tasks_done, 'task')} finished`;
      return `project ${findProject(p.id)!.name} grew since ${clock(Date.parse(since), now)}: ${grew}, ${done}`;
    });
}

// ---- words

const threadName = (t: Pick<OpenThread, 'id' | 'name' | 'project'>) => `thread ${t.id} (${t.name}, ${ownerOf(t)}'s)`;
const span = (ms: number) => duration(ms / MINUTE_MS);

// How long ago or how long waiting, roughly: minutes, hours, then days. (summary.ts too)
export const age = (ms: number) =>
  ms < HOUR_MS
    ? `${Math.round(ms / MINUTE_MS)} min`
    : ms < 2 * DAY_MS
      ? `${Math.round(ms / HOUR_MS)} h`
      : `${Math.round(ms / DAY_MS)} d`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const percent = (share: number) => `${Math.round(share * 100)}%`;
const iso = (ms: number) => new Date(ms).toISOString();
