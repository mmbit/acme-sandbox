// A thread's window (hq window): two times on the thread. Its deadline is the latest the thread may be done (merged and
// deployed) and still be what was agreed: it orders the work, every job on the thread and the work it waits for (the
// backward pass's latest starts: planner.ts backward). Its aim is the time we said when it was agreed, the plan's finish
// then (aim <= deadline; the same time when it mustn't give): the space between them is how much the thread may give. A
// thread with no window has no deadline: it runs on the room every window leaves. A window is set when the work is
// agreed, by hq window or by a call's item with its time when it's handed out (ledger.ts link, hq job --item), and goes
// on the thread, never on one job. HQ tells nobody by itself: whether the board hears, and the new time it's given, is
// the CEO's call.
// Each task inherits the one deadline through its deliverable membership. The plan and pacing read it afresh,
// so a deadline change applies to all its work without task-level copies.
// (its messages say deliverable, the board's word for a thread)
import { db } from './db.ts';
import * as jobs from './jobs.ts';
import { companyFormats, companyMoment, timeZone } from './company.ts';
import { findProject, findThread, type Thread } from './projects.ts';
import { standing, type Forecast } from './forecast.ts';
import type { OrderingSnapshot } from './playtypes.ts';

const MINUTE_MS = 60_000,
  HOUR_MS = 60 * MINUTE_MS,
  DAY_MS = 24 * HOUR_MS;
const DEPTH = 5; // re-lands followed this far
type WorkEnd = 'finished' | 'dropped';

// When a deadline given as text falls, counted from `now`, or why it can't be read: '2h', '90m' or '1h30m' from now;
// '14:30', the next 14:30 UTC; a whole UTC time, '2026-10-06T14:30Z'; or one on the company's clock without a zone,
// '2026-10-06 16:30', at the offset of its own date, so a time the board said needs no converting across a clock change.
// A time already past is refused,
// unless `allowPast` (an agreed time recorded after it passed: a call item's time or hq window's --aim).
export function parse(text: string, now = Date.now(), allowPast = false, field = 'the deadline'): number | string {
  const given = text.trim();
  const relative = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?$/i.exec(given),
    daily = /^(\d{1,2}):(\d{2})$/.exec(given),
    local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/i.exec(given);
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
  } else if (local) {
    const [y, m, d, hour, minute] = local.slice(1).map(Number);
    // (the same typo check, on the date as given)
    const real = new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === given.slice(0, 10);
    if (real && hour < 24 && minute < 60) at = companyMoment(y, m, d, hour, minute);
  }
  if (Number.isNaN(at))
    return (
      `can't read ${field} "${given.slice(0, 40)}": give a time from now (2h, 90m, 1h30m), a UTC time ` +
      `(14:30, 2026-10-06T14:30Z) or one on the company's clock (2026-10-06 16:30, ${timeZone()})`
    );
  return at > now || allowPast ? at : `${field} ${when(at)} has passed already`;
}

// The thread a window goes on, named by its id, by a job on it, or by a pull request (the thread of the work job whose
// branch it's on), or why not.
export function threadOf(target: { thread?: string; job?: number; pr?: number }): Thread | string {
  if (target.thread !== undefined) {
    const thread = findThread(target.thread);
    if (!thread) return `there's no deliverable ${target.thread} (hq deliverable list)`;
    return thread.status === 'open' || inReview(thread.id)
      ? thread
      : `${thread.id} is done: a window goes on an open deliverable`;
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
  if (!job) return pr ? `no job on a deliverable made pull request #${pr.number}` : `there's no job #${target.job}`;
  if (!job.thread) return `job #${job.id} is in no deliverable`;
  return threadOf({ thread: job.thread });
}

function inReview(thread: string) {
  return db
    .prepare(
      `select 1 from jobs j where j.thread = ? and j.kind = 'work' and
      (select status from prs where branch = ${jobs.workBranch('j')} order by number desc limit 1) in ${jobs.OPEN_PRS} limit 1`,
    )
    .get(thread);
}

// The saved windows still ordering work. The queue supplies done tasks whose PRs remain open.
export function current(reviewing: (string | null)[] = []) {
  // Ancestors without open work keep the inheritance chain available to a trial.
  const threads = db
    .prepare(
      `with recursive included(id) as (
        select id from threads where status = 'open' or id in (select value from json_each(?))
        union select t.deadline_from from threads t join included i on i.id = t.id where t.deadline_from is not null
      ) select t.id, w.deadline, w.aim, t.deadline_from from included i
        join threads t on t.id = i.id join thread_windows w on w.id = t.id`,
    )
    .all(JSON.stringify(reviewing)) as Pick<Thread, 'id' | 'deadline' | 'aim' | 'deadline_from'>[];
  return Object.fromEntries(
    threads.map(({ id, deadline, aim, deadline_from }) => [
      id,
      { deadline, aim, ...(deadline_from && { deadline_from }) },
    ]),
  );
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
  db.prepare('update threads set deadline = ?, aim = ?, deadline_by = ?, deadline_from = null where id = ?').run(
    window?.deadline ?? null,
    window?.aim ?? null,
    window ? by : null,
    thread.id,
  );
  const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());
  return { thread: thread.id, deadline: iso(window?.deadline), aim: iso(window?.aim) };
}

// The thread whose window a release follow-up reads until given its own.
export function inherit(thread: string, deadline_from: string) {
  db.prepare('update threads set deadline_from = ? where id = ?').run(deadline_from, thread);
}

// The queue with a thread's window set as given (null: taken off), changed where the snapshot keeps it, its windows and
// its jobs' due (backlog.ts queuedJob), rather than read again: what hq window plays (moves.ts change).
export function withWindow<S extends OrderingSnapshot>(queue: S, thread: string, window: Window | null): S {
  const deadline = window?.deadline ?? null;
  const aim = window?.aim ?? null;
  const entries = Object.entries(queue.windows ?? {});
  const changed = [thread];
  for (const id of changed)
    changed.push(...entries.filter(([, window]) => window.deadline_from === id).map(([follower]) => follower));
  const windows = { ...queue.windows };
  // The trial thread now has its own window. Followers keep their source.
  for (const id of changed) windows[id] = id === thread ? { deadline, aim } : { ...windows[id], deadline, aim };
  return {
    ...queue,
    windows,
    jobs: queue.jobs.map(j => (j.thread && changed.includes(j.thread) ? { ...j, due: deadline } : j)),
  };
}

// Active threads whose forecast misses their window: planned finish past the deadline, or none in sight.
export function misses(f: Forecast) {
  return [...f.threads.values()]
    .filter(o => standing(o) === 'misses')
    .flatMap(o => {
      const t = findThread(o.thread);
      if (!t || (t.status !== 'open' && !inReview(t.id))) return [];
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

// (the job from db.ts jobs_state, not its row: the summary reads the end of every job of each done thread it looks at.
const jobEnd = db.prepare('select id, status, branch from jobs indexed by jobs_state where id = ?');
const branchPr = db.prepare('select number, status from prs where branch = ? order by number desc limit 1');
const relandOf = db.prepare(
  `select id from jobs where kind = 'work' and pr = ? and status != 'cancelled'
    and coalesce(branch, 'job/' || id) != ? order by id desc limit 1`,
);
function endOf(id: number, depth = 0): WorkEnd | undefined {
  const job = jobEnd.get(id) as { id: number; status: string; branch: string | null } | undefined;
  if (job?.status === 'failed' || job?.status === 'cancelled') return 'dropped';
  if (job?.status !== 'done') return undefined;
  const branch = job.branch ?? `job/${job.id}`;
  const pr = branchPr.get(branch) as { number: number; status: string } | undefined;
  if (!pr || pr.status === 'merged') return 'finished';
  if (pr.status !== 'closed' || depth >= DEPTH) return undefined;
  const reland = relandOf.get(pr.number, branch) as { id: number } | undefined;
  return reland ? endOf(reland.id, depth + 1) : 'dropped';
}

const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
