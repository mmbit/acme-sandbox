// node --test src/seatlist.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyList, carryOut, off, type Listed } from './seatlist.ts';

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
    ],
    w.hooks,
  );
  assert.deepEqual(w.said, ['start claude-1', 'start mistral-1', 'drop codex-1']);
  assert.deepEqual(
    w.seats.map(s => [s.id, s.signIn, s.url]),
    [
      ['claude-1', 'login', undefined],
      ['mistral-1', 'key', 'https://x.example'],
    ],
  );
  w.said.length = 0;
  applyList(
    w.seats,
    [listed('claude-1', { paused: true }), listed('mistral-1', { sign_in: 'key', url: 'https://x.example' })],
    w.hooks,
  );
  applyList(w.seats, [listed('claude-1'), listed('mistral-1', { sign_in: 'key' })], w.hooks);
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
