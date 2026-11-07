// Seat admission and active work are separate facts, shared by HQ and its reports.
import { paceTo, pacedUntil, pacedRuns, pacingLifts, reserveElsewhere, stopWindows, type Windows } from './pace.ts';
import type { SeatStatus } from '../hq/seatwords.ts';

// A seat as pace.ts reads it, out of its database row (SeatRow: HQ's seats row with its stop level)
// (heldUntil: a held Codex seat's real hold end, with its next check in until; paceRuns: the runs at a time the worker
// reported for it while paced; paceRest: the end of a paced seat's rest, pace.ts pacedRest)
export type PacedSeat = Windows & {
  id: string;
  engine: string;
  state: SeatStatus['state'];
  until: number | null;
  heldUntil?: number | null;
  paceRuns?: number | null;
  paceRest?: number | null;
};
export type SeatRow = {
  id: string;
  engine: string;
  state: SeatStatus['state'];
  until: number | null;
  util: number | null;
  resets: number | null;
  week: number | null;
  week_resets: number | null;
  stop: number | null;
  credits: number | null;
  pace_runs?: number | null;
  pace_rest?: number | null;
  held_until: number | null;
};

// A seat row's windows as pace.ts reads them, with its stop level (seat_list's percent) and credits.
export function windowsOf(
  row: Pick<SeatRow, 'util' | 'resets' | 'week' | 'week_resets' | 'stop' | 'credits'>,
): Windows {
  return {
    util: row.util ?? undefined,
    resets: row.resets ?? 0,
    week: row.week ?? undefined,
    weekResets: row.week_resets ?? 0,
    drainAt: row.stop === null ? undefined : row.stop / 100,
    credits: !!row.credits,
  };
}

export function seatStatusesOf(rows: SeatRow[], pacing: boolean, running: Map<string, number>, now = Date.now()) {
  const seats: PacedSeat[] = rows.map(row => ({
    id: row.id,
    engine: row.engine,
    state: row.state,
    until: row.until,
    heldUntil: row.held_until,
    paceRuns: row.pace_runs,
    paceRest: row.pace_rest,
    ...windowsOf(row),
  }));
  return new Map(seats.map(seat => [seat.id, seatStatus(seat, seats, pacing, running.get(seat.id) ?? 0, now)]));
}

export function seatStatus(
  seat: PacedSeat,
  seats: PacedSeat[],
  pacing: boolean,
  running: number,
  now = Date.now(),
): SeatStatus {
  return { ...admissionOf(seat, seats, pacing, now), running, state: seat.state };
}

function admissionOf(seat: PacedSeat, seats: PacedSeat[], pacing: boolean, now: number) {
  const unavailable = (until: number | null, reason?: SeatStatus['reason']) => ({
    admission: 'unavailable' as const,
    until,
    reason,
  });
  if (!['ready', 'sleeping', 'draining'].includes(seat.state)) return unavailable(null);
  const holds = stopWindows(seat, seats, now);
  const reportedHold = seat.until !== null && seat.until > now;
  if (seat.state !== 'ready' || reportedHold || holds.length) {
    if (holds.some(([, reset]) => !reset)) return unavailable(null, 'quota');
    // A hold the worker reported ends at heldUntil (a held Codex seat's), and the seat is checked before then at its
    // until. With a stop window behind it too, the seat is back at whichever ends last, and that one names the cause.
    const holdEnd = seat.heldUntil ?? (reportedHold ? seat.until! : 0);
    const stopEnd = Math.max(0, ...holds.map(([, reset]) => reset));
    const back = Math.max(holdEnd, stopEnd);
    const reason = stopEnd > holdEnd ? 'quota' : seat.state === 'sleeping' ? 'provider' : 'drained';
    const status = unavailable(back > now ? back : null, reason);
    return seat.heldUntil && reportedHold ? { ...status, nextCheck: seat.until! } : status;
  }
  if (
    !seat.credits &&
    ((seat.util === undefined && seat.resets > now) || (seat.week === undefined && seat.weekResets > now))
  )
    return unavailable(null, 'usage');
  const target = paceTo(seat, pacing, reserveElsewhere(seat, seats, now));
  if (pacedUntil(seat, target, now) !== undefined)
    return {
      admission: 'paced' as const,
      until: pacingLifts(seat, target!, now),
      pace: {
        runs: seat.paceRuns ?? 1,
        perHour: pacedRuns(seat, target, undefined, now)!.perHour,
        ...(seat.paceRest && seat.paceRest > now ? { restUntil: seat.paceRest } : {}),
      },
    };
  return { admission: 'open' as const, until: null };
}
