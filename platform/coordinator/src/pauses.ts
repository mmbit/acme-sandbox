// Project and thread pauses, their release conditions (jobs merged, or a decision of the board's: decisions.ts), and the
// queued work they hold.
import { db, inOneStep, mergePending, prepared } from './db.ts';
import { ceo } from './company.ts';
import { publish } from './events.ts';
import * as jobs from './jobs.ts';
import * as redraws from './redraws.ts';
import { findProject, findThread } from './projects.ts';
import { projects } from './company.ts';
import { oneLine } from './agreements.ts';

const WHY_MAX = 300;

type Row = {
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
};
// A job a pause waits for, and where it is in words (untilWords)
export type Until = { id: number; agent: string; title: string; state: string };
// An open pause as the follow-through read, hq and the projects view show it: what it pauses, why, by whom since when,
// the jobs it waits for, the board's decision it waits for (with its card once there is one), the board's call item, and
// the work on it that's held or still running.
export type Pause = {
  id: number;
  target: string;
  kind: 'thread' | 'project';
  why: string;
  by: string;
  at: string;
  item: number | null;
  until: Until[];
  decision: { id: number; name: string; card: number | null } | null;
  held: number;
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

const targetOf = (p: Pick<Row, 'project' | 'thread'>) => p.thread ?? p.project;
// The queued and running work on threads, and in none but what the desk's pause lets go (jobs.ts deskLets), read
// once for all the pauses described and split per pause in JS: a per-pause query matching its thread or any of its
// project's can't use jobs_status, so it would scan every job's row each time.
type OnThread = Pause['running'][number] & { thread: string | null };
const workOnThreads = () =>
  db
    .prepare(
      `select j.id, j.agent, j.title, j.step, j.round, j.kind, j.status, j.started, j.thread from jobs j
      where j.status in ('queued', 'running') and j.kind != 'chat' and (j.thread is not null or not ${jobs.deskLets('j')})
      order by j.id`,
    )
    .all() as OnThread[];
// Whether job `j` is on what pause `p` pauses: its thread, every thread of its project, or the desk's work
const isOn = (j: OnThread, p: Pick<Row, 'project' | 'thread'>) =>
  p.project === jobs.DESK
    ? j.thread === null
    : p.thread
      ? j.thread === p.thread
      : !!j.thread?.startsWith(`${p.project}/`);
// The CEO's desk as a pause's project: the work in no thread, which is the CEO's (projects.ts ownerOf)
const desk = () => ({ id: jobs.DESK, name: jobs.pauseName(jobs.DESK), owner: ceo() });
const isDesk = (named: string) =>
  named === jobs.DESK ||
  (!!projects().groups.unsorted?.code && named.toUpperCase() === projects().groups.unsorted?.code);

// hq thread pause | hq project pause: the CEO or the project's owner pauses it, why in a line, and --until jobs that
// resume it once they're all done and merged. A pause for a decision (decisions.ts) is the CEO's, and waits for
// that. The answer is the pause, or why not.
export function pause(
  ask: { thread?: string; project?: string; why: unknown; until?: unknown[]; decision?: number },
  agent: string,
): Pause | string {
  const found = targetIn(ask);
  if (typeof found === 'string') return found;
  const { project, thread } = found;
  const target = thread ?? project.id;
  if (![project.owner, ceo()].includes(agent))
    return `only ${project.owner} (${project.name}'s owner) or the CEO pauses ${target}`;
  const why = oneLine(String(ask.why ?? ''));
  if (!why || why.length > WHY_MAX) return `say why in one line of up to ${WHY_MAX} characters: the board reads it`;
  const already = openOn(project.id, thread);
  if (already) return `${target} is paused already (by ${already.by}, ${already.at.slice(0, 16)} UTC): ${already.why}`;
  const until = [...new Set((ask.until ?? []).map(Number))];
  for (const id of until) {
    const refused = untilRefusal(id, project.id, thread);
    if (refused) return refused;
  }
  const id = inOneStep(() => {
    const made = Number(
      db
        .prepare('insert into pauses (project, thread, why, by, at, decision) values (?, ?, ?, ?, ?, ?)')
        .run(project.id, thread, why, agent, new Date().toISOString(), ask.decision ?? null).lastInsertRowid,
    );
    for (const job of until) db.prepare('insert into pause_until (pause, job) values (?, ?)').run(made, job);
    return made;
  });
  publish({ type: 'log', agent, text: `Paused ${jobs.pauseName(target)}: ${why}` });
  return described(row(id)!);
}

// hq thread resume | hq project resume: its CEO or the project's owner ends the pause on it. One the CEO made, or one
// carrying the board's item, only the CEO.
export function resume(
  ask: { thread?: string; project?: string },
  agent: string,
): { ok: true; target: string } | string {
  const found = targetIn(ask, true);
  if (typeof found === 'string') return found;
  const { project, thread } = found;
  const target = thread ?? project.id;
  if (![project.owner, ceo()].includes(agent))
    return `only ${project.owner} (${project.name}'s owner) or the CEO resumes ${target}`;
  const open = openOn(project.id, thread);
  if (!open) return `${target} isn't paused`;
  if (open.decision !== null)
    return `${target} waits for the board's decision #${open.decision}: only the board's answer on its card lets it go`;
  if (agent !== ceo() && open.item != null)
    return `only the CEO resumes ${target}: it carries the board's item #${open.item}`;
  if (agent !== ceo() && open.by === ceo()) return `only the CEO resumes ${target}: the CEO paused it`;
  db.prepare('update pauses set resumed = ?, resumed_by = ? where id = ?').run(
    new Date().toISOString(),
    agent,
    open.id,
  );
  publish({ type: 'log', agent, text: `Resumed ${jobs.pauseName(target)}` });
  return { ok: true, target };
}

// Every minute: a pause whose --until jobs are all done and merged, and whose decision the board answered or released,
// has resumed (the claim already lets its work go): recorded, and said on HQ's feed.
export function sweep(t = Date.now()) {
  const lifted = db
    .prepare(
      redraws.query(`select p.* from pauses p where p.resumed is null
      and (exists (select 1 from pause_until u where u.pause = p.id) or p.decision is not null) and not (${jobs.pauseHolds('p')})`),
    )
    .all() as Row[];
  for (const p of lifted) {
    db.prepare('update pauses set resumed = ? where id = ?').run(new Date(t).toISOString(), p.id);
    const ids = (untilsOf([p.id]).get(p.id) ?? []).map(u => `#${u.id}`);
    const met = [
      ...(ids.length ? [`${ids.join(' and ')} done and merged`] : []),
      ...(p.decision ? ['the board decided'] : []),
    ];
    publish({ type: 'log', agent: p.by, text: `${targetOf(p)} resumed by itself: ${met.join(', and ')}` });
  }
}

// A pull request closed with every commit of its branch on main (review.ts close): it meets the --until on its work, as
// it meets the waits on it. A pause waiting for nothing else has resumed.
export function landed(branch: string, t = Date.now()) {
  const on = `select id from jobs where branch = ? and kind = 'work'`;
  const met = db.prepare(`select distinct pause from pause_until where job in (${on})`).all(branch) as {
    pause: number;
  }[];
  db.prepare(`delete from pause_until where job in (${on})`).run(branch);
  for (const { pause } of met) {
    const p = row(pause);
    if (!p || p.resumed || db.prepare('select 1 from pause_until where pause = ?').get(pause) || p.decision) continue;
    db.prepare('update pauses set resumed = ? where id = ?').run(new Date(t).toISOString(), pause);
    publish({ type: 'log', agent: p.by, text: `${targetOf(p)} resumed by itself: the work it waited for is on main` });
  }
}
// Work closed unmerged, redrawn by job `job` (reviewclosure.ts redirect): a pause until it waits for the redraw.
export const redrawing = (branch: string, job: number) =>
  db
    .prepare(
      `update or replace pause_until set job = ? where job in (select id from jobs where branch = ? and kind = 'work')
      and pause in (select id from pauses where resumed is null or item is not null)`,
    )
    .run(job, branch);

// The open pauses, oldest first (the jobs they wait for, and the work on them, in one read each)
export function open() {
  const rows = openRows();
  const untils = untilsOf(rows.map(p => p.id));
  const work = rows.length ? workOnThreads() : [];
  return rows.map(p => described(p, untils.get(p.id) ?? [], work));
}
const openRows = () =>
  db.prepare(redraws.query(`select * from pauses p where ${jobs.pauseHolds('p')} order by p.id`)).all() as Row[];
// Whether any pause is open (the follow-through check's)
export const anyOpen = () =>
  !!db.prepare(redraws.query(`select 1 from pauses p where ${jobs.pauseHolds('p')} limit 1`)).get();

// The unfinished release jobs of active pauses seed priority in the shared plan.
export function untilJobs() {
  const until = `select distinct ${redraws.current('u.job')} job from pauses p join pause_until u on u.pause = p.id
    join jobs prior on prior.id = u.job where ${jobs.pauseHolds('p')} and not ${jobs.merged('prior')}`;
  return (db.prepare(redraws.query(until)).all() as { job: number }[]).map(row => row.job);
}

// The open pause on exactly this project or thread (hq item link <item> pause:<id>), or why there's none
export function openPause(target: string): Row | string {
  const found = targetIn(target.includes('/') ? { thread: target } : { project: target }, true);
  if (typeof found === 'string') return found;
  return openOn(found.project.id, found.thread) ?? `${target} isn't paused (hq thread pause or hq project pause first)`;
}

// Why work on thread `from` (null: in no thread, held by the desk's pause) can't move to `to` (regroup.ts): an open pause
// holds it there that wouldn't hold it after the move, and work leaves a pause only the way the pause lifts. A moving
// thread (no `to.thread`) takes its own pauses along, never its project's. A moving job keeps only its project's, and
// only within that project. Undefined when none does.
export function shedRefusal(from: string | null, to: { project: string; thread?: string }) {
  const shed = (
    db
      .prepare(
        redraws.query(
          `select * from pauses p where ${jobs.pauseHolds('p')} and p.project = ? and (p.thread is null or p.thread = ?)`,
        ),
      )
      .all(from?.split('/')[0] ?? jobs.DESK, from) as Row[]
  ).filter(p => (p.thread === null ? p.project !== to.project : to.thread !== undefined && p.thread !== to.thread));
  if (!shed.length) return undefined;
  const pauses = shed.map(p => `${jobs.pauseName(targetOf(p))} (${oneLine(p.why)})`).join(' and ');
  return `the pause on ${pauses} holds this work where it is: move it once that pause lifts`;
}

// What holds a job queued on a paused thread (hq job's answer), or nothing
export function heldBy(job: number) {
  const target = jobs.pausedOn(job);
  const p = target ? open().find(o => o.target === target) : undefined;
  return p ? { paused: { target: p.target, why: p.why, until: p.until.map(u => u.id) } } : {};
}

// The open pauses on a thread, each with the jobs it still waits for and the open card of the board's decision it waits
// for, if any (the play: backlog.ts).
export function holding(thread: string | null) {
  // (kept prepared: each open job's on every play of the queue.)
  const rows = prepared(
    redraws.query(`select coalesce(p.thread, p.project) target, (select json_group_array(${redraws.current('u.job')}) from pause_until u join jobs prior
        on prior.id = u.job where u.pause = p.id and not ${jobs.merged('prior')}) until,
        (select d.request from decisions d where d.id = p.decision and d.answered is null and d.released is null) card
      from pauses p where ${jobs.pauseHolds('p')} and p.project = ? and (p.thread is null or p.thread = ?) order by p.id`),
  ).all(thread?.split('/')[0] ?? jobs.DESK, thread) as { target: string; until: string; card: number | null }[];
  return rows.map(r => ({ target: r.target, until: JSON.parse(r.until) as number[], card: r.card }));
}

// GET /api/projects with each paused project's and thread's pause: why, by whom since when, and the jobs it waits for
// (projects.ts listProjectBoard gives the rest). The board's item stays out: the board isn't shown its own words.
// (only what it shows: not the work each pause holds, open()'s two reads of the jobs per pause.)
export function withPauses<B extends { projects: { id: string; threads: { id: string }[] }[] }>(board: B) {
  const rows = openRows();
  const untils = untilsOf(rows.map(p => p.id));
  const shown = (target: string) => {
    const p = rows.find(o => targetOf(o) === target);
    return p ? { why: p.why, by: p.by, at: p.at, until: untils.get(p.id) ?? [], decision: decisionOf(p) } : null;
  };
  return {
    ...board,
    projects: board.projects.map(p => ({
      ...p,
      pause: shown(p.id),
      threads: p.threads.map(t => ({ ...t, pause: shown(t.id) })),
    })),
  };
}

// ---- in words

function described(p: Row, until = untilsOf([p.id]).get(p.id) ?? [], work = workOnThreads()): Pause {
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
    until,
    decision: decisionOf(p),
    held: heldQueued,
    running,
  };
}
const decisionOf = (p: Row) =>
  p.decision === null
    ? null
    : (db.prepare('select id, name, request card from decisions where id = ?').get(p.decision) as Pause['decision']);

// The jobs each of these pauses waits for, by pause
function untilsOf(pauses: number[]) {
  const rows = db
    .prepare(
      redraws.query(`select u.pause, j.id, j.agent, j.title, j.status, ${jobs.merged('j')} merged, (select p.number || ' ' || p.status from prs p
        where p.branch = coalesce(j.branch, 'job/' || j.id) order by p.number desc limit 1) pr
      from pause_until u join jobs j on j.id = u.job where u.pause in (select value from json_each(?)) order by u.pause, j.id`),
    )
    .all(JSON.stringify(pauses)) as {
    pause: number;
    id: number;
    agent: string;
    title: string;
    status: string;
    merged: number;
    pr: string | null;
  }[];
  const untils = new Map<number, Until[]>();
  for (const r of rows)
    untils.set(r.pause, [
      ...(untils.get(r.pause) ?? []),
      { id: r.id, agent: r.agent, title: r.title, state: untilWords(r) },
    ]);
  return untils;
}

// Where a job a pause waits for is: under way, in review, merged, or ended so that the pause won't resume by itself
function untilWords(j: { status: string; merged: number; pr: string | null }) {
  if (j.merged) return 'merged';
  if (j.status === 'blocked') return 'waiting for the board';
  if (j.status === 'queued' || j.status === 'running') return j.status;
  const [number, status] = (j.pr ?? '').split(' ');
  if (j.status === 'done' && ['open', 'stuck', 'board'].includes(status)) return `in review (PR #${number})`;
  return `${j.status === 'done' ? 'done without merged work' : j.status}: the pause won't resume by itself`;
}

// ---- checks

function targetIn(ask: { thread?: string; project?: string }, closedToo = false) {
  if (ask.thread != null) {
    const thread = findThread(String(ask.thread));
    if (!thread) return `there's no thread ${ask.thread} (hq thread list)`;
    if (thread.status !== 'open' && !closedToo) return `${thread.id} is done`;
    const project = findProject(thread.project);
    if (!project) return `${thread.id}'s project ${thread.project} isn't a project (hq plan)`;
    return { project, thread: thread.id };
  }
  if (isDesk(String(ask.project ?? ''))) return { project: desk(), thread: null };
  const project = findProject(String(ask.project ?? ''));
  return project ? { project, thread: null } : `there's no project "${ask.project}"`;
}

const openOn = (project: string, thread: string | null) =>
  db
    .prepare(redraws.query(`select * from pauses p where p.project = ? and p.thread is ? and ${jobs.pauseHolds('p')}`))
    .get(project, thread) as Row | undefined;

const row = (id: number) => db.prepare('select * from pauses where id = ?').get(id) as Row | undefined;

// A job the pause can wait for: work that isn't merged yet, and that neither it nor any job it needs first (at any depth)
// is held short of its merge (the pause would hold them, and itself, for good).
function untilRefusal(id: number, project: string, thread: string | null) {
  if (!Number.isSafeInteger(id) || id <= 0) return '--until takes a job number';
  const j = db
    .prepare(
      redraws.query(`select j.status, ${jobs.merged('j')} merged, ${mergePending('j')} pending from jobs j
      where j.id = ? and j.kind = 'work'`),
    )
    .get(id) as { status: string; merged: number; pending: number | null } | undefined;
  if (!j) return `there's no job #${id}`;
  if (j.merged) return `#${id} is done and merged already: the pause would resume at once`;
  if (!j.pending)
    return `#${id} ${j.status === 'done' ? 'ended without work that can merge' : j.status}: the pause would never resume by itself`;
  const held = jobs.prerequisites([id], { ordered: true }).filter(n => heldShort(n, project, thread));
  const where = (n: { thread: string | null }) => n.thread ?? jobs.pauseName(jobs.DESK);
  const root = held.find(n => n.id === id),
    first = held.find(n => n.id !== id);
  if (root) return `#${id} is on ${where(root)}, which the pause would hold: it would never resume by itself`;
  if (first)
    return `#${id} needs #${first.id} first, on ${where(first)}, which the pause would hold: it would never resume by itself`;
  return null;
}

// Whether the pause on `project` (`thread`, or all of it) holds job `n` short of its merge: it's on what the pause pauses,
// and runs there, or merges only through the review, rulings and fixes its pull request's rounds make there (they
// take its thread: jobs.ts threadFrom). Of what the desk's pause lets go (jobs.ts deskLets), expedited work merges on
// its checks ahead of its review, and a meeting merges nothing. A call's follow-up runs, but its review would wait.
function heldShort(
  n: { thread: string | null; kind: string; expedite: number },
  project: string,
  thread: string | null,
) {
  if (project === jobs.DESK) return n.thread === null && !n.expedite && n.kind !== 'meeting';
  return !!n.thread && (thread ? n.thread === thread : n.thread.startsWith(`${project}/`));
}
