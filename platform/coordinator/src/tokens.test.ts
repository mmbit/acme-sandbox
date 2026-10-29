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
async function ran(
  job: { engine: string; kind?: string; pr?: number },
  runs: { seat: string; usage: Record<string, unknown> }[],
) {
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

test("the Numbers home's Tokens tile: both engines' tokens per kind of job and seat, Claude's cost, the opening context and resumes", async () => {
  const claude = (cost: number, opening: number, resumed = false) => ({
    models: { 'claude-opus': tokens(100, cost) },
    cost,
    resumed,
    opening,
    openingWritten: opening / 2,
    turns: 1,
  });
  await ran({ engine: 'claude' }, [
    { seat: 'claude-1', usage: claude(2, 4_000) },
    { seat: 'claude-2', usage: { ...claude(3, 6_000, true), models: { 'claude-opus': tokens(200, 5) }, cost: 5 } },
  ]);
  await ran({ engine: 'claude', pr: 9 }, [{ seat: 'claude-1', usage: claude(1, 2_000) }]);
  await ran({ engine: 'codex', kind: 'review' }, [
    { seat: 'codex-1', usage: { resumed: false, models: { 'gpt-5.5': tokens(10_000) } } },
  ]);

  const home = await (await fetch(`${h.base}/api/numbers?days=7`, board)).json();
  const d = home.dashboards.find((x: any) => x.id === 'tokens');
  // (a run's tokens: all it read and wrote, 112 per 1 of tokens(): Claude's 100-token runs 11,200 each (the resumed
  // one's 200 a running total, 100 of them its own), Codex's 1,120,000; both engines in that one unit)
  assert.deepEqual(
    d.figures.map((f: any) => [f.label, f.value, f.unit]),
    [
      ['Claude', 33_600, 'tokens'],
      ['Codex', 1_120_000, 'tokens'],
      ['Claude at API prices', 6, 'USD'],
      ['Context a run opens with', 4_000, 'tokens'],
    ],
  );
  // (a share's figure, whatever the words around it)
  const share = (text: string) => Number(text.match(/(\d+)%/)?.[1]);
  assert.equal(share(d.figures[1].sub), 97);
  assert.match(d.tile, /\b34 k\b.*\b1\.12 M\b/);
  const bars = Object.fromEntries(d.bars.map((b: any) => [b.title, b.rows.map((r: any) => [r.label, r.value])]));
  assert.deepEqual(bars['Claude per kind of job'], [
    ['Work', 22_400],
    ['Fixes after review', 11_200],
  ]);
  assert.deepEqual(bars['Codex per kind of job'], [['Review', 1_120_000]]);
  assert.deepEqual(bars['Tokens per seat'], [
    ['codex-1', 1_120_000],
    ['claude-1', 22_400],
    ['claude-2', 11_200],
  ]);
  // the opening read again on its one turn, as a share of what the runs read (111 per 1 of tokens(): 11,100 a run): the
  // work's 4k and 6k of 22,200 (and a median of 5k), the fix's 2k of 11,100, all Claude's 12k of 33,300
  assert.equal(share(d.figures[3].sub), 36);
  assert.deepEqual(
    bars['Opening context per kind of job'].map(([label, v]: [string, number]) => [
      label.split(' · ')[0],
      share(label),
      v,
    ]),
    [
      ['Work', 45, 5_000],
      ['Fixes after review', 18, 2_000],
    ],
  );
  assert.deepEqual(
    bars['Resumed runs per kind of job'].map(([label, v]: [string, number]) => [label.split(' · ')[0], v]),
    [['Work', 3]],
  );
  const today = d.daily.rows.at(-1);
  assert.deepEqual(
    [d.daily.rows.length, today.day, today.tokens, today.claude, today.codex, today.cost],
    [7, home.to, 1_153_600, 33_600, 1_120_000, 6],
  );
  assert.match(
    (await h.hq(await h.start({ agent: 'wren' }), 'numbers')).out,
    /\nTokens \(tokens\): .*\n {2}Claude: 33600 tokens/,
    'hq numbers prints it',
  );
});
