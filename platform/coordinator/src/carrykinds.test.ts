// node --test src/carrykinds.test.ts   (throwaway DATA_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('carrykinds');
const predictions = await import('./predictions.ts');
const MINUTE = 60_000;
const T = Date.now();
const scopeOf = (code: boolean) => ({ typecheck: code, tests: code ? ['infra', 'platform/coordinator'] : [] });
const sha = (n: number) => n.toString(16).padStart(40, '0');
const reader = await h.start({ agent: 'bolt', title: 'Read carry estimates', kind: 'chat' });
const kindOf = (n: number) =>
  (h.db.prepare('select code from carry_commits where sha = ?').get(sha(n)) as { code: number } | undefined)?.code;

// Past carry checks in the pairs they come in, one every ten minutes: a foundation merge bringing code, its checks 20
// minutes, then the merge-back of company files, under half a minute. Their commits' kinds as the worker told them.
const pairs = 6;
for (let n = 0; n < 2 * pairs; n++) {
  const code = n % 2 === 0,
    at = T - (3 * 60 - 10 * n) * MINUTE,
    minutes = code ? 20 : 0.4;
  h.pastJob({
    agent: 'juno',
    title: `The gates and tests on ${n}, a commit main took outside review`,
    queued_by: null,
    carry: sha(100 + n),
    carryScope: scopeOf(code),
    created: at,
    run: { started: at, ended: at + minutes * MINUTE },
    sized: 5 * MINUTE,
  });
}

test("the worker's word on each commit is kept before its check is queued, and for one checked before", async () => {
  const commit = (n: number, code?: boolean, ...parents: number[]) => ({
    sha: sha(n),
    parents: parents.map(sha),
    ...(code === undefined ? {} : { code, scope: scopeOf(code) }),
  });
  const checksOf = (n: number) =>
    (h.db.prepare('select id from jobs where carry = ?').all(sha(n)) as { id: number }[]).map(j => j.id);
  // main at 2, HQ having queued 1's check before the worker said what commits change
  assert.equal((await h.worker('main-moved', { commits: [commit(2, undefined, 1), commit(1)] })).status, 200);
  const old = h.queue({ agent: 'juno', title: 'A check from before', carry: sha(1) });
  const line = [commit(4, true, 3, 40), commit(3, false, 2, 41), commit(2, true, 1), commit(1, false)];
  assert.equal((await h.worker('main-moved', { commits: line })).status, 200);
  assert.deepEqual([kindOf(4), kindOf(3), kindOf(2), kindOf(1)], [1, 0, undefined, 0]);
  assert.deepEqual(checksOf(1), [old]);
  assert.equal(predictions.stored(checksOf(4)[0])!.size.agent_ms, 20 * MINUTE);
  assert.equal(predictions.stored(checksOf(3)[0])!.size.agent_ms, 0.4 * MINUTE);
  assert.deepEqual(predictions.stored(checksOf(4)[0])!.basis.scope, scopeOf(true));
  assert.deepEqual(predictions.stored(checksOf(3)[0])!.basis.scope, scopeOf(false));
  assert.equal(
    (await h.worker('main-moved', { commits: [{ ...commit(6, true, 5), scope: { typecheck: true, tests: [12] } }] }))
      .status,
    400,
  );
  assert.equal((await h.worker('main-moved', { commits: [{ ...commit(6, true, 5), code: 'yes' }] })).status, 400);
});

test("a carry check is sized on carries of its own kind, and on every kind's while its own is unknown", async () => {
  const sized = (carry_code: number | null) =>
    predictions.predict({ title: 'The gates and tests', origin: 'carry', carry_code });
  const code = sized(1),
    files = sized(0),
    unknown = sized(null);
  assert.equal(code.size.agent_ms, 20 * MINUTE);
  assert.ok(code.picks.every(p => p.carry_code === 1));
  assert.deepEqual(code.basis, { kind: 'carry', agent: null, words: [], code: true });
  assert.equal(files.size.agent_ms, 0.4 * MINUTE);
  assert.equal(unknown.basis.code, undefined);
  assert.ok(unknown.picks.some(p => p.carry_code === 1) && unknown.picks.some(p => p.carry_code === 0));
});

test('hq estimate --accuracy replays the carry checks on their own kind beside every kind, as before', async () => {
  const report = (await h.agent('estimate/accuracy?days=1', reader.token)).body;
  const c = report.matching_carries;
  // each sized from those done before it was queued: the first two have none, nor has the third of its own kind
  assert.equal(c.jobs, 2 * pairs);
  assert.ok(c.now.median_factor < c.mixed.median_factor, JSON.stringify(c));
  assert.equal(c.now.median_factor, 1);
  const cli = await h.hq(reader, 'estimate', '--accuracy', '--days', '1');
  assert.equal(cli.code, 0, cli.out);
  assert.match(
    cli.out,
    /mechanical carry checks, worker occupancy: 12 jobs\n {4}recorded required-check scope: 12\/12\n {4}on their required checks/,
  );
});
