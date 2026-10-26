// Inspectable seat exhaustion, reset, pacing and resume events from the shared play.
import type { Snapshot } from './eta.ts';
import type { Play, Run } from './simulation.ts';
import * as capacity from './playseats.ts';
import * as memory from './playmemory.ts';

type Observation = { used: number | null; at: number | null; source: string; resets: number | null };
type Work = { job: number; stage: string | null; kind: string; remaining_ms: number; bound_seat: string | null };
type Event = {
  at: number;
  started_at?: number | null;
  type: 'exhaustion' | 'reset' | 'pacing' | 'resume' | 'release';
  quota?: 'fiveHour' | 'week' | 'reported';
  running?: Work[];
  until?: number | null;
  idle_ms?: number | null;
  job?: number;
  from?: string;
  running_continues?: boolean;
};
export type SeatAccount = {
  seat: string;
  engine: string;
  uncertainty: string[];
  observations: { five_hour: Observation; week: Observation };
  events: Event[];
  work_mix: { kind: string; five: number | null; week: number | null; source: string }[];
};
export type Account = {
  seats: SeatAccount[];
  active: Map<string, Event>;
  idleSince: Map<string, number>;
  suspended: Map<number, { seat: string; at: number }>;
};

export function create(snapshot: Snapshot): Account {
  const seats = capacity.seatsOf(snapshot).map(seat => ({
    seat: seat.id,
    engine: seat.engine,
    uncertainty: uncertainties(seat),
    observations: {
      five_hour: {
        used: seat.fiveHour,
        at: seat.fiveHourObservedAt ?? null,
        source: seat.fiveHourSource ?? 'legacy',
        resets: seat.fiveHourResets,
      },
      week: {
        used: seat.week,
        at: seat.weekObservedAt ?? null,
        source: seat.weekSource ?? 'legacy',
        resets: seat.weekResets,
      },
    },
    events: [] as Event[],
    work_mix: kinds(snapshot, seat.engine).map(kind => ({
      kind,
      ...capacity.burnRates(seat, { kind }),
      support: seat.mix[kind] ?? null,
    })),
  }));
  const account: Account = { seats, active: new Map(), idleSince: new Map(), suspended: new Map() };
  for (const seat of capacity.seatsOf(snapshot)) recordHold(account, seat, snapshot.now, null);
  return account;
}

function uncertainties(seat: capacity.Seat) {
  return [
    ...(seat.fiveRate === null ? ['Five-hour burn is unmeasured.'] : []),
    ...(seat.weekRate === null ? ['Weekly burn is unmeasured.'] : []),
    ...(seat.fiveHour === null ? ['Five-hour usage is unknown.'] : []),
    ...(seat.week === null ? ['Weekly usage is unknown.'] : []),
    ...(seat.fiveHourSource === 'prior' || seat.weekSource === 'prior'
      ? ['Usage is a prior observed lower bound, not a fresh reading.']
      : []),
  ];
}

export function resources(snapshot: Snapshot) {
  return {
    memory: snapshot.memory ? 'reported per-run demand' : 'legacy fixed room sensitivity',
    conditional: true,
    limits: [
      ...memory.assumptions(snapshot),
      'Only queued work and its projected review stages are played. Future arrivals are unknown.',
      'Unmeasured burn and work mixes do not establish a provider allowance or a deadline guarantee.',
      ...(snapshot.memory
        ? []
        : ['Per-run memory was not retained. Room release cannot be reconstructed from this input.']),
    ],
  };
}

export function exhaust(account: Account, play: Play, now: number) {
  for (const seat of play.seats) {
    const exhausted = recordHold(account, seat, now, now);
    if (!exhausted) continue;
    const running = play.started.filter(r => r.state === 'running' && r.seat === seat);
    if (seat.engine !== 'claude' && running.length) account.idleSince.delete(seat.id);
    else if (!account.idleSince.has(seat.id)) account.idleSince.set(seat.id, now);
    if (!exhausted.running!.length) {
      exhausted.running = running.map(run => work(run, now));
      // (only work still running goes on through the hold: an empty seat sits idle)
      exhausted.running_continues = seat.engine !== 'claude' && running.length > 0;
    }
    if (seat.engine === 'claude')
      for (const run of running) account.suspended.set(run.row.id, { seat: seat.id, at: now });
  }
}

function recordHold(account: Account, seat: capacity.Seat, now: number, startedAt: number | null) {
  const hold = capacity.holding(seat, now);
  if (!hold) return null;
  const active = account.active.get(seat.id);
  if (active) {
    // (a window that binds for longer moves the return: the hold's start and its work stay)
    if ((hold.until ?? Infinity) > (active.until ?? Infinity)) Object.assign(active, hold);
    return active;
  }
  const event: Event = {
    at: now,
    started_at: startedAt,
    type: 'exhaustion',
    ...hold,
    running: [],
    running_continues: false,
  };
  own(account, seat.id).events.push(event);
  account.active.set(seat.id, event);
  return event;
}

const work = (run: Run, now: number): Work => ({
  job: run.row.id,
  stage: run.stage,
  kind: run.row.kind,
  remaining_ms: Math.max(0, run.ends - now),
  bound_seat: run.row.for_seat,
});

export function reset(account: Account, seat: capacity.Seat, now: number) {
  const record = own(account, seat.id);
  for (const [quota, at, used] of [
    ['fiveHour', seat.fiveHourResets, seat.fiveHour],
    ['week', seat.weekResets, seat.week],
  ] as const) {
    if (at === null || at > now || used === 0) continue;
    record.events.push({ at: now, type: 'reset', quota });
  }
}

export function release(account: Account, seat: capacity.Seat, now: number) {
  const exhausted = account.active.get(seat.id);
  if (!exhausted || capacity.drained(seat, now)) return;
  exhausted.idle_ms = now - (account.idleSince.get(seat.id) ?? now);
  account.idleSince.delete(seat.id);
  own(account, seat.id).events.push({ at: now, type: 'release', quota: exhausted.quota });
  account.active.delete(seat.id);
}

export function pacing(account: Account, moment: capacity.Moment) {
  for (const seat of moment.seats) {
    const until = moment.paced.get(seat);
    if (until === undefined || until <= moment.now) continue;
    const events = own(account, seat.id).events;
    const prior = events.findLast(e => e.type === 'pacing');
    if (prior?.until === until) continue;
    events.push({ at: moment.now, type: 'pacing', until });
  }
}

export function resume(account: Account, run: Run, seat: capacity.Seat, now: number) {
  const previous = account.suspended.get(run.row.id);
  if (!previous) return;
  own(account, seat.id).events.push({
    type: 'resume',
    at: now,
    job: run.row.id,
    from: previous.seat,
    idle_ms: now - previous.at,
  });
  account.suspended.delete(run.row.id);
}

const own = (account: Account, seat: string) => account.seats.find(s => s.seat === seat)!;

export function reviewQueue(play: Play) {
  return [...play.runs.values()]
    .filter(run => run.row.kind !== 'work' && run.row.kind !== 'resolution')
    .map(run => ({
      job: run.row.id,
      kind: run.row.kind,
      stage: run.stage,
      start: run.start,
      done: run.done,
      planned_ms: run.remainingMs,
      waits: [...run.waits, ...(run.held ? [run.held.by] : [])],
    }));
}

export function conditions(snapshot: Snapshot) {
  return capacity.seatsOf(snapshot).flatMap(seat => {
    if (seat.credits) return [];
    return uncertainties(seat)
      .map(why => `${seat.id}: ${why}`)
      .concat(
        kinds(snapshot, seat.engine).some(kind => capacity.burnRates(seat, { kind }).source !== 'mix')
          ? [`${seat.id}: Separate work-mix burn is not identified. Aggregate rates are a conditional assumption.`]
          : [],
      );
  });
}

function kinds(snapshot: Snapshot, engine: string) {
  return [
    ...new Set(
      snapshot.jobs.flatMap(row => [
        ...(row.engine === engine ? [row.kind] : []),
        ...(row.reviewPlan?.stages.filter(stage => stage.engine === engine).map(stage => stage.kind) ?? []),
      ]),
    ),
  ];
}
