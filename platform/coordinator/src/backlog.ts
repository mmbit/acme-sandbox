// The play's live input: jobs, waits, seats, capacity and measured sizes, review runs and delays.
// The play itself reads only this snapshot, never the database or the clock.
import { db, prepared } from './db.ts';
import { branchUrgent, threadUrgent } from './urgency.ts';
import { whole, type Parts } from './latency.ts';
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
import { answerTimes } from './answertime.ts';
import { holdMerges } from './mergeholds.ts';
import { deployLag } from './deploytime.ts';
import { heldWindows } from './inbox.ts';
import { observedSeats } from './seatobservations.ts';
import { measuredMemories } from './room.ts';
import { queuedJob } from './queuedjob.ts';
import type { Memory, OrderingSnapshot, Planned, QueuedJob, Snapshot } from './eta.ts';

const iso = (ms: number) => new Date(ms).toISOString();

export type Row = {
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
  cli: string | null;
  falls_back: number;
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
  urgent?: number;
  source_urgent?: number; // (its own or its parents' flag, which its branch's reviews and fixes carry: urgency.ts)
  follow_through: number;
  pause_lets: number; // (what no pause holds: jobs.ts pauseLets)
  sorter: number | null; // (the owner's job its sort waits for: sorting.ts)
  spent_ms: number;
  cards: string;
  wakes: string;
};

// Open jobs except chats, done work still in review and prospective runs, with open threads' deadlines.
export function snapshot(now: number, planned: Omit<Planned, 'size'>[] = [], prospective?: ProspectiveRun) {
  return whole(snapshotInParts(now, planned, prospective));
}
// The same read in parts (latency.ts Parts), so the minute's play can give HQ's thread a turn after each.
export function* snapshotInParts(
  now: number,
  planned: Omit<Planned, 'size'>[] = [],
  prospective?: ProspectiveRun,
): Parts<Snapshot> {
  const queue = yield* orderingInParts(now, planned, false, prospective),
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
  const seats = observedSeats(now, STOP_DEFAULT);
  yield 'seats and capacity';
  return {
    ...queue,
    seats,
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
) {
  return whole(orderingInParts(now, planned, keepLoops, prospective));
}
// (the jobs a part of 'the jobs' takes: each job's waits are a few reads of their own, slow on a cold file; exported for
// the claim's plan in turns, ordering.ts)
const JOBS_PER_PART = 50;
export function* orderingInParts(
  now: number,
  planned: Omit<Planned, 'size'>[],
  keepLoops: boolean,
  prospective?: ProspectiveRun,
): Parts<OrderingSnapshot> {
  const rows = queueRows(now);
  yield 'the queue rows';
  if (prospective) rows.push({ ...plannedRow({ ...prospective, title: 'Review round' }, now), ...prospective });
  const open = new Map(rows.map(r => [r.id, r]));
  const lastId = Math.max(0, ...rows.map(row => row.id));
  rows.push(...planned.map(p => plannedRow(p, now)));
  const placement = threadorder.placing(
    planned.filter(p => p.placeholder),
    rows,
  );
  const itemBranches = itemBranchesOf(rows, placement.place);
  const { waits, inOrder, branchTask } = placement;
  yield 'placing';
  const answers = answerTimes(now),
    lag = deployLag(now);
  const reviewing = rows.filter(row => row.kind === 'work' && row.status === 'done').map(row => row.thread);
  const threadWindows = windows.current(reviewing);
  const paused = jobs.pauseAllowed(),
    due = deadlines(threadWindows),
    held = heldWindows();
  yield 'windows and answers';
  const rounds = reviewPlans(now, prospective);
  yield 'review plans';
  const byPr = Map.groupBy(rows, row => row.pr);
  const holdingOf = pauses.holdings(); // (one read for every thread)
  const holds = new Map([...new Set(rows.map(row => row.thread))].map(thread => [thread, holdingOf(thread)]));
  const queued: QueuedJob[] = [];
  for (const [index, row] of rows.entries()) {
    const job = queuedJob(row, { open, waits, answers, lag, paused, due, held, now, byPr, holds, inOrder, branchTask });
    if (row.id < 0) job.orderId = lastId + index + 1;
    const at = placedAt(row, placement.place);
    job.itemWork = itemBranches.has(at.branch);
    Object.assign(job, urgencyOf(row, at, prospective?.id, placement.place, open));
    job.reviewPlan = rounds(row);
    job.opensReview = job.reviewPlan !== undefined;
    job.placeholder = planned.find(p => p.id === row.id)?.placeholder;
    queued.push(job);
    if (index % JOBS_PER_PART === JOBS_PER_PART - 1 || index === rows.length - 1) yield 'the jobs';
  }
  inThreads(rows, queued, placement.place, rounds, keepLoops, now);
  holdMerges(queued, answers);
  yield 'the thread order';
  return { now, planner: 3, windows: threadWindows, pauseUntil: pauses.untilJobs(), jobs: queued, deployLagMs: lag };
}

// A row's branch and the task before it in its thread, as its thread places it
type Place = ReturnType<typeof threadorder.placing>['place'];
function placedAt(row: Row, place: Place) {
  const placed = place(row);
  return { branch: placed?.branch ?? jobs.workBranchOf(row), follows: placed?.follows };
}

// A review or fix carries the urgency of work on its branch: work there already (branchUrgent), and open work before it
// in its thread on the same branch, which joins the branch before the review runs
function urgencyOf(
  row: Row,
  at: ReturnType<typeof placedAt>,
  prospectiveId: number | undefined,
  place: Place,
  open: Map<number, Row>,
) {
  const { branch, follows } = at;
  const sourceUrgent = branchUrgent(branch) || urgentBefore(follows, branch, place, open);
  const urgent = !!row.urgent || (row.id === prospectiveId && sourceUrgent);
  return { urgent, reviewUrgent: urgent || sourceUrgent };
}

function urgentBefore(follows: number | undefined, branch: string, place: Place, open: Map<number, Row>) {
  while (follows !== undefined) {
    const before = open.get(follows);
    const placed = before && place(before);
    if (!placed || placed.branch !== branch) return false;
    if (before.kind === 'work' && before.source_urgent) return true;
    follows = placed.follows;
  }
  return false;
}

// The branches of the work that carries call items (jobs.ts itemWorkCarriers), each as its thread places it
// (out of orderingInParts)
function itemBranchesOf(rows: Row[], place: Place) {
  const itemCarriers = jobs.itemWorkCarriers();
  const itemBranches = new Set(itemCarriers.values());
  for (const row of rows) {
    const placed = itemCarriers.has(row.id) ? place(row) : undefined;
    if (placed) itemBranches.add(placed.branch);
  }
  return itemBranches;
}
const deadlines = (threadWindows: ReturnType<typeof windows.current>) =>
  new Map(
    Object.entries(threadWindows).flatMap(([id, window]) =>
      window.deadline === null ? [] : [[id, window.deadline] as const],
    ),
  );

function queueRows(now: number) {
  // jobs_play holds every jobs column here, by state then id: open work and the done work in review are read without
  // a row's brief and output, and prs_plan finds the pull requests in review without their verdicts (db.ts).
  // (board: the order's first lane, jobs.ts LANE; cli, falls_back: the seats it may run on, playseats.ts)
  const columns = `j.id, j.agent, j.title, j.step, j.round, j.kind, j.status, j.engine, j.for_seat, j.cli,
    ${jobs.FALLS_BACK} falls_back, j.downtime,
    coalesce((select urgent from urgent_tasks where id = j.id), 0) urgent,
    coalesce((select urgent from urgent_work where id = j.id), 0) source_urgent,
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
      `select ${columns} from jobs j indexed by jobs_play where j.kind != 'chat' and j.status in ${jobs.OPEN_JOBS}
      union all select ${columns} from jobs j indexed by jobs_play where j.id in (${inReview}) and j.kind = 'work'
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
  ...{ kind: 'work', origin: 'work', status: 'queued', for_seat: null, cli: null, falls_back: 0, downtime: 0 },
  ...{ request: null, not_before: 0 },
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
  urgent: p.thread ? Number(threadUrgent(p.thread)) : 0,
});

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
