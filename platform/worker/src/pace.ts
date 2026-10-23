// A seat's windows as draining and pacing read them (the board's switch in HQ's Settings › Seats), the same in the worker
// (its claims and the seats it reports: downtime.ts, worker.ts) and in HQ's play of the queue (the coordinator's
// playseats.ts), so the play holds back what the claim does, and lets it go when the claim does. The coordinator's image
// takes this file (.dockerignore).
// A five-hour window starts on reuse. Weekly resets keep the reported seven-day cadence.
export function nextWindowReset(reported: number, now: number, weekly: boolean) {
  return weekly ? reported + (Math.floor((now - reported) / WEEK) + 1) * WEEK : now + 5 * 3600_000;
}

export type Week = { week?: number; weekResets: number };
export type Windows = Week & { util?: number; resets: number; credits?: boolean; drainAt?: number };

// A window's drain level: the seat's own (its stop level in HQ's Settings › Seats, the board's; SEATS' id:engine:percent
// is carried over once, as a big plan's reserve is a bigger share than it needs), else DRAIN_AT. In the week's last day
// the reserve shrinks with the time left, to nothing at the reset: what's unspent then is lost, and the board's own work
// may take a draining seat anyway (healthiest).
export const DRAIN_AT = 0.9,
  LAST_DAY = 24 * 3600_000;
export function drainLevel(s: { drainAt?: number; weekResets: number }, weekly: boolean, now = Date.now()) {
  const at = s.drainAt ?? DRAIN_AT,
    left = s.weekResets - now;
  return weekly && s.weekResets && left < LAST_DAY ? 1 - ((1 - at) * Math.max(0, left)) / LAST_DAY : at;
}

// The share of a seat's window used now, the fuller of the 5-hour and the weekly one: the last figure each reported,
// none once that window has reset, or undefined if the seat hasn't reported either yet (the coordinator counts that as
// full: no downtime work starts on a guess). The week counts too: downtime around the clock mustn't use up the week and
// leave the seat drained for days. A window the seat doesn't report (a weekly figure not in yet, a Codex plan with no
// 5-hour window) counts as none.
export function windowUsed(s: Windows, now = Date.now()) {
  const five = s.resets && s.resets <= now ? 0 : s.util,
    week = s.weekResets && s.weekResets <= now ? 0 : s.week;
  return five === undefined && week === undefined ? undefined : Math.max(five ?? 0, week ?? 0);
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
// Undefined: not before the reset.
export function drainLifts(s: Windows, now = Date.now()) {
  const at = s.drainAt ?? DRAIN_AT;
  if (s.week === undefined || s.week < at || s.week >= 1 || !s.weekResets) return undefined;
  const lifts = Math.ceil(s.weekResets - ((1 - s.week) * LAST_DAY) / (1 - at)) + 1;
  return lifts > now ? lifts : undefined;
}

// One seat of an engine keeps the reserve, not every one: a seat runs on past its drain level (to its limit) while
// another ready seat of its engine is still under its own, and the last one to get there drains (the worker's drain).
type Seated = Windows & { engine: string; state: string };
export const reserveElsewhere = <S extends Seated>(seat: S, seats: S[], now = Date.now()) =>
  seats.some(
    o =>
      o !== seat &&
      o.engine === seat.engine &&
      o.state === 'ready' &&
      windowUsed(o, now) !== undefined &&
      !full(o, now).length,
  );

// The level a seat's pacing aims for (pacedUntil), while the board has pacing on and the seat isn't on credits: its
// drain level, or 1 for a seat that runs to its limit while another keeps the reserve (reserveElsewhere). Undefined: not
// paced.
export const paceTo = (s: Windows, pacing: boolean, reserve: boolean) =>
  pacing && !s.credits ? (reserve ? 1 : (s.drainAt ?? DRAIN_AT)) : undefined;

// The week's pace, while the board has pacing on: at the average pace of the week so far, would the seat reach the
// level its pacing aims for (`to`) more than PACE_EARLY before the weekly reset? Then it's paced until that reset: it
// takes only the board's word and work that has to start before the week turns over to keep its window (the
// coordinator's claim, by each job's latest start), and the rest waits, so a few jobs start later rather than everything
// stopping a day or two early (the board, 15 Oct). A stop due only a few hours early costs less than holding work back,
// so it doesn't pace. It aims PACE_MARGIN under the level, so a week on pace ends just short of it. Before a day of the
// week has gone there's no pace to go by. `to`: paceTo, as drainLevel shrinks it in the last day. Undefined: not paced.
const WEEK = 7 * 24 * 3600_000,
  PACE_FROM = 1 / 7,
  PACE_MARGIN = 0.02;
const PACE_EARLY = 3 * 3600_000;
export function pacedUntil(s: Week, to: number | undefined, now = Date.now()) {
  if (to === undefined || s.week === undefined || !s.weekResets || s.weekResets <= now) return undefined;
  const left = s.weekResets - now,
    gone = 1 - Math.min(1, left / WEEK);
  if (gone < PACE_FROM) return undefined;
  const level = drainLevel({ drainAt: to, weekResets: s.weekResets }, true, now);
  const pace = s.week / (gone * WEEK),
    early = left - Math.max(0, level - PACE_MARGIN - s.week) / pace; // (ms)
  return early > PACE_EARLY ? s.weekResets : undefined;
}

// When pacedUntil's answer next changes while the week's use and the level it aims for stay as they are: once a day of
// the week has gone, pacing may start, and a paced seat's pacing lifts (pacingLifts). More use only paces a seat sooner,
// and the level moves with the reserve, so whoever plays the week forward asks again as either changes (the
// coordinator's playseats.ts). Undefined: nothing changes before the reset.
export function paceChange(s: Week, to: number | undefined, now = Date.now()) {
  if (to === undefined || s.week === undefined || !s.weekResets || s.weekResets <= now) return undefined;
  const from = s.weekResets - (1 - PACE_FROM) * WEEK;
  if (now < from) return from;
  return pacedUntil(s, to, now) === undefined ? undefined : pacingLifts(s, to, now);
}

// When a seat paced now (pacedUntil gives its reset) stops being paced with its use as it stands: `early` comes down to
// PACE_EARLY only as time goes (the time left shrinks faster than the stop its pace leads to, the last day's reserve
// shrinking too), so that moment is found by halving, to the second, and comes before the reset.
export function pacingLifts(s: Week, to: number, now = Date.now()) {
  let [paced, lifted] = [now, s.weekResets];
  while (lifted - paced > 1000) {
    const mid = (paced + lifted) / 2;
    if (pacedUntil(s, to, mid) === undefined) lifted = mid;
    else paced = mid;
  }
  return lifted;
}
