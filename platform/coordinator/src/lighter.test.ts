// node --test src/lighter.test.ts   (A small, fully specified job its queuer puts
// on a lighter model (hq job --model): only for an agent on the Claude engine on its engine's own model, run on the
// lighter one with the hand-up in its briefing; a run that finds it bigger hands it up (hq up), and the same job goes on
// at once on the agent's own model, in a new session in its kept clone, counted and in the job's history.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from './harness.ts';

const OPUS = 'claude-opus-5-5',
  SONNET = 'claude-sonnet-5-5';
const h = await harness('lighter', {
  serve: true,
  before: repo => {
    writeFileSync(
      `${repo}/company/models.yaml`,
      `claude: { model: ${OPUS}, effort: high, lighter: [${SONNET}] }\ncodex: { model: null, effort: high }\n` +
        `choices:\n  anthropic: { ${OPUS}: Opus 5.5, ${SONNET}: Sonnet 5.5 }\n`,
    );
    appendFileSync(
      `${repo}/company/org.yaml`,
      `\nengineOnly:\n  - { id: pixels, what: pixel work, engine: claude, model: ${OPUS}, paths: ["platform/hq/renderers/**"] }\n`,
    );
  },
});
const { db } = h;
const models = await import('./models.ts');
const brief = join(mkdtempSync(join(tmpdir(), 'lighter-')), 'brief.md');
writeFileSync(brief, 'Change the button label to "Order yours".\n');

type Row = { model: string | null; light: number; up: string | null; session: string | null; status: string };
const row = (id: number) =>
  db.prepare('select model, light, up, session, status from jobs where id = ?').get(id) as Row;
const queued = (out: string) => Number(/Queued job #(\d+)/.exec(out)?.[1]);
let codes = 0;
const queue = async (lead: Parameters<typeof h.hq>[0], agent: string, ...flags: string[]) =>
  h.hq(lead, 'job', agent, 'Change the label', brief, '--code', `LABEL${'ABCDEFGHIJ'[codes++]}`, '--new', ...flags);

test('hq job --model queues a lighter model for a Claude agent on its own; anything else is refused with why', async () => {
  const lead = await h.start({ agent: 'bolt' });
  const light = await queue(lead, 'wren', '--model', 'sonnet');
  assert.equal(light.code, 0, light.out);
  assert.match(
    light.out,
    /It runs on Sonnet 5\.5, and hands itself up to wren's own model if it's bigger than it looks\./,
  );
  assert.deepEqual(
    { model: row(queued(light.out)).model, light: row(queued(light.out)).light },
    { model: SONNET, light: 1 },
  );
  const byId = await queue(lead, 'moss', '--model', SONNET);
  assert.equal(row(queued(byId.out)).model, SONNET, byId.out);

  const refusals: [string[], RegExp][] = [
    [
      ['nib', '--model', 'sonnet'],
      /--model takes a lighter model models\.yaml lists for Nib's engine, and codex lists none/,
    ],
    [['wren', '--model', 'opus'], /Opus 5\.5 is Wren's own model: queue it without --model/],
    [
      ['wren', '--model', 'haiku'],
      /--model takes a lighter model models\.yaml lists for claude: claude-sonnet-5-5 \(Sonnet 5\.5\)/,
    ],
    [['wren', '--model', 'sonnet', '--only', 'pixels'], /queue it without --model/],
  ];
  for (const [args, why] of refusals) {
    const before = (db.prepare('select max(id) n from jobs').get() as { n: number }).n;
    const refused = await queue(lead, ...(args as [string, ...string[]]));
    assert.notEqual(refused.code, 0, refused.out);
    assert.match(refused.out, /No job was queued/);
    assert.match(refused.out, why);
    assert.equal((db.prepare('select max(id) n from jobs').get() as { n: number }).n, before, 'nothing queued');
  }
  // an agent the board put on the lighter model already takes none
  assert.deepEqual(models.setAgentModels('wren', SONNET, null), { ok: true });
  try {
    const already = await queue(lead, 'wren', '--model', 'sonnet');
    assert.match(already.out, /Wren runs on Sonnet 5\.5 already, not claude's own model/);
  } finally {
    models.setAgentModels('wren', null, null);
  }
  await h.finish(lead);
  h.cancelQueued();
});

test("a light run is told it's on the lighter model and how to hand up; its hand-up requeues the same job on the agent's own model, in a new session", async () => {
  const lead = await h.start({ agent: 'bolt' });
  const id = queued((await queue(lead, 'wren', '--model', 'sonnet')).out);
  await h.finish(lead);
  const light = (await h.claim('claude')) as any;
  assert.equal(light?.id, id);
  assert.equal(light.agentInfo.model, SONNET);
  assert.deepEqual(light.lighter, { name: 'Sonnet 5.5', own: 'Opus 5.5' });
  assert.equal(light.handedUp, undefined);
  assert.deepEqual(
    light.company.lighter,
    [{ id: SONNET, name: 'Sonnet 5.5' }],
    'every briefing names the lighter model',
  );

  const note = 'The label comes from the shared button kit, not the page: three products use it.';
  assert.equal(
    (await h.finish(light, { status: 'up', session: 'sonnet-session', branch: `job/${id}`, up: note })).status,
    200,
  );
  const after = row(id);
  assert.equal(after.status, 'queued');
  assert.equal(after.model, null, "on its agent's own model now");
  assert.equal(after.light, 0);
  assert.equal(after.session, null, 'a new session: the lighter model can only resume its own');
  assert.equal(JSON.parse(after.up!).note, note);
  const runs = db.prepare('select ended_as from runs where job = ? order by id').all(id) as { ended_as: string }[];
  assert.deepEqual(
    runs.map(r => r.ended_as),
    ['up'],
    'the hand-up is counted',
  );

  const own = (await h.claim('claude')) as any;
  assert.equal(own?.id, id, 'the same job, at once');
  assert.equal(own.agentInfo.model, OPUS);
  assert.equal(own.lighter, undefined);
  assert.deepEqual(own.handedUp, { from: 'Sonnet 5.5', note });
  assert.equal(own.branch ?? `job/${id}`, `job/${id}`);
  // a run of its own goes on in its own session after that
  await h.finish(own, { status: 'interrupted', session: 'opus-session' });
  const resumed = (await h.claim('claude')) as any;
  assert.equal(resumed?.id, id);
  assert.equal(resumed.session, 'opus-session');
  assert.equal(resumed.handedUp, undefined);
  await h.finish(resumed, { status: 'done', session: 'opus-session' });

  // the job's history shows it
  const reader = await h.start({ agent: 'wren' });
  const history = await h.hq(reader, 'history', `#${id}`);
  assert.match(
    history.out,
    new RegExp(`#${id} .*\\nHanded up from Sonnet 5\\.5, bigger than it looked: ${note}`),
    history.out,
  );
});

test("a hand-up from a run on its agent's own model has nowhere to go: the run failed", async () => {
  const run = await h.start({ agent: 'wren', engine: 'claude' });
  await h.finish(run, { status: 'up', up: 'Bigger.' });
  const ended = row(run.id);
  assert.equal(ended.status, 'failed');
  assert.equal(ended.up, null);
});
