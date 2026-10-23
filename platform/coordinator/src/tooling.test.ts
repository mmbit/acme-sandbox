// node --test src/tooling.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { splitPlatform } from './fixture.ts';
import { measurement } from '../../worker/tooling/metrics.ts';

const h = await harness('tooling', {
  before: repo => {
    splitPlatform(repo);
  },
});
const snapshot = () => {
  const m = measurement(0);
  m.observe(
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'hq search "private customer question"' } },
        ],
      },
    },
    10,
  );
  m.observe(
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'private response', is_error: true }] },
    },
    20,
  );
  return m.snapshot();
};

test('the worker stores one content-free snapshot per run and Process can read measured and missing coverage', async () => {
  const process = await h.start({ agent: 'bolt' });
  const measured = await h.start({ agent: 'moss', title: 'private customer title', engine: 'claude' });
  const missing = await h.start({ agent: 'nib', engine: 'codex' });
  const since = new Date(Date.now() - 60_000).toISOString();
  await h.finish(measured, { tooling: snapshot(), toolingEngine: 'claude' });
  await h.finish(missing);
  const reply = await h.agent(`tooling?since=${since}`, process.token);
  assert.equal(reply.status, 200);
  const row = reply.body.runs.find((row: any) => row.job === measured.id);
  assert.equal(row.engine, 'claude');
  assert.equal(row.department, 'creative');
  assert.equal(row.metrics.commands.search.failed, 1);
  assert.equal(reply.body.runs.find((row: any) => row.job === missing.id).metrics, null);
  assert.doesNotMatch(JSON.stringify(reply.body), /private|customer|question|response|title/);
  const cli = await h.hq(process, 'tooling', '--since', since);
  assert.equal(cli.code, 0);
  assert.equal(JSON.parse(cli.out).runs.length, reply.body.runs.length);
  assert.equal((await h.agent(`tooling?until=${since}`, process.token)).body.runs.length, 0);
});

test('access follows the Process role and refuses non-Process, unauthenticated and malformed queries', async () => {
  const process = await h.start({ agent: 'bolt' });
  const other = await h.start({ agent: 'chime' });
  assert.equal((await h.agent('tooling', other.token)).status, 403);
  assert.equal((await h.agent('tooling', 'invalid')).status, 401);
  assert.equal((await h.agent('tooling?since=invalid', process.token)).status, 400);
  assert.equal((await h.agent('tooling?since=2030-01-01&until=2020-01-01', process.token)).status, 400);
  const refusal = await h.hq(other, 'tooling');
  assert.notEqual(refusal.code, 0);
  assert.ok(refusal.out.includes((await h.agent('tooling', other.token)).body.error));
  const invalid = await h.hq(process, 'tooling', '--since', 'invalid');
  assert.notEqual(invalid.code, 0);
  assert.ok(invalid.out.includes((await h.agent('tooling?since=invalid', process.token)).body.error));
  assert.notEqual((await h.hq(process, 'tooling', '--since')).code, 0);
  assert.equal((await h.hq({ token: 'invalid', agent: 'bolt' }, 'tooling', '--help')).code, 0);
});

test('agents cannot write snapshots', async () => {
  const process = await h.start({ agent: 'bolt' });
  assert.equal((await h.agent('tooling', process.token, { tooling: snapshot() })).status, 404);
  assert.equal((await h.finish(process, { tooling: snapshot(), toolingEngine: 'codex' })).status, 200);
});
