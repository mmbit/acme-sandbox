// node --test src/readings.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatReadings } from './readings.ts';
import { takeRead } from './downtime.ts';
import { CLAUDE_RECHECK_MS, windowUsed } from './pace.ts';
import { seatStatus, type PacedSeat } from './seatstatus.ts';

const NOW = Date.parse('2026-11-07T03:05:00Z');
const HOUR_MS = 3_600_000;
const seat = (engine = 'claude') => ({
  id: `${engine}-1`,
  engine,
  signIn: 'login' as 'login' | 'key',
  state: 'ready',
  until: 0,
  util: undefined as number | undefined,
  week: undefined as number | undefined,
  resets: NOW + HOUR_MS,
  weekResets: NOW + 5 * 24 * HOUR_MS,
  fiveHourObservedAt: undefined as number | undefined,
  weekObservedAt: undefined as number | undefined,
  measured: undefined as number | undefined,
});
type Seat = ReturnType<typeof seat>;
const read = async (s: Seat) => {
  takeRead(s, { at: NOW, util: 0.1, week: 0.1, resets: s.resets, weekResets: s.weekResets });
};
const failed = (_s: Seat, error: unknown) => {
  throw error;
};

for (const restored of [undefined, 0.1]) {
  test(`an unread seat with a future reset gets readings with restored week ${restored}`, async () => {
    const s = seat();
    s.week = restored;
    const status = () => seatStatus(s as PacedSeat, [s as PacedSeat], false, 0, NOW);
    assert.equal(status().admission, 'unavailable');
    await seatReadings({ claude: read, codex: read, failed })([s], NOW);
    assert.equal(s.util, 0.1);
    assert.equal(s.week, 0.1);
    assert.equal(s.fiveHourObservedAt, NOW);
    assert.equal(s.weekObservedAt, NOW);
    assert.equal(status().admission, 'open');
  });
}

test('expired resets do not stand in for the first account reading', async () => {
  const s = seat();
  s.resets = NOW - HOUR_MS;
  s.weekResets = NOW - HOUR_MS;
  assert.equal(windowUsed(s, NOW), 0);
  await seatReadings({ claude: read, codex: read, failed })([s], NOW);
  assert.equal(s.fiveHourObservedAt, NOW);
  assert.equal(s.weekObservedAt, NOW);
});

test('a failed Claude read leaves the other seats able to get their readings', async () => {
  const broken = seat(),
    claude = { ...seat(), id: 'claude-3' },
    codex = seat('codex');
  const errors: unknown[] = [];
  const check = seatReadings({
    claude: async (s: Seat) => {
      if (s === broken) throw new Error('Provider unavailable');
      await read(s);
    },
    codex: read,
    failed: (_s, error) => errors.push(error),
  });
  await check([broken, claude, codex], NOW);
  assert.equal(broken.util, undefined);
  assert.equal(claude.fiveHourObservedAt, NOW);
  assert.equal(codex.weekObservedAt, NOW);
  assert.equal(errors.length, 1);
  await check([broken, claude, codex], NOW + CLAUDE_RECHECK_MS - 1);
  assert.equal(errors.length, 1);
  await check([broken, claude, codex], NOW + CLAUDE_RECHECK_MS);
  assert.equal(errors.length, 2);
});

test('signed-out, paused and key seats make no reading request', async () => {
  const seats = [
    { ...seat(), state: 'login' },
    { ...seat(), paused: true },
    { ...seat(), signIn: 'key' as const },
  ];
  const noRead = async () => {
    throw new Error('Unexpected account request');
  };
  await seatReadings({ claude: noRead, codex: noRead, failed })(seats, NOW);
  assert.ok(seats.every(s => s.util === undefined));
});

test('a restart re-reads a restored weekly value but a measured weekly-only Codex plan is complete', async () => {
  const codex = seat('codex');
  codex.week = 0.1;
  const check = seatReadings({ claude: read, codex: read, failed });
  await check([codex], NOW);
  assert.equal(codex.measured, NOW);
  codex.util = undefined;
  const noRead = async () => {
    throw new Error('Weekly-only plan already measured');
  };
  await seatReadings({ claude: noRead, codex: noRead, failed })([codex], NOW + HOUR_MS);
});
