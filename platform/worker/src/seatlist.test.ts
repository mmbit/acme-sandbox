// node --test src/seatlist.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyList, carryOut, off, spendCredits, type Listed } from './seatlist.ts';
import {
  checkDue,
  codexReading,
  DRAIN_RECHECK,
  drainOf,
  drainPauses,
  drainUntil,
  limitsReading,
  readDue,
  reportedUntil,
  reserveFor,
  takeRead,
  takeReading,
} from './downtime.ts';
import { pacedUntil, paceTo, reserveElsewhere } from './pace.ts';

type S = {
  id: string;
  engine: string;
  signIn: 'login' | 'key';
  state: string;
  paused?: boolean;
  gone?: boolean;
  url?: string;
  cli?: string;
  drainAt?: number;
  hasCredits?: boolean;
  useCredits?: boolean;
  credits?: boolean;
};
const listed = (id: string, more: Partial<Listed> = {}): Listed => ({
  id,
  engine: id.split('-')[0] === 'codex' ? 'codex' : 'claude',
  provider: 'anthropic',
  sign_in: 'login',
  paused: false,
  ...more,
});
function world(seats: S[] = []) {
  const said: string[] = [];
  const hooks = {
    held: new Set<string>(),
    make: (id: string, engine: string): S => ({ id, engine, signIn: 'login', state: 'login' }),
    start: (s: S) => said.push(`start ${s.id}`),
    changed: (s: S) => said.push(`changed ${s.id} ${off(s) ? 'off' : 'on'}`),
    drop: (s: S) => {
      s.gone = true;
      seats.splice(seats.indexOf(s), 1);
      said.push(`drop ${s.id}`);
    },
  };
  return { seats, said, hooks };
}

test("the worker's seats follow HQ's list: new ones start, changes are heard, and one off the list goes", () => {
  const w = world([
    { id: 'claude-1', engine: 'claude', signIn: 'login', state: 'ready' },
    { id: 'codex-1', engine: 'codex', signIn: 'login', state: 'ready' },
  ]);
  applyList(
    w.seats,
    [
      listed('claude-1'),
      listed('mistral-1', { provider: 'mistral', sign_in: 'key', url: 'https://x.example' }),
      listed('bad id'),
      listed('claude-team-2'),
      listed('claude--3'),
    ],
    w.hooks,
  );
  assert.deepEqual(w.said, ['start claude-1', 'start mistral-1', 'start claude-team-2', 'drop codex-1']);
  assert.deepEqual(
    w.seats.map(s => [s.id, s.signIn, s.url]),
    [
      ['claude-1', 'login', undefined],
      ['mistral-1', 'key', 'https://x.example'],
      ['claude-team-2', 'login', undefined],
    ],
  );
  w.said.length = 0;
  applyList(
    w.seats,
    [
      listed('claude-1', { paused: true }),
      listed('mistral-1', { sign_in: 'key', url: 'https://x.example' }),
      listed('claude-team-2'),
    ],
    w.hooks,
  );
  applyList(w.seats, [listed('claude-1'), listed('mistral-1', { sign_in: 'key' }), listed('claude-team-2')], w.hooks);
  assert.deepEqual(w.said, ['changed claude-1 off', 'changed claude-1 on']);
  // a seat held off at this start (its login move failed) isn't brought back by the list
  w.hooks.held.add('claude-7');
  applyList(w.seats, [listed('claude-1'), listed('mistral-1', { sign_in: 'key' }), listed('claude-7')], w.hooks);
  assert.ok(!w.seats.some(s => s.id === 'claude-7'));
});

test("a seat runs its provider's CLI, and one moved to another CLI or another engine's work starts again", () => {
  const w = world();
  applyList(
    w.seats,
    [listed('mistral-1', { engine: 'codex', cli: 'vibe', provider: 'mistral', sign_in: 'key' })],
    w.hooks,
  );
  assert.deepEqual(
    w.seats.map(s => [s.id, s.engine, s.cli]),
    [['mistral-1', 'codex', 'vibe']],
  );
  // its provider now takes the other engine's work (company/providers.yaml): the same seat starts again
  applyList(
    w.seats,
    [listed('mistral-1', { engine: 'claude', cli: 'vibe', provider: 'mistral', sign_in: 'key' })],
    w.hooks,
  );
  assert.deepEqual(w.said, ['start mistral-1', 'drop mistral-1', 'start mistral-1']);
  assert.deepEqual(
    w.seats.map(s => [s.engine, s.cli]),
    [['claude', 'vibe']],
  );
  // a CLI the worker doesn't have is left out
  applyList(w.seats, [listed('other-1', { engine: 'codex', cli: 'nothing' })], w.hooks);
  assert.ok(!w.seats.some(s => s.id === 'other-1'));
});

test("the board's changes: each settled with words for it, a removal's sign-in forgotten even for a seat the worker lost", async () => {
  const w = world([
    { id: 'claude-1', engine: 'claude', signIn: 'login', state: 'ready' },
    { id: 'claude-k', engine: 'claude', signIn: 'key', state: 'login' },
  ]);
  const settled: [number, string, string?][] = [],
    forgot: string[] = [],
    signins: [string, number?][] = [];
  let keyWorks = true;
  const d = {
    runsOn: (id: string) => (id === 'claude-1' ? 2 : 0),
    settle: async (id: number, status: string, words?: string) => {
      settled.push([id, status, words]);
    },
    signIn: async (s: S, action?: number) => {
      signins.push([s.id, action]);
    },
    takeKey: async () => (keyWorks ? { ok: true, words: 'The key works.' } : { ok: false, words: 'No.' }),
    drop: w.hooks.drop,
    forget: (id: string) => forgot.push(id),
    pacing: () => true,
  };
  await carryOut({ id: 1, seat: 'claude-1', what: 'pause' }, w.seats, d);
  assert.match(settled.at(-1)![2]!, /^Paused: it takes no new work\. The 2 jobs running on it finish there first\.$/);
  await carryOut({ id: 2, seat: 'claude-1', what: 'sign-in' }, w.seats, d);
  assert.deepEqual(
    [settled.at(-1), signins.at(-1)],
    [
      [2, 'working', undefined],
      ['claude-1', 2],
    ],
  );
  await carryOut({ id: 3, seat: 'claude-k', what: 'add' }, w.seats, d);
  assert.deepEqual(settled.slice(-2), [
    [3, 'working', undefined],
    [3, 'done', 'Added. The key works.'],
  ]);
  keyWorks = false;
  await carryOut({ id: 4, seat: 'claude-k', what: 'key' }, w.seats, d);
  assert.deepEqual(settled.at(-1), [4, 'failed', 'No.']);
  await carryOut({ id: 5, seat: 'claude-1', what: 'remove' }, w.seats, d);
  assert.match(
    settled.at(-1)![2]!,
    /sign-in deleted from our server\. The 2 jobs running on it finish there first\. The account itself is still open/,
  );
  assert.ok(!w.seats.some(s => s.id === 'claude-1'));
  await carryOut({ id: 6, seat: 'codex-9', what: 'remove' }, w.seats, d);
  await carryOut({ id: 7, seat: '../etc', what: 'remove' }, w.seats, d);
  assert.deepEqual(forgot, ['claude-1', 'codex-9']);
  await carryOut({ id: 8, seat: 'claude-1', what: 'resume' }, w.seats, d);
  assert.deepEqual(settled.at(-1)!.slice(0, 2), [8, 'failed']);
});

test("a seat's stop level is the board's once it set one; until then the seat keeps its own (SEATS')", () => {
  const w = world([
    { id: 'claude-1', engine: 'claude', signIn: 'login', state: 'ready', drainAt: 0.95 },
    { id: 'claude-2', engine: 'claude', signIn: 'login', state: 'ready' },
  ]);
  applyList(
    w.seats,
    [listed('claude-1', { stop: null }), listed('claude-2'), listed('claude-3', { stop: 70 })],
    w.hooks,
  );
  assert.deepEqual(
    w.seats.map(s => [s.id, s.drainAt]),
    [
      ['claude-1', 0.95],
      ['claude-2', undefined],
      ['claude-3', 0.7],
    ],
  );
  applyList(w.seats, [listed('claude-1', { stop: 80 }), listed('claude-2', { stop: 99 }), listed('claude-3')], w.hooks);
  assert.deepEqual(
    w.seats.map(s => s.drainAt),
    [0.8, 0.99, 0.7],
  );
});

test('a stop level and pacing: done once the list is applied, in words for the board', async () => {
  const w = world([
    { id: 'claude-1', engine: 'claude', signIn: 'login', state: 'ready', drainAt: 0.85 },
    { id: 'claude-2', engine: 'claude', signIn: 'login', state: 'ready' },
  ]);
  const settled: [number, string, string?][] = [];
  let pacing = false;
  const d = {
    runsOn: () => 0,
    settle: async (id: number, status: string, words?: string) => {
      settled.push([id, status, words]);
    },
    signIn: async () => {},
    takeKey: async () => ({ ok: true, words: '' }),
    drop: w.hooks.drop,
    forget: () => {},
    pacing: () => pacing,
  };
  await carryOut({ id: 1, seat: 'claude-1', what: 'stop' }, w.seats, d);
  await carryOut({ id: 2, seat: 'claude-2', what: 'stop' }, w.seats, d);
  await carryOut({ id: 3, seat: 'claude-9', what: 'stop' }, w.seats, d);
  await carryOut({ id: 4, seat: null, what: 'pacing' }, w.seats, d);
  pacing = true;
  await carryOut({ id: 5, seat: null, what: 'pacing' }, w.seats, d);
  assert.deepEqual(settled, [
    [1, 'done', 'Stops at 85% of its limits now.'],
    [2, 'done', 'Stops at 90% of its limits now.'],
    [3, 'failed', "The worker doesn't have this seat. Try again in a minute."],
    [4, 'done', 'Pacing is off.'],
    [5, 'done', 'Pacing is on.'],
  ]);
});

test("a Codex seat is paced over its week like Claude's, and runs on past its level only while the board lets it spend credits", async () => {
  const NOW = Date.parse('2026-10-22T12:00:00Z'),
    reset = NOW + 4 * 24 * 3600e3;
  // (half the week gone in three days, as on 22 Oct: on pace to run out a day and a half early)
  const reading = (week: number, credits: object) =>
    codexReading(
      JSON.stringify({
        timestamp: '2026-10-22T11:59:00Z',
        payload: {
          rate_limits: { primary: { used_percent: week, window_minutes: 10080, resets_at: reset / 1000 }, credits },
        },
      }),
      0,
      0,
      NOW,
    )!;
  const w = world([{ id: 'codex-1', engine: 'codex', signIn: 'login', state: 'ready' }]);
  const codex = Object.assign(w.seats[0], { util: undefined, resets: 0 }) as S & {
    week?: number;
    weekResets: number;
    util?: number;
    resets: number;
  };
  const read = (week: number, credits: object) => {
    const r = reading(week, credits);
    Object.assign(codex, { week: r.week, weekResets: r.weekResets, hasCredits: r.credits });
    spendCredits(codex);
  };
  const paced = () => pacedUntil(codex, paceTo(codex, true, false), NOW);
  read(50, { has_credits: true, unlimited: false, balance: '57000' });
  applyList(w.seats, [listed('codex-1')], w.hooks);
  assert.equal(codex.credits, false, 'credits in the account alone spend nothing');
  assert.equal(paced(), reset, 'paced till its reset, as a Claude seat is');
  read(95, { has_credits: true });
  assert.equal(drainUntil(codex, NOW), reset, 'and it stops at its level');
  applyList(w.seats, [listed('codex-1', { use_credits: true })], w.hooks);
  assert.equal(codex.credits, true);
  assert.deepEqual(
    [paced(), drainUntil(codex, NOW)],
    [reset, 0],
    "the board's choice: past its level on credits, still paced",
  );
  read(95, { has_credits: false, balance: '0' });
  assert.deepEqual([codex.credits, drainUntil(codex, NOW)], [false, reset], 'none left: it keeps to its plan again');
  applyList(w.seats, [listed('codex-1', { use_credits: false })], w.hooks);
  read(50, { has_credits: true });
  assert.equal(paced(), reset);
  const settled: (string | undefined)[] = [];
  const d = {
    runsOn: () => 0,
    settle: async (id: number, status: string, words?: string) => void settled.push(words),
    signIn: async () => {},
    takeKey: async () => ({ ok: true, words: '' }),
    drop: w.hooks.drop,
    forget: () => {},
    pacing: () => true,
  };
  await carryOut({ id: 1, seat: 'codex-1', what: 'credits' }, w.seats, d);
  applyList(w.seats, [listed('codex-1', { use_credits: true })], w.hooks);
  await carryOut({ id: 2, seat: 'codex-1', what: 'credits' }, w.seats, d);
  assert.deepEqual(settled, [
    'It keeps to its plan now: paced over its week, it stops at its level.',
    'It may spend credits past its plan now, while its account has them.',
  ]);
});

test("a Codex account with credits the board hasn't allowed never runs past its plan: no reserve elsewhere, its runs pause, no job checks it", () => {
  const NOW = Date.parse('2026-10-22T12:00:00Z'),
    H = 3600e3,
    reset = NOW + 72 * H;
  const w = world([
    { id: 'codex-1', engine: 'codex', signIn: 'login', state: 'ready' },
    { id: 'codex-2', engine: 'codex', signIn: 'login', state: 'ready' },
  ]);
  const seats = w.seats.map(s =>
      Object.assign(s, { until: 0, resets: 0, weekResets: reset, checked: undefined as number | undefined }),
    ),
    [full, healthy] = seats;
  Object.assign(full, { week: 0.95, hasCredits: true });
  Object.assign(healthy, { week: 0.3 });
  const running = new Map([
    ['codex#1', { seat: 'codex-1', job: 21 }],
    ['codex#2', { seat: 'codex-2', job: 22 }],
  ]);
  // the worker's drain, from its drainOf: the seat's hold, and the runs that stop
  const drain = () => {
    const d = drainOf(full, seats, running, 'claude#chat', NOW);
    if (d.until) Object.assign(full, { state: 'draining', until: d.until });
    else Object.assign(full, { state: 'ready', until: 0 });
    return d;
  };
  applyList(w.seats, [listed('codex-1', { use_credits: true }), listed('codex-2')], w.hooks);
  assert.equal(full.credits, true);
  assert.deepEqual(drain(), { until: 0, pause: [] }, 'on credits by the board: it runs on');
  // the board takes its leave back while job 21 runs on it, beside a healthy second seat
  applyList(w.seats, [listed('codex-1'), listed('codex-2')], w.hooks);
  assert.deepEqual([full.credits, reserveFor(full, seats, NOW)], [false, false], 'its limit is where credits begin');
  assert.deepEqual(drain(), { until: reset, pause: [21] }, 'held till its reset, its run paused at its next step');
  assert.deepEqual(drain().pause, [21], 'held still: a run going when the reading came in pauses too');
  assert.equal(checkDue({ ...full, checked: NOW - 2 * H }, NOW), false, 'no job through to measure it');
  assert.equal(readDue({ ...full, checked: NOW - 2 * H }, NOW), true, 'the worker reads its account instead');
  assert.equal(
    reportedUntil({ ...full, checked: NOW, confirmed: true }, NOW),
    reset,
    'once that read holds it, HQ counts it out till the reset',
  );
  // an account without credits keeps the reserve and the hourly check as before
  Object.assign(full, { hasCredits: false, state: 'ready', until: 0 });
  assert.equal(reserveFor(full, seats, NOW), true);
  assert.deepEqual(drain(), { until: 0, pause: [] });
  Object.assign(full, { state: 'draining', until: reset, checked: NOW - H });
  assert.deepEqual([checkDue(full, NOW), drainPauses(full, running, 'claude#chat')], [true, []]);
});

test("a reading a job planted (credits and a full week) can't hold a seat past one recheck: the worker's own read lifts it", () => {
  const NOW = Date.parse('2026-10-22T12:00:00Z'),
    H = 3600e3,
    reset = NOW + 7 * 24 * H - 60_000;
  const w = world([
    { id: 'codex-1', engine: 'codex', signIn: 'login', state: 'ready' },
    { id: 'codex-2', engine: 'codex', signIn: 'login', state: 'ready' },
  ]);
  const seats = w.seats.map(s =>
      Object.assign(s, {
        until: 0,
        resets: 0,
        week: undefined as number | undefined,
        weekResets: 0,
        checked: undefined as number | undefined,
        confirmed: undefined as boolean | undefined,
        readFailed: undefined as boolean | undefined,
      }),
    ),
    [seat, peer] = seats;
  applyList(w.seats, [listed('codex-1'), listed('codex-2')], w.hooks);
  const running = new Map([['codex#1', { seat: 'codex-1', job: 21 }]]);
  // the worker's drain: the hold drainOf gives, from when it began (checked)
  const drain = (now: number) => {
    const d = drainOf(seat, seats, running, 'claude#chat', now);
    Object.assign(seat, d.until ? { state: 'draining', until: d.until } : { state: 'ready', until: 0 });
    return d;
  };
  const planted = codexReading(
    JSON.stringify({
      timestamp: '2026-10-22T12:00:00Z',
      payload: {
        rate_limits: {
          primary: { used_percent: 100, window_minutes: 10080, resets_at: reset / 1000 },
          credits: { has_credits: true },
        },
      },
    }),
    0,
    0,
    NOW,
  )!;
  takeReading(seat, planted, false);
  assert.deepEqual(drain(NOW), { until: reset, pause: [21] }, 'it holds the seat at first');
  seat.checked = NOW;
  assert.equal(reportedUntil(seat, NOW), NOW + DRAIN_RECHECK, 'HQ counts it out only till the recheck');
  assert.deepEqual([checkDue(seat, NOW + DRAIN_RECHECK), readDue(seat, NOW + DRAIN_RECHECK - 1)], [false, false]);
  assert.equal(readDue(seat, NOW + DRAIN_RECHECK), true, 'the recheck: the worker reads the account');
  // the account says otherwise: a third of the week used, no credits
  const read = (week: number, hasCredits: boolean) =>
    limitsReading(
      {
        rateLimits: {
          primary: { usedPercent: week, windowDurationMins: 10080, resetsAt: reset / 1000 },
          secondary: null,
          credits: { hasCredits, unlimited: false, balance: null },
        },
      },
      NOW + DRAIN_RECHECK,
    )!;
  takeRead(seat, read(30, false));
  assert.deepEqual(drain(NOW + DRAIN_RECHECK), { until: 0, pause: [] }, 'lifted at the recheck');
  assert.equal(seat.state, 'ready');
  // an account that reports only its 5-hour window: the planted week goes too, never confirmed
  takeReading(seat, planted, false);
  drain(NOW);
  takeRead(
    seat,
    limitsReading(
      {
        rateLimits: {
          primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: null },
          secondary: null,
          credits: { hasCredits: true, unlimited: false, balance: null },
        },
      },
      NOW + DRAIN_RECHECK,
    )!,
  );
  assert.equal(seat.week, undefined);
  assert.deepEqual(drain(NOW + DRAIN_RECHECK), { until: 0, pause: [] }, 'lifted: no week of its own to hold it');
  // a read that fails (readLimits marks the try first) keeps the hold as it was, unconfirmed: its run stays paused, no
  // job goes through, HQ counts it out only till the next hour, and then the account is read again
  takeReading(seat, planted, false);
  drain(NOW);
  seat.checked = NOW + DRAIN_RECHECK;
  takeRead(seat, undefined);
  assert.deepEqual([seat.hasCredits, seat.confirmed, seat.readFailed], [true, false, true]);
  assert.deepEqual(drain(NOW + DRAIN_RECHECK), { until: reset, pause: [21] }, 'still held: its run stays paused');
  assert.equal(reportedUntil(seat, NOW + DRAIN_RECHECK), NOW + 2 * DRAIN_RECHECK);
  assert.deepEqual(
    [
      checkDue(seat, NOW + 2 * DRAIN_RECHECK),
      readDue(seat, NOW + 2 * DRAIN_RECHECK - 1),
      readDue(seat, NOW + 2 * DRAIN_RECHECK),
    ],
    [false, false, true],
  );
  // the same with a healthy Codex peer: the seat keeps to its plan, so the peer doesn't keep the reserve for it
  Object.assign(peer, { util: 0.1, resets: NOW + 3 * H, week: 0.2, weekResets: reset });
  assert.deepEqual(
    [reserveElsewhere(seat, seats, NOW + DRAIN_RECHECK), reserveFor(seat, seats, NOW + DRAIN_RECHECK)],
    [true, false],
  );
  takeRead(seat, undefined);
  assert.deepEqual(drain(NOW + DRAIN_RECHECK), { until: reset, pause: [21] }, 'held beside a healthy peer too');
  assert.equal(checkDue(seat, NOW + 2 * DRAIN_RECHECK), false);
  // a read that confirms the planted figures holds the seat, now as the last word
  takeReading(seat, planted, false);
  drain(NOW);
  takeRead(seat, read(100, true));
  assert.deepEqual(drain(NOW + DRAIN_RECHECK), { until: reset, pause: [21] });
  assert.deepEqual(
    [readDue(seat, NOW + 50 * H), reportedUntil(seat, NOW + 50 * H)],
    [false, reset],
    'confirmed: no more reads, and HQ hears the real end',
  );
});
