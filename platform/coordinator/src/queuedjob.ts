// What each job in the play's snapshot waits for, from its row as the snapshot reads it (backlog.ts): its --after and
// further waits, its cards and wakes, the pauses that hold it, and a done job's pull request in review.
import { db, prepared } from './db.ts';
import * as jobs from './jobs.ts';
import type * as pauses from './pauses.ts';
import type * as threadorder from './threadorder.ts';
import { wholeSeconds } from './arithmetic.ts';
import { mergeWait } from './mergewait.ts';
import type { Row } from './backlog.ts';
import type { QueuedJob } from './eta.ts';

export type Context = {
  open: Map<number, Row>;
  waits: ReturnType<typeof jobs.outstandingWaitsByJob>;
  answers: (request: number) => number;
  lag: number;
  paused: ReturnType<typeof jobs.pauseAllowed>;
  due: Map<string, number>;
  held: Map<number, number>;
  now: number;
  byPr: Map<number | null, Row[]>;
  holds: Map<string | null, ReturnType<typeof pauses.holding>>;
  inOrder: ReturnType<typeof threadorder.placing>['inOrder'];
  branchTask: ReturnType<typeof threadorder.placing>['branchTask'];
};

// What a job waits for: its --after, its further waits and cards (jobs.ts READY), its wakes (hq job --when), and the
// author's job on a pull request in review, which it merges after. (Its lookups kept prepared: db.ts prepared.)
export function queuedJob(row: Row, c: Context): QueuedJob {
  const job = unplanned(row);
  waitForJobs(job, row, c);
  const cards = [
    ...(JSON.parse(row.cards) as number[]),
    ...(row.status === 'blocked' && row.request ? [row.request] : []),
  ];
  job.cards = [...new Set(cards)].map(request => ({ request, at: c.answers(request) }));
  if (row.status === 'blocked' && !row.request) job.reasons.push({ on: 'board' });
  const wakes = JSON.parse(row.wakes) as Wake[];
  job.wakes = wakes.map(w => wakeOf(w, c));
  // (its sort comes at the end of the owner's job that took it: held there, it holds this one too.)
  if (row.sorter !== null && row.sorter !== row.id && c.open.has(row.sorter))
    job.dependencies = [{ job: row.sorter, until: 'done' }];
  holdForPauses(job, row, c);
  // (the earliest of its thread's window and, for a planning job, the windows of the findings it holds: inbox.ts
  // heldWindows.)
  const dues = [row.thread ? c.due.get(row.thread) : undefined, c.held.get(row.id)].filter(d => d !== undefined);
  job.due = dues.length ? Math.min(...dues) : null;
  if (row.status === 'done') job.review = reviewOf(job, row, c);
  return job;
}

// The job as its row has it, waiting for nothing yet
function unplanned(row: Row): QueuedJob {
  return {
    ...{ id: row.id, agent: row.agent, title: row.title, kind: row.kind, origin: row.origin, status: row.status },
    ...{ engine: row.engine, for_seat: row.for_seat, cli: row.cli, downtime: row.downtime },
    fallsBack: !!row.falls_back,
    ...{ created: Date.parse(row.created), finished: row.finished === null ? null : Date.parse(row.finished) },
    ...{ notBefore: row.held_by ? 0 : row.not_before, seat: row.seat, pr: row.pr, board: row.board },
    ...(row.follow_through ? { followThrough: true } : {}),
    spentMs: wholeSeconds(row.spent_ms),
    ...{ after: 'released', waitsFor: [], cards: [], wakes: [], due: null, review: null, reasons: [] },
    thread: row.thread,
    ...{ step: row.step, round: row.round },
  };
}

// Its --after and its further waits (hq waits add). An --after on a task before it in its own thread is the thread's
// order (threadorder.ts afterInOrder).
function waitForJobs(job: QueuedJob, row: Row, c: Context) {
  if (row.after && !c.inOrder(row, row.after)) {
    job.after = c.open.has(row.after) ? row.after : released(row.after) ? 'released' : 'never';
    waitForBranch(job, row.after, c);
  }
  const further = c.waits.get(row.id) ?? [];
  for (const prior of further) {
    if (prior.status === 'done' && waitForBranch(job, prior.id, c)) continue;
    if (c.open.has(prior.id)) waitFor(job, prior.id);
    else stall(job, `it waits for job #${prior.id}, which ended without merged work`);
  }
}

// A prerequisite's merge edge follows its branch's open PR. A finished task can follow its open deliverable's
// remaining work on that branch first.
function waitForBranch(job: QueuedJob, prior: number, c: Context) {
  const target = mergeWait(prior, c.open, c.branchTask);
  if (!target) return false;
  if ('job' in target) waitFor(job, target.job);
  else stall(job, `it waits for pull request #${target.pr}, whose work isn't open`);
  return true;
}

// The board's pause of everything, and a paused thread or project
function holdForPauses(job: QueuedJob, row: Row, c: Context) {
  if (c.paused && row.status !== 'running' && row.status !== 'done')
    if (!c.paused.has(row.id)) job.reasons.push({ on: 'board', paused: true });
  // A paused thread or project, or the desk (work in no thread), holds it (a review too) until the board answers its
  // decision's card (queued or parked: work needing it hears it), or it's resumed (pauses.ts). Its --until jobs only
  // wake its owner to judge: the play reads the resume as coming after them, the earliest it can.
  const held = ['queued', 'blocked'].includes(row.status) && row.pause_lets === 0;
  for (const p of held ? c.holds.get(row.thread)! : []) {
    if (p.card !== null && !job.cards.some(o => o.request === p.card))
      job.cards.push({ request: p.card, at: c.answers(p.card) });
    if (row.status !== 'queued') continue;
    if (p.untilTime !== null) job.wakes.push({ at: Math.max(p.untilTime, c.now) });
    const open = p.until.filter(id => c.open.has(id));
    if (p.untilTime === null && !open.length && p.card === null)
      stall(job, `${p.target} is paused until it's resumed`, p.target);
    for (const id of open) waitFor(job, id);
  }
}

// (pause: the thread or project whose pause stalls it, which routing reads)
const stall = (job: QueuedJob, why: string, pause?: string) => {
  job.after = 'never';
  job.reasons.push({ on: 'stalled', why, ...(pause && { pause }) });
};
const waitFor = (job: QueuedJob, id: number) => {
  if (!job.waitsFor.includes(id)) job.waitsFor.push(id);
};

// A done job's pull request in review: where it stands, the author's job on it and its review runs
function reviewOf(job: QueuedJob, row: Row, c: Context): QueuedJob['review'] {
  const pr = prepared('select number, status from prs where branch = ? order by number desc limit 1').get(
    jobs.workBranchOf(row),
  ) as { number: number; status: string };
  if (pr.status === 'board') job.reasons.push({ on: 'board' });
  if (pr.status === 'stuck')
    job.reasons.push({ on: 'stalled', why: `its pull request #${pr.number} is stuck in review` });
  const related = c.byPr.get(pr.number) ?? [];
  const author = related.find(r => r.id !== row.id && r.kind === 'work' && r.status !== 'done' && r.pr === pr.number);
  const runs = related.filter(r => r.kind !== 'work').map(r => r.id);
  return { pr: pr.number, state: pr.status, author: author?.id ?? null, runs };
}

// Terminal jobs release their own --after edge. An unresolved PR keeps the branch merge edge.
const released = (id: number) =>
  !!prepared("select 1 from jobs where id = ? and status in ('done', 'failed', 'stopped', 'cancelled')").get(id);

// A time wakes it then, and a call's follow-up or end at once (end). A deploy comes the median lag from a merge to its deploy after
// now (each of the next n deploys), and a job's or pull request's work deployed that long after it merges in the play.
type Wake = { kind: string; arg: string };
function wakeOf(wake: Wake, c: Context): QueuedJob['wakes'][number] {
  if (wake.kind === 'at') return { at: Number(wake.arg) };
  // (sorted: the owner's job that sorts it, queuedJob)
  if (wake.kind === 'followed' || wake.kind === 'ended' || wake.kind === 'sorted') return { at: c.now };
  if (wake.kind !== 'deployed')
    return { at: c.now + c.lag * (wake.kind === 'deploy' ? Number(wake.arg) : 1), deploy: true };
  const job = wake.arg.startsWith('pr:')
    ? (
        db
          .prepare(
            `select j.id from jobs j where j.kind = 'work' and ${jobs.workBranch('j')} = (select branch from prs
        where number = ?) order by j.id limit 1`,
          )
          .get(Number(wake.arg.slice(3))) as { id: number } | undefined
      )?.id
    : Number(wake.arg);
  return job !== undefined && c.open.has(job) ? { deployOf: job } : { at: c.now + c.lag, deploy: true };
}
