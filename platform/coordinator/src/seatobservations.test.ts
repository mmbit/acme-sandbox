// node --test src/seatobservations.test.ts (uses a throwaway DATA_DIR)
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { takeRead, takeReading } from '../../worker/src/downtime.ts';

const h = await harness('seatobservations');
const { snapshot } = await import('./backlog.ts');
const HOUR = 3_600_000;
const T0 = Math.floor(Date.now() / HOUR) * HOUR;
mock.timers.enable({ apis: ['Date'], now: T0 });
test.after(() => mock.timers.reset());
const report = (seat: string, windows: Record<string, unknown>) =>
  h.worker('seat', {
    seat,
    engine: 'claude',
    state: 'ready',
    ...windows,
  });

test('a missing weekly reading retains the earlier measured paced usage with its original age', async () => {
  mock.timers.setTime(T0);
  await report('claude-prior', { util: 0.2, resets: T0 + 5 * HOUR, week: 0.92, weekResets: T0 + 24 * HOUR });
  mock.timers.setTime(T0 + HOUR);
  await report('claude-prior', { util: 0.3, resets: T0 + 5 * HOUR, weekResets: T0 + 24 * HOUR });
  const prior = snapshot(T0 + HOUR).seats.find(seat => seat.id === 'claude-prior')!;
  assert.equal(prior.week, 0.92);
  assert.equal(prior.weekObservedAt, T0);
  assert.equal(prior.weekSource, 'prior');
  assert.equal(prior.fiveHour, 0.3);
  assert.equal(prior.fiveHourSource, 'reported');
  assert.equal(prior.latestReportedAt, T0 + HOUR);
  const id = h.queue({ agent: 'bolt', engine: 'claude', forSeat: 'claude-prior' });
  await h.worker('room', { capacity: { slots: { claude: 1 }, seatRuns: { claude: 1 }, room: 1 } });
  const { play } = await import('./eta.ts');
  const played = play(snapshot(T0 + HOUR), new Map([[id, { agent_ms: 60_000 }]]));
  assert.ok(
    played.get(id)!.start === null || played.get(id)!.start! > T0 + HOUR,
    'the omitted weekly figure cannot make an exhausted paced seat immediately eligible',
  );
});

test('never measured usage stays unknown and a later reading does not leak into an earlier cutoff', async () => {
  mock.timers.setTime(T0 + 2 * HOUR);
  await report('claude-unknown', {});
  const missing = snapshot(T0 + 2 * HOUR).seats.find(seat => seat.id === 'claude-unknown')!;
  assert.equal(missing.week, null);
  assert.equal(missing.fiveHour, null);
  assert.equal(missing.weekSource, 'unknown');
  mock.timers.setTime(T0 + 3 * HOUR);
  await report('claude-unknown', { util: 0.1, week: 0.15 });
  const cutoff = snapshot(T0 + 2 * HOUR).seats.find(seat => seat.id === 'claude-unknown')!;
  assert.equal(cutoff.week, null);
  assert.equal(cutoff.fiveHour, null);
});

test('usage from a completed quota epoch cannot establish headroom in a newly reported window', async () => {
  mock.timers.setTime(T0 + 4 * HOUR);
  await report('claude-epoch', { util: 0.99, resets: T0 + 5 * HOUR, week: 0.2 });
  mock.timers.setTime(T0 + 6 * HOUR);
  await report('claude-epoch', { resets: T0 + 10 * HOUR, week: 0.2 });
  const reset = snapshot(T0 + 6 * HOUR).seats.find(seat => seat.id === 'claude-epoch')!;
  assert.equal(reset.fiveHour, null);
  assert.equal(reset.fiveHourSource, 'unknown');
  assert.equal(reset.fiveHourResets, T0 + 10 * HOUR);
});

test('a state report preserves provider observation age and an incomplete report in the same minute cannot erase it', async () => {
  mock.timers.setTime(T0 + 7 * HOUR);
  await report('claude-age', { util: 0.2, week: 0.92, weekResets: T0 + 24 * HOUR });
  mock.timers.setTime(T0 + 7 * HOUR + 1000);
  await report('claude-age', { util: 0.2, fiveHourObservedAt: T0 + 7 * HOUR, weekObservedAt: null });
  const retained = snapshot(Date.now()).seats.find(seat => seat.id === 'claude-age')!;
  assert.equal(retained.week, 0.92);
  assert.equal(retained.weekObservedAt, T0 + 7 * HOUR);
  assert.equal(retained.weekSource, 'prior');
  assert.equal(retained.fiveHourObservedAt, T0 + 7 * HOUR);
  assert.equal(retained.fiveHourSource, 'prior');
});

test('conflicting readings at the same timestamp keep the latest report and later revisions respect the cutoff', async () => {
  const at = T0 + 8 * HOUR;
  mock.timers.setTime(at);
  await report('claude-revision', { util: 0.8, week: 0.8 });
  await report('claude-revision', { util: 0.1, week: 0.1 });
  const latest = snapshot(at).seats.find(seat => seat.id === 'claude-revision')!;
  assert.equal(latest.week, 0.1);
  assert.equal(latest.fiveHour, 0.1);
  mock.timers.setTime(at + 1000);
  await report('claude-revision', { util: 0.2, week: 0.3, fiveHourObservedAt: at, weekObservedAt: at });
  const revised = snapshot(at + 1000).seats.find(seat => seat.id === 'claude-revision')!;
  assert.equal(revised.week, 0.3);
  assert.equal(revised.weekObservedAt, at);
  const earlier = snapshot(at).seats.find(seat => seat.id === 'claude-revision')!;
  assert.equal(earlier.week, 0.1);
  const { windowReadings } = await import('./seatobservations.ts');
  assert.equal(windowReadings('claude-revision', 'week', at - 1, at)[0].used, 0.1);
  assert.equal(windowReadings('claude-revision', 'week', at - 1, at + 1000)[0].used, 0.3);
});

test('a fresh worker account read keeps both window histories at their own observation times', async () => {
  const at = T0 + 9 * HOUR;
  const seat = {
    state: 'draining',
    until: at + 4 * HOUR,
    resets: 0,
    weekResets: 0,
    util: undefined as number | undefined,
    week: undefined as number | undefined,
    fiveHourObservedAt: undefined as number | undefined,
    weekObservedAt: undefined as number | undefined,
  };
  const send = () =>
    report('codex-account', {
      engine: 'codex',
      state: seat.state,
      util: seat.util,
      resets: seat.resets,
      week: seat.week,
      weekResets: seat.weekResets,
      fiveHourObservedAt: seat.fiveHourObservedAt ?? null,
      weekObservedAt: seat.weekObservedAt ?? null,
    });
  mock.timers.setTime(at);
  takeReading(seat, { at, util: 0.95, resets: at + 4 * HOUR, week: 0.95, weekResets: at + 24 * HOUR }, false);
  await send();
  mock.timers.setTime(at + HOUR);
  takeRead(seat, { at: Date.now(), util: 0.5, resets: seat.resets, week: 0.5, weekResets: seat.weekResets });
  await send();
  const fresh = snapshot(Date.now()).seats.find(seat => seat.id === 'codex-account')!;
  assert.equal(fresh.fiveHourObservedAt, at + HOUR);
  assert.equal(fresh.weekObservedAt, at + HOUR);
  assert.equal(fresh.fiveHourSource, 'reported');
  assert.equal(fresh.weekSource, 'reported');
  const { windowReadings } = await import('./seatobservations.ts');
  for (const quota of ['five', 'week'] as const)
    assert.deepEqual(
      windowReadings('codex-account', quota, at - 1, Date.now()).map(r => [r.at, r.used]),
      [
        [at, 0.95],
        [at + HOUR, 0.5],
      ],
    );
  mock.timers.setTime(at + HOUR + 1000);
  takeRead(seat, undefined);
  await send();
  const retained = snapshot(Date.now()).seats.find(seat => seat.id === 'codex-account')!;
  assert.equal(retained.weekObservedAt, at + HOUR);
  assert.equal(retained.weekSource, 'prior');
});
