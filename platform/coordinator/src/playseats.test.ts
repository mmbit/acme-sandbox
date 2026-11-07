// node --test src/playseats.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainUntil } from '../../worker/src/downtime.ts';
import { at, available, binding, burnRates, choices, consume, drained, rest, seatEvent, seatsOf } from './playseats.ts';
import type { Snapshot } from './eta.ts';
import { waitWords } from '../../worker/hq/waits.ts';

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
  input.pacing = true;
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
  seats[0].week = 0.5;
  seats[0].weekResets = now + 5 * 24 * HOUR;
  const paced = pick({ id: 4, agent: 'bolt', fallsBack: true });
  assert.ok('id' in paced && paced.id === 'claude-mix', 'a paced primary still takes ordinary work');
  seats[0].week = 0.1;
  // its own seat asleep: the fallback's while it's out, and without one it waits for the seat's return
  seats[0].state = 'sleeping';
  seats[0].until = now + HOUR;
  assert.equal((pick({ id: 4, agent: 'bolt', fallsBack: true }) as { id: string }).id, 'codex-1');
  assert.deepEqual(pick({ id: 5, agent: 'wren' }), {
    on: 'seats',
    engine: 'claude',
    from: now,
    until: now + HOUR,
    reason: 'unavailable',
  });
});

test('a paced seat has a working place and a full week still waits for reset', () => {
  const input = snapshot();
  input.pacing = true;
  input.seats[0].week = 0.5;
  input.seats[0].weekResets = now + 5 * 24 * HOUR;
  const seats = seatsOf(input);
  const order = { id: 1, board: 0, latestStart: null };
  const row = { id: 1, agent: 'bolt', engine: 'claude', for_seat: null, downtime: 0 };
  const pick = (busy = new Map<string, number>()) => choices(at(seats, now), busy, {})(row, order).seat;
  assert.ok('id' in pick());
  const queued = pick(new Map([['claude-mix', 1]]));
  assert.ok('on' in queued && queued.on === 'queue');
  seats[0].week = 1;
  const unavailable = pick();
  assert.ok('on' in unavailable && unavailable.on === 'seats');
  assert.equal(unavailable.reason, 'unavailable');
  assert.equal(unavailable.until, seats[0].weekResets);
  assert.match(waitWords(unavailable, String), /a matching claude seat becoming available/);
});

test('the play keeps a tight seat to one job and prefers a peer with room below its own stop', () => {
  const input = snapshot();
  input.seats[0] = { ...input.seats[0], id: 'claude-1', week: 0.78, stop: 0.8 };
  input.seats.push({ ...input.seats[0], id: 'claude-3', week: 0.88, stop: 0.99 });
  const seats = seatsOf(input);
  const order = { id: 1, board: 0, latestStart: null };
  const row = { id: 1, agent: 'bolt', engine: 'claude', for_seat: null, downtime: 0 };
  const pick = (busy = new Map<string, number>(), pinned: string | null = null) =>
    choices(at(seats, now), busy, {})({ ...row, for_seat: pinned }, order).seat;
  assert.equal((pick() as { id: string }).id, 'claude-3');
  assert.deepEqual(pick(new Map([['claude-1', 1]]), 'claude-1'), { on: 'queue', engine: 'claude', minutes: 0 });
  assert.equal((pick(new Map(), 'claude-1') as { id: string }).id, 'claude-1');
});

test('new work spends the nearly finished weeks before an under-pace peer', () => {
  const input = snapshot();
  input.seats[0] = { ...input.seats[0], id: 'claude-1', week: 0.88, stop: 0.99, weekResets: now + 5 * 24 * HOUR };
  input.seats.push(
    { ...input.seats[0], id: 'claude-4', week: 0.92, weekResets: now + 12 * HOUR },
    { ...input.seats[0], id: 'claude-3', week: 0.95, weekResets: now + 4 * HOUR },
  );
  const seats = seatsOf(input);
  const order = { id: 1, board: 0, latestStart: now };
  const row = { id: 1, agent: 'bolt', engine: 'claude', for_seat: null, downtime: 0 };
  const pick = (busy = new Map<string, number>()) => choices(at(seats, now), busy, {})(row, order).seat;
  assert.equal((pick() as { id: string }).id, 'claude-3');
  seats[0].week = 0.1;
  assert.equal((pick() as { id: string }).id, 'claude-3');
  seats[0].week = 0.88;
  assert.equal((pick(new Map([['claude-3', 1]])) as { id: string }).id, 'claude-4');
  seats[2].week = seats[2].stop;
  assert.equal((pick() as { id: string }).id, 'claude-4');
  seats[1].week = seats[1].stop;
  assert.equal((pick() as { id: string }).id, 'claude-1');
  seats[2].week = 0.9;
  seats[0].week = 0.4;
  seats[0].weekResets = now + 3 * 24 * HOUR;
  assert.equal((pick() as { id: string }).id, 'claude-3');
  seats[2].week = 0.989;
  assert.equal(
    (pick() as { id: string }).id,
    'claude-1',
    'remaining allowance per time decides, not reset order alone',
  );
});

test("a paced seat's play wakes when its allowance affords another run at a time, not only when a run ends", () => {
  const paced = snapshot();
  paced.pacing = true;
  paced.seats = [
    { ...paced.seats[0]!, fiveHour: null, fiveHourResets: null, week: 0.7, weekResets: now + 120 * HOUR, stop: 1 },
  ];
  paced.rates = { claude: { five: { 'claude-mix': 0 }, week: { 'claude-mix': 0.002 } } };
  const [seat] = seatsOf(paced);
  assert.equal(at([seat], now).paceRuns.get(seat), 1);
  const rises = seatEvent(seat, [seat], now, 0);
  assert.ok(Math.abs(rises - (now + 50 * HOUR)) < 2000, `wakes ${(rises - now) / HOUR} h on`);
  assert.equal(at([seat], rises).paceRuns.get(seat), 2);

  // A resting seat's play wakes when its growing allowance affords a run, before its rest ends.
  const resting = snapshot();
  resting.pacing = true;
  resting.seats = [
    {
      ...resting.seats[0]!,
      fiveHour: null,
      fiveHourResets: null,
      week: 0.882,
      weekResets: now + 21 * HOUR,
      stopConfigured: false,
    },
  ];
  resting.rates = { claude: { five: { 'claude-mix': 0 }, week: { 'claude-mix': 0.002 } } };
  const [tired] = seatsOf(resting);
  rest(tired, 2 * HOUR, now, [tired]);
  assert.ok(tired.paceRest! > now + 5.5 * HOUR, `rests ${(tired.paceRest! - now) / HOUR} h`);
  assert.equal(at([tired], now).paceRuns.get(tired), 0);
  const affords = seatEvent(tired, [tired], now, 0);
  assert.ok(affords < tired.paceRest!, `wakes ${(affords - now) / HOUR} h on`);
  assert.equal(at([tired], affords).paceRuns.get(tired), 1);
});
