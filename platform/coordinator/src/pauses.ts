// Project and thread pauses, what wakes their owner to judge them (a time, jobs merged or ended: pausewake.ts), the
// decision of the board's whose answer lifts one (decisions.ts), and the queued work they hold. Every pause names what
// wakes its owner, or that nothing does (by hand). Nothing but a resume lifts a pause otherwise: a condition met wakes
// its owner, who lifts it, tells the board or keeps it on for what's still missing. In words: pausewords.ts.
// (its messages say deliverable, the board's word for a thread)
import { db, inOneStep, prepared } from './db.ts';
import { ceo } from './company.ts';
import { publish } from './events.ts';
import * as jobs from './jobs.ts';
import * as redraws from './redraws.ts';
import { findProject, findThread } from './projects.ts';
import { projects } from './company.ts';
import { oneLine } from './agreements.ts';
import { parse as parseTime } from './windows.ts';
import {
  described,
  decisionOf,
  targetOf,
  untilsOf,
  workOnThreads,
  type Pause,
  type Row,
  type Until,
} from './pausewords.ts';
import { untilRefusal } from './pausewake.ts';

export type { Pause, Until } from './pausewords.ts';

const WHY_MAX = 300;

// The CEO's desk as a pause's project: the work in no thread, which is the CEO's (projects.ts ownerOf)
const desk = () => ({ id: jobs.DESK, name: jobs.pauseName(jobs.DESK), owner: ceo() });
const isDesk = (named: string) =>
  named === jobs.DESK ||
  (!!projects().groups.unsorted?.code && named.toUpperCase() === projects().groups.unsorted?.code);

// hq thread pause | hq project pause: the CEO or the project's owner pauses it, why in a line, and what wakes them to
// judge it: --until jobs, once they're all merged or ended, and --until-time, a time (both: once both are met), or
// --by-hand, nothing (the hourly check reads it). A pause for a decision (decisions.ts) is the CEO's, and waits for that.
// Paused already, the same again by whoever may resume it keeps it on with this why and these conditions instead, and
// they wake its owner afresh: how a woken owner keeps holding for what's still missing, or waits for the board's decision
// (hq decision --blocks). The answer is the pause, or why not. A pause holds work that must wait on a condition (the
// board's answer or decision, a hold it asked for), never to put other work first: a window does that (windows.ts), and
// the scheduler makes room (board, call 169). Its running work yields at its next step but the run that made it (`byJob`:
// jobs.ts pauseSuspends).
export function pause(
  ask: {
    thread?: string;
    project?: string;
    why: unknown;
    until?: unknown[];
    untilTime?: unknown;
    byHand?: boolean;
    decision?: number;
    byJob?: number;
  },
  agent: string,
  now = Date.now(),
): Pause | string {
  const found = targetIn(ask);
  if (typeof found === 'string') return found;
  const { project, thread } = found;
  const target = thread ?? project.id;
  if (![project.owner, ceo()].includes(agent))
    return `only ${project.owner} (${project.name}'s owner) or the CEO pauses ${target}`;
  const why = oneLine(String(ask.why ?? ''));
  if (!why || why.length > WHY_MAX) return `say why in one line of up to ${WHY_MAX} characters: the board reads it`;
  const until = [...new Set((ask.until ?? []).map(Number))];
  const unnamed = conditionRefusal({ ...ask, until }, target);
  if (unnamed) return unnamed;
  const already = openOn(project.id, thread);
  if (already) {
    const refused = rearmRefusal(already, agent);
    if (refused) return `${target} is paused already (by ${already.by}, ${already.at.slice(0, 16)} UTC): ${refused}`;
  }
  for (const id of until) {
    const refused = untilRefusal(id, project.id, thread);
    if (refused) return refused;
  }
  const time = ask.untilTime == null ? null : parseTime(String(ask.untilTime), now, false, '--until-time');
  if (typeof time === 'string') return time;
  const untilTime = time === null ? null : new Date(time).toISOString();
  const id = written(
    already?.id,
    { project: project.id, thread, why, by: agent, at: now, decision: ask.decision, untilTime, byJob: ask.byJob },
    until,
  );
  const said = already
    ? `Kept ${jobs.pauseName(target)} paused, on new conditions`
    : `Paused ${jobs.pauseName(target)}`;
  publish({ type: 'log', agent, text: `${said}: ${why}` });
  return described(row(id)!);
}
// A new pause, or an open one (`kept`) on new conditions and made anew by this run, with the jobs that wake its owner: its
// id.
function written(
  kept: number | undefined,
  p: {
    project: string;
    thread: string | null;
    why: string;
    by: string;
    at: number;
    decision?: number;
    untilTime: string | null;
    byJob?: number;
  },
  until: number[],
) {
  return inOneStep(() => {
    if (kept !== undefined) {
      db.prepare('update pauses set why = ?, until_time = ?, decision = ?, by_job = ?, woken = null where id = ?').run(
        p.why,
        p.untilTime,
        p.decision ?? null,
        p.byJob ?? null,
        kept,
      );
      db.prepare('delete from pause_until where pause = ?').run(kept);
    }
    const insert =
      'insert into pauses (project, thread, why, by, at, decision, until_time, by_job) values (?, ?, ?, ?, ?, ?, ?, ?)';
    const id =
      kept ??
      Number(
        db
          .prepare(insert)
          .run(
            p.project,
            p.thread,
            p.why,
            p.by,
            new Date(p.at).toISOString(),
            p.decision ?? null,
            p.untilTime,
            p.byJob ?? null,
          ).lastInsertRowid,
      );
    for (const job of until) db.prepare('insert into pause_until (pause, job) values (?, ?)').run(id, job);
    return id;
  });
}
// Why a pause names no way to wake its owner: none of --until, --until-time and --by-hand, or --by-hand with another
// (its --until-time forms)
function conditionRefusal(
  ask: { until: number[]; untilTime?: unknown; byHand?: boolean; decision?: number },
  target: string,
) {
  const named = ask.until.length > 0 || ask.untilTime != null;
  if (named && ask.byHand) return '--by-hand is for a pause nothing wakes you about: give it or --until/--until-time';
  if (!named && !ask.byHand && ask.decision == null)
    return `say what wakes you to judge ${target}: --until <job> (once it's merged or ended), --until-time <time> (2h, 90m, 2026-10-26 09:00 on the company's clock, 14:30 UTC), or --by-hand (nothing does: the hourly check reads it)`;
  return null;
}
// Why `agent` can't put an open pause on new conditions: as resume, and never one waiting for the board's decision
function rearmRefusal(open: Row, agent: string) {
  if (open.decision !== null) return `it waits for the board's decision #${open.decision}`;
  if (agent !== ceo() && open.item != null) return `only the CEO changes it: it carries the board's item #${open.item}`;
  if (agent !== ceo() && open.by === ceo()) return 'only the CEO changes it: the CEO paused it';
  return null;
}

// hq thread resume | hq project resume: its CEO or the project's owner ends the pause on it, the only way one ends but
// the board's answer to its decision. One the CEO made, or one carrying the board's item, only the CEO.
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
  return (
    openOn(found.project.id, found.thread) ?? `${target} isn't paused (hq deliverable pause or hq project pause first)`
  );
}

// Why work on thread `from` (null: in no thread, held by the desk's pause) can't move to `to` (regroup.ts): an open pause
// holds it there that would not hold it after the move. Its owner or the CEO may move it with a reason, except for
// a board-decision pause. A moving thread takes its own pauses along. A moving job keeps its project's pause only
// within that project. Undefined when no pause refuses the move.
export function shedRefusal(
  from: string | null,
  to: { project: string; thread?: string },
  agent?: string,
  why?: string,
) {
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
  const protectedPause = shed.find(p => p.decision !== null);
  if (protectedPause)
    return `this work waits for the board's decision #${protectedPause.decision}: only its answer lets it go`;
  if (agent && shed.every(p => (agent === ceo() || p.by === agent) && !rearmRefusal(p, agent))) {
    if (!why?.trim()) return 'say why this work leaves its pause with --why "reason": HQ shows it on the feed';
    return undefined;
  }
  const pauses = shed.map(p => `${jobs.pauseName(targetOf(p))} (${oneLine(p.why)})`).join(' and ');
  return `the pause on ${pauses} holds this work where it is: move it once that pause lifts`;
}

// What holds a job queued on a paused thread (hq job's answer), or nothing
export function heldBy(job: number) {
  const target = jobs.pausedOn(job);
  const p = target ? open().find(o => o.target === target) : undefined;
  return p ? { paused: { target: p.target, why: p.why, untilTime: p.untilTime, until: p.until.map(u => u.id) } } : {};
}

// The open pauses on a thread, each with its time, the jobs it still waits for and the open card of the board's decision
// it waits for, if any (the play: backlog.ts).
export function holding(thread: string | null) {
  return holdings()(thread);
}
// Every thread's holding() from one read of the open pauses: the play asks it of each open job's thread, and a read
// builds the redraws' relations whole (redraws.ts query).
export function holdings() {
  // (kept prepared: on every play of the queue.)
  const rows = prepared(
    redraws.query(`select p.project, p.thread, coalesce(p.thread, p.project) target, (select json_group_array(${redraws.current('u.job')}) from pause_until u join jobs prior
        on prior.id = u.job where u.pause = p.id and not ${jobs.merged('prior')}) until, p.until_time,
        (select d.request from decisions d where d.id = p.decision and d.answered is null and d.released is null) card
      from pauses p where ${jobs.pauseHolds('p')} order by p.id`),
  ).all() as {
    project: string;
    thread: string | null;
    target: string;
    until: string;
    until_time: string | null;
    card: number | null;
  }[];
  const held = rows.map(r => ({
    project: r.project,
    thread: r.thread,
    pause: {
      target: r.target,
      untilTime: r.until_time === null ? null : Date.parse(r.until_time),
      until: JSON.parse(r.until) as number[],
      card: r.card,
    },
  }));
  return (thread: string | null) => {
    const project = thread?.split('/')[0] ?? jobs.DESK;
    return held.filter(h => h.project === project && (h.thread === null || h.thread === thread)).map(h => h.pause);
  };
}

// GET /api/projects with each paused project's and thread's pause: why, by whom since when, the time and the jobs it
// waits for, and whether its owner was woken to judge it (woken)
// (projects.ts listProjectBoard gives the rest). The board's item stays out: the board isn't shown its own words.
// (only what it shows: not the work each pause holds, open()'s two reads of the jobs per pause.)
export function withPauses<B extends { projects: { id: string; threads: { id: string }[] }[] }>(board: B) {
  const rows = openRows();
  const untils = untilsOf(rows.map(p => p.id));
  const shown = (target: string) => {
    const p = rows.find(o => targetOf(o) === target);
    return p ? shownOf(p, untils.get(p.id) ?? []) : null;
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
// The open pause holding a thread, its own else its project's, as withPauses shows it (hq thread), or null
export function pauseOf(thread: string) {
  const { target } = db.prepare(redraws.query(`select ${jobs.pausedWith('$thread')} target`)).get({ thread }) as {
    target: string | null;
  };
  const p = target ? openRows().find(o => targetOf(o) === target) : undefined;
  return p ? { target: targetOf(p), ...shownOf(p, untilsOf([p.id]).get(p.id) ?? []) } : null;
}
const shownOf = (p: Row, until: Until[]) => ({
  why: p.why,
  by: p.by,
  at: p.at,
  untilTime: p.until_time,
  until,
  woken: p.woken !== null,
  decision: decisionOf(p),
});

// ---- checks

function targetIn(ask: { thread?: string; project?: string }, closedToo = false) {
  if (ask.thread != null) {
    const thread = findThread(String(ask.thread));
    if (!thread) return `there's no deliverable ${ask.thread} (hq deliverable list)`;
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
