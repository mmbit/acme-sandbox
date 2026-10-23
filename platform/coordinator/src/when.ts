// hq when: when new work could be done, played into the plan as it stands. The work is sized like hq estimate (or by
// the size given), then the queue is played several ways on one snapshot: without it, with it and no window (the room
// every window leaves), and with it given a deadline in each span between the points where its place in the play's
// order changes, the first that holds narrowed down. That is the earliest it can be done without making any window
// miss, or there is none in the play's reach. With --by, whether it makes that time, with a sooner deadline if need be;
// only when it doesn't, what would, as played: the windows ahead of it giving way, each against its deadline then, and
// one more seat like one HQ has with measured rates, searched the same way. Seats the plays count as never filling are
// named. Nothing is kept: the plays are no forecast, and the answer is a time and the window to set (hq window).
import { db } from './db.ts';
import { findAgent } from './jobs.ts';
import { pastJobs, type Work } from './matching.ts';
import * as predictions from './predictions.ts';
import { readSize } from './sizes.ts';
import { agreed, type Deadline } from './deadlines.ts';
import * as windows from './windows.ts';
import { threadOutlooks, standing, type ThreadOutlook } from './forecast.ts';
import { findProject, findThread } from './projects.ts';
import { play, type Outlook, type Size, type Snapshot } from './eta.ts';
import { HORIZON_DAYS, playOrder } from './simulation.ts';

const MINUTE_MS = 60_000,
  DAY_MS = 86_400_000;
// A thread that ends this much later than without the work only moved with the clock.
const STEP_MS = 5 * MINUTE_MS;
const PLANNED = -1;

export type Ask = { q?: unknown; size?: unknown; agent?: unknown; after?: unknown; by?: unknown };
type Given = { title: string; agent: string; size: number | null; after?: number; by?: number };
// A window against the work's play: the thread, how far past its deadline it ends (null: no finish in sight then).
export type Give = { thread: string; project: string; name: string; deadline: number; past_ms: number | null };
// unpriced: the seats the play counts as never filling, their fill rates not measured yet (simulation.ts unpricedSeats).
// deadlines: each agreed deadline with the work played in, against the play without it (deadlines.ts)
type Trial = {
  time: Outlook['time'];
  rounds: number;
  fixes: number;
  finish: number | null;
  start: number | null;
  waits: Outlook['waits'];
  gives: Give[];
  unpriced: string[];
  deadlines: Deadline[];
};
// The plays on one queue: the work given a deadline (null: none), and the crossings between two deadlines.
type QueueTrials = { trial: (due: number | null) => Trial; crossings: (lo: number, hi: number) => number[] };

export function when(ask: Ask, asker: string, now = Date.now()) {
  const given = readAsk(ask, asker, now);
  if (typeof given === 'string') return [400, given] as const;
  const t0 = performance.now();
  const { planned, sized } = plannedWork(given);
  const { snapshot, trialsFor, relaxedTrial, plays } = trials(planned, now);
  const original = trialsFor(snapshot);
  const free = original.trial(null);
  const seated = () => {
    const more = oneMoreSeat(snapshot, planned.engine);
    return more && trialsFor(more);
  };
  return {
    work: { title: given.title, agent: given.agent, engine: planned.engine },
    size: {
      agent_minutes: minutes(planned.size.agent_ms),
      given: given.size !== null,
      compared: sized.picks.length,
      basis: sized.basis,
      guessed: sized.guessed,
    },
    free,
    ...(given.by === undefined
      ? { earliest: earliest(free, original, now) }
      : { by: byTime(given.by, free, original, relaxedTrial, seated, now) }),
    horizon_days: HORIZON_DAYS,
    played: { plays: plays(), ms: Math.round(performance.now() - t0) },
  };
}

// The ask, read and checked, or why not.
function readAsk(ask: Ask, asker: string, now: number): Given | string {
  const title = String(ask.q ?? '').trim();
  const agent = String(ask.agent ?? '').trim() || asker;
  if (!title) return 'say what the work is: hq when "what"';
  if (!findAgent(agent)) return `there's no agent ${agent.slice(0, 40)}`;
  let size: number | null = null;
  if (ask.size !== undefined && ask.size !== '') {
    const read = readSize(String(ask.size), 'size');
    if (typeof read === 'string') return read;
    size = read;
  }
  let after: number | undefined;
  if (ask.after !== undefined && ask.after !== '') {
    after = Number(String(ask.after).replace(/^#/, ''));
    if (!Number.isInteger(after) || after <= 0)
      return `--after takes a job number, not "${String(ask.after).slice(0, 40)}"`;
    if (!db.prepare('select 1 from jobs where id = ?').get(after)) return `there's no job #${after}`;
  }
  let by: number | undefined;
  if (ask.by !== undefined && ask.by !== '') {
    const at = windows.parse(String(ask.by), now, false, 'by');
    if (typeof at === 'string') return at;
    by = at;
  }
  return { title, agent, size, after, by };
}

// The work as a job queued now, sized on done jobs like it, or by the size given (its slow size never below that).
function plannedWork(given: Given) {
  const engine = findAgent(given.agent)!.engine;
  const work: Work = { title: given.title, origin: 'work', agent: given.agent };
  const sized = predictions.predict(work, pastJobs());
  const size: Size = given.size === null ? sized.size : { ...sized.size, agent_ms: given.size };
  const slow: Size =
    given.size === null ? sized.slow : { ...sized.slow, agent_ms: Math.max(given.size, sized.slow.agent_ms) };
  const planned = { id: PLANNED, agent: given.agent, title: given.title, engine, after: given.after };
  return { planned: { ...planned, size, slow }, sized };
}

// One snapshot with the work in it, and the plays on it or on one changed from it (trialsFor): the queue played with the work
// given a deadline (null: none), its finish (merged and deployed) set against the play without the work. And the
// crossings between two deadlines: where the work's place in the order the play runs work in changes (playOrder), as a
// latest start that moves with its deadline (its own, its review stages', work it waits for) meets one that doesn't.
// Between two crossings, that order is the same.
function trials(planned: ReturnType<typeof plannedWork>['planned'], now: number) {
  const { snapshot, sizes } = predictions.prepared(now, [planned], ['usual']);
  let plays = 0;
  const played = (queue: Snapshot) => {
    plays++;
    const usual = play(queue, sizes.usual, { pace: 'usual' });
    return { usual, threads: threadOutlooks(queue, usual, usual, sizes.usual) };
  };
  const base = played({ ...snapshot, jobs: snapshot.jobs.filter(j => j.id !== PLANNED) }).threads;
  const outcome = ({ usual, threads }: ReturnType<typeof played>): Trial => {
    const o = usual.get(PLANNED)!;
    const finish = o.merged === null ? null : o.merged + snapshot.deployLagMs;
    const plan = snapshot.jobs.find(j => j.id === PLANNED)!.reviewPlan;
    return {
      finish,
      start: o.start,
      time: o.time,
      rounds: plan?.count ?? 0,
      fixes: plan?.stages.filter(s => s.kind === 'work').length ?? 0,
      waits: o.waits,
      gives: gives(base, threads),
      unpriced: o.unpricedSeats ?? [],
      deadlines: agreed(threads, base, snapshot.deployLagMs, now),
    };
  };
  const trialsFor = (queue: Snapshot): QueueTrials => ({
    trial: due => outcome(played(withDue(queue, due))),
    crossings: (lo, hi) => {
      const { moving, fixed } = orderAt(queue, sizes.usual, lo);
      const dues = moving
        .flatMap(m => fixed.map(f => f.latestStart + lo - m.latestStart))
        .filter(due => due > lo && due < hi);
      return [...new Set(dues)].sort((a, b) => a - b);
    },
  });
  // The work due at `by` played ahead of the windows whose work the play runs before any of its own rows, those windows
  // moved later, and how each of their threads then ends against its window as it is (widen).
  const relaxedTrial = (by: number) => {
    const { moving, fixed } = orderAt(snapshot, sizes.usual, by);
    const last = Math.max(...moving.map(p => p.latestStart));
    const before = new Set(
      fixed.flatMap(({ row, latestStart }) =>
        row.thread && row.due !== null && latestStart < last ? [row.thread] : [],
      ),
    );
    const relaxedPlay = played(withDue(relaxed(snapshot, by, before), by));
    return { ...outcome(relaxedPlay), widen: [...before].map(t => giveOf(relaxedPlay.threads.get(t)!)) };
  };
  return { snapshot, trialsFor, relaxedTrial, plays: () => plays };
}

// The queue with the work due then.
const withDue = (queue: Snapshot, due: number | null) => ({
  ...queue,
  jobs: queue.jobs.map(j => (j.id === PLANNED ? { ...j, due } : j)),
});

// The order the play runs work in with the work due then: each row's latest start, and whether it moves with the
// work's deadline (the work's own rows, its review stages', work it waits for) or stays where it is.
function orderAt(snapshot: Snapshot, sizes: ReadonlyMap<number, Size>, due: number) {
  const [{ timings, rows }, after] = [due, due + MINUTE_MS].map(d => playOrder(withDue(snapshot, d), sizes));
  const placed = rows.flatMap(row => {
    const latestStart = timings.get(row.id)!.latestStart;
    return latestStart === null
      ? []
      : [{ row, latestStart, moves: after.timings.get(row.id)!.latestStart !== latestStart }];
  });
  return { moving: placed.filter(p => p.moves), fixed: placed.filter(p => !p.moves) };
}

// The windows the work's play pushes past their deadlines that the play without it doesn't, or further than it does.
function gives(base: Map<string, ThreadOutlook>, threads: Map<string, ThreadOutlook>) {
  return [...threads.values()].flatMap(t => {
    if (standing(t) !== 'misses') return [];
    const before = base.get(t.thread);
    const later = before?.finish == null ? false : t.finish === null || t.finish > before.finish + STEP_MS;
    if (before && standing(before) === 'misses' && !later) return [];
    return [giveOf(t)];
  });
}

// A thread's finish against its window: how far past its deadline (inside it when not above 0; null: no finish in
// sight).
function giveOf(t: ThreadOutlook): Give {
  const thread = findThread(t.thread)!;
  const project = findProject(thread.project)!.name;
  const past_ms = t.finish === null ? null : t.finish - t.deadline!;
  return { thread: t.thread, project, name: thread.name, deadline: t.deadline!, past_ms };
}

// A play that holds every window: the work done, inside its own deadline when it has one, and no window pushed past.
const holds = (t: Trial, due: number | null) =>
  t.finish !== null && (due === null || t.finish <= due) && !t.gives.length;

// The earliest it's done with every window held: the first deadline that holds, up to the end of the play's reach (or
// to its finish with no window, when that holds); else with no window at all, when that holds. found false: none holds,
// and the play at the latest deadline shows why.
function earliest(free: Trial, queueTrials: QueueTrials, now: number) {
  const plain = holds(free, null) ? { ...free, due: null as number | null } : null;
  const { found, last } = firstHolding(queueTrials, now, plain ? free.finish! : now + HORIZON_DAYS * DAY_MS);
  if (found) return { found: true, ...found };
  return plain ? { found: true, ...plain } : { found: false, ...last };
}

// The earliest deadline after `lo`, up to `hi`, that holds every window, to the minute, and the play at the last one
// tried. The play's order changes only at the crossings; between two, a later deadline holds the work back by no more
// than it moves and pushes no window further, so a span that fails at its end fails throughout. Each span is tried at
// its end, and only the first that holds is narrowed down.
function firstHolding({ trial, crossings }: QueueTrials, lo: number, hi: number, lastTrial = trial(hi)) {
  const last = { ...lastTrial, due: hi };
  for (const edge of [...crossings(lo, hi), hi]) {
    const due = edge === hi ? hi : edge - 1;
    const tried = edge === hi ? last : { ...trial(due), due };
    if (holds(tried, due)) return { found: narrowed(trial, lo, tried), last };
    lo = edge;
  }
  return { found: null, last };
}

// The earliest deadline after `lo` that holds, from one that does, on whole minutes.
function narrowed(trial: QueueTrials['trial'], lo: number, best: Trial & { due: number }) {
  for (;;) {
    const mid = Math.ceil((lo + best.due) / 2 / MINUTE_MS) * MINUTE_MS;
    if (mid >= best.due) return best;
    const tried = { ...trial(mid), due: mid };
    if (holds(tried, mid)) best = tried;
    else lo = mid;
  }
}

// With --by: whether it's done by then with every window held (heldBy). If not, what would, as played: the windows that
// give for it (giving, widen: each against its deadline), at that deadline when it's done by then, else with the windows
// the play runs before it moved later (relaxed); and one more seat of its engine, searched the same way (seat: its play,
// makes when one holds; null when HQ has no seat of the engine with measured rates and reported slots to copy). The play
// with the windows giving is the answer's own (finish, gives).
function byTime(
  by: number,
  free: Trial,
  original: QueueTrials,
  relaxedTrial: (by: number) => Trial & { widen: Give[] },
  oneMore: () => QueueTrials | null,
  now: number,
) {
  const { tried, held } = heldBy(by, original, now, () => free);
  if (held) return { at: by, makes: true, ...held };
  const ahead = tried.finish !== null && tried.finish <= by ? { ...tried, widen: tried.gives } : relaxedTrial(by);
  const more = oneMore();
  const seated = more && heldBy(by, more, now);
  return {
    at: by,
    makes: false,
    ...ahead,
    giving: ahead.finish !== null && ahead.finish <= by,
    seat: seated && (seated.held ? { ...seated.held, makes: true } : { ...seated.tried, makes: false }),
  };
}

// Whether the work is done by `by` with every window held on one queue: with that deadline, a sooner one (due), or no
// window at all (due null) when a deadline moves it ahead of work whose windows then miss (pushed). held null: none
// does, and tried is the play with that deadline.
function heldBy(by: number, queueTrials: QueueTrials, now: number, free = () => queueTrials.trial(null)) {
  const tried = { ...queueTrials.trial(by), due: by };
  if (holds(tried, by)) return { tried, held: tried };
  const { found } = firstHolding(queueTrials, now, by, tried);
  if (found) return { tried, held: found };
  const plain = free();
  return { tried, held: holds(plain, by) ? { ...plain, due: null, pushed: tried.gives } : null };
}

// The queue with the windows of `threads` relaxed: each of their deadlines moved later by one span, past `by` and the
// play's reach, so they keep their order among themselves and go after the work due at `by`. Their threads' finishes
// are still set against their windows as they are (snapshot.windows).
function relaxed(snapshot: Snapshot, by: number, threads: Set<string>): Snapshot {
  const moved = snapshot.jobs.filter(j => j.thread && threads.has(j.thread) && j.due !== null);
  if (!moved.length) return snapshot;
  const span = Math.max(0, by - Math.min(...moved.map(j => j.due!))) + HORIZON_DAYS * DAY_MS;
  return { ...snapshot, jobs: snapshot.jobs.map(j => (moved.includes(j) ? { ...j, due: j.due! + span } : j)) };
}

// The queue as it is with one more seat of the engine: a copy of one of its seats as HQ reads it, its windows fresh,
// at that seat's measured fill rates (both windows'), and the slots one seat runs as the worker reports them. Null
// without all of those: a seat with no measured rate would play as never filling.
function oneMoreSeat(snapshot: Snapshot, engine: string): Snapshot | null {
  const rate = snapshot.rates[engine];
  const runs = snapshot.seatRuns?.[engine];
  const slots = snapshot.slots[engine];
  if (!rate || runs === undefined || slots === undefined) return null;
  const perSeat = typeof rate.week === 'object' ? rate.week : null;
  const weekOf = (seat: string) => (perSeat ? perSeat[seat] : rate.week);
  const measured = (seat: string) => typeof rate.five[seat] === 'number' && typeof weekOf(seat) === 'number';
  const like = snapshot.seats.find(s => s.engine === engine && measured(s.id));
  if (!like) return null;
  const id = `${engine}-more`;
  const fresh = { state: 'ready', until: null, fiveHour: 0, fiveHourResets: null, week: 0, weekResets: null };
  return {
    ...snapshot,
    seats: [...snapshot.seats, { ...like, ...fresh, id }],
    rates: {
      ...snapshot.rates,
      [engine]: {
        week: perSeat ? { ...perSeat, [id]: perSeat[like.id] } : rate.week,
        five: { ...rate.five, [id]: rate.five[like.id] },
      },
    },
    slots: { ...snapshot.slots, [engine]: slots + runs },
  };
}

const minutes = (ms: number) => Math.round(ms / MINUTE_MS);
