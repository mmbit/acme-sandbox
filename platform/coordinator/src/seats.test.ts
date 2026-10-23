// node --test src/seats.test.ts   (the board's seats in HQ and the worker's side of them: the test company)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('seats', {
  before: repo =>
    writeFileSync(
      `${repo}/company/providers.yaml`,
      `providers:
  - { id: elsewhere, name: Elsewhere, engine: claude, url: "https://api.elsewhere.example/anthropic", model: big-1, models: { haiku: small-1 } }
  - { id: broken, name: Broken, engine: claude, url: "http://plain.example", model: x }
`,
    ),
});
const { worker, board } = h;
const KEY = 'sk-test-0123456789abcdefghijklmnop';
const seats = async () => (await board('/api/seats')).body as any[];
const seat = async (id: string) => (await seats()).find(s => s.id === id);
// (pacing)
const list = async () => (await worker('seat-list')).body as { seats: any[]; actions: any[]; pacing: boolean };
const settle = (id: number, status: string, words?: string) => worker('seat-action', { id, status, words });
const forSeat = (job: number) => (h.db.prepare('select for_seat from jobs where id = ?').get(job) as any).for_seat as string | null;
const openCards = async (id: string) => ((await board('/api/requests')).body as any[]).filter(c => c.seat === id);

test("the worker's list at its first start is the board's first list, taken once", async () => {
  await worker('seat', { seat: 'claude-1', engine: 'claude', state: 'ready', util: 0.4 });
  const first = (
    await worker('seats', { seats: [{ id: 'claude-1', engine: 'claude' }, 'codex-1:codex', 'Bad Name:claude'] })
  ).body;
  assert.deepEqual(
    first.seats.map((s: any) => [s.id, s.provider, s.sign_in]),
    [
      ['claude-1', 'anthropic', 'login'],
      ['codex-1', 'openai', 'login'],
    ],
  );
  await worker('seats', { seats: ['claude-9:claude'] }); // (a later start's setting changes nothing)
  const shown = await seats();
  assert.deepEqual(
    shown.map(s => s.id),
    ['claude-1', 'codex-1'],
  );
  assert.equal(shown[0].util, 0.4);
  assert.equal(shown[0].provider_name, 'Anthropic: Claude subscription');
  assert.equal(shown[1].state, null); // (nothing reported yet)
});

test("the providers: the platform's and the company's file (a bad entry left out)", async () => {
  const r = (await board('/api/seats/providers')).body;
  assert.equal(r.engines, undefined, 'no switch per engine: each agent has its own model (models.ts)');
  const ids = r.providers.map((p: any) => p.id);
  assert.deepEqual(ids, ['anthropic', 'anthropic-key', 'openai', 'openai-key', 'mistral', 'google', 'elsewhere']);
  assert.equal(r.providers.at(-1).from, 'company');
  // each with the CLI it runs, and the engine whose work it takes: another model family's is the second opinion
  const google = r.providers.find((p: any) => p.id === 'google');
  assert.deepEqual([google.cli, google.engine, google.sign_in], ['agy', 'codex', 'login']);
  assert.deepEqual(
    ['mistral', 'elsewhere'].map(id => r.providers.find((p: any) => p.id === id)).map(p => [p.cli, p.engine, p.sign_in]),
    [
      ['vibe', 'codex', 'key'],
      ['claude', 'claude', 'key'],
    ],
  );
});

test('a key seat: added with its key, which the worker takes once and HQ never shows', async () => {
  assert.match(
    (await board('/api/seats/add', { id: 'claude-k', provider: 'anthropic-key' })).body.error,
    /Paste the service's API key/,
  );
  assert.match(
    (await board('/api/seats/add', { id: 'Claude K', provider: 'anthropic-key', key: KEY })).body.error,
    /lowercase/,
  );
  assert.match(
    (await board('/api/seats/add', { id: 'claude-1', provider: 'anthropic-key', key: KEY })).body.error,
    /already/,
  );
  assert.match(
    (await board('/api/seats/add', { id: 'claude-k', provider: 'anthropic-key', key: 'two words' })).body.error,
    /doesn't look like a key/,
  );
  const added = (await board('/api/seats/add', { id: 'claude-k', provider: 'anthropic-key', key: KEY })).body;
  assert.equal(added.ok, true);
  const { seats: theirs, actions } = await list();
  assert.deepEqual(
    theirs.find(s => s.id === 'claude-k'),
    {
      id: 'claude-k',
      engine: 'claude',
      cli: 'claude',
      provider: 'anthropic-key',
      sign_in: 'key',
      paused: false,
      stop: null,
    },
  );
  assert.deepEqual(
    actions.map(a => [a.id, a.seat, a.what]),
    [[added.action, 'claude-k', 'add']],
  );
  assert.deepEqual((await worker('seat-key', { seat: 'claude-k' })).body, { key: KEY });
  assert.deepEqual((await worker('seat-key', { seat: 'claude-k' })).body, { key: null });
  await settle(added.action, 'working');
  assert.equal((await seat('claude-k')).action.status, 'working');
  await settle(added.action, 'done', 'Added, and a test call with its key worked.');
  const row = await seat('claude-k');
  assert.deepEqual(
    [row.action.what, row.action.status, row.action.words],
    ['add', 'done', 'Added, and a test call with its key worked.'],
  );
  assert.equal((await list()).actions.length, 0);
  // a new key, refused for a seat that signs in with its account
  assert.match((await board('/api/seats/key', { seat: 'claude-1', key: KEY })).body.error, /signs in with its account/);
  assert.equal((await board('/api/seats/key', { seat: 'claude-k', key: `${KEY}2` })).status, 200);
  assert.equal((await worker('seat-key', { seat: 'claude-k' })).body.key, `${KEY}2`);
  assert.doesNotMatch(JSON.stringify(await seats()), /sk-test/);
});

test("a service of the board's own: its address and model reach the worker", async () => {
  const refused = (b: object) =>
    board('/api/seats/add', { id: 'other-1', provider: 'new', key: KEY, ...b }).then(r => r.body.error);
  assert.match(await refused({ name: 'Other', engine: 'claude', url: 'http://x.example', model: 'm' }), /https/);
  assert.match(
    await refused({ name: 'Other', cli: 'gemini', url: 'https://x.example', model: 'm' }),
    /Anthropic's API or OpenAI's/,
  );
  const r = await board('/api/seats/add', {
    id: 'other-1',
    provider: 'new',
    name: 'Other Place',
    cli: 'claude',
    url: 'https://api.other.example/v1',
    model: 'coder-2',
    key: KEY,
  });
  assert.equal(r.status, 200);
  const mine = (await list()).seats.find(s => s.id === 'other-1');
  assert.deepEqual(mine, {
    id: 'other-1',
    engine: 'codex',
    cli: 'claude',
    provider: 'other-place',
    sign_in: 'key',
    url: 'https://api.other.example/v1',
    model: 'coder-2',
    paused: false,
    stop: null,
  });
  assert.equal((await seat('other-1')).provider_name, 'Other Place');
  assert.ok(
    (await board('/api/seats/providers')).body.providers.some((p: any) => p.id === 'other-place' && p.from === 'board'),
  );
});

test("a sign-in on the seat's row: the page, the board's code (once), the result, and its card goes", async () => {
  await worker('seat', { seat: 'claude-1', engine: 'claude', state: 'login' }); // it had run: it lost its sign-in
  assert.equal((await openCards('claude-1')).length, 1);
  assert.match(
    (await board('/api/seats/code', { seat: 'claude-1', code: 'abc' })).body.error,
    /isn't waiting for a code/,
  );
  const started = (await board('/api/seats/sign-in', { seat: 'claude-1' })).body;
  assert.equal((await seat('claude-1')).signin.status, 'starting');
  assert.ok((await list()).actions.some(a => a.id === started.action && a.what === 'sign-in'));
  await settle(started.action, 'working');
  assert.deepEqual(
    (await worker('signin', { seat: 'claude-1', status: 'open', url: 'https://claude.ai/oauth/x', asks: 'code' })).body,
    { code: null },
  );
  assert.deepEqual((await seat('claude-1')).signin, {
    status: 'open',
    asks: 'code',
    url: 'https://claude.ai/oauth/x',
    at: (await seat('claude-1')).signin.at,
  });
  assert.equal((await board('/api/seats/code', { seat: 'claude-1', code: ' the-code#state ' })).status, 200);
  assert.equal((await seat('claude-1')).signin.status, 'checking');
  assert.deepEqual(
    (await worker('signin', { seat: 'claude-1', status: 'open', url: 'https://claude.ai/oauth/x' })).body,
    { code: 'the-code#state' },
  );
  assert.equal((await seat('claude-1')).signin.status, 'checking'); // (the worker is on it)
  assert.deepEqual(
    (await worker('signin', { seat: 'claude-1', status: 'open', url: 'https://claude.ai/oauth/x' })).body,
    { code: null },
  );
  await worker('signin', { seat: 'claude-1', status: 'done', words: 'Signed in: a test call worked.' });
  await settle(started.action, 'done', 'Signed in: a test call worked.');
  assert.equal((await seat('claude-1')).signin.status, 'done');
  assert.equal((await openCards('claude-1')).length, 0);
  // a seat the board just added, or one never signed in, gets no card
  await worker('seat', { seat: 'codex-1', engine: 'codex', state: 'login' });
  assert.equal((await openCards('codex-1')).length, 0);
});

test('a Codex sign-in shows the code to type at OpenAI, and asks for nothing back', async () => {
  await board('/api/seats/sign-in', { seat: 'codex-1' });
  await worker('signin', {
    seat: 'codex-1',
    status: 'open',
    url: 'https://auth.openai.com/codex/device',
    code: 'ABCD-12345',
    asks: 'nothing',
  });
  const shown = (await seat('codex-1')).signin;
  assert.deepEqual([shown.status, shown.code, shown.asks], ['open', 'ABCD-12345', 'nothing']);
  assert.match((await board('/api/seats/code', { seat: 'codex-1', code: 'x' })).body.error, /isn't waiting for a code/);
});

test("pause: the worker hears it, and a paused seat's waiting jobs go to any seat", async () => {
  const p = (await board('/api/seats/pause', { seat: 'codex-1', paused: true })).body;
  assert.equal((await list()).seats.find(s => s.id === 'codex-1').paused, true);
  const job = h.jobs.createJob({ agent: 'bolt', title: 'Codex work', prompt: 'x', engine: 'codex' }) as { id: number };
  h.db.prepare('update jobs set for_seat = ? where id = ?').run('codex-1', job.id);
  await worker('seat', { seat: 'codex-1', engine: 'codex', state: 'paused' });
  assert.equal((h.db.prepare('select for_seat from jobs where id = ?').get(job.id) as any).for_seat, null);
  await settle(p.action, 'done', 'Paused: it takes no new work.');
  assert.equal((await board('/api/seats/pause', { seat: 'codex-1', paused: false })).status, 200);
  assert.equal((await list()).seats.find(s => s.id === 'codex-1').paused, false);
});

test("a high-risk round's Codex review runs on Codex alone: never pinned to or claimed by another family's seat", async () => {
  for (const [id, provider] of [['mistral-2', 'mistral'], ['google-1', 'google']])
    assert.equal((await board('/api/seats/add', { id, provider, key: KEY })).body.ok, true);
  h.db.prepare("update jobs set status = 'cancelled' where status = 'queued'").run();
  const report = (seat: string, state: string) =>
    worker('seat', { seat, engine: 'codex', state, until: state === 'ready' ? undefined : Date.now() + 3_600_000 });
  try {
    for (const s of ['mistral-2', 'google-1']) await report(s, 'ready');
    await report('codex-1', 'sleeping');
    const high = h.jobs.createJob({ agent: 'bolt', kind: 'review', title: 'High', prompt: 'x', engine: 'codex', cli: 'codex' });
    assert.equal(forSeat(high.id), 'codex-1', "Codex's own seat, though another family's is ready");
    h.db.prepare('update jobs set for_seat = null where id = ?').run(high.id);
    for (const s of ['mistral-2', 'google-1'])
      assert.equal((await worker('claim', { seat: s, engine: 'codex' })).body, null, `${s} never claims it`);
    // the second opinion's other work is any seat's that takes it
    const normal = h.jobs.createJob({ agent: 'bolt', kind: 'review', title: 'Normal', prompt: 'x', engine: 'codex' });
    assert.ok(['mistral-2', 'google-1'].includes(forSeat(normal.id)!));
    await report('codex-1', 'ready');
    assert.equal((await worker('claim', { seat: 'codex-1', engine: 'codex' })).body.id, high.id);
  } finally {
    h.db.prepare("update jobs set status = 'cancelled' where status in ('queued', 'running')").run();
    await report('codex-1', 'ready');
    for (const seat of ['mistral-2', 'google-1']) await board('/api/seats/remove', { seat });
  }
});

test("the voice line counts subscription seats only: a ready key seat is no room for it", async () => {
  const before = (await seat('claude-1')).state;
  const until = 8e15;
  await worker('seat', { seat: 'claude-1', engine: 'claude', state: 'sleeping', until });
  await worker('seat', { seat: 'claude-k', engine: 'claude', state: 'ready' });
  assert.deepEqual(h.jobs.callSeat(), { room: false, why: 'limit', until });
  await worker('seat', { seat: 'claude-1', engine: 'claude', state: 'ready' });
  assert.deepEqual(h.jobs.callSeat(), { room: true });
  await worker('seat', { seat: 'claude-1', engine: 'claude', state: before });
  assert.deepEqual(h.jobs.callSeat(), { room: false, why: 'signin' });
  await worker('seat', { seat: 'claude-k', engine: 'claude', state: 'ready' });
  h.db.prepare("update seat_list set provider = 'anthropic-key' where id = 'claude-1'").run();
  assert.deepEqual(h.jobs.callSeat(), { room: false, why: 'signin' });
  h.db.prepare("update seat_list set provider = 'anthropic' where id = 'claude-1'").run();
});

test("remove: off the worker's list at once, gone from HQ once the worker has removed it", async () => {
  const running = h.jobs.createJob({ agent: 'bolt', title: 'Running on it', prompt: 'x', engine: 'codex' }) as { id: number };
  h.db.prepare("update jobs set status = 'running', for_seat = 'claude-k' where id = ?").run(running.id);
  await worker('seat', { seat: 'claude-k', engine: 'claude', state: 'ready' });
  await worker('seat', { seat: 'claude-k', engine: 'claude', state: 'login' });
  assert.equal((await openCards('claude-k')).length, 1);
  const r = (await board('/api/seats/remove', { seat: 'claude-k' })).body;
  assert.ok(!(await list()).seats.some(s => s.id === 'claude-k'));
  assert.equal((await seat('claude-k')).removing, true);
  assert.match((await board('/api/seats/pause', { seat: 'claude-k' })).body.error, /no such seat/);
  await settle(r.action, 'done', 'Removed.');
  assert.equal((h.db.prepare('select for_seat from jobs where id = ?').get(running.id) as any).for_seat, null);
  assert.equal(await seat('claude-k'), undefined);
  assert.equal((await openCards('claude-k')).length, 0);
});

test('a change the worker had taken up when it restarted ends, and says so', async () => {
  const r = (await board('/api/seats/sign-in', { seat: 'claude-1' })).body;
  await settle(r.action, 'working');
  await worker('signin', { seat: 'claude-1', status: 'open', url: 'https://claude.ai/oauth/y', asks: 'code' });
  await worker('seats', { seats: [] });
  const row = await seat('claude-1');
  assert.deepEqual([row.action.status, row.signin.status], ['failed', 'failed']);
  assert.match(row.action.words, /restarted/);
  assert.equal(row.signin.url, undefined);
});

test("a seat's stop level: the board's, from 50% to 99%, listed with the worker's default until it's set", async () => {
  assert.equal((await seat('claude-1')).stop, 90);
  assert.equal((await list()).seats.find(s => s.id === 'claude-1').stop, null);
  for (const stop of [49, 100, 85.5, '85', null])
    assert.equal(
      (await board('/api/seats/stop', { seat: 'claude-1', stop })).body.error,
      'Pick a level from 50% to 99%.',
    );
  assert.equal((await board('/api/seats/stop', { seat: 'claude-x', stop: 80 })).body.error, "There's no such seat.");
  const first = (await board('/api/seats/stop', { seat: 'claude-1', stop: 80 })).body;
  const r = (await board('/api/seats/stop', { seat: 'claude-1', stop: 85 })).body;
  assert.deepEqual(Object.keys(r), ['ok', 'action']);
  assert.equal((await seat('claude-1')).stop, 85);
  const l = await list();
  assert.equal(l.seats.find(s => s.id === 'claude-1').stop, 85);
  assert.deepEqual(
    l.actions.filter(a => a.what === 'stop').map(a => [a.id, a.seat]),
    [[r.action, 'claude-1']],
  );
  assert.equal(
    h.db.prepare('select words from seat_actions where id = ?').get(first.action)!.words,
    'Replaced by your next change.',
  );
  await settle(r.action, 'done', 'Stops at 85% of its limits now.');
  assert.deepEqual([(await seat('claude-1')).action.what, (await seat('claude-1')).action.status], ['stop', 'done']);
});

test("a SEATS level fills in a stop the board hasn't set, at every start, and never over the board's", async () => {
  await worker('seats', { seats: ['claude-1:claude:95', { id: 'codex-1', engine: 'codex', stop: 70 }] });
  assert.equal((await seat('claude-1')).stop, 85); // (the board's stays)
  assert.equal((await seat('codex-1')).stop, 70);
  await worker('seats', { seats: [{ id: 'codex-1', engine: 'codex', stop: 95 }] });
  assert.equal((await seat('codex-1')).stop, 70);
  assert.equal((await list()).seats.find(s => s.id === 'codex-1').stop, 70);
  h.db.prepare("update seat_list set stop = null where id = 'codex-1'").run();
  await worker('seats', { seats: ['codex-1:codex:40', { id: 'codex-1', engine: 'codex', stop: 'x' }] });
  assert.equal((await seat('codex-1')).stop, 90); // (out of range or not a number: none taken)
});

test('pacing: on until the board turns it off, for every seat, and a waiting change gives way to the next', async () => {
  const shown = async () => (await board('/api/seats/providers')).body.pacing;
  assert.deepEqual(await shown(), { on: true, action: null });
  assert.equal((await list()).pacing, true);
  assert.equal((await board('/api/seats/pacing', { on: 'off' })).body.error, 'Say whether pacing is on or off.');
  const off = (await board('/api/seats/pacing', { on: false })).body;
  assert.equal((await list()).pacing, false);
  assert.deepEqual(
    [(await shown()).on, (await shown()).action.id, (await shown()).action.status],
    [false, off.action, 'waiting'],
  );
  const on = (await board('/api/seats/pacing', { on: true })).body;
  const l = await list();
  assert.equal(l.pacing, true);
  assert.deepEqual(
    l.actions.filter(a => a.what === 'pacing').map(a => [a.id, a.seat]),
    [[on.action, null]],
  );
  assert.equal(h.db.prepare('select status from seat_actions where id = ?').get(off.action)!.status, 'failed');
  // (a seat's change of the same kind stays: only pacing's own give way)
  const stop = (await board('/api/seats/stop', { seat: 'codex-1', stop: 75 })).body;
  await board('/api/seats/pacing', { on: false });
  assert.equal(h.db.prepare('select status from seat_actions where id = ?').get(stop.action)!.status, 'waiting');
  await settle(stop.action, 'done', 'Stops at 75% of its limits now.');
  for (const a of (await list()).actions.filter(a => a.what === 'pacing')) await settle(a.id, 'done', 'Pacing is off.');
  assert.deepEqual(
    [(await shown()).on, (await shown()).action.status, (await shown()).action.words],
    [false, 'done', 'Pacing is off.'],
  );
  await board('/api/seats/pacing', { on: true });
  for (const a of (await list()).actions.filter(a => a.what === 'pacing')) await settle(a.id, 'done', 'Pacing is on.');
  assert.deepEqual([(await shown()).on, (await shown()).action.words], [true, 'Pacing is on.']);
});

test('a paced seat reaches HQ as the worker last reported it, and stops being one with the next report without it', async () => {
  await worker('seat', { seat: 'claude-1', engine: 'claude', state: 'ready', week: 0.8, pace: true });
  assert.equal((await seat('claude-1')).pace, 1);
  await worker('seat', { seat: 'claude-1', engine: 'claude', state: 'ready', week: 0.8, pace: 2 });
  assert.equal((await seat('claude-1')).pace, null, 'paced or not, nothing else');
  await worker('seat', { seat: 'claude-1', engine: 'claude', state: 'ready', week: 0.8, pace: true });
  await worker('seat', { seat: 'claude-1', engine: 'claude', state: 'ready', week: 0.8 });
  assert.equal((await seat('claude-1')).pace, null);
});
