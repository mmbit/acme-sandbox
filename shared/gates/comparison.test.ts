// node --test shared/gates/comparison.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clone, playedHq, ON_HELPER, nodeTest, sum } from './fixture.ts';

test('local and helper pushes reuse base outcomes only within the same environment, including local fallback', async () => {
  const { repo, run, marker } = await comparisonCase({
    RUN_STATES: JSON.stringify([[['done', 'attic']], [['done', 'attic']], [['done', 'attic']], [['lost', 'attic']]]),
  });
  await run();
  assert.equal(readFileSync(marker, 'utf8'), 'base\n');
  repo.change({ 'kits/old/mode': 'next push' });
  const reused = await run();
  assert.equal(readFileSync(marker, 'utf8'), 'base\n');
  assert.match(reused, /Base comparison: 2 kept, 0 run/);
  repo.change({ 'kits/old/mode': 'helper push' });
  const lent = await run(true);
  assert.match(lent, /Base comparison: 0 kept, 2 run/);
  assert.match(lent, /on attic/);
  assert.equal(readFileSync(marker, 'utf8'), 'base\n'.repeat(2));
  repo.change({ 'kits/old/mode': 'second helper push' });
  assert.match(await run(true), /Base comparison: 2 kept, 0 run/);
  assert.equal(readFileSync(marker, 'utf8'), 'base\n'.repeat(2));
  repo.change({ 'kits/old/mode': 'helper lost push' });
  const fallback = await run(true);
  assert.match(fallback, /They run here instead/);
  assert.match(fallback, /Base comparison: 2 kept, 0 run/);
  assert.equal(readFileSync(marker, 'utf8'), 'base\n'.repeat(2));
});

test('a new base runs its comparison and incomplete comparisons remain retryable', async () => {
  const { repo, run, marker, git } = await comparisonCase();
  await run(true);
  repo.change({ 'kits/old/mode': 'base' });
  git('branch', '-f', 'main', 'HEAD');
  repo.change({ 'kits/old/mode': 'new base push' });
  assert.match(await run(true), /Base comparison: 0 kept, 2 run/);
  assert.equal(readFileSync(marker, 'utf8'), 'base\nbase\n');
  repo.change({
    'kits/deps/package.json': JSON.stringify({ name: 'deps', dependencies: { adder: 'file:../../vendor/adder' } }),
    'kits/deps/package-lock.json': JSON.stringify({
      name: 'deps',
      lockfileVersion: 3,
      packages: { '': { name: 'deps' } },
    }),
    'kits/old/mode': 'base',
  });
  git('branch', '-f', 'main', 'HEAD');
  repo.change({ 'kits/deps/package.json': '{}', 'kits/old/mode': 'incomplete comparison' });
  await run(false, 2);
  repo.change({ 'kits/old/mode': 'try incomplete comparison again' });
  await run(false, 2);
  assert.equal(readFileSync(marker, 'utf8'), 'base\n'.repeat(4));
});

test('a parent ticket stays with its runner through suites with nested fixtures and local helper fallback', async () => {
  const { repo, run } = await comparisonCase({ RUN_STATES: JSON.stringify([[['lost', 'attic']]]) });
  const nested = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tests, nodeTest, sum } from './fixture.ts';
test('nested fixture compares its own base', () => {
  const ran = tests({
    'kits/adds/sum.ts': sum('a + b'),
    'kits/adds/sum.test.ts': nodeTest('sums', 'assert.equal(sum(1, 2), 3);'),
  }, { 'kits/adds/sum.ts': sum('a * b') });
  assert.equal(ran.status, 1, ran.out);
});
`;
  repo.change({
    'shared/gates/fixture.ts': readFileSync(new URL('./fixture.ts', import.meta.url), 'utf8'),
    'shared/gates/nested.test.ts': nested,
  });
  const local = await run();
  assert.match(local, /shared\/gates .*1 passed/);
  assert.doesNotMatch(local, /Failing on main too: shared\/gates/);
  const fallback = await run(true);
  assert.match(fallback, /They run here instead/);
  assert.match(fallback, /shared\/gates .*1 passed/);
  assert.match(fallback, /Base comparison: 2 kept, 0 run/);
});

test('a ticket for another base still leaves its owning comparison incomplete', () => {
  const repo = clone(
    { 'kits/adds/sum.ts': sum('a + b'), 'kits/adds/sum.test.ts': nodeTest('sums', 'assert.equal(sum(1, 2), 3);') },
    { 'kits/adds/sum.ts': sum('a * b') },
  );
  const ran = repo.run({ TESTS_COMPARISON: JSON.stringify({ commit: 'another base' }) });
  assert.equal(ran.status, 2, ran.out);
  assert.match(ran.out, /ticket names a different base commit/);
});

test('interrupted base comparisons are incomplete and run again instead of retaining an outcome', async () => {
  const { repo, run, marker } = await comparisonCase();
  const stopped = `import { test } from 'node:test';
import { readFileSync, appendFileSync } from 'node:fs';
test('interrupted on base', () => {
  if (readFileSync('kits/old/mode', 'utf8') === 'base') {
    appendFileSync(${JSON.stringify(marker)}, 'interrupted\\n');
    process.kill(process.ppid, 'SIGKILL');
  }
  throw new Error('push failure');
});`;
  repo.change({ 'kits/old/old.test.ts': stopped, 'kits/old/mode': 'base' });
  execFileSync('git', ['branch', '-f', 'main', 'HEAD'], { cwd: repo.dir });
  repo.change({ 'kits/old/mode': 'push' });
  for (let i = 0; i < 2; i++) {
    const out = await run(false, 2);
    assert.match(out, /base.*SIGKILL/i);
  }
  assert.equal(readFileSync(marker, 'utf8'), 'interrupted\n'.repeat(2));
});

async function comparisonCase(env: NodeJS.ProcessEnv = {}) {
  const marker = join(mkdtempSync(join(tmpdir(), 'base-reuse-')), 'comparisons');
  const suite = `import { test } from 'node:test';
import { readFileSync, appendFileSync } from 'node:fs';
test('already broken', () => {
  if (readFileSync('kits/old/mode', 'utf8') === 'base') appendFileSync(${JSON.stringify(marker)}, 'base\\n');
  throw new Error('broken');
});
test('new breakage', () => {
  if (readFileSync('kits/old/mode', 'utf8') !== 'base') throw new Error('new breakage');
});`;
  const repo = clone(
    {
      'kits/old/mode': 'base',
      'kits/old/old.test.ts': suite,
      'shared/gates/tests-on-helper.sh': ON_HELPER,
    },
    { 'kits/old/mode': 'push' },
  );
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo.dir, encoding: 'utf8' }).trim();
  const helper = await playedHq(undefined, env);
  const run = async (lent = false, expectedCode = 1) => {
    const ticket = { commit: git('rev-parse', 'main') };
    const ran = repo.run({ ...helper, TESTS_COMPARISON: JSON.stringify(ticket) }, 'tests.ts', lent ? ['--helper'] : []);
    assert.equal(ran.status, expectedCode, ran.out);
    assert.match(ran.out, expectedCode === 2 ? /Tests incomplete|The tests could not run/ : /Tests failed/);
    return ran.out;
  };
  return { repo, run, marker, git };
}
