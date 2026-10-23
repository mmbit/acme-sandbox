// node --test src/models.test.ts   (each agent's main model and fallback, picked by the board: the test company)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { completeTriage } from './reviewfixture.ts';
import { harness } from './harness.ts';

const h = await harness('models', {
  before: repo =>
    appendFileSync(
      `${repo}/company/models.yaml`,
      `choices:
  anthropic: { claude-opus-5-5: Opus 5.5, claude-sonnet-5-5: Sonnet 5.5 }
  openai: { gpt-6.1-sol: GPT-6.1 Sol }
  mistral: { mistral-medium-3.5: Mistral Medium 3.5 }
  nowhere: { x-1: Not a provider }
`,
    ),
});
const { worker, board } = h;
const pick = (agent: string, main: string | null, fallback: string | null = null) =>
  board('/api/agents/model', { agent, main, fallback });
const shown = async () => (await board('/api/agents/models')).body;
const jobOf = (id: number) => ({
  ...(h.db.prepare('select engine, cli, for_seat from jobs where id = ?').get(id) as any),
});
const report = (seat: string, engine: string, state: string) =>
  worker('seat', { seat, engine, state, until: state === 'ready' ? undefined : Date.now() + 3_600_000 });
const clear = () => h.db.prepare("update jobs set status = 'cancelled' where status in ('queued', 'running')").run();

await worker('seats', { seats: ['claude-1:claude', 'codex-1:codex'] });
await report('claude-1', 'claude', 'ready');
await report('codex-1', 'codex', 'ready');

test("the list: the company's models with the providers the board has seats at, and each agent's model as it stands", async () => {
  const r = await shown();
  assert.deepEqual(
    r.choices.map((c: any) => [c.id, c.name, c.engine, c.cli, c.seated]),
    [
      ['claude-opus-5-5', 'Opus 5.5', 'claude', 'claude', true],
      ['claude-sonnet-5-5', 'Sonnet 5.5', 'claude', 'claude', true],
      ['gpt-6.1-sol', 'GPT-6.1 Sol', 'codex', 'codex', true],
      ['mistral-medium-3.5', 'Mistral Medium 3.5', 'codex', 'vibe', false],
    ],
  );
  // the files' model where the board picked none; an agent off the seats (Poppy's care runs on its own key) has none
  assert.deepEqual(r.models.juno, { main: 'claude-opus-5-5', picked: false, fallback: null, engine: null });
  assert.deepEqual(r.models.rook, { main: 'claude-sonnet-5-5', picked: false, fallback: null, engine: 'claude' });
  assert.equal(r.models.poppy, undefined);
});

test('a pick: refused for no such agent or model, or a fallback on the main model’s own seats', async () => {
  assert.match((await pick('nobody', 'claude-opus-5-5')).body.error, /no such agent/);
  assert.match((await pick('poppy', 'claude-opus-5-5')).body.error, /no such agent/);
  assert.match((await pick('wren', 'gpt-9')).body.error, /isn't on the list/);
  assert.match((await pick('wren', null, 'claude-sonnet-5-5')).body.error, /another provider/);
  assert.match((await pick('wren', 'gpt-6.1-sol', 'gpt-6.1-sol')).body.error, /another provider/);
  assert.deepEqual((await shown()).models.wren, {
    main: 'claude-opus-5-5',
    picked: false,
    fallback: null,
    engine: null,
  });
});

test("the main model: the agent's work runs on it, queued work that hasn't started moves with it, and its org row says so", async () => {
  clear();
  const queued = h.jobs.createJob({ agent: 'kit', title: 'Queued before', prompt: 'x' });
  assert.equal((await pick('kit', 'gpt-6.1-sol')).status, 200);
  assert.deepEqual(jobOf(queued.id), { engine: 'codex', cli: 'codex', for_seat: null });
  const made = h.jobs.createJob({ agent: 'kit', title: 'Made after', prompt: 'x' });
  assert.deepEqual([jobOf(made.id).engine, jobOf(made.id).cli], ['codex', 'codex']);
  assert.equal((await worker('claim', { seat: 'claude-1', engine: 'claude' })).body, null);
  const ran = (await worker('claim', { seat: 'codex-1', engine: 'codex' })).body;
  assert.deepEqual([ran.id, ran.agentInfo.model, ran.agentInfo.effort], [queued.id, 'gpt-6.1-sol', 'high']);
  const kit = (await board('/api/org')).body.departments.flatMap((d: any) => d.agents).find((a: any) => a.id === 'kit');
  assert.equal(kit.engine, 'codex');
  // back on the files' engine, with a model of the same engine: Sonnet wins over the scheduled entry's model
  assert.equal((await pick('kit', 'claude-sonnet-5-5')).status, 200);
  const scheduled = h.jobs.createJob({ agent: 'kit', title: 'Scheduled', prompt: 'x', model: 'claude-haiku-4-5' });
  const next = (await worker('claim', { seat: 'claude-1', engine: 'claude' })).body;
  assert.deepEqual([next.id, next.agentInfo.model], [made.id, 'claude-sonnet-5-5']);
  assert.equal((await worker('claim', { seat: 'claude-1', engine: 'claude' })).body.id, scheduled.id);
  await pick('kit', null);
  assert.deepEqual((await shown()).models.kit, {
    main: 'claude-opus-5-5',
    picked: false,
    fallback: null,
    engine: null,
  });
  clear();
});

test('the fallback: work moves there only while its own seats are out or at their limit, and stays once it ran there', async () => {
  clear();
  assert.equal((await pick('vera', null, 'gpt-6.1-sol')).status, 200);
  assert.deepEqual((await shown()).models.vera, {
    main: 'claude-opus-5-5',
    picked: false,
    fallback: 'gpt-6.1-sol',
    engine: null,
  });
  const work = h.jobs.createJob({ agent: 'vera', title: 'Compliance check', prompt: 'x' });
  const none = h.jobs.createJob({ agent: 'penny', title: 'No fallback', prompt: 'x' });
  const review = h.jobs.createJob({ agent: 'vera', kind: 'review', title: 'A review', prompt: 'x', pr: 1, round: 1 });
  try {
    assert.equal((await worker('claim', { seat: 'codex-1', engine: 'codex' })).body, null, 'Claude has a seat ready');
    await report('claude-1', 'claude', 'sleeping');
    const ran = (await worker('claim', { seat: 'codex-1', engine: 'codex' })).body;
    assert.deepEqual(
      [ran.id, ran.engine, ran.agentInfo.model, ran.agentInfo.effort],
      [work.id, 'codex', 'gpt-6.1-sol', 'high'],
    );
    assert.deepEqual(jobOf(work.id), { engine: 'codex', cli: 'codex', for_seat: 'codex-1' });
    // no fallback, or a review (its panel keeps its mix): it waits for its own seats
    assert.equal((await worker('claim', { seat: 'codex-1', engine: 'codex' })).body, null);
    // past its stop level counts as short too
    await report('claude-1', 'claude', 'draining');
    const again = h.jobs.createJob({ agent: 'vera', title: 'Another', prompt: 'x' });
    assert.equal((await worker('claim', { seat: 'codex-1', engine: 'codex' })).body.id, again.id);
    await report('claude-1', 'claude', 'ready');
    assert.deepEqual(
      [none, review].map(j => jobOf(j.id).engine),
      ['claude', 'claude'],
    );
  } finally {
    clear();
    await report('claude-1', 'claude', 'ready');
    await pick('vera', null);
  }
});

test("a Codex agent's fallback: its job leaves its own Codex seat once that seat is out", async () => {
  clear();
  assert.equal((await pick('nib', null, 'claude-sonnet-5-5')).status, 200);
  const job = h.jobs.createJob({ agent: 'nib', title: 'Codex work', prompt: 'x' });
  try {
    assert.equal(jobOf(job.id).for_seat, 'codex-1');
    assert.equal((await worker('claim', { seat: 'claude-1', engine: 'claude' })).body, null);
    await report('codex-1', 'codex', 'sleeping');
    const ran = (await worker('claim', { seat: 'claude-1', engine: 'claude' })).body;
    assert.deepEqual([ran.id, ran.agentInfo.model, ran.agentInfo.effort], [job.id, 'claude-sonnet-5-5', 'high']);
    assert.deepEqual(jobOf(job.id), { engine: 'claude', cli: 'claude', for_seat: null });
  } finally {
    clear();
    await report('codex-1', 'codex', 'ready');
    await pick('nib', null);
  }
});

test("a job gets its own engine's model, whatever the board's pick is by the time it runs", async () => {
  clear();
  const review = h.jobs.createJob({
    agent: 'quill',
    kind: 'consolidate',
    title: 'A ruling',
    prompt: 'x',
    pr: 2,
    round: 1,
  });
  const codexJob = h.jobs.createJob({ agent: 'nib', title: 'Codex work', prompt: 'x' });
  try {
    assert.equal(jobOf(codexJob.id).cli, null, 'made on its engine, no CLI of its own');
    assert.equal((await pick('quill', 'gpt-6.1-sol')).status, 200);
    assert.equal((await pick('nib', 'gpt-6.1-sol')).status, 200);
    assert.deepEqual(
      jobOf(codexJob.id),
      { engine: 'codex', cli: 'codex', for_seat: null },
      'a job made with no CLI of its own follows the pick',
    );
    const ran = (await worker('claim', { seat: 'claude-1', engine: 'claude' })).body;
    assert.deepEqual(
      [ran.id, ran.agentInfo.model],
      [review.id, 'claude-opus-5-5'],
      'a ruling keeps its Claude route and model',
    );
    // moved to its fallback, then the fallback is cleared while the job waits to run again
    clear();
    await pick('quill', null);
    await pick('nib', null);
    await pick('vera', null, 'gpt-6.1-sol');
    const work = h.jobs.createJob({ agent: 'vera', title: 'Compliance check', prompt: 'x' });
    await report('claude-1', 'claude', 'sleeping');
    assert.equal((await worker('claim', { seat: 'codex-1', engine: 'codex' })).body.id, work.id);
    h.db.prepare("update jobs set status = 'queued', seat = null, session = 'saved' where id = ?").run(work.id);
    await pick('vera', null);
    const again = (await worker('claim', { seat: 'codex-1', engine: 'codex' })).body;
    // (the test company's Codex model is null: Codex's own default)
    assert.deepEqual([again.id, again.engine, again.agentInfo.model], [work.id, 'codex', null]);
  } finally {
    clear();
    await report('claude-1', 'claude', 'ready');
    for (const a of ['quill', 'nib', 'vera']) await pick(a, null);
  }
});

test("a selected reviewer's main model stays on its assigned engine", async () => {
  clear();
  const review = await import('./review.ts');
  try {
    assert.match((await pick('rook', 'gpt-6.1-sol')).body.error, /review panel's Claude reviewers/);
    assert.match((await pick('nib', 'claude-sonnet-5-5')).body.error, /review panel's Codex reviewers/);
    assert.equal(
      (await pick('flint', 'gpt-6.1-sol', 'claude-sonnet-5-5')).status,
      200,
      'its own engine, and any fallback',
    );
    assert.deepEqual((await shown()).models.rook, {
      main: 'claude-sonnet-5-5',
      picked: false,
      fallback: null,
      engine: 'claude',
    });
    // a pick made before the agent joined the panel counts as none
    h.db
      .prepare(
        "insert or replace into agent_models (agent, main, fallback, at) values ('tally', 'gpt-6.1-sol', null, '')",
      )
      .run();
    review.startReview(9001, 'job/9001', 'bolt', ['platform/coordinator/src/review.ts'], 'a'.repeat(40));
    await completeTriage(h, 9001, ['rook', 'tally', 'nib', 'flint']);
    const panel = h.db
      .prepare("select agent, engine from jobs where pr = 9001 and kind = 'review' order by agent")
      .all();
    assert.deepEqual(
      panel.map((j: any) => [j.agent, j.engine]),
      [
        ['flint', 'codex'],
        ['nib', 'codex'],
        ['rook', 'claude'],
        ['tally', 'claude'],
      ],
    );
  } finally {
    clear();
    for (const a of ['flint', 'tally']) await pick(a, null);
  }
});
