// node --test src/headroom.test.ts   (uses a throwaway DATA_DIR)
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('headroom');
const { fillRates, priceAhead, seatProjection } = await import('./headroom.ts');
const HOUR = 3_600_000,
  T0 = Math.floor(Date.now() / HOUR) * HOUR;
mock.timers.enable({ apis: ['Date'], now: T0 });
test.after(() => mock.timers.reset());
const report = (seat: string, util: number, week: number, resets = T0 + 5 * HOUR) =>
  h.worker('seat', { seat, engine: 'claude', state: 'ready', util, week, resets, weekResets: T0 + 7 * 24 * HOUR });

// (first: the module's kept prices are empty, as after a restart)
test("the readings priced ahead at the server's start, a slice at a time, give the rates one read gives", async () => {
  mock.timers.setTime(T0 - 14 * HOUR);
  await report('claude-ahead', 0.1, 0.1);
  const job = await h.start({ agent: 'bolt' }, { seat: 'claude-ahead' });
  for (const [hour, used] of [
    [10, 0.2],
    [4, 0.3],
  ]) {
    mock.timers.setTime(T0 - hour * HOUR);
    await report('claude-ahead', used, used);
  }
  mock.timers.setTime(T0 - 1.5 * HOUR);
  await h.finish(job);
  mock.timers.setTime(T0 - HOUR);
  await report('claude-ahead', 0.3, 0.3);
  // (six-hour slices, ending 12.5 and 6.5 hours before T0 among them: the readings fall in three)
  await priceAhead(T0 - HOUR / 2);
  mock.timers.setTime(T0);
  const rates = fillRates().get('claude')!;
  // (0.2 of the five hours' gain over the run's 12.5 hours, in three intervals)
  assert.ok(Math.abs(rates.five.get('claude-ahead')! - 0.016) < 1e-10);
  assert.deepEqual(rates.measurements.get('claude-ahead'), {
    fiveHours: 12.5,
    weekHours: 12.5,
    fiveIntervals: 3,
    weekIntervals: 3,
  });
});

test('each seat prices its own usage gains against all active run hours, without finished-job spend', async () => {
  await report('claude-a', 0.2, 0.3);
  await report('claude-b', 0.1, 0.2);
  const first = await h.start({ agent: 'bolt' }, { seat: 'claude-a' });
  const second = await h.start({ agent: 'kit' }, { seat: 'claude-a' });
  const third = await h.start({ agent: 'bolt' }, { seat: 'claude-b' });
  assert.equal(fillRates().get('claude')!.week.get('claude-a'), null);
  mock.timers.setTime(T0 + HOUR);
  await report('claude-a', 0.4, 0.4);
  await report('claude-b', 0.15, 0.22);
  const rates = fillRates().get('claude')!;
  assert.ok(Math.abs(rates.five.get('claude-a')! - 0.1) < 1e-10);
  assert.ok(Math.abs(rates.week.get('claude-a')! - 0.05) < 1e-10);
  assert.ok(Math.abs(rates.five.get('claude-b')! - 0.05) < 1e-10);
  assert.ok(Math.abs(rates.week.get('claude-b')! - 0.02) < 1e-10);
  const projectedA = seatProjection('claude-a');
  const projectedB = seatProjection('claude-b');
  assert.ok(Math.abs(projectedA.week! - (T0 + 7 * HOUR)) < 1);
  assert.ok(Math.abs(projectedB.week! - (T0 + 40 * HOUR)) < 1);
  assert.ok(Math.abs(projectedA.five_hour! - (T0 + 4 * HOUR)) < 1);
  assert.ok(Math.abs(projectedB.five_hour! - (T0 + 18 * HOUR)) < 1);
  const shown = (await h.agent('estimate?limit=1', third.token)).body.seats;
  const own = shown.seats.find((seat: { id: string }) => seat.id === 'claude-a');
  assert.ok(Math.abs(own.week_per_hour - 0.05) < 1e-10);
  assert.equal(shown.engines[0].per_percent, undefined, 'weekly prices belong to each seat');
  await Promise.all([first, second, third].map(job => h.finish(job)));
});

test('a reported reset preserves measured prices and never prices its drop as consumption', async () => {
  await report('claude-reset', 0.6, 0.4);
  const job = await h.start({ agent: 'bolt' }, { seat: 'claude-reset' });
  mock.timers.setTime(T0 + 2 * HOUR);
  await report('claude-reset', 0.8, 0.45);
  const before = fillRates().get('claude')!.five.get('claude-reset')!;
  assert.ok(Math.abs(before - 0.2) < 1e-10);
  mock.timers.setTime(T0 + 3 * HOUR);
  await report('claude-reset', 0.05, 0.5, T0 + 8 * HOUR);
  assert.equal(fillRates().get('claude')!.five.get('claude-reset'), before);
  mock.timers.setTime(T0 + 4 * HOUR);
  await report('claude-reset', 0.25, 0.55, T0 + 8 * HOUR);
  assert.ok(Math.abs(fillRates().get('claude')!.five.get('claude-reset')! - before) < 1e-10);
  await h.finish(job);
});

test('observed run hours without a usage gain measure zero, while a first reading remains unknown', async () => {
  await report('claude-quiet', 0.2, 0.3);
  const job = await h.start({ agent: 'bolt' }, { seat: 'claude-quiet' });
  assert.equal(fillRates().get('claude')!.week.get('claude-quiet'), null);
  mock.timers.setTime(T0 + 4.5 * HOUR);
  await report('claude-quiet', 0.2, 0.3);
  assert.equal(fillRates().get('claude')!.week.get('claude-quiet'), 0);
  assert.equal(fillRates().get('claude')!.five.get('claude-quiet'), 0);
  await h.finish(job);
});

test('staggered concurrent runs price partial reading intervals and exclude idle gains', async () => {
  mock.timers.setTime(T0 + 5 * HOUR);
  await report('claude-overlap', 0, 0, T0 + 10 * HOUR);
  const first = await h.start({ agent: 'bolt' }, { seat: 'claude-overlap' });
  mock.timers.setTime(T0 + 5.5 * HOUR);
  await h.heartbeat(first);
  const second = await h.start({ agent: 'kit' }, { seat: 'claude-overlap' });
  mock.timers.setTime(T0 + 6 * HOUR);
  await h.finish(first);
  await report('claude-overlap', 0.3, 0.15, T0 + 10 * HOUR);
  assert.ok(Math.abs(fillRates().get('claude')!.five.get('claude-overlap')! - 0.2) < 1e-10);
  mock.timers.setTime(T0 + 6.5 * HOUR);
  await h.finish(second);
  mock.timers.setTime(T0 + 7 * HOUR);
  await report('claude-overlap', 0.4, 0.2, T0 + 10 * HOUR);
  mock.timers.setTime(T0 + 8 * HOUR);
  await report('claude-overlap', 0.5, 0.3, T0 + 10 * HOUR);
  const measured = fillRates().get('claude')!;
  assert.ok(Math.abs(measured.five.get('claude-overlap')! - 0.2) < 1e-10);
  assert.ok(Math.abs(measured.week.get('claude-overlap')! - 0.1) < 1e-10);
  const evidence = { fiveHours: 2, weekHours: 2, fiveIntervals: 2, weekIntervals: 2 };
  assert.deepEqual(measured.measurements.get('claude-overlap'), evidence);
  assert.deepEqual(fillRates().get('claude')!.measurements.get('claude-overlap'), evidence);
});

test("a lost run's hours end at its last heartbeat in readings already read", async () => {
  const { runsLost } = await import('./agenttime.ts');
  mock.timers.setTime(T0 + 10 * HOUR);
  await report('claude-lost', 0.1, 0.1, T0 + 20 * HOUR);
  const job = await h.start({ agent: 'bolt' }, { seat: 'claude-lost' });
  mock.timers.setTime(T0 + 10.5 * HOUR);
  await h.heartbeat(job);
  for (const [hour, used] of [
    [11, 0.2],
    [12, 0.3],
  ]) {
    mock.timers.setTime(T0 + hour * HOUR);
    await report('claude-lost', used, used, T0 + 20 * HOUR);
    assert.ok(Math.abs(fillRates().get('claude')!.five.get('claude-lost')! - 0.1) < 1e-10);
  }
  runsLost(T0 + 11 * HOUR);
  mock.timers.setTime(T0 + 13 * HOUR);
  await report('claude-lost', 0.4, 0.4, T0 + 20 * HOUR);
  // (the hour to 11:00 had half an hour of the run, the hours after none)
  assert.ok(Math.abs(fillRates().get('claude')!.five.get('claude-lost')! - 0.2) < 1e-10);
});

test('different observed overlap mixtures identify stage burn in both windows without future readings', async () => {
  const start = T0 + 14 * HOUR;
  mock.timers.setTime(start);
  await report('claude-mix', 0.1, 0.1, start + 5 * HOUR);
  const work = await h.start({ agent: 'bolt' }, { seat: 'claude-mix' });
  mock.timers.setTime(start + HOUR);
  await h.heartbeat(work);
  await report('claude-mix', 0.2, 0.11, start + 5 * HOUR);
  const review = await h.start({ agent: 'kit', kind: 'review' }, { seat: 'claude-mix' });
  mock.timers.setTime(start + 2 * HOUR);
  await h.heartbeat(work);
  await h.heartbeat(review);
  await report('claude-mix', 0.5, 0.15, start + 5 * HOUR);
  const mix = fillRates().get('claude')!.mix.get('claude-mix')!;
  assert.ok(Math.abs(mix.work.five! - 0.1) < 1e-10);
  assert.ok(Math.abs(mix.review.five! - 0.2) < 1e-10);
  assert.ok(Math.abs(mix.work.week! - 0.01) < 1e-10);
  assert.ok(Math.abs(mix.review.week! - 0.03) < 1e-10);
  const projected = seatProjection('claude-mix');
  assert.ok(Math.abs(projected.five_hour! - (start + (2 + 0.5 / 0.3) * HOUR)) < 1);
  assert.ok(Math.abs(projected.week! - (start + (2 + 0.85 / 0.04) * HOUR)) < 1);
  assert.ok(mix.work.fiveFit!.residualPerHour < 1e-10);
  assert.equal(mix.work.fiveFit!.observations, 2);
  const cutoff = fillRates(start + HOUR)
    .get('claude')!
    .mix.get('claude-mix')!;
  assert.equal(cutoff.review, undefined, 'a future overlap and reading cannot price a cutoff');
  assert.ok(Math.abs(cutoff.work.five! - 0.1) < 1e-10);
  await h.finish(work);
  await h.finish(review);
});

test('a fixed concurrent stage mixture preserves unknown component prices', async () => {
  const start = T0 + 17 * HOUR;
  mock.timers.setTime(start);
  await report('claude-unidentified', 0.1, 0.1, start + 5 * HOUR);
  const work = await h.start({ agent: 'bolt' }, { seat: 'claude-unidentified' });
  const review = await h.start({ agent: 'kit', kind: 'review' }, { seat: 'claude-unidentified' });
  mock.timers.setTime(start + HOUR);
  await report('claude-unidentified', 0.4, 0.15, start + 5 * HOUR);
  const rates = fillRates().get('claude')!;
  assert.ok(Math.abs(rates.five.get('claude-unidentified')! - 0.15) < 1e-10);
  const mix = rates.mix.get('claude-unidentified')!;
  assert.equal(mix.work.five, null);
  assert.equal(mix.review.five, null);
  assert.equal(mix.work.week, null);
  assert.equal(mix.review.week, null);
  await h.finish(work);
  await h.finish(review);
});

test('state reports do not manufacture zero-burn intervals or move provider observations before their report cutoff', async () => {
  const start = T0 + 20 * HOUR;
  const reading = (used: number, observedAt: number) =>
    h.worker('seat', {
      seat: 'claude-aged',
      engine: 'claude',
      state: 'ready',
      util: used,
      week: used,
      resets: start + 5 * HOUR,
      weekResets: start + 7 * 24 * HOUR,
      fiveHourObservedAt: observedAt,
      weekObservedAt: observedAt,
    });
  mock.timers.setTime(start);
  await reading(0.1, start);
  const work = await h.start({ agent: 'bolt' }, { seat: 'claude-aged' });
  mock.timers.setTime(start + HOUR);
  await h.heartbeat(work);
  await reading(0.2, start + HOUR);
  mock.timers.setTime(start + 2 * HOUR);
  await h.heartbeat(work);
  await reading(0.2, start + HOUR);
  assert.equal(fillRates().get('claude')!.measurements.get('claude-aged')!.fiveHours, 1);
  mock.timers.setTime(start + 3 * HOUR);
  await h.heartbeat(work);
  await reading(0.3, start + 2 * HOUR);
  assert.equal(fillRates().get('claude')!.measurements.get('claude-aged')!.fiveHours, 2);
  assert.equal(
    fillRates(start + 2 * HOUR)
      .get('claude')!
      .measurements.get('claude-aged')!.fiveHours,
    1,
  );
  await h.finish(work);
});
