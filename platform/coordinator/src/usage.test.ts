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

// A fix round, a touch-up check and the board's notes go on in the author's last session on the branch (the worker's
// carry.ts): the same session, its running totals restored, in a new job.
const carried = async (session: string, totals: number[], seat = 'claude-1', engine?: string) => {
  const jobs: number[] = [];
  for (const input of totals) {
    const id = await running(seat, engine);
    await finish(id, { status: 'done', session, usage: { models: { [SONNET]: t(input, input / 1000) }, cost: input / 1000, resumed: jobs.length > 0 } });
    jobs.push(id);
  }
  return jobs;
};

test("build, fix and merge in one carried session: each job is stored as what its run added", async () => {
  const jobs = await carried('s5', [1000, 1300, 1350]);
  assert.deepEqual(jobs.map(j => rows(j).map(r => [r.input, r.cache_read, r.cost])),
    [[[1000, 10000, 1]], [[300, 3000, 0.3]], [[50, 500, 0.05]]]);
});

test('Codex: a session carried on the same seat is stored the same way', async () => {
  const jobs = await carried('c2', [700, 900], 'codex-1', 'codex');
  assert.deepEqual(jobs.map(j => rows(j).map(r => r.input)), [[700], [200]]);
});

test('a carried session that started over is stored whole', async () => {
  const jobs = await carried('s6', [1000, 400]);
  assert.deepEqual(jobs.map(j => rows(j).map(r => r.input)), [[1000], [400]]);
});

test('stored rows that hold a carried session whole: each becomes what its run added, and nothing else changes', async () => {
  const { rebaseCarried } = await import('./usage.ts');
  // a carried job's first run whole (reported as not resumed), its later runs against its own report
  const report = async (job: number, session: string, input: number, resumed: boolean, status = 'done') =>
    finish(job, { status, session, usage: { models: { [SONNET]: t(input, input / 1000) }, cost: input / 1000, resumed } });
  const build = await running(), fix = await running(), over = await running(), other = await running();
  await report(build, 'old-a', 1000, false);
  await report(fix, 'old-a', 1200, false, 'limited');   // carried: stored whole
  await again(fix);
  await report(fix, 'old-a', 1500, true);   // the fix's own resume, against its own report
  await report(over, 'old-a', 200, false);   // carried, but started over
  await report(other, 'old-b', 5000, false);
  assert.deepEqual([build, fix, over].map(j => rows(j).map(r => r.input)), [[1000], [1200, 300], [200]]);
  const before = rows(other);
  const stored = () => [build, fix, over].map(j => rows(j).map(r => [r.input, r.cache_read, r.cost]));
  rebaseCarried();
  const after = stored();
  assert.deepEqual(after, [[[1000, 10000, 1]], [[200, 2000, 0.2], [300, 3000, 0.3]], [[200, 2000, 0.2]]]);
  rebaseCarried();   // once more: the same figures
  assert.deepEqual(stored(), after);
  assert.deepEqual(rows(other), before);
});

test("a run's up-front context, its turns and, resumed, how long its session sat idle", async () => {
  const id = await running();
  const main = { opening: 52_003, openingWritten: 40_000, turns: 12 };
  await finish(id, { status: 'limited', session: 's7', usage: { models: { [SONNET]: t(1000, 0.5) }, cost: 0.5, resumed: false, ...main } });
  await new Promise(resolve => setTimeout(resolve, 60));
  await again(id);
  await finish(id, { status: 'done', session: 's7', usage: { models: { [SONNET]: t(1500, 0.7) }, cost: 0.7, resumed: true,
    opening: 61_000, openingWritten: 61_000, turns: 3 } });
  const stored = h.db.prepare('select opening, opening_written, turns, resumed, idle_ms from usage where job = ? order by id').all(id)
    .map(r => ({ ...r }));
  assert.deepEqual(stored[0], { opening: 52_003, opening_written: 40_000, turns: 12, resumed: 0, idle_ms: null });
  assert.deepEqual({ ...stored[1], idle_ms: undefined }, { opening: 61_000, opening_written: 61_000, turns: 3, resumed: 1, idle_ms: undefined });
  assert.ok((stored[1].idle_ms as number) >= 60, `idle ${stored[1].idle_ms} ms`);
});

test('a run the worker measured no main thread for (Codex) keeps those empty', async () => {
  const id = await running('codex-1', 'codex');
  await finish(id, { status: 'done', session: 'c3', usage: { resumed: false, opening: 'lots', turns: -1,
    models: { 'gpt-5.5': { input: 700, cacheWrite: 0, cacheRead: 300, output: 50 } } } });
  assert.deepEqual({ ...h.db.prepare('select opening, opening_written, turns from usage where job = ?').get(id) },
    { opening: null, opening_written: null, turns: null });
});
