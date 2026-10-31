// node --test src/playseats.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainUntil } from '../../worker/src/downtime.ts';
import { at, available, binding, burnRates, choices, consume, drained, seatEvent, seatsOf } from './playseats.ts';
import type { Snapshot } from './eta.ts';

const HOUR = 3_600_000,
  now = Date.parse('2026-10-24T08:00:00Z');
function snapshot(): Snapshot {
  return {
    now,
    jobs: [],
    slots: { claude: 2 },
    deployLagMs: 0,
    seats: [
      {
        id: 'claude-mix',
        engine: 'claude',
        state: 'ready',
        until: null,
        fiveHour: 0.2,
        week: 0.1,
        fiveHourResets: now + 5 * HOUR,
        weekResets: now + 7 * 24 * HOUR,
        stop: 0.9,
      },
    ],
    rates: { claude: { five: { 'claude-mix': 0.15 }, week: { 'claude-mix': 0.1 } } },
    seatMix: {
      'claude-mix': {
        work: { five: 0.2, week: 0.1, fiveHours: 2, weekHours: 2, fiveIntervals: 2, weekIntervals: 2 },
        review: { five: 0.1, week: 0.3, fiveHours: 1, weekHours: 1, fiveIntervals: 1, weekIntervals: 1 },
      },
    },
  };
}

test('concurrent stages consume their identified prices and expose each binding quota', () => {
  const [seat] = seatsOf(snapshot());
  const running = [{ kind: 'work' }, { kind: 'review' }];
  assert.equal(seatEvent(seat, [seat], now, running), now + 2 * HOUR);
  for (const row of running) consume(seat, 2 * HOUR, row);
  assert.ok(Math.abs(seat.fiveHour! - 0.8) < 1e-10);
  assert.ok(Math.abs(seat.week! - 0.9) < 1e-10);
  assert.equal(binding(seat, now + 2 * HOUR), 'week');
  seat.fiveHour = 0.7;
  seat.week = 0.1;
  assert.ok(Math.abs(seatEvent(seat, [seat], now, running) - (now + (2 / 3) * HOUR)) < 1);
});

test('credits preserve worker service past numeric quotas while a reported provider hold remains binding', () => {
  const [seat] = seatsOf(snapshot());
  seat.credits = true;
  seat.fiveHour = 1;
  seat.week = 1;
  assert.equal(
    drainUntil({ util: 1, week: 1, resets: seat.fiveHourResets!, weekResets: seat.weekResets!, credits: true }, now),
    0,
  );
  assert.equal(available(seat, now), true);
  assert.equal(drained(seat, now), false);
  assert.equal(seatEvent(seat, [seat], now, [{ kind: 'work' }]), now + 5 * HOUR);
  seat.state = 'sleeping';
  seat.until = now + HOUR;
  assert.equal(available(seat, now), false);
  assert.equal(binding(seat, now), 'reported');
});

test('missing prices and unidentifiable mixes remain explicit while known usage stays a lower bound', () => {
  const input = snapshot();
  input.rates.claude.five['claude-mix'] = null;
  input.seatMix = {};
  const [seat] = seatsOf(input);
  assert.deepEqual(burnRates(seat, { kind: 'ruling' }), { five: null, week: 0.1, source: 'unmeasured' });
  consume(seat, HOUR, { kind: 'ruling' });
  assert.equal(seat.fiveHour, 0.2);
  assert.ok(Math.abs(seat.week! - 0.2) < 1e-10);
  seat.fiveHour = null;
  assert.equal(available(seat, now), false, 'an unmeasured reported quota is not free headroom');
});

test("a seat takes work as claim does: its engine's on its CLI, else its agent's fallback's while its own is out", () => {
  const input = snapshot();
  input.seats[0].cli = 'claude';
  input.seats.push({ ...input.seats[0], id: 'codex-1', engine: 'codex', cli: 'codex', fallbacks: ['bolt'] });
  const seats = seatsOf(input);
  const order = { id: 1, board: 0, latestStart: null };
  const pick = (row: { id: number; agent: string; cli?: string; fallsBack?: boolean }) =>
    choices(at(seats, now), new Map(), {})({ engine: 'claude', for_seat: null, downtime: 0, ...row }, order).seat;
  assert.equal((pick({ id: 1, agent: 'bolt', fallsBack: true }) as { id: string }).id, 'claude-mix');
  // (a CLI no seat runs, its agent with no fallback: stuck, its wait naming it)
  assert.deepEqual(pick({ id: 2, agent: 'wren', cli: 'nowhere' }), {
    on: 'stalled',
    why: 'No claude seat takes it',
    job: 2,
  });
  assert.equal((pick({ id: 3, agent: 'bolt', cli: 'nowhere', fallsBack: true }) as { id: string }).id, 'codex-1');
  // its own seat asleep: the fallback's while it's out, and without one it waits for the seat's return
  seats[0].state = 'sleeping';
  seats[0].until = now + HOUR;
  assert.equal((pick({ id: 4, agent: 'bolt', fallsBack: true }) as { id: string }).id, 'codex-1');
  assert.deepEqual(pick({ id: 5, agent: 'wren' }), { on: 'seats', engine: 'claude', until: now + HOUR });
});
