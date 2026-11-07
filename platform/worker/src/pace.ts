// A seat's windows as draining and pacing read them (the board's switch in HQ's Settings › Seats), the same in the worker
// (its claims and the seats it reports: downtime.ts, worker.ts) and in HQ's play of the queue (the coordinator's
// playseats.ts), so the play holds back what the claim does, and lets it go when the claim does. The coordinator's image
// takes this file (.dockerignore).
const WEEK_MS = 7 * 24 * 3600_000;

// A five-hour window starts on reuse. Weekly resets keep the reported seven-day cadence.
export function nextWindowReset(reported: number, now: number, weekly: boolean) {
  return weekly ? reported + (Math.floor((now - reported) / WEEK_MS) + 1) * WEEK_MS : now + 5 * 3600_000;
}

export type Week = { week?: number; weekResets: number };
export type Windows = Week & { util?: number; resets: number; credits?: boolean; drainAt?: number };

// A drained Claude seat gets another account reading every ten minutes.
export const CLAUDE_RECHECK_MS = 10 * 60_000;

export const hasConfiguredStop = (s: { drainAt?: number }): s is { drainAt: number } => s.drainAt !== undefined;

// A window's drain level: the seat's own (its stop level in HQ's Settings › Seats, the board's; SEATS' id:engine:percent
// is carried over once, as a big plan's reserve is a bigger share than it needs), else DRAIN_AT. In the week's last day
// the reserve shrinks with the time left, to nothing at the reset: what's unspent then is lost, and the board's own work
// may take a draining seat anyway (healthiest). A configured stop always holds, including on the last day.
export const DRAIN_AT = 0.9,
  LAST_DAY = 24 * 3600_000;
export function drainLevel(s: { drainAt?: number; weekResets: number }, weekly: boolean, now = Date.now()) {
  if (hasConfiguredStop(s)) return s.drainAt;
  return relaxedLevel(DRAIN_AT, s.weekResets, weekly, now);
}

function relaxedLevel(at: number, weekResets: number, weekly: boolean, now: number) {
  const left = weekResets - now;
  return weekly && weekResets && left < LAST_DAY ? 1 - ((1 - at) * Math.max(0, left)) / LAST_DAY : at;
}

// The share of a seat's window used now, the fuller of the 5-hour and the weekly one: the last figure each reported,
// none once that window has reset, or undefined if the seat hasn't reported either yet (the coordinator counts that as
// full: no downtime work starts on a guess). The week counts too: downtime around the clock mustn't use up the week and
// leave the seat drained for days. A window the seat doesn't report (a weekly figure not in yet, a Codex plan with no
// 5-hour window) counts as none.
export function windowUsed(s: Windows, now = Date.now()) {
  const { five, week } = activeWindows(s, now);
  return five === undefined && week === undefined ? undefined : Math.max(five ?? 0, week ?? 0);
}

// Room to the seat's own stop in its active windows, so unused plan room comes before credit overage.
export function stopRoom(s: Partial<Windows>, now = Date.now()) {
  const own = { drainAt: s.drainAt, weekResets: s.weekResets ?? 0 };
  const { five, week } = activeWindows(s, now);
  if (five === undefined && week === undefined) return undefined;
  return Math.min(
    five === undefined ? Infinity : drainLevel(own, false, now) - five,
    week === undefined ? Infinity : drainLevel(own, true, now) - week,
  );
}

const activeWindows = (s: Partial<Windows>, now: number) => ({
  five: s.resets && s.resets <= now ? 0 : s.util,
  week: s.weekResets && s.weekResets <= now ? 0 : s.week,
});

// Plan room comes before credit overage. Timed weeks rank by remaining allowance per time until reset, highest first.
// Without a weekly reading and reset, room decides after seats with a known weekly pace.
export function compareSeatPace(a: Partial<Windows>, b: Partial<Windows>, now = Date.now()) {
  const aRoom = stopRoom(a, now) ?? -Infinity;
  const bRoom = stopRoom(b, now) ?? -Infinity;
  return Number(bRoom > 0) - Number(aRoom > 0) || weeklyPace(b, now) - weeklyPace(a, now) || bRoom - aRoom;
}

function weeklyPace(s: Partial<Windows>, now: number) {
  if (s.week === undefined || !s.weekResets) return -Infinity;
  const expired = s.weekResets <= now;
  const weekResets = expired ? nextWindowReset(s.weekResets, now, true) : s.weekResets;
  const room = drainLevel({ drainAt: s.drainAt, weekResets }, true, now) - (expired ? 0 : s.week);
  return room / (weekResets - now);
}

// The approach band budgets eight points for work in flight and two points for measurement overshoot.
const STOP_APPROACH = 0.1;
export function seatRunLimit(s: Partial<Windows>, limit = Infinity, now = Date.now()) {
  if (s.credits) return limit;
  const room = stopRoom(s, now);
  if (hasConfiguredStop(s) && room !== undefined && room <= 0) return 0;
  return room !== undefined && room <= STOP_APPROACH + Number.EPSILON ? Math.min(1, limit) : limit;
}

// the seat's windows at or past their drain level, each with its reset
export const full = (s: Windows, now: number) =>
  (
    [
      [s.util, s.resets, false],
      [s.week, s.weekResets, true],
    ] as const
  ).filter(
    ([used, reset, weekly]) => used !== undefined && used >= drainLevel(s, weekly, now) && !(reset && reset <= now),
  );

// When a seat full for the week stops being full with its use as it stands: its drain level rises through the week's
// last day (drainLevel) and passes the use. Take a whole millisecond past equality, where full() still counts it as full.
// Only the default reserve relaxes. A configured stop has no pre-reset lift.
export function drainLifts(s: Windows, now = Date.now()) {
  if (hasConfiguredStop(s)) return undefined;
  const at = DRAIN_AT;
  if (s.week === undefined || s.week < at || s.week >= 1 || !s.weekResets) return undefined;
  const lifts = Math.ceil(s.weekResets - ((1 - s.week) * LAST_DAY) / (1 - at)) + 1;
  return lifts > now ? lifts : undefined;
}

// One seat of an engine keeps the reserve, not every one: a seat runs on past its drain level (to its limit) while
// another ready seat of its engine is still under its own. A configured stop keeps its own reserve.
type Seated = Windows & { engine: string; state: string };
export const reserveElsewhere = <S extends Seated>(seat: S, seats: S[], now = Date.now()) =>
  !hasConfiguredStop(seat) &&
  seats.some(
    o =>
      o !== seat &&
      o.engine === seat.engine &&
      o.state === 'ready' &&
      windowUsed(o, now) !== undefined &&
      !full(o, now).length,
  );

// An account with credits the board hasn't let it spend (seatlist.ts spendCredits): its provider bills them for use past
// its plan's limits, so no run may take it there. It keeps its own reserve (reserveFor), and its running jobs stop when
// it drains (downtime.ts drainPauses). Its hold lets no checking job through (downtime.ts checkDue): the worker reads
// the account instead (downtime.ts readDue), and a confirmed hold lasts until reset, at most the window's length.
export const keepsToPlan = (s: { hasCredits?: boolean; credits?: boolean }) => !!s.hasCredits && !s.credits;

type StopSeat = Seated & { hasCredits?: boolean };
// Whether a seat may run past its drain level toward its plan's limit while another keeps the reserve
// (reserveElsewhere). An account that keepsToPlan always keeps its own reserve. Approved spending (credits) bypasses
// the plan's stop entirely (stopWindows). seats: those it may leave the reserve to.
export const reserveFor = <S extends StopSeat>(seat: S, seats: S[], now = Date.now()) =>
  !keepsToPlan(seat) && reserveElsewhere(seat, seats, now);

// The worker and the play hold the same windows and preserve the same running work at a stop.
export const stopWindows = <S extends StopSeat>(seat: S, seats: S[], now: number) =>
  seat.credits || reserveFor(seat, seats, now) ? [] : full(seat, now);

export const pausesAtStop = (seat: { engine: string; drainAt?: number; hasCredits?: boolean; credits?: boolean }) =>
  seat.engine === 'claude' || hasConfiguredStop(seat) || keepsToPlan(seat);

// Pacing targets a configured stop even beside a reserve peer. A default seat targets DRAIN_AT, or 1 while another
// keeps the reserve (reserveElsewhere). Undefined: not paced. A seat on credits is paced
// over its plan's week all the same: credits carry it past its limits (downtime.ts drainUntil), never ahead of its pace
// (the board, 22 Oct).
export const paceTo = (s: Windows, pacing: boolean, reserve: boolean) =>
  pacing ? (hasConfiguredStop(s) ? s.drainAt : reserve ? 1 : DRAIN_AT) : undefined;

// Whether a seat's week runs ahead of its pace, while the board has pacing on: at the average pace of the week so far,
// would it reach the level its pacing aims for (`to`: paceTo) more than PACE_EARLY before the weekly reset? Then it's
// paced until that reset (pacedRuns: how many runs at a time). A small lead doesn't pace it, and it aims PACE_MARGIN
// under the level, which leaves room for readings and work in flight. Before a day of the week has gone there's no pace
// to go by. Only a default target relaxes in the last day (pacedLevel). Undefined: not paced.
const PACE_FROM = 1 / 7,
  PACE_MARGIN = 0.02;
const PACE_EARLY = 3 * 3600_000;
type PacedWeek = Week & { drainAt?: number };
export function pacedUntil(s: PacedWeek, to: number | undefined, now = Date.now()) {
  if (to === undefined || s.week === undefined || !s.weekResets || s.weekResets <= now) return undefined;
  const left = s.weekResets - now,
    gone = 1 - Math.min(1, left / WEEK_MS);
  if (gone < PACE_FROM) return undefined;
  const level = pacedLevel(s, to, now);
  const pace = s.week / (gone * WEEK_MS),
    early = left - Math.max(0, level - PACE_MARGIN - s.week) / pace; // (ms)
  return early > PACE_EARLY ? s.weekResets : undefined;
}

// When pacedUntil's answer next changes while the week's use and the level it aims for stay as they are: once a day of
// the week has gone, pacing may start, and a paced seat's pacing lifts (pacingLifts). More use only paces a seat sooner,
// and the level moves with the reserve, so whoever plays the week forward asks again as either changes (the
// coordinator's playseats.ts). Undefined: nothing changes before the reset.
export function paceChange(s: PacedWeek, to: number | undefined, now = Date.now()) {
  if (to === undefined || s.week === undefined || !s.weekResets || s.weekResets <= now) return undefined;
  const from = s.weekResets - (1 - PACE_FROM) * WEEK_MS;
  if (now < from) return from;
  return pacedUntil(s, to, now) === undefined ? undefined : pacingLifts(s, to, now);
}

// When a seat paced now (pacedUntil gives its reset) stops being paced with its use as it stands: `early` comes down to
// PACE_EARLY only as time goes (the time left shrinks faster than the stop its pace leads to, the last day's reserve
// shrinking too), so that moment is found by halving, to the second, and comes before the reset.
export const pacingLifts = (s: PacedWeek, to: number, now = Date.now()) =>
  firstWhen(now, s.weekResets, t => pacedUntil(s, to, t) === undefined);

// The remaining weekly allowance per wall hour, and the concurrent runs its measured per-agent-hour cost affords.
// A seat whose one run costs more than that allowance keeps one place, and rests after each run (restUntil: pacedRest)
// with none. An unknown cost permits one place with no rest.
export function pacedRuns(
  s: PacedWeek,
  to: number | undefined,
  weekRate?: number | null,
  now = Date.now(),
  restUntil?: number,
) {
  if (pacedUntil(s, to, now) === undefined) return undefined;
  const perHour = (Math.max(0, pacedLevel(s, to!, now) - PACE_MARGIN - s.week!) * 3600_000) / (s.weekResets - now);
  const affords = weekRate && weekRate > 0 ? perHour / weekRate : 1;
  const resting = affords < 1 && restUntil !== undefined && restUntil > now;
  return {
    perHour,
    runs: affords >= 1 ? Math.floor(affords) : resting ? 0 : 1,
    restUntil: resting ? restUntil : undefined,
  };
}

// The level a paced seat's week aims for now: `to`, which relaxes through the last day as the reserve does (drainLevel),
// but for a configured stop.
const pacedLevel = (s: PacedWeek, to: number, now: number) =>
  hasConfiguredStop(s) ? to : relaxedLevel(to, s.weekResets, true, now);

// When a paced seat's rest ends after a run of `ranMs` ends now: the run's spend at its measured cost, taken back at
// the seat's allowance, so its average spend lands on its week's budget. A rest still going (restUntil) is added to,
// and none lasts past the weekly reset. A seat that affords the run keeps restUntil as it is.
export function pacedRest(
  s: PacedWeek,
  to: number | undefined,
  weekRate: number | null | undefined,
  ranMs: number,
  restUntil?: number,
  now = Date.now(),
) {
  const paced = pacedRuns(s, to, weekRate, now);
  if (!paced || !weekRate || weekRate <= paced.perHour) return restUntil;
  const rest = paced.perHour > 0 ? ranMs * (weekRate / paced.perHour - 1) : Infinity;
  return Math.min(s.weekResets, Math.max(restUntil ?? now, now) + rest);
}

// When a paced seat next takes more runs at a time (pacedRuns), or its pacing lifts: its allowance per hour grows as the
// reset nears and the last day's reserve relaxes, while its running work spends `spend` of its week an hour. A resting
// seat (restUntil) takes its first run once its allowance affords one, or its rest ends. Undefined: an unknown cost,
// whose one place lasts until pacing lifts (paceChange).
export function pacedRunsRise(
  s: PacedWeek,
  to: number | undefined,
  weekRate: number | null | undefined,
  spend: number,
  now = Date.now(),
  restUntil?: number,
) {
  const runs = pacedRuns(s, to, weekRate, now, restUntil)?.runs;
  if (runs === undefined || !weekRate || weekRate <= 0) return undefined;
  const spent = (t: number) => ({ ...s, week: s.week! + (spend * (t - now)) / 3600_000 });
  return firstWhen(now, s.weekResets, t => (pacedRuns(spent(t), to, weekRate, t, restUntil)?.runs ?? Infinity) > runs);
}

// The first moment between start and end, to the second, at which holds is true. Once holds is true it stays true.
function firstWhen(start: number, end: number, holds: (t: number) => boolean) {
  while (end - start > 1000) {
    const mid = (start + end) / 2;
    if (holds(mid)) end = mid;
    else start = mid;
  }
  return end;
}
