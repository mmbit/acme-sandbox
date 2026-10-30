// node --test src/incidents.test.ts
// HQ's calls to the CEO about something broken (incidents.ts): a deploy that broke HQ, from the server's record; work that
// stopped moving after a deploy; the claim that starts one on a slot with no room for other work; and the CEO's reverts,
// made by the server (reverts.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('incidents');
const { db } = h;
const incidents = await import('./incidents.ts');
const wakes = await import('./wakes.ts');
const reverts = await import('./reverts.ts');
type Row = { agent: string; incident: number; expedite: number; status: string; prompt: string };
const row = (id: number) =>
  db.prepare('select agent, incident, expedite, status, prompt from jobs where id = ?').get(id) as Row;
const iso = (ago: number) => new Date(Date.now() - ago).toISOString();

test("a deploy that broke HQ calls the CEO, with what HQ's check said and the revert on main", () => {
  mkdirSync(`${h.dataDir}/deploys`, { recursive: true });
  const [sha, revert] = ['a'.repeat(40), 'b'.repeat(40)];
  writeFileSync(
    `${h.dataDir}/deploys/20261030T100000Z-aaaaaaaaaaaa.json`,
    JSON.stringify({
      sha,
      fetched: iso(60_000),
      finished: iso(0),
      ok: false,
      recreated: [],
      reloaded: [],
      services: [],
      broke: "HQ: wire: page error: SyntaxError: no export named 'tipOf'",
      reverted: revert,
    }),
  );
  wakes.readDeploys();
  const { id } = db.prepare('select id from jobs where incident = 1').get() as { id: number };
  const job = row(id);
  assert.deepEqual([job.agent, job.expedite, job.status], ['juno', 1, 'queued']);
  assert.match(job.prompt, /no export named 'tipOf'/);
  assert.match(job.prompt, /reverted the commits since the last good deploy on main, in bbbbbbbbb/);
  assert.equal(
    (db.prepare('select broke, reverted from deploys where sha = ?').get(sha) as { reverted: string }).reverted,
    revert,
  );
});

test('work that stops moving is an incident only after a deploy, one job a cause', () => {
  assert.equal(
    incidents.stalled('engine:claude', 'Claude has started no job', Date.now()),
    undefined,
    'no deploy came',
  );
  db.prepare("insert into deploys (file, sha, fetched, finished, ok) values ('d.json', ?, ?, ?, 1)").run(
    'c'.repeat(40),
    iso(3600_000),
    iso(3500_000),
  );
  const id = incidents.stalled('engine:claude', 'Claude has started no job', Date.now())!;
  assert.match(row(id).prompt, /Claude has started no job.*A deploy came shortly before/s);
  assert.match(row(id).prompt, /- ccccccccc, finished/);
  assert.match(row(id).prompt, /hq revert <commit>\.\.\. "why"/);
  assert.equal(incidents.stalled('engine:claude', 'still', Date.now()), id, 'the open one, not another');
  const jam = incidents.stalled('jam', 'the worker has been short of memory', Date.now() - 4 * 3600_000, true)!;
  assert.match(row(jam).prompt, /No deploy came in the 3 hours before it/);
});

test("an incident claim takes an incident and nothing else, so a slot with no room for work still starts the CEO's", async () => {
  const other = h.queue({ agent: 'bolt', engine: 'claude' });
  const incidentIds = (db.prepare('select id from jobs where incident = 1').all() as { id: number }[]).map(j => j.id);
  db.prepare('update jobs set engine = ? where incident = 1').run('claude');
  const taken = await h.claim('claude', { kind: 'incident' });
  assert.ok(taken && incidentIds.includes(taken.id), `an incident, not #${other}`);
  h.cancelQueued();
});

test("the CEO's revert goes to the server as a request, and its answer comes back to HQ", () => {
  assert.match(String(reverts.request(['abcdef1'], 'why', 'bolt')), /only the CEO/);
  assert.match(String(reverts.request(['--upload-pack=x'], 'why', 'juno')), /by their ids/);
  const asked = reverts.request(['abcdef1'], 'the deploy stopped the worker', 'juno') as { id: string };
  const file = `${h.dataDir}/reverts/${asked.id}.json`;
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    commits: ['abcdef1'],
    why: 'the deploy stopped the worker',
  });
  assert.equal(reverts.list()[0].said, undefined, 'waiting for the server');
  writeFileSync(`${h.dataDir}/reverts/${asked.id}.done`, JSON.stringify({ ok: true, said: 'c0ffee' }));
  wakes.readDeploys();
  assert.deepEqual([reverts.list()[0].ok, reverts.list()[0].said], [true, 'c0ffee']);
  assert.ok(!existsSync(file) && !existsSync(`${h.dataDir}/reverts/${asked.id}.done`), 'the files go');
});
