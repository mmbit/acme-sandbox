// The queue as it stands, the play's input (eta.ts Snapshot): each open job with what it waits for, the seats, and what
// the play takes from the record (how many jobs an engine runs at once, the rates the seats fill at, the lag to a deploy,
// when the board answers a card, how long a review run takes). Everything that reads the database or the clock is here,
// so the play itself stays a function of what this gives it.
import { db, prepared } from './db.ts';
import * as jobs from './jobs.ts';
import * as pauses from './pauses.ts';
import { ORIGIN } from './matching.ts';
import { fillRates } from './headroom.ts';
import { pacingOn, STOP_DEFAULT } from './seats.ts';
import { reviewPlans } from './reviewplan.ts';
import * as threadorder from './threadorder.ts';
import { unloop } from './plancycles.ts';
import { plannerCapacity } from './room.ts';
import { median, wholeSeconds } from './arithmetic.ts';
import { deployLag } from './deploytime.ts';
import { heldWindows } from './inbox.ts';
import type { OrderingSnapshot, Planned, QueuedJob, SeatNow, Snapshot } from './eta.ts';

const MINUTE_MS = 60_000,
  HOUR_MS = 60 * MINUTE_MS,
  DAY_MS = 24 * HOUR_MS,
  WEEK_MS = 7 * DAY_MS;
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
  spent_ms: number;
  cards: string;
  wakes: string;
};

// The queue now: open jobs (chats left out) and done work whose latest pull request is in review, oldest first; then
// work not queued yet, as if queued now (hq when). The rows are looked up among open jobs and the work on the
// branches of pull requests in review, never every job read. Thread deadlines come from the open threads' windows.
//
export function snapshot(now: number, planned: Omit<Planned, 'size'>[] = []): Snapshot {
  const queue = orderingSnapshot(now, planned),
    capacity = plannerCapacity(now);
  return {
    ...queue,
    seats: seats(),
    pacing: pacingOn(),
    rates: Object.fromEntries(
      [...fillRates(now)].map(([engine, r]) => [
        engine,
        { week: Object.fromEntries(r.week), five: Object.fromEntries(r.five) },
      ]),
    ),
    slots: capacity?.slots ?? {},
    ...(capacity ? { room: capacity.room, seatRuns: capacity.seatRuns } : {}),
  };
}

// The backward pass and live eligibility do not consume seat prices or worker capacity.
export function orderingSnapshot(
  now: number,
  planned: Omit<Planned, 'size'>[] = [],
  keepLoops = false,
): OrderingSnapshot {
  const rows = queueRows(now);
  const open = new Map(rows.map(r => [r.id, r]));
  const lastId = Math.max(0, ...rows.map(row => row.id));
  rows.push(...planned.map(p => plannedRow(p, now)));
  const placement = threadorder.ordered()
    ? threadorder.placing(
        planned.filter(p => p.placeholder),
        rows,
      )
    : undefined;
  const waits = placement?.waits ?? jobs.outstandingWaitsByJob([...open.keys()]);
  const answers = answerTimes(now),
    lag = deployLag(now);
  const windows = windowsOf();
  const paused = jobs.pauseAllowed(),
    due = new Map(
      Object.entries(windows).flatMap(([id, window]) =>
        window.deadline === null ? [] : [[id, window.deadline] as const],
      ),
    ),
    held = heldWindows(),
    rounds = reviewPlans(now);
  const byPr = Map.groupBy(rows, row => row.pr);
  const holds = new Map([...new Set(rows.map(row => row.thread))].map(thread => [thread, pauses.holding(thread)]));
  const queued = rows.map((row, index) => {
    const job = queuedJob(row, { open, waits, answers, lag, paused, due, held, now, byPr, holds });
    if (row.id < 0) job.orderId = lastId + index + 1;
    job.reviewPlan = rounds(row);
    job.opensReview = job.reviewPlan !== undefined;
    job.placeholder = planned.find(p => p.id === row.id)?.placeholder;
    return job;
  });
  if (placement) inThreads(rows, queued, placement.place, rounds, keepLoops);
  return { now, planner: 3, windows, jobs: queued, deployLagMs: lag };
}

function queueRows(now: number) {
  // The status index reads open work without scanning completed briefs. The PR branch index finds work in review.
  const columns = `j.id, j.agent, j.title, j.step, j.round, j.kind, j.status, j.engine, j.for_seat, j.downtime,
    j.after, j.request, j.not_before, j.held_by, j.created, j.branch, j.pr, j.seat, j.thread,
    coalesce(j.finished, (select max(ended) from runs where job = j.id)) finished,
    (select coalesce(sum((julianday(coalesce(ended, $now)) - julianday(started)) * 86400000), 0) from runs where job = j.id) spent_ms,
    (select json_group_array(request) from (${jobs.openCards('j.id')})) cards,
    (select json_group_array(json_object('kind', kind, 'arg', arg)) from wakes where job = j.id and met is null) wakes,
    ${ORIGIN} origin, ${jobs.BOARD_CALL('j')} board`;
  const inReview = `select w.id from prs p cross join jobs w on w.branch = p.branch where p.status in ${jobs.OPEN_PRS}
    union select cast(substr(p.branch, 5) as integer) from prs p where p.status in ${jobs.OPEN_PRS} and p.branch like 'job/%'`;
  const rows = db
    .prepare(
      `select ${columns} from jobs j indexed by jobs_status where j.kind != 'chat' and j.status in ${jobs.OPEN_JOBS}
      union all select ${columns} from jobs j where j.id in (${inReview}) and j.kind = 'work' and j.status = 'done'
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
  if (!keepLoops) unloop(queued);
}

function windowsOf() {
  const threads = db.prepare("select id, deadline, aim from threads where status = 'open'").all() as {
    id: string;
    deadline: number | null;
    aim: number | null;
  }[];
  return Object.fromEntries(threads.map(({ id, deadline, aim }) => [id, { deadline, aim }]));
}

// Planned work as a queued job: nothing run of it yet, nothing it waits on but its --after.
const plannedRow = (p: Omit<Planned, 'size'>, now: number): Row => ({
  ...{ kind: 'work', origin: 'work', status: 'queued', for_seat: null, downtime: 0, request: null, not_before: 0 },
  ...{
    held_by: null,
    finished: null,
    branch: null,
    pr: null,
    seat: null,
    created: iso(now),
    board: 0,
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
  holdForPauses(job, row, c);
  // (a planning job: the earliest window of the findings it holds, inbox.ts heldWindows.)
  job.due = row.thread ? (c.due.get(row.thread) ?? null) : (c.held.get(row.id) ?? null);
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
    spentMs: wholeSeconds(row.spent_ms),
    ...{ after: 'released', waitsFor: [], cards: [], wakes: [], due: null, review: null, reasons: [] },
    thread: row.thread,
    ...{ step: row.step, round: row.round },
  };
}

// Its --after and its further waits (hq waits add)
function waitForJobs(job: QueuedJob, row: Row, c: Context) {
  if (row.after) {
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
  // A paused thread or project holds it (a review too) until the jobs the pause waits for merge, or until it's resumed
  // by hand (pauses.ts)
  if (row.status === 'queued')
    for (const p of c.holds.get(row.thread)!) {
      if (!p.until.length) stall(job, `${p.target} is paused until it's resumed`);
      for (const id of p.until)
        if (c.open.has(id)) waitFor(job, id);
        else stall(job, `${p.target} is paused until job #${id} merges, which ended without merged work`);
    }
}

const stall = (job: QueuedJob, why: string) => {
  job.after = 'never';
  job.reasons.push({ on: 'stalled', why });
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
  !!prepared("select 1 from jobs where id = ? and status in ('done', 'failed', 'cancelled')").get(id);

// A time wakes it then, and a call's follow-up or end at once (end). A deploy comes the median lag from a merge to its deploy after
// now (each of the next n deploys), and a job's or pull request's work deployed that long after it merges in the play.
type Wake = { kind: string; arg: string };
function wakeOf(wake: Wake, c: Context): QueuedJob['wakes'][number] {
  if (wake.kind === 'at') return { at: Number(wake.arg) };
  if (wake.kind === 'followed' || wake.kind === 'ended') return { at: c.now };
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

// Each seat as it reports itself now. A seat the board gave no stop level runs to the worker's own (seats.ts
// STOP_DEFAULT). With whether it runs on credits, which the play paces it by as the worker does (playseats.ts).
function seats(): SeatNow[] {
  const rows = db
    .prepare(
      `select s.id, s.engine, s.state, s.until, s.util five_hour, s.resets five_hour_resets, s.week, s.week_resets,
      s.credits, l.stop from seats s left join seat_list l on l.id = s.id order by s.id`,
    )
    .all() as {
    id: string;
    engine: string;
    state: string;
    until: number | null;
    five_hour: number | null;
    five_hour_resets: number | null;
    week: number | null;
    week_resets: number | null;
    credits: number | null;
    stop: number | null;
  }[];
  return rows.map(s => ({
    ...{ id: s.id, engine: s.engine, state: s.state, until: s.until },
    ...{ fiveHour: s.five_hour ?? 0, fiveHourResets: s.five_hour_resets },
    ...{ week: s.week ?? 0, weekResets: s.week_resets, stop: (s.stop ?? STOP_DEFAULT) / 100 },
    credits: s.credits === 1,
  }));
}

// ---- what the play needs from the record

// When the board is expected to answer an open card: the median time cards of its kind took over the last two weeks
// (any kind's, with fewer than FEW of its own), counting only those that took longer than this one has been open so
// far. None took that long: as the play starts. The hour of the day (the board sleeps) isn't played yet.
const ANSWERS_OVER_MS = 2 * WEEK_MS,
  FEW = 3;
function answerTimes(now: number) {
  const answered = db
    .prepare(
      `select kind, (julianday(answered) - julianday(created)) * 86400000 ms from requests
      where answered is not null and answered > ?`,
    )
    .all(iso(now - ANSWERS_OVER_MS)) as { kind: string; ms: number }[];
  return (request: number) => {
    const card = prepared('select kind, created from requests where id = ?').get(request) as
      { kind: string; created: string } | undefined;
    if (!card) return now;
    const created = Date.parse(card.created),
      open = now - created;
    const own = answered.filter(a => a.kind === card.kind);
    const longer = (own.length >= FEW ? own : answered).map(a => a.ms).filter(ms => ms > open);
    const typical = median(longer);
    return typical === null ? now : Math.max(now, Math.round(created + typical));
  };
}
