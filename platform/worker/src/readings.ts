// Subscription seats get account readings independently of the jobs they admit.
import { CLAUDE_RECHECK_MS, type Windows } from './pace.ts';
import { DRAIN_RECHECK, readDue } from './downtime.ts';
import { cliOf, type SeatProvider } from './providers.ts';

type ReadingSeat = SeatProvider &
  Windows & {
    state: string;
    until: number;
    measured?: number;
    fiveHourObservedAt?: number;
    weekObservedAt?: number;
    paused?: boolean;
    gone?: boolean;
  };

type Readers<S> = {
  claude: (seat: S) => Promise<void>;
  codex: (seat: S) => Promise<void>;
  failed: (seat: S, error: unknown) => void;
};

export function seatReadings<S extends ReadingSeat>(readers: Readers<S>) {
  const attemptedAt = new WeakMap<S, number>();
  return async (seats: S[], now = Date.now()) => {
    for (const seat of seats) {
      if (seat.signIn !== 'login' || seat.paused || seat.gone) continue;
      const cli = cliOf(seat);
      if (cli !== 'claude' && cli !== 'codex') continue;
      const interval = readingInterval(seat, cli, now);
      if (interval === undefined) continue;
      const lastAttemptAt = attemptedAt.get(seat);
      if (lastAttemptAt !== undefined && now - lastAttemptAt < interval) continue;
      attemptedAt.set(seat, now);
      try {
        await readers[cli](seat);
      } catch (err) {
        readers.failed(seat, err);
      }
    }
  };
}

function readingInterval(seat: ReadingSeat, cli: 'claude' | 'codex', now: number) {
  if (cli === 'claude') {
    const held = (seat.state === 'sleeping' || seat.state === 'draining') && seat.until > now;
    // Restored weekly usage and expired resets are admission inputs, not fresh account readings.
    const unread =
      seat.state === 'ready' &&
      (seat.util === undefined ||
        seat.week === undefined ||
        seat.fiveHourObservedAt === undefined ||
        seat.weekObservedAt === undefined);
    return held || unread ? CLAUDE_RECHECK_MS : undefined;
  }
  const unread = seat.state === 'ready' && seat.measured === undefined;
  return unread || readDue(seat, now) ? DRAIN_RECHECK : undefined;
}
