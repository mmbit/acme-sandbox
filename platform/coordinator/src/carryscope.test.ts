// node --test src/carryscope.test.ts   (throwaway DATA_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('carryscope');
const predictions = await import('./predictions.ts');
const matching = await import('./matching.ts');
const reader = await h.start({ agent: 'bolt', title: 'Read carry scopes', kind: 'chat' });
const MINUTE = 60_000,
  SECOND = 1000;
const SAVED_MS = 12 * MINUTE;
const sha = (n: number) => n.toString(16).padStart(40, '0');
const profileScope = { typecheck: false, tests: [] };
const broadScope = { typecheck: true, tests: ['infra', 'platform/one', 'platform/two', 'shared/three'] };
// Carry checks three hours apart over the last day, each queued with the same saved estimate. The first one's check was
// lost once and resumed: its timing counts for nothing.
const cases = [
  { scope: broadScope, runs: [30 * MINUTE, 60 * MINUTE], resumed: true },
  { scope: profileScope, runs: [20 * SECOND] },
  { scope: broadScope, runs: [45 * MINUTE] },
  { scope: profileScope, runs: [12 * SECOND] },
  { scope: broadScope, runs: [60 * MINUTE] },
  { scope: profileScope, runs: [30 * SECOND] },
  { scope: broadScope, runs: [100 * MINUTE] },
  { scope: profileScope, runs: [12 * SECOND] },
  { scope: broadScope, runs: [108 * MINUTE] },
].map((c, n) => {
  const created = Date.now() - 30 * 60 * MINUTE + n * 3 * 60 * MINUTE;
  let at = created + MINUTE;
  const runs = c.runs.map((ms, i) => {
    const run = { started: at, ended: at + ms, outcome: c.resumed && i === 0 ? ('lost' as const) : ('done' as const) };
    at = run.ended + MINUTE;
    return run;
  });
  const id = h.pastJob({
    agent: 'juno',
    title: 'The same title for every check',
    queued_by: null,
    carry: sha(n + 1),
    carryScope: c.scope,
    created,
    sized: SAVED_MS,
    runs,
  });
  return { id, sha: sha(n + 1), scope: c.scope, created, agent_ms: c.runs.at(-1)! };
});
const [, , , oneEarlier, , , , profile, broad] = cases;

test('profile and broad-code estimates use only earlier clean claims of the checks they require', async () => {
  const pool = matching.pastJobs();
  const forecast = (c: (typeof cases)[number]) =>
    predictions.predict(
      pool.find(j => j.id === c.id)!,
      pool.filter(p => Date.parse(p.finished) < c.created),
    );
  for (const c of [profile, broad]) {
    const prediction = forecast(c);
    const factor = (estimate: number) => Math.max(estimate / c.agent_ms, c.agent_ms / estimate);
    assert.ok(factor(prediction.size.agent_ms) < factor(SAVED_MS));
    assert.ok(prediction.picks.every(p => !p.timing_flags?.length && Date.parse(p.finished) < c.created));
    assert.ok(prediction.picks.every(p => JSON.parse(p.carry_scope!).typecheck === c.scope.typecheck));
    assert.equal(predictions.stored(c.id)!.size.agent_ms, SAVED_MS, 'saved estimates remain as given');
  }
  assert.ok(forecast(profile).size.agent_ms < MINUTE);
  assert.ok(forecast(broad).size.agent_ms > 10 * MINUTE);
  assert.equal(forecast(oneEarlier).guessed, false, 'one comparable claim is evidence');
  const shown = (await h.agent(`estimate?q=%23${broad.id}`, reader.token)).body.job;
  assert.deepEqual(shown.check_scope, { sha: broad.sha, required: broadScope });
  const audit = (await h.agent('estimate/accuracy?days=7', reader.token)).body;
  assert.equal(audit.matching_carries.jobs, cases.length - 1, 'a resumed claim is unscoreable');
  assert.ok(audit.matching_carries.now.median_factor < audit.matching_carries.mixed.median_factor);
});

test('unknown scopes do not dilute known checks, and disjoint test areas supply no comparison', () => {
  const unknown = h.pastJob({
    agent: 'juno',
    title: 'The same title for every check',
    carry: 'e'.repeat(40),
    queued_by: null,
    run: { started: Date.now() - 120 * 60_000, ended: Date.now() - 60 * 60_000 },
  });
  const pool = matching.pastJobs();
  const known = predictions.predict(
    {
      title: 'No title classifier',
      origin: 'carry',
      carry_scope: JSON.stringify({ typecheck: true, tests: ['products/unrelated'] }),
    },
    pool,
  );
  const profile = predictions.predict(
    {
      title: 'The same title for every check',
      origin: 'carry',
      carry_scope: JSON.stringify({ typecheck: false, tests: [] }),
    },
    pool,
  );
  assert.ok(profile.picks.length > 0);
  assert.ok(profile.picks.every(p => p.id !== unknown));
  assert.equal(known.guessed, true);
  assert.deepEqual(known.picks, []);
});
