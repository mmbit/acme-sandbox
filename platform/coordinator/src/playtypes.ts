// The serializable inputs and outputs shared by the planner and its replay.
import type { JobOrigin } from './matching.ts';
import type { Wait } from '../../worker/hq/waits.ts';
// The queue as it stands at `now`: plain data (JSON as it is), so it can be kept and played again.
export type Snapshot = {
  now: number;
  seatPlans?: Record<string, 5 | 20>;
  seatMeasurements?: Record<string, import('./headroom.ts').Measurement>;
  planner?: 3;
  planningSizes?: [number, Size][];
  // Active pauses' release jobs. Their merge endpoints and prerequisites must not wait on pacing.
  pauseUntil?: number[];
  windows?: Record<string, { deadline: number | null; aim: number | null }>;
  room?: number;
  memory?: Memory;
  seatMix?: Record<string, Record<string, import('./workmix.ts').MixRate>>;
  seatRuns?: Record<string, number>;
  jobs: QueuedJob[];
  seats: SeatNow[];
  // the share of a seat's windows an agent hour fills, by engine: the week's, and each seat's 5-hour window's (headroom.ts)
  rates: Record<string, { week: number | null | Record<string, number | null>; five: Record<string, number | null> }>;
  // how many jobs an engine runs at once
  slots: Record<string, number>;
  // from a merge to the deploy that brings it
  deployLagMs: number;
  // the board's pacing switch (HQ's Settings › Seats), absent from snapshots stored before pacing was played.
  pacing?: boolean;
};
export type OrderingSnapshot = Pick<Snapshot, 'now' | 'planner' | 'windows' | 'pauseUntil' | 'jobs' | 'deployLagMs'>;

export type Memory = {
  at: number;
  availableMb: number;
  freeReserveMb: number;
  defaultRunMb: number;
  totalSlots: number;
  heldSlots: number;
  heldMb: number;
  starting: { until: number; mb: number }[];
  runningMb: Record<string, number | null>;
};

// An open job (queued, running, waiting for the board, or done with its pull request in review), by its id: what it
// starts after and waits for (other jobs in the snapshot by id, or gone: released, or never), the cards it waits on
// with the time the board is expected to answer, and what holds it that the play doesn't move.
export type QueuedJob = {
  memoryMb?: number | null;
  id: number;
  orderId?: number;
  placeholder?: boolean;
  agent: string;
  title: string;
  reviewPlan?: import('./rounds.ts').ReviewPlan;
  opensReview?: boolean;
  dependencies?: import('./planner.ts').Dependency[];
  // its thread's order (threadorder.ts placing): the task before it, which it follows once that's done, and the last
  // tasks of the threads it needs, which it follows once they merge.
  follows?: number;
  needs?: number[];
  // a review loop job's step and round, its name in agents' lines with the title (jobs.ts nameOf).
  step?: string | null;
  round?: number | null;
  kind: string;
  origin: JobOrigin;
  status: string;
  engine: string;
  for_seat: string | null;
  downtime: number;
  created: number;
  finished: number | null;
  notBefore: number;
  seat: string | null;
  pr: number | null;
  // The board's call follow-up or sent-note routing check, work carrying a call's item, or the CEO's hourly check (jobs.ts
  // LANE), which goes first.
  board: number;
  // Derived from jobs.ts ITEM_WORK, retained by projected PR stages.
  itemWork?: boolean;
  // the CEO's hourly follow-through check (jobs.ts FOLLOW_THROUGH), which no pause stops (planner.ts pausable)
  followThrough?: boolean;
  spentMs: number;
  after: number | 'released' | 'never';
  waitsFor: number[];
  cards: { request: number; at: number }[];
  wakes: ({ at: number; deploy?: true } | { deployOf: number })[];
  due: number | null;
  // done work whose pull request is in review: its state, the author's job on it (fixes, notes, an update), and the
  // review runs and checks of its round queued or running
  review: { pr: number; state: string; author: number | null; runs: number[] } | null;
  mergeHold?: { job: number | null; card: { request: number; at: number } | null };
  reasons: Wait[];
  // the thread it serves (projects.ts), which the play doesn't read: forecast.ts adds up threads by it
  thread?: string | null;
};
export type SeatNow = {
  id: string;
  engine: string;
  state: string;
  until: number | null;
  fiveHour: number | null;
  fiveHourObservedAt?: number | null;
  fiveHourSource?: UsageSource;
  fiveHourResets: number | null;
  week: number | null;
  weekObservedAt?: number | null;
  weekSource?: UsageSource;
  latestReportedAt?: number | null;
  weekResets: number | null;
  // the share of a window it stops at
  stop: number;
  // runs on credits past its limits in the worker (worker/src/downtime.ts). The play does not use this flag.
  credits?: boolean;
};
export type Size = { agent_ms: number };
export type UsageSource = 'reported' | 'prior' | 'unknown' | 'reset';

// ---- the play's output

// What holds the work, besides its own time.
export type { Wait };
// cards: the board's answers the time rests on, its own cards' and those of the work it waits for.
// Elapsed time from the snapshot to live. Parallel reviews count once, fixes belong to review.
export type PlayTime = {
  work_ms: number;
  review_ms: number;
  waiting_ms: number;
  deploy_ms: number;
  total_ms: number;
};
export type Outlook = {
  capacityConditions?: string[];
  time?: PlayTime | null;
  unpricedSeats?: string[];
  start: number | null;
  done: number | null;
  merged: number | null;
  left_ms: number;
  waits: Wait[];
  cards: { request: number; at: number }[];
};
// Work not queued yet, played as if queued now (hq when): a negative id.
export type Planned = {
  id: number;
  agent: string;
  title: string;
  engine: string;
  after?: number;
  size: Size;
  thread?: string | null;
  placeholder?: boolean;
};
