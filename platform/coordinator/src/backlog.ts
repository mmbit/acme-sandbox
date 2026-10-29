// The play's live input: jobs, waits, seats, capacity and measured sizes, review runs and delays.
// The play itself reads only this snapshot, never the database or the clock.
import { db, prepared } from './db.ts';
import * as jobs from './jobs.ts';
import * as pauses from './pauses.ts';
import * as windows from './windows.ts';
import { ORIGIN } from './matching.ts';
import { configuredPlans } from './seatcapacity.ts';
import { fillRates } from './headroom.ts';
import { pacingOn, STOP_DEFAULT } from './seats.ts';
import { reviewPlans, type ProspectiveRun } from './reviewplan.ts';
import * as threadorder from './threadorder.ts';
import { unloop } from './plancycles.ts';
import { plannerCapacity } from './room.ts';
import { wholeSeconds } from './arithmetic.ts';
import { answerTimes } from './answertime.ts';
import { holdMerges } from './mergeholds.ts';
import { deployLag } from './deploytime.ts';
import { heldWindows } from './inbox.ts';
import { observedSeats } from './seatobservations.ts';
import { measuredMemories } from './room.ts';
import type { Memory, OrderingSnapshot, Planned, QueuedJob, Snapshot } from './eta.ts';

const iso = (ms: number) => new Date(ms).toISOString();

type Row = {
  id: number;
  agent: string;
  title: string;
  step?: string | null;
  round?: number | null;
  kind: string;
  origin: QueuedJob['origin'];
  status: string;
  engine: string;
  for_seat: string | null;
  downtime: number;
  after: number | null;
  request: number | null;
  not_before: number;
  held_by: string | null;
  created: string;
  finished: string | null;
  branch: string | null;
  pr: number | null;
  seat: string | null;
  thread: string | null;
  board: number;
  follow_through: number;
  pause_lets: number; // (what no pause holds: jobs.ts pauseLets)
  sorter: number | null; // (the owner's job its sort waits for: sorting.ts)
  spent_ms: number;
  cards: string;
  wakes: string;
};

// Open jobs except chats, done work still in review, then prospective work (hq when).
// Deadlines come from threads still open or in review. Historical jobs stay out of the read.
export function snapshot(now: number, planned: Omit<Planned, 'size'>[] = []): Snapshot {
  const queue = orderingSnapshot(now, planned),
    capacity = plannerCapacity(now),
    measured = fillRates(now);
  const stages = queue.jobs.flatMap(row => row.reviewPlan?.stages.filter(stage => stage.job === undefined) ?? []);
  const future = stages.map((stage, index) => ({ id: -index - 1, agent: stage.agent, kind: stage.kind }));
  const memory = measuredMemories([...queue.jobs.filter(row => row.id > 0), ...future]);
  queue.jobs.forEach(row => {
    row.memoryMb = row.id > 0 ? (memory.get(row.id) ?? null) : null;
  });
  stages.forEach((stage, index) => {
    stage.memoryMb = memory.get(-index - 1) ?? null;
  });
  return {
    ...queue,
    seats: observedSeats(now, STOP_DEFAULT),
    seatPlans: configuredPlans(),
    seatMeasurements: Object.fromEntries([...measured.values()].flatMap(r => [...r.measurements])),
    seatMix: Object.fromEntries([...measured.values()].flatMap(r => [...r.mix])),
    pacing: pacingOn(),
    rates: Object.fromEntries(
      [...measured].map(([engine, r]) => [
        engine,
        { week: Object.fromEntries(r.week), five: Object.fromEntries(r.five) },
      ]),
    ),
    slots: capacity?.slots ?? {},
    ...(capacity
      ? {
          room: capacity.room,
          seatRuns: capacity.seatRuns,
          memory: capacity.memory ? currentMemory(capacity.memory) : undefined,
        }
      : {}),
  };
}

// The backward pass and live eligibility do not consume seat prices or worker capacity.
export function orderingSnapshot(
  now: number,
  planned: Omit<Planned, 'size'>[] = [],
  keepLoops = false,
  prospective?: ProspectiveRun,
): OrderingSnapshot {
  const rows = queueRows(now);
  if (prospective) rows.push({ ...plannedRow({ ...prospective, title: 'Review round' }, now), ...prospective });
  const open = new Map(rows.map(r => [r.id, r]));
  const lastId = Math.max(0, ...rows.map(row => row.id));
  rows.push(...planned.map(p => plannedRow(p, now)));
  const placement = threadorder.placing(
    planned.filter(p => p.placeholder),
    rows,
  );
  const itemCarriers = jobs.itemWorkCarriers();
  const itemBranches = new Set(itemCarriers.values());
  for (const row of rows) {
    const placed = itemCarriers.has(row.id) ? placement.place(row) : undefined;
    if (placed) itemBranches.add(placed.branch);
  }
  const { waits, inOrder } = placement;
  const answers = answerTimes(now),
    lag = deployLag(now);
  const reviewing = rows.filter(row => row.kind === 'work' && row.status === 'done').map(row => row.thread);
  const threadWindows = windows.current(reviewing);
  const paused = jobs.pauseAllowed(),
    due = new Map(
      Object.entries(threadWindows).flatMap(([id, window]) =>
        window.deadline === null ? [] : [[id, window.deadline] as const],
      ),
    ),
    held = heldWindows(),
    rounds = reviewPlans(now, prospective);
  const byPr = Map.groupBy(rows, row => row.pr);
  const holdingOf = pauses.holdings(); // (one read for every thread)
  const holds = new Map([...new Set(rows.map(row => row.thread))].map(thread => [thread, holdingOf(thread)]));
  const queued = rows.map((row, index) => {
    const job = queuedJob(row, { open, waits, answers, lag, paused, due, held, now, byPr, holds, inOrder });
    if (row.id < 0) job.orderId = lastId + index + 1;
    job.itemWork = itemBranches.has(placement.place(row)?.branch ?? jobs.workBranchOf(row));
    job.reviewPlan = rounds(row);
    job.opensReview = job.reviewPlan !== undefined;
    job.placeholder = planned.find(p => p.id === row.id)?.placeholder;
    return job;
  });
  inThreads(rows, queued, placement.place, rounds, keepLoops, now);
  holdMerges(queued, answers);
  return { now, planner: 3, windows: threadWindows, pauseUntil: pauses.untilJobs(), jobs: queued, deployLagMs: lag };
}

function queueRows(now: number) {
  // jobs_queue holds every jobs column here, by state then id: open work and the done work in review are read without
  // a row's brief and output, and prs_plan finds the pull requests in review without their verdicts (db.ts).
  // (board: the order's first lane, jobs.ts LANE)
  const columns = `j.id, j.agent, j.title, j.step, j.round, j.kind, j.status, j.engine, j.for_seat, j.downtime,
    j.after, j.request, j.not_before, j.held_by, j.created, j.branch, j.pr, j.seat, j.thread,
    coalesce(j.finished, (select max(ended) from runs where job = j.id)) finished,
    (select coalesce(sum((julianday(coalesce(ended, $now)) - julianday(started)) * 86400000), 0) from runs where job = j.id) spent_ms,
    (select json_group_array(request) from (${jobs.openCards('j.id')})) cards,
    (select json_group_array(json_object('kind', kind, 'arg', arg)) from wakes where job = j.id and met is null) wakes,
    ${ORIGIN} origin, ${jobs.LANE('j')} board, ${jobs.FOLLOW_THROUGH('j')} follow_through, ${jobs.pauseLets('j')} pause_lets,
    (select p.heard_by from sorts x join proposals p on p.id = x.proposal where x.job = j.id and p.status = 'open') sorter`;
  const inReview = `select w.id from prs p indexed by prs_plan cross join jobs w on w.branch = p.branch
    where p.status in ${jobs.OPEN_PRS} union select cast(substr(p.branch, 5) as integer) from prs p indexed by prs_plan
    where p.status in ${jobs.OPEN_PRS} and p.branch like 'job/%'`;
  const rows = db
    .prepare(
      `select ${columns} from jobs j indexed by jobs_queue where j.kind != 'chat' and j.status in ${jobs.OPEN_JOBS}
      union all select ${columns} from jobs j indexed by jobs_queue where j.id in (${inReview}) and j.kind = 'work'
        and j.status = 'done'
        and (select status from prs where branch = ${jobs.workBranch('j')} order by number desc limit 1) in ${jobs.OPEN_PRS}`,
    )
    .all({ now: iso(now) }) as Row[];
  // (sorted here: sorted in the query, it reads the table in order instead)
  rows.sort((a, b) => a.id - b.id);
  return rows;
}

// Each task in its thread's order (threadorder.ts): what it follows, the branch its review is on, and what stalls it;
// then no thread edge closing a loop.
function inThreads(
  rows: Row[],
  queued: QueuedJob[],
  place: ReturnType<typeof threadorder.placing>['place'],
  rounds: ReturnType<typeof reviewPlans>,
  keepLoops: boolean,
  now: number,
) {
  rows.forEach((row, i) => {
    const placed = place(row),
      job = queued[i];
    if (!placed) return;
    job.reviewPlan = rounds({ ...row, branch: placed.branch });
    job.opensReview = job.reviewPlan !== undefined;
    if (placed.follows !== undefined) job.follows = placed.follows;
    if (placed.needs) job.needs = placed.needs;
    job.reasons.push(...placed.stalls.map(why => ({ on: 'stalled' as const, why })));
  });
  // A task whose thread's next task follows it with nothing else to wait for opens no round: its push waits for that
  // task's (review.ts heldForThread, threadorder.ts nextReady), so the thread plays one review, after its last task. A
  // follower waiting for a time, a card, a deploy or other work lets the push go to review at once, and so does a fix
  // for a round's findings or the board's notes (origin 'fix').
  const onCue = (job: QueuedJob) =>
    !job.wakes.length && !job.cards.length && !job.waitsFor.length && !job.needs?.length && job.notBefore <= now;
  const followed = new Set(queued.flatMap(job => (job.follows !== undefined && onCue(job) ? [job.follows] : [])));
  for (const job of queued)
    if (followed.has(job.id) && job.origin !== 'fix') {
      job.reviewPlan = undefined;
      job.opensReview = false;
    }
  if (!keepLoops) unloop(queued);
}

// Planned work as a queued job: nothing run of it yet, nothing it waits on but its --after.
const plannedRow = (p: Omit<Planned, 'size'>, now: number): Row => ({
  ...{ kind: 'work', origin: 'work', status: 'queued', for_seat: null, downtime: 0, request: null, not_before: 0 },
  ...{
    follow_through: 0,
    held_by: null,
    finished: null,
    branch: null,
    pr: null,
    seat: null,
    created: iso(now),
    board: 0,
    pause_lets: 0,
    sorter: null,
    spent_ms: 0,
    cards: '[]',
    wakes: '[]',
  },
  ...{ id: p.id, agent: p.agent, title: p.title, engine: p.engine, after: p.after ?? null },
  thread: p.thread ?? null,
});

type Context = {
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
};

// What a job waits for: its --after, its further waits and cards (jobs.ts READY), its wakes (hq job --when), and the
// author's job on a pull request in review, which it merges after. (Its lookups kept prepared: db.ts prepared.)
function queuedJob(row: Row, c: Context): QueuedJob {
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
    ...{ engine: row.engine, for_seat: row.for_seat, downtime: row.downtime },
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
    if (c.open.has(prior.id)) waitFor(job, prior.id);
    else if (prior.status !== 'done' || !waitForBranch(job, prior.id, c))
      stall(job, `it waits for job #${prior.id}, which ended without merged work`);
  }
}

// A completed prerequisite leaves its branch merge edge in the plan until the PR resolves.
function waitForBranch(job: QueuedJob, prior: number, c: Context) {
  const before = prepared('select id, branch from jobs where id = ?').get(prior) as
    { id: number; branch: string | null } | undefined;
  if (!before) return false;
  const branch = jobs.workBranchOf(before);
  const pr = prepared(
    `select number from prs where branch = ? and status in ${jobs.OPEN_PRS} order by number limit 1`,
  ).get(branch) as { number: number } | undefined;
  if (!pr) return false;
  const work = [...c.open.values()].find(
    r => r.kind === 'work' && r.status === 'done' && jobs.workBranchOf(r) === branch,
  );
  if (work) waitFor(job, work.id);
  else stall(job, `it waits for pull request #${pr.number}, whose work isn't open`);
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

function currentMemory(memory: Memory): Memory {
  let availableMb = memory.availableMb;
  const runningMb = Object.fromEntries(
    Object.entries(memory.runningMb).filter(([id, mb]) => {
      const job = prepared('select status from jobs where id = ?').get(Number(id)) as { status: string } | undefined;
      if (!job || job.status === 'running') return true;
      availableMb += mb ?? memory.defaultRunMb;
      return false;
    }),
  );
  return { ...memory, availableMb, runningMb };
}
