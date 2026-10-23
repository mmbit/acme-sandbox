// node --test src/headroom.test.ts   (uses a throwaway DATA_DIR)
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('headroom');
const { fillRates, seatProjection } = await import('./headroom.ts');
const HOUR = 3_600_000,
  T0 = Math.floor(Date.now() / HOUR) * HOUR;
mock.timers.enable({ apis: ['Date'], now: T0 });
test.after(() => mock.timers.reset());
const report = (seat: string, util: number, week: number, resets = T0 + 5 * HOUR) =>
  h.worker('seat', { seat, engine: 'claude', state: 'ready', util, week, resets, weekResets: T0 + 7 * 24 * HOUR });

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
});
