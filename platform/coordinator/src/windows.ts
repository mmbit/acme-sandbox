// A thread's window (hq window): two times on the thread. Its deadline is the latest the thread may be done (merged and
// deployed) and still be what was agreed: it orders the work, every job on the thread and the work it waits for (the
// backward pass's latest starts: planner.ts backward). Its aim is the time we said when it was agreed, the plan's finish
// then (aim <= deadline; the same time when it mustn't give): the space between them is how much the thread may give. A
// thread with no window has no deadline: it runs on the room every window leaves. A window is set when the work is
// agreed, by hq window or by a call's item with its time when it's handed out (ledger.ts link, hq job --item), and goes
// on the thread, never on one job. HQ tells nobody by itself: whether the board hears, and the new time it's given, is
// the CEO's call.
import { db } from './db.ts';
import { companyFormats } from './company.ts';
import { findProject, findThread, type Thread } from './projects.ts';
import { standing, type Forecast } from './forecast.ts';
import type { OrderingSnapshot } from './playtypes.ts';

const MINUTE_MS = 60_000,
  HOUR_MS = 60 * MINUTE_MS,
  DAY_MS = 24 * HOUR_MS;
const DEPTH = 5; // re-lands followed this far
type WorkEnd = 'finished' | 'dropped';

// When a deadline given as text falls, counted from `now`, or why it can't be read: '2h', '90m' or '1h30m' from now;
// '14:30', the next 14:30 UTC; or a whole UTC time, '2026-10-06T14:30Z'. A time already past is refused,
// unless `allowPast` (an agreed time recorded after it passed: a call item's time or hq window's --aim).
export function parse(text: string, now = Date.now(), allowPast = false, field = 'the deadline'): number | string {
  const given = text.trim();
  const relative = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?$/i.exec(given),
    daily = /^(\d{1,2}):(\d{2})$/.exec(given);
  let at = NaN;
  if (relative && (relative[1] || relative[2]))
    at = now + Number(relative[1] ?? 0) * HOUR_MS + Number(relative[2] ?? 0) * MINUTE_MS;
  else if (daily && Number(daily[1]) < 24 && Number(daily[2]) < 60) {
    const today = new Date(now).setUTCHours(Number(daily[1]), Number(daily[2]), 0, 0);
    at = today > now ? today : today + DAY_MS;
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?Z$/i.test(given)) {
    at = Date.parse(given.replace(' ', 'T'));
    // Date.parse moves a day that doesn't exist (31 February) on into the next month: that's a typo, not a deadline.
    if (!Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) !== given.slice(0, 10)) at = NaN;
  }
  if (Number.isNaN(at))
    return (
      `can't read ${field} "${given.slice(0, 40)}": give a time from now (2h, 90m, 1h30m) or a UTC time ` +
      '(14:30, 2026-10-06T14:30Z)'
    );
  return at > now || allowPast ? at : `${field} ${when(at)} has passed already`;
}

// The thread a window goes on, named by its id, by a job on it, or by a pull request (the thread of the work job whose
// branch it's on), or why not.
export function threadOf(target: { thread?: string; job?: number; pr?: number }): Thread | string {
  if (target.thread !== undefined) {
    const thread = findThread(target.thread);
    if (!thread) return `there's no thread ${target.thread} (hq thread list)`;
    return thread.status === 'open' ? thread : `${thread.id} is done: a window goes on an open thread`;
  }
  const pr =
    target.pr == null
      ? undefined
      : (db.prepare('select number, branch from prs where number = ?').get(target.pr) as
          { number: number; branch: string } | undefined);
  if (target.pr != null && !pr) return `there's no pull request #${target.pr}`;
  const job = pr
    ? (db
        .prepare(
          `select id, thread from jobs where kind = 'work' and coalesce(branch, 'job/' || id) = ? and thread is not null
        order by id limit 1`,
        )
        .get(pr.branch) as { id: number; thread: string } | undefined)
    : (db.prepare('select id, thread from jobs where id = ?').get(target.job ?? 0) as
        { id: number; thread: string | null } | undefined);
  if (!job) return pr ? `no job on a thread made pull request #${pr.number}` : `there's no job #${target.job}`;
  if (!job.thread) return `job #${job.id} is in no thread`;
  return threadOf({ thread: job.thread });
}

// A thread's window as hq window gives it: its deadline, and its aim when given. Without one the thread's aim stays while
// it's still at or before the new deadline, else it's the deadline. An aim after the deadline is refused.
export type Window = { deadline: number; aim: number };
export function windowOf(thread: Thread, deadline: number, aim?: number): Window | string {
  if (aim !== undefined && aim > deadline)
    return `the aim ${when(aim)} is after the deadline ${when(deadline)}: aim at or before it`;
  return { deadline, aim: aim ?? (thread.aim !== null && thread.aim <= deadline ? thread.aim : deadline) };
}

// A thread's window, given by `by` (who agreed the time: the summary's line names them). A new window replaces the last;
// null takes it off. A call's item with its time comes here, both times at the item's, when the call's follow-up hands
// it out or links it to work (ledger.ts): a time already past shows as late at once (hq window's own is ahead: parse).
export function set(thread: Thread, window: Window | null, by: string) {
  db.prepare('update threads set deadline = ?, aim = ?, deadline_by = ? where id = ?').run(
    window?.deadline ?? null,
    window?.aim ?? null,
    window ? by : null,
    thread.id,
  );
  const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());
  return { thread: thread.id, deadline: iso(window?.deadline), aim: iso(window?.aim) };
}

// The queue with a thread's window set as given (null: taken off), changed where the snapshot keeps it, its windows and
// its jobs' due (backlog.ts queuedJob), rather than read again: what hq window plays (moves.ts change).
export function withWindow<S extends OrderingSnapshot>(queue: S, thread: string, window: Window | null): S {
  const deadline = window?.deadline ?? null;
  return {
    ...queue,
    windows: { ...queue.windows, [thread]: { deadline, aim: window?.aim ?? null } },
    jobs: queue.jobs.map(j => (j.thread === thread ? { ...j, due: deadline } : j)),
  };
}

// The open threads whose window a forecast misses (forecast.ts standing): their planned finish past the deadline, or
// none in sight.
export function misses(f: Forecast) {
  return [...f.threads.values()]
    .filter(o => standing(o) === 'misses')
    .flatMap(o => {
      const t = findThread(o.thread);
      if (t?.status !== 'open') return [];
      const project = findProject(t.project)?.name ?? t.project;
      return [{ thread: t.id, project, name: t.name, deadline: o.deadline!, finish: o.finish }];
    })
    .sort((a, b) => a.deadline - b.deadline || a.thread.localeCompare(b.thread));
}

// What became of work: finished (it ended done with its pull request merged or none opened, or the re-land of one closed
// unmerged finished so), dropped (it failed or was cancelled, or its pull request was closed unmerged and no re-land took
// it on, or that re-land was dropped so), or neither while it goes on. A re-land is another branch's work job naming
// the pull request: an older record, since a close queues none (review.ts close). A time the board was given for
// finished work was kept: linking its item to it is a record, and leaves the deadline of its thread, where other work
// may go on, as it is (ledger.ts link).
export const finished = (id: number) => endOf(id) === 'finished';
export const dropped = (id: number) => endOf(id) === 'dropped';

// A time as the board reads it: on the company's clock (org.yaml's timeZone), with the day when it isn't today.
// (threats.ts too)
export function clock(ms: number, now: number) {
  const f = companyFormats(),
    day = f.dayAt(ms),
    time = f.time(ms, 'en');
  return day === f.dayAt(now) ? time : `${f.weekday(day, 'en', { short: true })} ${time}`;
}

function endOf(id: number, depth = 0): WorkEnd | undefined {
  const job = db.prepare('select id, status, branch from jobs where id = ?').get(id) as
    { id: number; status: string; branch: string | null } | undefined;
  if (job?.status === 'failed' || job?.status === 'cancelled') return 'dropped';
  if (job?.status !== 'done') return undefined;
  const branch = job.branch ?? `job/${job.id}`;
  const pr = db.prepare('select number, status from prs where branch = ? order by number desc limit 1').get(branch) as
    { number: number; status: string } | undefined;
  if (!pr || pr.status === 'merged') return 'finished';
  if (pr.status !== 'closed' || depth >= DEPTH) return undefined;
  const reland = db
    .prepare(
      `select id from jobs where kind = 'work' and pr = ? and status != 'cancelled'
    and coalesce(branch, 'job/' || id) != ? order by id desc limit 1`,
    )
    .get(pr.number, branch) as { id: number } | undefined;
  return reland ? endOf(reland.id, depth + 1) : 'dropped';
}

const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
