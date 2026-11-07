// A project or thread pause in words (pauses.ts): its row, and what the follow-through read, hq and the projects view
// show of it, with the jobs it waits for and the work it holds.
import { db } from './db.ts';
import * as jobs from './jobs.ts';
import * as redraws from './redraws.ts';
import { wholeLive, wholeName, wholeWords } from './whole.ts';

export type Row = {
  id: number;
  project: string;
  thread: string | null;
  why: string;
  by: string;
  at: string;
  item: number | null;
  resumed: string | null;
  resumed_by: string | null;
  decision: number | null;
  until_time: string | null;
  woken: number | null;
  by_job: number | null;
};
// A job a pause waits for, where it is in words (untilWords), and whether it has ended, merged or not (ended)
export type Until = { id: number; agent: string; title: string; state: string; ended: boolean };
// A milestone or deliverable a pause waits for to go live (--until <project>): its id, its name (whole.ts wholeName), in
// words with what it covers, and whether it's live
export type UntilWhole = { id: string; name: string; words: string; live: boolean };
// An open pause as the follow-through read, hq and the projects view show it: what it pauses, why, by whom since when,
// the time (ISO), the jobs and the milestones or deliverables live that wake its owner, the job that woke them once they're met (woken), the board's decision
// it waits for (with its card once there is one), the board's call item, and the work on it that's held or still running.
export type Pause = {
  id: number;
  target: string;
  kind: 'thread' | 'project';
  why: string;
  by: string;
  at: string;
  item: number | null;
  untilTime: string | null;
  until: Until[];
  untilWhole: UntilWhole[];
  woken: number | null;
  decision: { id: number; name: string; card: number | null } | null;
  held: number;
  byJob: number | null; // (the run that made it, which runs on under it)
  // (step, round: a job's name, jobs.ts nameOf.)
  running: {
    id: number;
    agent: string;
    title: string;
    step: string | null;
    round: number | null;
    kind: string;
    status: string;
    started: string | null;
  }[];
};

export const targetOf = (p: Pick<Row, 'project' | 'thread'>) => p.thread ?? p.project;
// The queued and running work a pause may hold: on threads, and in none but what the desk's pause lets go, never what
// no pause holds (jobs.ts pauseLets: the hourly check judging the holds, a pause's wake). Read once for all the pauses described and split per pause in JS: a per-pause query matching its
// thread or any of its project's can't use jobs_status, so it would scan every job's row each time.
type OnThread = Pause['running'][number] & { thread: string | null };
export const workOnThreads = () =>
  db
    .prepare(
      redraws.query(`select j.id, j.agent, j.title, j.step, j.round, j.kind, j.status, j.started, j.thread from jobs j
      where j.status in ('queued', 'running') and not ${jobs.pauseLets('j')} order by j.id`),
    )
    .all() as OnThread[];
// Whether job `j` is on what pause `p` pauses: its thread, every thread of its project, or the desk's work
const isOn = (j: OnThread, p: Pick<Row, 'project' | 'thread'>) =>
  p.project === jobs.DESK
    ? j.thread === null
    : p.thread
      ? j.thread === p.thread
      : !!j.thread?.startsWith(`${p.project}/`);

export function described(p: Row, until = untilsOf([p.id]).get(p.id) ?? [], work = workOnThreads()): Pause {
  const on = work.filter(j => isOn(j, p));
  // (a job back in the queue after it started, paused by a limit or a restart, is held mid-run)
  const running = on.filter(j => j.status === 'running' || j.started !== null).map(({ thread: _thread, ...j }) => j);
  const heldQueued = on.filter(j => j.status === 'queued' && j.started === null).length;
  return {
    id: p.id,
    target: targetOf(p),
    kind: p.thread ? 'thread' : 'project',
    why: p.why,
    by: p.by,
    at: p.at,
    item: p.item,
    untilTime: p.until_time,
    until,
    untilWhole: untilWholeOf(p.id),
    woken: p.woken,
    decision: decisionOf(p),
    held: heldQueued,
    byJob: p.by_job,
    running,
  };
}
export const decisionOf = (p: Row) =>
  p.decision === null
    ? null
    : (db.prepare('select id, name, request card from decisions where id = ?').get(p.decision) as Pause['decision']);

// The jobs each of these pauses waits for, by pause
export function untilsOf(pauses: number[]) {
  const rows = db
    .prepare(
      redraws.query(`select u.pause, j.id, j.agent, j.title, j.status, u.on_main, ${jobs.merged('j')} merged, (select p.number || ' ' || p.status from prs p
        where p.branch = coalesce(j.branch, 'job/' || j.id) order by p.number desc limit 1) pr
      from pause_until u join jobs j on j.id = u.job where u.pause in (select value from json_each(?)) order by u.pause, j.id`),
    )
    .all(JSON.stringify(pauses)) as {
    pause: number;
    id: number;
    agent: string;
    title: string;
    status: string;
    on_main: number;
    merged: number;
    pr: string | null;
  }[];
  const untils = new Map<number, Until[]>();
  for (const r of rows)
    untils.set(r.pause, [
      ...(untils.get(r.pause) ?? []),
      { id: r.id, agent: r.agent, title: r.title, ...untilWords(r) },
    ]);
  return untils;
}

// The milestones and deliverables each of these pauses waits for to go live (their ids), by pause
export function wholesOf(pauses: number[]) {
  const rows = db
    .prepare(
      'select pause, whole from pause_until_whole where pause in (select value from json_each(?)) order by pause, rowid',
    )
    .all(JSON.stringify(pauses)) as { pause: number; whole: string }[];
  const wholes = new Map<number, string[]>();
  for (const r of rows) wholes.set(r.pause, [...(wholes.get(r.pause) ?? []), r.whole]);
  return wholes;
}
// Those of one pause, each in words and whether it's live
export const untilWholeOf = (pause: number): UntilWhole[] =>
  (wholesOf([pause]).get(pause) ?? []).map(id => ({
    id,
    name: wholeName(id),
    words: wholeWords(id),
    live: wholeLive(id),
  }));

// Where a job a pause waits for is: under way, in review, merged, or ended without merging (which wakes its owner too),
// and whether it has ended
function untilWords(j: { status: string; on_main: number; merged: number; pr: string | null }) {
  const at = (state: string, ended: boolean) => ({ state, ended });
  if (j.merged) return at('merged', true);
  if (j.on_main) return at('done, its commits on main', true);
  if (j.status === 'blocked') return at('waiting for the board', false);
  if (j.status === 'queued' || j.status === 'running') return at(j.status, false);
  const [number, status] = (j.pr ?? '').split(' ');
  if (j.status === 'done' && ['open', 'stuck', 'board'].includes(status)) return at(`in review (PR #${number})`, false);
  return at(j.status === 'done' ? 'done without merged work' : j.status, true);
}
