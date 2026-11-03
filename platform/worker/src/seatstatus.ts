// Seat admission and active work are separate facts, shared by HQ and its reports.
import { paceTo, pacedUntil, pacingLifts, reserveElsewhere, stopWindows, type Windows } from './pace.ts';
import type { SeatStatus } from '../hq/seatwords.ts';

// A seat as pace.ts reads it, out of its database row (SeatRow: HQ's seats row with its stop level)
export type PacedSeat = Windows & { id: string; engine: string; state: SeatStatus['state']; until: number | null };
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
};

export function seatStatusesOf(rows: SeatRow[], pacing: boolean, running: Map<string, number>, now = Date.now()) {
  const seats: PacedSeat[] = rows.map(row => ({
    id: row.id,
    engine: row.engine,
    state: row.state,
    until: row.until,
    util: row.util ?? undefined,
    resets: row.resets ?? 0,
    week: row.week ?? undefined,
    weekResets: row.week_resets ?? 0,
    drainAt: row.stop === null ? undefined : row.stop / 100,
    credits: !!row.credits,
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
  const unavailable = (until: number | null) => ({ admission: 'unavailable' as const, until });
  if (!['ready', 'sleeping', 'draining'].includes(seat.state)) return unavailable(null);
  if (
    !seat.credits &&
    ((seat.util === undefined && seat.resets > now) || (seat.week === undefined && seat.weekResets > now))
  )
    return unavailable(null);
  const holds = stopWindows(seat, seats, now);
  const reportedHold = seat.until !== null && seat.until > now;
  if (seat.state !== 'ready' || reportedHold || holds.length) {
    const until = Math.max(reportedHold ? seat.until! : 0, ...holds.map(([, reset]) => reset));
    return unavailable(until > now ? until : null);
  }
  const target = paceTo(seat, pacing, reserveElsewhere(seat, seats, now));
  if (pacedUntil(seat, target, now) !== undefined)
    return { admission: 'paced' as const, until: pacingLifts(seat, target!, now) };
  return { admission: 'open' as const, until: null };
}
