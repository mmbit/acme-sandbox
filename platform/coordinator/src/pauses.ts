// Project and thread pauses, their release conditions (jobs merged, or a decision of the board's: decisions.ts), and the
// queued work they hold.
import { db, inOneStep, mergePending, prepared } from './db.ts';
import { ceo } from './company.ts';
import { publish } from './events.ts';
import * as jobs from './jobs.ts';
import * as redraws from './redraws.ts';
import { findProject, findThread } from './projects.ts';
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
// The jobs on what a pause pauses (`j`'s thread): its thread, or every thread of its project
const ON = `(j.thread = $thread or $thread is null and j.thread like $project || '/%')`;

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
  publish({ type: 'log', agent, text: `Paused ${target}: ${why}` });
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
  publish({ type: 'log', agent, text: `Resumed ${target}` });
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

// The open pauses, oldest first (the jobs they wait for in one read)
export function open() {
  const rows = db
    .prepare(redraws.query(`select * from pauses p where ${jobs.pauseHolds('p')} order by p.id`))
    .all() as Row[];
  const untils = untilsOf(rows.map(p => p.id));
  return rows.map(p => described(p, untils.get(p.id) ?? []));
}
// Whether any pause is open (the follow-through check's)
export const anyOpen = () =>
  !!db.prepare(redraws.query(`select 1 from pauses p where ${jobs.pauseHolds('p')} limit 1`)).get();

// The open pause on exactly this project or thread (hq item link <item> pause:<id>), or why there's none
export function openPause(target: string): Row | string {
  const found = targetIn(target.includes('/') ? { thread: target } : { project: target }, true);
  if (typeof found === 'string') return found;
  return openOn(found.project.id, found.thread) ?? `${target} isn't paused (hq thread pause or hq project pause first)`;
}

// Why work on thread `from` can't move to `to` (regroup.ts): an open pause holds it there that wouldn't hold it after the
// move, and work leaves a pause only the way the pause lifts. A moving thread (no `to.thread`) takes its own pauses
// along, never its project's. A moving job keeps only its project's, and only within that project. Undefined when none
// does.
export function shedRefusal(from: string, to: { project: string; thread?: string }) {
  const shed = (
    db
      .prepare(
        redraws.query(
          `select * from pauses p where ${jobs.pauseHolds('p')} and p.project = ? and (p.thread is null or p.thread = ?)`,
        ),
      )
      .all(from.split('/')[0], from) as Row[]
  ).filter(p => (p.thread === null ? p.project !== to.project : to.thread !== undefined && p.thread !== to.thread));
  if (!shed.length) return undefined;
  const pauses = shed.map(p => `${targetOf(p)} (${oneLine(p.why)})`).join(' and ');
  return `the pause on ${pauses} holds this work where it is: move it once that pause lifts`;
}

// What holds a job queued on a paused thread (hq job's answer), or nothing
export function heldBy(job: number) {
  const target = jobs.pausedOn(jobs.threadOf(job));
  const p = target ? open().find(o => o.target === target) : undefined;
  return p ? { paused: { target: p.target, why: p.why, until: p.until.map(u => u.id) } } : {};
}

// The open pauses on a thread, each with the jobs it still waits for (the play: backlog.ts)
export function holding(thread: string | null) {
  if (!thread) return [];
  // (kept prepared: each open job's on every play of the queue.)
  const rows = prepared(
    redraws.query(`select coalesce(p.thread, p.project) target, (select json_group_array(${redraws.current('u.job')}) from pause_until u join jobs prior
        on prior.id = u.job where u.pause = p.id and not ${jobs.merged('prior')}) until
      from pauses p where ${jobs.pauseHolds('p')} and p.project = ? and (p.thread is null or p.thread = ?) order by p.id`),
  ).all(thread.split('/')[0], thread) as { target: string; until: string }[];
  return rows.map(r => ({ target: r.target, until: JSON.parse(r.until) as number[] }));
}

// GET /api/projects with each paused project's and thread's pause: why, by whom since when, and the jobs it waits for
// (projects.ts listProjectBoard gives the rest). The board's item stays out: the board isn't shown its own words.
export function withPauses<B extends { projects: { id: string; threads: { id: string }[] }[] }>(board: B) {
  const all = open();
  const shown = (target: string) => {
    const p = all.find(o => o.target === target);
    return p ? { why: p.why, by: p.by, at: p.at, until: p.until, decision: p.decision } : null;
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

function described(p: Row, until = untilsOf([p.id]).get(p.id) ?? []): Pause {
  const params = { thread: p.thread, project: p.project };
  const held = db
    .prepare(`select count(*) n from jobs j where j.kind != 'chat' and j.status = 'queued' and ${ON}`)
    .get(params) as { n: number };
  // (a job back in the queue after it started, paused by a limit or a restart, is held mid-run)
  const running = db
    .prepare(
      `select j.id, j.agent, j.title, j.step, j.round, j.kind, j.status, j.started from jobs j where j.kind != 'chat' and ${ON}
      and (j.status = 'running' or j.status = 'queued' and j.started is not null) order by j.id`,
    )
    .all(params) as Pause['running'];
  const heldQueued = held.n - running.filter(r => r.status === 'queued').length;
  return {
    id: p.id,
    target: targetOf(p),
    kind: p.thread ? 'thread' : 'project',
    why: p.why,
    by: p.by,
    at: p.at,
    item: p.item,
    until,
    decision:
      p.decision === null
        ? null
        : (db
            .prepare('select id, name, request card from decisions where id = ?')
            .get(p.decision) as Pause['decision']),
    held: heldQueued,
    running,
  };
}

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
  const project = findProject(String(ask.project ?? ''));
  return project ? { project, thread: null } : `there's no project "${ask.project}"`;
}

const openOn = (project: string, thread: string | null) =>
  db
    .prepare(redraws.query(`select * from pauses p where p.project = ? and p.thread is ? and ${jobs.pauseHolds('p')}`))
    .get(project, thread) as Row | undefined;

const row = (id: number) => db.prepare('select * from pauses where id = ?').get(id) as Row | undefined;

// A job the pause can wait for: work that isn't merged yet, and neither on what it pauses nor needing work there first
// (the pause would hold it, and itself, for good).
function untilRefusal(id: number, project: string, thread: string | null) {
  if (!Number.isSafeInteger(id) || id <= 0) return '--until takes a job number';
  const j = db
    .prepare(
      redraws.query(`select j.id, j.status, j.thread, ${jobs.merged('j')} merged, ${mergePending('j')} pending
      from jobs j where j.id = ? and j.kind = 'work'`),
    )
    .get(id) as
    { id: number; status: string; thread: string | null; merged: number; pending: number | null } | undefined;
  if (!j) return `there's no job #${id}`;
  if (j.merged) return `#${id} is done and merged already: the pause would resume at once`;
  if (!j.pending)
    return `#${id} ${j.status === 'done' ? 'ended without work that can merge' : j.status}: the pause would never resume by itself`;
  const on = (t: string | null) => !!t && (thread ? t === thread : t.startsWith(`${project}/`));
  if (on(j.thread)) return `#${id} is on ${j.thread}, which the pause would hold: it would never resume by itself`;
  const held = jobs.prerequisites([id], { ordered: true }).find(n => on(n.thread));
  if (held)
    return `#${id} needs #${held.id} first, on ${held.thread}, which the pause would hold: it would never resume by itself`;
  return null;
}
