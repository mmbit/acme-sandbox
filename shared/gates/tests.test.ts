// node --test shared/gates/tests.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tests, clone, nodeTest, sum } from './fixture.ts';

test("a test the change breaks fails the run; one that fails on main too doesn't, and untouched areas don't run", () => {
  const { status, out } = tests(
    {
      'kits/adds/sum.ts': sum('a + b'),
      'kits/adds/sum.test.ts': nodeTest('sums two numbers', 'assert.equal(sum(1, 2), 3);'),
      'kits/old/sum.ts': sum('a - b'),
      'kits/old/sum.test.ts': nodeTest('was always wrong', 'assert.equal(sum(1, 2), 3);'),
      'kits/far/sum.ts': sum('a - b'),
      'kits/far/sum.test.ts': nodeTest('far away and failing', 'assert.equal(sum(1, 2), 3);'),
      'infra/test_one.py': 'print("ok")\n',
    },
    {
      'kits/adds/sum.ts': sum('a * b'),
      'kits/old/notes.md': 'touched\n',
      'infra/test_one.py': 'import sys\nsys.exit("FAIL: the one check")\n',
    },
  );
  assert.equal(status, 1, out);
  assert.match(out, /kits\/adds\/sum\.test\.ts: sums two numbers/);
  assert.match(out, /- kits\/old \(node --test, 1 file\): 0 passed, 1 failing on main too/);
  assert.match(out, /infra\/test_one\.py: exit 1/);
  assert.doesNotMatch(out, /far away/);
});

test("--all runs every area's suites, untouched ones too, and names what fails on main (the nightly run)", () => {
  const { status, out } = clone(
    {
      'kits/far/sum.ts': sum('a - b'),
      'kits/far/sum.test.ts': nodeTest('far away and failing', 'assert.equal(sum(1, 2), 3);'),
      'kits/fine/sum.ts': sum('a + b'),
      'kits/fine/sum.test.ts': nodeTest('sums two numbers', 'assert.equal(sum(1, 2), 3);'),
    },
    { 'notes.md': 'nothing tested\n' },
  ).run({}, 'tests.ts', ['--all']);
  assert.equal(status, 0, out);
  assert.match(out, /- kits\/far \(node --test, 1 file\): 0 passed, 1 failing on main too/);
  assert.match(out, /kits\/fine/);
});

test('a change whose tests pass says what ran, and lists the page checks it leaves to the reviewers', () => {
  const { status, out } = tests(
    {
      'kits/adds/sum.ts': sum('a + b'),
      'kits/adds/sum.test.ts': nodeTest('sums two numbers', 'assert.equal(sum(1, 2), 3);'),
      'kits/adds/page-check.mjs': 'throw new Error("a page check never runs here");\n',
    },
    { 'kits/adds/sum.ts': sum('b + a') },
  );
  assert.equal(status, 0, out);
  assert.match(out, /^Tests passed: 1 area against main/);
  assert.match(out, /- kits\/adds \(node --test, 1 file\): 1 passed/);
  assert.match(out, /Time: dependencies [\d.]+ s, suites [\d.]+ s, failure comparison [\d.]+ s/);
  assert.match(out, /Slowest files: kits\/adds\/sum\.test\.ts \([\d.]+ s\)/);
  assert.match(out, /not run here \(a reviewer's, where the change needs one\): kits\/adds\/page-check\.mjs/);
});

test("a change's suites are told without running any: none for notes, as the tests say it, else each run", () => {
  const { change, run } = clone(
    {
      'kits/adds/sum.ts': sum('a + b'),
      'kits/adds/sum.test.ts': nodeTest('never runs here', 'throw new Error("ran");'),
      'company/people/someone.md': 'before\n',
    },
    { 'company/people/someone.md': 'after\n' },
  );
  const none = run({}, 'suites.ts');
  assert.equal(none.status, 0, none.out);
  assert.equal(none.out, 'Tests: none in what this change touches (company)\n');
  assert.deepEqual(run(), { status: 0, out: none.out });
  change({ 'kits/adds/sum.ts': sum('b + a') });
  const some = run({}, 'suites.ts');
  assert.equal(some.status, 1, some.out);
});

test('--commit tests that commit, not the files as they are', () => {
  const { dir, run } = clone(
    {
      'kits/adds/sum.ts': sum('a + b'),
      'kits/adds/sum.test.ts': nodeTest('sums two numbers', 'assert.equal(sum(1, 2), 3);'),
    },
    { 'kits/adds/notes.md': 'touched\n' },
  );
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  writeFileSync(join(dir, 'kits/adds/sum.ts'), sum('a * b'));
  const dirty = run();
  assert.equal(dirty.status, 1, dirty.out);
  const committed = run({}, 'tests.ts', ['--commit', head]);
  assert.equal(committed.status, 0, committed.out);
  assert.match(committed.out, /^- kits\/adds \(node --test, 1 file\): 1 passed/m);
});

test('a test that fails once and passes on a second run is named flaky and holds nothing up', () => {
  const once = `import { test } from 'node:test';\nimport { existsSync, writeFileSync } from 'node:fs';\ntest('fails the first time only', () => {\n  if (existsSync('ran-once')) return;\n  writeFileSync('ran-once', '');\n  throw new Error('first run');\n});\n`;
  const { status, out } = tests({ 'kits/once/once.test.ts': once }, { 'kits/once/notes.md': 'touched\n' });
  assert.equal(status, 0, out);
  assert.match(out, /- kits\/once \(node --test, 1 file\): 0 passed, 1 flaky \(passed on a second run\)/);
  assert.match(out, /Flaky: kits\/once\/once\.test\.ts › fails the first time only/);
});

test('a failing test is not hidden by a same-named test that fails on main', () => {
  const twoChecks = (aBody: string) =>
    `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { sum } from './sum.ts';\n` +
    `test('a', async t => { await t.test('checks output', () => { ${aBody} }); });\n` +
    `test('b', async t => { await t.test('checks output', () => { assert.equal(sum(1, 2), 4); }); });\n`;
  const { status, out } = tests(
    { 'kits/twin/sum.ts': sum('a + b'), 'kits/twin/sum.test.ts': twoChecks('assert.equal(sum(1, 2), 3);') },
    { 'kits/twin/sum.test.ts': twoChecks('assert.equal(sum(1, 2), 5);') },
  );
  assert.equal(status, 1, out);
  assert.match(out, /0 passed, 1 failing, 1 failing on main too/);
  assert.match(out, /Failing on main too: kits\/twin\/sum\.test\.ts › b › checks output/);
});

test('crashes and named failures keep their identities through the push rerun and base comparison', async t => {
  const cases = [
    { area: 'other', recurring: true, brokenAtBase: true },
    { area: 'same', recurring: true, brokenAtBase: true },
    { area: 'same', recurring: false, brokenAtBase: true },
    { area: 'same', recurring: false, brokenAtBase: false },
  ];
  for (const { area, recurring, brokenAtBase } of cases) {
    const name = brokenAtBase ? 'existing failure' : 'new failure';
    await t.test(`${recurring ? 'recurring' : 'once-only'} crash beside ${name} in ${area}`, () => {
      const named = (passes: boolean) =>
        `import assert from 'node:assert/strict'; import { test } from 'node:test'; test('${name}', () => assert.equal(${passes}, true));\n`;
      const crash = `import { test } from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
test('crash', () => {
  if (${!recurring} && existsSync('crashed')) return;
  writeFileSync('crashed', '');
  process.kill(process.ppid, 'SIGKILL');
});
`;
      const { status, out } = tests(
        {
          [`kits/${area}/old.test.ts`]: named(!brokenAtBase),
          'kits/same/crash.test.ts': "import { test } from 'node:test'; test('crash', () => {});\n",
        },
        {
          [`kits/${area}/old.test.ts`]: named(false),
          [`kits/${area}/notes.md`]: 'touched\n',
          'kits/same/crash.test.ts': crash,
        },
      );
      assert.equal(status, recurring || !brokenAtBase ? 1 : 0, out);
      if (recurring) {
        assert.match(out, /SIGKILL/);
        assert.doesNotMatch(out, /Flaky:/);
      } else {
        assert.match(out, /Flaky: kits\/same node \. failed/);
        assert.match(out, brokenAtBase ? /Failing on main too: .*existing failure/ : /old\.test\.ts: new failure/);
      }
    });
  }
});

test("each checkout's HEAD is its own commit: the change's at the change, the base's at the base", () => {
  const readsHead = `import assert from 'node:assert/strict';\nimport { execFileSync } from 'node:child_process';\nimport { test } from 'node:test';\ntest('main committed good', () => assert.equal(execFileSync('git', ['show', 'HEAD:kits/revision/value.txt'], { encoding: 'utf8' }), 'good'));\n`;
  const { status, out } = tests(
    { 'kits/revision/value.txt': 'good', 'kits/revision/value.test.ts': readsHead },
    { 'kits/revision/value.txt': 'bad' },
  );
  assert.equal(status, 1, out);
  assert.match(out, /kits\/revision\/value\.test\.ts: main committed good/);
  assert.doesNotMatch(out, /Failing on main too/);
});

test('a failure is found by its file when the temporary folder is a symlink', () => {
  const real = mkdtempSync(join(tmpdir(), 'tests-real-'));
  const linked = join(mkdtempSync(join(tmpdir(), 'tests-link-')), 'tmp');
  symlinkSync(real, linked);
  const { status, out } = tests(
    { 'kits/adds/sum.ts': sum('a + b'), 'kits/adds/sum.test.ts': nodeTest('sums', 'assert.equal(sum(1, 2), 3);') },
    { 'kits/adds/sum.ts': sum('a - b') },
    { TMPDIR: linked },
  );
  assert.equal(status, 1, out);
  assert.match(out, /^kits\/adds\/sum\.test\.ts: sums$/m);
  assert.doesNotMatch(out, /Flaky/);
});

test('suites that cannot start say the tests could not run, never that they passed', () => {
  const { status, out } = tests(
    { 'kits/adds/sum.ts': sum('a + b'), 'kits/adds/sum.test.ts': nodeTest('sums', 'assert.equal(sum(1, 2), 3);') },
    { 'kits/adds/sum.ts': sum('b + a') },
    { PATH: onlyGit() },
  );
  assert.equal(status, 2, out);
  assert.match(out, /^The tests could not run: /);
});

// A PATH with git and nothing else (no nice)
function onlyGit() {
  const bin = mkdtempSync(join(tmpdir(), 'tests-bin-'));
  const git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  symlinkSync(git, join(bin, 'git'));
  return bin;
}

test('a passing shell suite changed to die by signal fails the push check', () => {
  const { status, out } = tests({ 'infra/test_cut.sh': 'echo ok\n' }, { 'infra/test_cut.sh': 'kill -TERM $$\n' });
  assert.equal(status, 1, out);
  assert.match(out, /Tests failed/);
  assert.match(out, /SIGTERM/);
});
