// Work regrouped (hq thread move, hq job move): a thread into another project, or a job with its review loop into another
// thread, by the CEO, the process team or the work's owner. A moved thread's old id keeps resolving (projects.ts
// findThread). Also a task out of its thread, as the CEO expedites it (hq expedite).
// (the work's owner: its thread's project's, projects.ts ownerOf)
// (its messages say deliverable, the board's word for a thread)
import { db, inOneStep, planChange } from './db.ts';
import { ceo } from './company.ts';
import { oneLine } from './agreements.ts';
import { deskLets, inProcess, loopJobs, WORK_LEAD } from './jobs.ts';
import { dropped, finished } from './windows.ts';
import { findProject, findThread, ownerOf, type Thread } from './projects.ts';
import { threadClash } from './names.ts';
import { oneTask } from './made.ts';
import { publish } from './events.ts';
import { shedRefusal } from './pauses.ts';
import * as redraws from './redraws.ts';
import * as messages from './messages.ts';
import * as predictionlog from './predictionlog.ts'; // (its table, whose thread rows move with the thread)

// hq thread move <project>/<slug> <project>: the thread becomes <project>/<slug> there, and everything that names it
// follows: its jobs, proposals, pause (a paused thread stays paused, and the call item it carries with it) and prediction
// records. Its window is on its own row. An open thread's name must be free in the product it moves to (names.ts
// threadClash; HQ's one-task threads aside, as when they're made). The thread,
// or why not.
export function moveThread(id: string, to: string, agent: string, why = ''): Thread | string {
  why = oneLine(why);
  const thread = findThread(id);
  if (!thread) return `there's no deliverable ${id} (hq deliverable list)`;
  const project = findProject(to);
  if (!project) return `there's no project "${to}" (hq projects)`;
  if (thread.project === project.id) return `${thread.id} is in ${project.id} already`;
  const owner = ownerOf(thread);
  if (!mayMove(agent, owner)) return `only ${owner}, the CEO or the process team can move ${thread.id}`;
  const from = thread.id,
    moved = `${project.id}/${from.slice(thread.project.length + 1)}`;
  const taken = findThread(moved);
  if (taken && taken.id !== from) return `${moved} is a deliverable already`;
  const clash = thread.status === 'open' && !oneTask(from) ? threadClash(project, thread.name, from) : undefined;
  if (clash) return clash;
  const held = shedRefusal(from, { project: project.id }, agent, why);
  if (held) return held;
  const changed = redraws.withoutLoop(from, () => newId(from, moved, project.id));
  if (typeof changed === 'string') return changed;
  publish({ type: 'log', agent, text: `${thread.name} moved to ${project.name}${why ? `: ${why}` : ''}` });
  return findThread(moved)!;
}

// The thread `from` is `to` now, in `project`, and everything that names it follows; the old id keeps resolving (hq
// thread move, and hq plan rename with a new slug: plan.ts).
export function newId(from: string, to: string, project: string) {
  inOneStep(() => {
    db.prepare('update threads set id = ?, project = ? where id = ?').run(to, project, from);
    predictionlog.write(); // (the plays' rows not written yet, so they move too)
    for (const table of ['jobs', 'proposals', 'prediction_log', 'review_inbox'])
      db.prepare(`update ${table} set thread = ? where thread = ?`).run(to, from);
    for (const table of ['proposals', 'review_inbox'])
      db.prepare(`update ${table} set project = ? where thread = ?`).run(project, to);
    // the threads it needs and those that need it (plan.ts).
    db.prepare('update thread_needs set thread = ? where thread = ?').run(to, from);
    db.prepare('update thread_needs set needs = ? where needs = ?').run(to, from);
    db.prepare('update pauses set project = ?, thread = ? where thread = ?').run(project, to, from);
    db.prepare('update call_items set ref = ? where ref = ?').run(`pause ${to}`, `pause ${from}`);
    db.prepare('delete from thread_aliases where old = ?').run(to);
    db.prepare('update thread_aliases set id = ? where id = ?').run(to, from);
    db.prepare('insert into thread_aliases (old, id) values (?, ?)').run(from, to);
  });
}

// hq job move <job> <project>/<slug>: work still going on, its review loop with it (the lead job on its branch, the
// reviews and fix rounds, which later rounds inherit), onto another open thread, from one or from none. The thread and the
// jobs it moved, or why not.
export function moveJob(
  job: number,
  to: string,
  agent: string,
  senderJob = job,
  why = '',
): { thread: string; jobs: number[]; notices?: string[] } | string {
  why = oneLine(why);
  const row = db.prepare(`select j.id, j.status, j.thread, ${WORK_LEAD} lead from jobs j where j.id = ?`).get(job) as
    { id: number; status: string; thread: string | null; lead: number } | undefined;
  if (!row) return `there's no job #${job}`;
  const lead = db.prepare('select agent from jobs where id = ?').get(row.lead) as { agent: string };
  // (dropped: failed, cancelled, or its pull request closed unmerged.)
  if (dropped(row.lead) || finished(row.lead))
    return `job #${row.lead}'s work has ended: only work still going on moves`;
  const thread = findThread(to);
  if (thread?.status !== 'open') return `${to} isn't an open deliverable (hq deliverable list)`;
  const had = row.thread ? findThread(row.thread) : undefined;
  if (had?.id === thread.id) return `job #${job} is on ${thread.id} already`;
  const owner = had && ownerOf(had);
  if (!mayMove(agent, owner, lead.agent))
    return `only ${[lead.agent, owner].filter(Boolean).join(', ')}, the CEO or the process team can move job #${job}`;
  const loop = { job, lead: row.lead, branch: `job/${row.lead}` };
  // (in no thread: what the desk's pause holds, jobs.ts deskLets.)
  const on = db
    .prepare(
      `select distinct thread from jobs where (id in ($job, $lead) or ${LOOP})
      and (thread is not null or not ${deskLets('jobs')})`,
    )
    .all(loop) as { thread: string | null }[];
  const held = on
    .map(r => shedRefusal(r.thread, { project: thread.project, thread: thread.id }, agent, why))
    .find(Boolean);
  if (held) return held;
  // (its place in its old thread's order stays there: by its id in the new one, plan.ts.)
  const from = on.map(r => r.thread).filter((id): id is string => id !== null && id !== thread.id);
  const moved = moveGroup(loop, thread, from, { agent, job: senderJob });
  if (typeof moved === 'string') return moved;
  publish({ type: 'log', agent, text: `Job #${row.lead} moved to ${thread.name}${why ? `: ${why}` : ''}` });
  return { thread: thread.id, ...moved };
}

// hq expedite on a thread's task (review.ts expedite): one that never started leaves its thread as its own expedited job,
// its brief, item and agent kept, and the thread's later tasks stop waiting for it. It runs on its own branch from main,
// without the thread's earlier work. One that ran shares the thread's branch with the others' work, so it stays, and the
// refusal says what to do instead.
export function takeOut(
  job: number,
  agent: string,
): { taken: true; thread: string } | { taken: false; refusal: string } {
  const row = db.prepare('select status, thread, branch, pr, started from jobs where id = ?').get(job) as {
    status: string;
    thread: string;
    branch: string | null;
    pr: number | null;
    started: string | null;
  };
  const thread = findThread(row.thread)!;
  if (row.status === 'running')
    return {
      taken: false,
      refusal: `job #${job} is running now on the branch it shares with the rest of ${thread.id}, so it can't leave that deliverable: ${QUEUE_THE_FIX}`,
    };
  if (row.status !== 'queued' || row.started || row.branch || row.pr)
    return {
      taken: false,
      refusal: `job #${job} has already run on the branch it shares with the rest of ${thread.id}, so it merges with that deliverable: ${QUEUE_THE_FIX}`,
    };
  redraws.writePlan(() => {
    redraws.rememberHolds();
    db.prepare('update jobs set thread = null, seq = null, expedite = 1 where id = ?').run(job);
    planChange({ project: thread.project, thread: thread.id, what: `task #${job} taken out, expedited`, by: agent });
  });
  publish({ type: 'log', agent, text: `Job #${job} left ${thread.name}, expedited` });
  return { taken: true, thread: thread.id };
}
// What an expedite refusal tells its caller to do instead
export const QUEUE_THE_FIX =
  'to put the fix first, queue it as its own job with hq job --expedite (on a call: the job tool with expedite)';

function moveGroup(
  loop: { job: number; lead: number; branch: string },
  thread: Thread,
  from: string[],
  by: { agent: string; job: number },
) {
  try {
    return redraws.withoutLoop(thread.id, () => {
      const jobs = placeJobs(loop, thread)
        .map(r => r.id)
        .sort((a, b) => a - b);
      const notices = notifyNeeds(from, thread.id, by);
      return { jobs, ...(notices.length ? { notices } : {}) };
    });
  } catch (err) {
    if (err instanceof NeedNoticeError) return err.message;
    throw err;
  }
}

function placeJobs(loop: { job: number; lead: number; branch: string }, thread: Thread) {
  redraws.rememberHolds();
  const moved = db
    .prepare(`update jobs set thread = $thread, seq = null where id in ($job, $lead) or ${LOOP} returning id`)
    .all({ ...loop, thread: thread.id }) as { id: number }[];
  db.prepare(
    'update proposals set thread = ?, project = ? where id in (select proposal from review_inbox where branch = ?)',
  ).run(thread.id, thread.project, loop.branch);
  db.prepare('update review_inbox set thread = ?, project = ? where branch = ?').run(
    thread.id,
    thread.project,
    loop.branch,
  );
  return moved;
}

function notifyNeeds(from: string[], to: string, by: { agent: string; job: number }) {
  const needing = db
    .prepare(
      `with recursive destination_needs(id) as (select ?
      union select n.needs from thread_needs n join destination_needs d on n.thread = d.id)
    select distinct t.id, t.project, t.id in (select id from destination_needs) creates_loop
    from threads t join thread_needs n on n.thread = t.id
    where t.status = 'open' and n.needs in (select value from json_each(?)) order by t.id`,
    )
    .all(to, JSON.stringify(from)) as { id: string; project: string; creates_loop: number }[];
  return needing.map(thread => {
    const owner = ownerOf(thread);
    const old = db.prepare('select needs from thread_needs where thread = ? order by needs').all(thread.id) as {
      needs: string;
    }[];
    const canRepoint = !thread.creates_loop && !old.some(n => n.needs === to);
    const preparation = canRepoint
      ? `To re-point any old need, first run hq plan need ${thread.id} ${to} once. If it is refused, keep all old needs. After it succeeds, choose independently for each old need. `
      : '';
    const decisions = old
      .filter(n => from.includes(n.needs))
      .map(({ needs }) => {
        const change = `${canRepoint ? 're-point' : 'remove'} it: hq plan unneed ${thread.id} ${needs}`;
        return `Work moved from ${needs} to ${to}. Decide: keep the need on ${needs} (no command), or ${change}.`;
      });
    const line = `${thread.id} (${owner}): ${preparation}${decisions.join(' ')}`;
    if (owner !== by.agent) {
      const sent = messages.send(by, owner, line);
      if (typeof sent === 'number')
        throw new NeedNoticeError(
          `could not notify ${owner} for ${thread.id} (hq say: ${sent}). Resolve the message refusal, then retry the move`,
        );
    }
    return line;
  });
}

class NeedNoticeError extends Error {}

// The jobs on the lead's branch: its reviews and fix rounds
const LOOP = `id in ${loopJobs('$branch')}`;

const mayMove = (agent: string, ...owners: (string | undefined)[]) =>
  agent === ceo() || inProcess(agent) || owners.includes(agent);
