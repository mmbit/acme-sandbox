// node --test src/tokens.test.ts   (uses a throwaway DATA_DIR): Numbers' Tokens dashboard, live from the runs' usage
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('tokens');
const board = { headers: { cookie: h.boardCookie } };
const tokens = (n: number, cost?: number) => ({
  input: n,
  cacheWrite: n * 10,
  cacheRead: n * 100,
  output: n,
  ...(cost === undefined ? {} : { cost }),
});

// A job's runs on a seat, each finished with the usage the worker measured.
async function ran(job: { engine: string; kind?: string }, runs: { seat: string; usage: Record<string, unknown> }[]) {
  const id = h.queue({ agent: 'bolt', ...job });
  for (const [i, run] of runs.entries()) {
    assert.equal((await h.claim(job.engine, { seat: run.seat }))?.id, id);
    await h.worker('finish', {
      job: id,
      seat: run.seat,
      session: `s${id}`,
      status: i < runs.length - 1 ? 'limited' : 'done',
      usage: run.usage,
    });
  }
}

test("the Numbers home's Tokens tile: Claude's cost per kind of job and seat, Codex's tokens, the up-front context and resumes", async () => {
  const claude = (cost: number, opening: number, resumed = false) => ({
    models: { 'claude-opus': tokens(100, cost) },
    cost,
    resumed,
    opening,
    openingWritten: opening / 2,
    turns: 10,
  });
  await ran({ engine: 'claude' }, [
    { seat: 'claude-1', usage: claude(2, 40_000) },
    { seat: 'claude-2', usage: { ...claude(3, 60_000, true), models: { 'claude-opus': tokens(200, 5) }, cost: 5 } },
  ]);
  await ran({ engine: 'claude', kind: 'review' }, [{ seat: 'claude-1', usage: claude(1, 20_000) }]);
  await ran({ engine: 'codex', kind: 'review' }, [
    { seat: 'codex-1', usage: { resumed: false, models: { 'gpt-5.5': tokens(10_000) } } },
  ]);

  const home = await (await fetch(`${h.base}/api/numbers?days=7`, board)).json();
  const d = home.dashboards.find((x: any) => x.id === 'tokens');
  assert.deepEqual(
    d.figures.map((f: any) => [f.label, f.value]),
    [
      ['Claude, at API prices', 6],
      ['Codex tokens', 1],
      ['Up-front context', 40],
      ['Resumed runs', 3],
    ],
  );
  const bars = Object.fromEntries(d.bars.map((b: any) => [b.title, b.rows.map((r: any) => [r.label, r.value])]));
  assert.deepEqual(bars['Claude per kind of job'], [
    ['Work', 5],
    ['Review', 1],
  ]);
  assert.deepEqual(bars['Claude per seat'], [
    ['claude-1', 3],
    ['claude-2', 3],
  ]);
  assert.deepEqual(bars['Codex per kind of job'], [['Review', 1.01]]);
  // the work's runs: 40k and 60k at the start, so a median of 50k
  assert.deepEqual(
    bars['Up-front context per kind of job'].map(([, v]: [string, number]) => v),
    [50, 20],
  );
  assert.equal(bars['Resumed runs per kind of job'].length, 1);
  const today = d.daily.rows.at(-1);
  assert.deepEqual(
    [d.daily.rows.length, today.day, today.cost, today['kind:work'], today['kind:review']],
    [7, home.to, 6, 5, 1],
  );
  assert.match(
    (await h.hq(await h.start({ agent: 'wren' }), 'numbers')).out,
    /\nTokens \(tokens\): .*\n {2}Claude, at API prices: 6 USD/,
    'hq numbers prints it',
  );
});
