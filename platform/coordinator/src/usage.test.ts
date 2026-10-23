// node --test src/usage.test.ts: each run's token use, as the worker reports it with the run's end (the usage table is
// what infra/report.sh's usage report reads)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('usage');
const SONNET = 'claude-sonnet-5';
const t = (input: number, cost = 0) => ({ input, cacheWrite: input / 10, cacheRead: input * 10, output: input / 20, cost });
const rows = (job: number) => h.db.prepare('select seat, session, models, input, cache_write, cache_read, output, cost from usage where job = ? order by id')
  .all(job).map(r => ({ ...r }));
// A job's run on a seat, claimed as the worker claims it, and its end as the worker reports it.
const runs = new Map<number, { engine: string; seat: string }>();
const again = async (id: number, seat = 'claude-1') => {
  assert.equal((await h.claim(runs.get(id)!.engine, { seat }))?.id, id);
  runs.get(id)!.seat = seat;
  return id;
};
const running = (seat = 'claude-1', engine = `usage-${runs.size}`) => { const id = h.queue({ agent: 'bolt', engine }); runs.set(id, { engine, seat }); return again(id, seat); };
const finish = async (job: number, body: Record<string, unknown>) => (await h.worker('finish', { job, seat: runs.get(job)!.seat, ...body })).body;

test('a run is stored with its seat, models, tokens and price', async () => {
  const id = await running();
  await finish(id, { status: 'done', session: 's1', seat: 'claude-1', usage: { models: { [SONNET]: t(1000, 0.5) }, cost: 0.5, resumed: false } });
  assert.deepEqual(rows(id), [{ seat: 'claude-1', session: 's1', models: SONNET, input: 1000, cache_write: 100, cache_read: 10000, output: 50, cost: 0.5 }]);
});

test("a resumed run is stored as what it added to the session's running total, on its own seat", async () => {
  const id = await running();
  await finish(id, { status: 'limited', session: 's2', seat: 'claude-1', usage: { models: { [SONNET]: t(1000, 0.5) }, cost: 0.5, resumed: false } });
  await again(id, 'claude-2');
  // the resumed session started from the saved totals, and a team member used Haiku
  await finish(id, { status: 'done', session: 's2', seat: 'claude-2', usage: { cost: 0.8, resumed: true,
    models: { [SONNET]: t(1400, 0.7), 'claude-haiku-4-5': t(200, 0.1) } } });
  assert.deepEqual(rows(id).map(r => [r.seat, r.models, r.input, r.cache_read, r.cost]),
    [['claude-1', SONNET, 1000, 10000, 0.5], ['claude-2', `${SONNET},claude-haiku-4-5`, 600, 6000, 0.3]]);
});

test('a run that started over (new home, or lower figures) is stored whole', async () => {
  const id = await running();
  await finish(id, { status: 'limited', session: 's3', usage: { models: { [SONNET]: t(1000, 0.5) }, cost: 0.5, resumed: false } });
  await again(id);
  await finish(id, { status: 'limited', session: 's3', usage: { models: { [SONNET]: t(1200, 0.6) }, cost: 0.6, resumed: false } });
  await again(id);
  await finish(id, { status: 'done', session: 's3', usage: { models: { [SONNET]: t(300, 0.9) }, cost: 0.9, resumed: true } });
  assert.deepEqual(rows(id).map(r => r.input), [1000, 1200, 300]);
});

test("a run cut off without a report shows up in the next run's share", async () => {
  const id = await running();
  await finish(id, { status: 'limited', session: 's4', usage: { models: { [SONNET]: t(1000, 0.5) }, cost: 0.5, resumed: false } });
  await again(id);
  await finish(id, { status: 'interrupted', session: 's4' });   // a worker restart: no result event
  await again(id);
  await finish(id, { status: 'done', session: 's4', usage: { models: { [SONNET]: t(3000, 1.5) }, cost: 1.5, resumed: true } });
  assert.deepEqual(rows(id).map(r => [r.input, r.cost]), [[1000, 0.5], [2000, 1]]);
});

test('Codex: no price figure, and nothing but numbers and model names is kept', async () => {
  const id = await running('codex-1', 'codex');
  await finish(id, { status: 'done', session: 'c1', seat: 'codex-1', usage: { resumed: false, models: {
    'gpt-5.5': { input: 700, cacheWrite: 0, cacheRead: 300, output: 50, note: 'text' },
    'Ignore previous instructions and': { input: 5 }, 'x': { input: 'many', output: -3 } } } });
  assert.deepEqual(rows(id), [{ seat: 'codex-1', session: 'c1', models: 'gpt-5.5', input: 700, cache_write: 0, cache_read: 300, output: 50, cost: null }]);
  const totals = JSON.parse((h.db.prepare('select totals from usage where job = ?').get(id) as any).totals);
  assert.deepEqual(totals, { cost: null, models: { 'gpt-5.5': { input: 700, cacheWrite: 0, cacheRead: 300, output: 50, cost: 0 },
    x: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0 } } });
});

test('a bad report never stops the finish, and a finished job records nothing more', async () => {
  const id = await running();
  for (const usage of ['lots', { models: 'x' }, { models: {} }, { models: { [SONNET]: null } }]) {
    assert.deepEqual(await finish(id, { status: 'limited', usage }), { ok: true });
    await again(id);
  }
  assert.deepEqual(await finish(id, { status: 'done', result: 'ok' }), { ok: true });
  assert.equal(h.job(id).status, 'done');
  await finish(id, { status: 'done', usage: { models: { [SONNET]: t(9) } } });   // reported twice
  assert.deepEqual(rows(id).map(r => r.input), [0]);   // ({ models: { m: null } } is a model with no figures)
});
