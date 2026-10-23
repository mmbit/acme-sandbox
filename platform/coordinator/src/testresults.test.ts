// node --test src/testresults.test.ts   (uses a throwaway DATA_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('testresults');
const code = (c: string, job: number) => ({ tree: c.repeat(40), base: 'b'.repeat(40), job });

test("a push's tests are claimed by the code they test, another push of it waits, and the result is its report; only that counts on the day and the log", async () => {
  const bolt = await h.start({ agent: 'bolt' });
  const kit = await h.start({ agent: 'kit' });
  assert.deepEqual((await h.worker('tests/claim', code('a', bolt.id))).body, { yours: true });
  assert.deepEqual((await h.worker('tests/claim', code('a', kit.id))).body, { running: bolt.id });
  // (a worker taking its own check on after a reload)
  assert.deepEqual((await h.worker('tests/claim', code('a', bolt.id))).body, { yours: true });
  const result = { passed: true, report: 'Tests passed: 1 area against origin/main, 4 s', tests: 3 };
  assert.deepEqual((await h.worker('tests/done', { ...code('a', bolt.id), ...result })).body, { ok: true });
  assert.deepEqual((await h.worker('tests/claim', code('a', kit.id))).body, {
    kept: { passed: true, report: result.report, job: bolt.id },
  });
  await h.worker('tests/done', { ...code('a', kit.id), ...result, tests: 9 });
  assert.equal((await h.board('/api/work')).body.days.at(-1).tests, 3);
  const steps = (await h.feed()).filter(e => e.type === 'log' && /tests? passed/.test(e.text));
  assert.deepEqual(
    steps.map(e => [e.agent, e.text]),
    [['bolt', '3 tests passed']],
  );
});

test('a check that ends without a result gives its claim up, and one whose worker never came back is taken over', async () => {
  const bolt = await h.start({ agent: 'bolt' });
  const kit = await h.start({ agent: 'kit' });
  await h.worker('tests/claim', code('c', bolt.id));
  await h.worker('tests/done', { ...code('c', bolt.id), passed: null });
  assert.deepEqual((await h.worker('tests/claim', code('c', kit.id))).body, { yours: true });
  h.db.prepare("update test_results set at = '2026-01-01T00:00:00.000Z' where tree = ?").run('c'.repeat(40));
  assert.deepEqual((await h.worker('tests/claim', code('c', bolt.id))).body, { running: kit.id });
  await h.finish(kit);
  assert.deepEqual((await h.worker('tests/claim', code('c', bolt.id))).body, { yours: true });
  // kit's result comes too late: bolt's run holds the claim now
  await h.worker('tests/done', { ...code('c', kit.id), passed: false, report: 'Tests failed', tests: 0 });
  assert.deepEqual((await h.worker('tests/claim', code('c', kit.id))).body, { running: bolt.id });
});

test("a job's token can neither claim nor record, and a result says what it is", async () => {
  const bolt = await h.start({ agent: 'bolt' });
  for (const route of ['claim', 'done'])
    assert.equal((await h.call(`/api/worker/tests/${route}`, bolt.token, code('d', bolt.id))).status, 401);
  const bad = [
    { ...code('d', bolt.id), tree: 'short' },
    { ...code('d', bolt.id), job: 999_999 },
  ];
  for (const body of bad) assert.equal((await h.worker('tests/claim', body)).status, 400, JSON.stringify(body));
  await h.worker('tests/claim', code('d', bolt.id));
  for (const result of [
    { passed: 'yes', report: '', tests: 0 },
    { passed: true, report: '', tests: -1 },
    { passed: true },
  ])
    assert.equal((await h.worker('tests/done', { ...code('d', bolt.id), ...result })).status, 400);
  assert.deepEqual((await h.worker('tests/claim', code('d', bolt.id))).body, { yours: true });
});

test('base comparisons are shared across pushes, isolated by commit and test, and incomplete claims can be recovered', async () => {
  const bolt = await h.start({ agent: 'bolt' });
  const kit = await h.start({ agent: 'kit' });
  const ticket = async (job: typeof bolt, tree: string, commit = 'e'.repeat(40)) => {
    const codeAt = code(tree, job.id);
    await h.worker('tests/claim', codeAt);
    return { ...(await h.worker('tests/comparison', { ...codeAt, commit })).body, environment: 'worker' };
  };
  const first = await ticket(bolt, 'e');
  const next = await ticket(kit, 'f');
  const claim = (job: typeof bolt, ticket: any, tests = ['old failure']) =>
    h.agent('tests/base/claim', job.token, { ...ticket, tests });
  const done = (job: typeof bolt, ticket: any, failed: boolean | null) =>
    h.agent('tests/base/done', job.token, { ...ticket, tests: [{ test: 'old failure', failed }] });
  assert.deepEqual((await claim(bolt, first)).body, [{ test: 'old failure', yours: true }]);
  assert.deepEqual((await claim(kit, next)).body, [{ test: 'old failure', running: bolt.id }]);
  await done(bolt, first, true);
  assert.deepEqual((await claim(kit, next)).body, [{ test: 'old failure', failed: true }]);
  const remote = { ...next, environment: 'helper:attic' };
  assert.deepEqual((await claim(kit, remote)).body, [{ test: 'old failure', yours: true }]);
  await done(kit, remote, false);
  assert.deepEqual((await claim(kit, remote)).body, [{ test: 'old failure', failed: false }]);
  assert.deepEqual((await claim(kit, next)).body, [{ test: 'old failure', failed: true }]);
  assert.deepEqual((await claim(kit, next, ['new failure'])).body, [{ test: 'new failure', yours: true }]);
  const changed = await ticket(bolt, '1', 'f'.repeat(40));
  assert.deepEqual((await claim(bolt, changed)).body, [{ test: 'old failure', yours: true }]);
  await done(bolt, changed, null);
  const takeover = await ticket(kit, '2', 'f'.repeat(40));
  assert.deepEqual((await claim(kit, takeover)).body, [{ test: 'old failure', yours: true }]);
  await h.finish(kit);
  assert.deepEqual((await claim(bolt, changed)).body, [{ test: 'old failure', yours: true }]);
  await done(kit, takeover, true);
  await done(bolt, changed, false);
  assert.deepEqual((await claim(bolt, changed)).body, [{ test: 'old failure', failed: false }]);
  const abandoned = await ticket(bolt, '3', '4'.repeat(40));
  await claim(bolt, abandoned);
  await h.worker('tests/done', { ...code('3', bolt.id), passed: null });
  const replacement = await h.start({ agent: 'kit' });
  const retry = await ticket(replacement, '5', '4'.repeat(40));
  assert.deepEqual((await claim(replacement, retry)).body, [{ test: 'old failure', yours: true }]);
});

test('a job token alone cannot record base results, and comparison tickets cannot cross jobs, bases or completed pushes', async () => {
  const bolt = await h.start({ agent: 'bolt' });
  const kit = await h.start({ agent: 'kit' });
  const claimed = code('8', bolt.id);
  const tests = [{ test: 'a test', failed: true }];
  await h.worker('tests/claim', claimed);
  const { body: ticket } = await h.worker('tests/comparison', { ...claimed, commit: '9'.repeat(40) });
  for (const body of [
    { ...claimed, tests },
    { ...ticket, commit: 'a'.repeat(40), tests },
  ])
    assert.equal((await h.agent('tests/base/done', bolt.token, body)).status, 403);
  assert.equal((await h.agent('tests/base/done', kit.token, { ...ticket, tests })).status, 403);
  assert.equal((await h.agent('tests/base/claim', bolt.token, { ...ticket, tests: [null] })).status, 400);
  assert.equal(
    (await h.agent('tests/base/done', bolt.token, { ...ticket, tests: [{ test: 'a', failed: 'yes' }] })).status,
    400,
  );
  await h.worker('tests/done', { ...claimed, passed: true, report: 'Tests passed', tests: 0 });
  assert.equal((await h.agent('tests/base/done', bolt.token, { ...ticket, tests })).status, 403);
});
