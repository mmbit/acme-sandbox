// node --test shared/gates/helper.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clone, nodeTest, ON_HELPER, playedHq, sum } from './fixture.ts';

test('--helper runs the tests on a lent machine and brings back its report, and --outcomes has the tests that passed, here or there', async () => {
  const env = await playedHq();
  const onHelper = { 'shared/gates/tests-on-helper.sh': ON_HELPER };
  const kits = {
    'kits/adds/sum.ts': sum('a + b'),
    'kits/adds/sum.test.ts': nodeTest('sums two numbers', 'assert.equal(sum(1, 2), 3);'),
  };
  const { run } = clone({ ...kits, ...onHelper }, { 'kits/adds/notes.md': 'touched\n' });
  const outcomes = mkdtempSync(join(tmpdir(), 'tests-outcomes-'));
  const passed = (file: string) => JSON.parse(readFileSync(join(outcomes, file), 'utf8'));
  const here = run({}, 'tests.ts', ['--outcomes', join(outcomes, 'here.json')]);
  assert.equal(here.status, 0, here.out);
  assert.deepEqual(passed('here.json'), { passed: 1 });
  const lent = run(env, 'tests.ts', ['--helper', '--outcomes', join(outcomes, 'lent.json')]);
  assert.equal(lent.status, 0, lent.out);
  assert.match(lent.out, /^- kits\/adds \(node --test, 1 file\): 1 passed/m);
  assert.match(lent.out, /\(on attic\)$/m);
  assert.deepEqual(passed('lent.json'), { passed: 1 });
});

for (const withJq of [true, false]) {
  test(`shell and Python bundles carry available tools with jq ${withJq ? 'present' : 'absent'}, and node bundles carry none`, async () => {
    const bin = mkdtempSync(join(tmpdir(), 'tests-tools-'));
    const tools = ['age', 'age-keygen', 'versitygw', 'caddy', 'docker-compose', ...(withJq ? ['jq'] : [])];
    for (const tool of tools) writeFileSync(join(bin, tool), `#!/bin/sh\necho ${tool}\n`, { mode: 0o755 });
    const env = { ...(await playedHq()), TESTS_TOOLS_BIN: bin };
    const onHelper = {
      'shared/gates/tests-on-helper.sh': "echo \"tools: $(ls ../tools 2>/dev/null | tr '\\n' ' ')\"\n" + ON_HELPER,
    };
    const kits = {
      'kits/adds/sum.ts': sum('a + b'),
      'kits/adds/sum.test.ts': nodeTest('sums two numbers', 'assert.equal(sum(1, 2), 3);'),
    };
    const shell = {
      'infra/test_tools.sh':
        'test "$(caddy)" = caddy && test "$(age)" = age && test "$(docker-compose)" = docker-compose\n',
    };
    const infra = clone({ ...kits, ...onHelper, ...shell }, { 'infra/notes.md': 'touched\n' }).run(env, 'tests.ts', [
      '--helper',
    ]);
    assert.equal(infra.status, 0, infra.out);
    const bundled = `tools: ${tools.toSorted().join(' ')}`;
    assert.ok(infra.out.split('\n').includes(bundled), infra.out);
    assert.match(infra.out, /^- infra \(in infra: bash test_tools.sh\): 0 passed/m);
    assert.doesNotMatch(infra.out, /failing|flaky/); // its exit 0, with the copies on PATH, not failing on main too
    const python = {
      'infra/test_tools.py':
        'import subprocess, unittest\n' +
        'class Tools(unittest.TestCase):\n' +
        '    def test_tools(self):\n' +
        `        for tool in ${JSON.stringify(tools)}:\n` +
        '            self.assertEqual(subprocess.check_output([tool], text=True).strip(), tool)\n' +
        'unittest.main()\n',
    };
    const py = clone({ ...onHelper, ...python }, { 'infra/notes.md': 'touched\n' }).run(env, 'tests.ts', ['--helper']);
    assert.equal(py.status, 0, py.out);
    assert.ok(py.out.split('\n').includes(bundled), py.out);
    assert.match(py.out, /^- infra \(in infra: python3 test_tools.py\): 1 passed/m);
    assert.doesNotMatch(py.out, /failing|flaky/);
    const node = clone({ ...kits, ...onHelper }, { 'kits/adds/notes.md': 'touched\n' }).run(env, 'tests.ts', [
      '--helper',
    ]);
    assert.equal(node.status, 0, node.out);
    assert.match(node.out, /^tools:$/m);
  });
}

test('--helper rides out HQ restarting: the run sent once HQ takes connections again, and polls it drops tried again', async () => {
  const { run } = clone(
    {
      'shared/gates/tests-on-helper.sh': ON_HELPER,
      'kits/adds/sum.ts': sum('a + b'),
      'kits/adds/sum.test.ts': nodeTest('sums two numbers', 'assert.equal(sum(1, 2), 3);'),
    },
    { 'kits/adds/notes.md': 'touched\n' },
  );
  const lent = run(await playedHq(undefined, { RESTARTING: '1' }), 'tests.ts', ['--helper']);
  assert.equal(lent.status, 0, lent.out);
  assert.match(lent.out, /^- kits\/adds \(node --test, 1 file\): 1 passed/m);
  assert.match(lent.out, /\(on attic\)$/m);
});

// HQ down for longer than one more try 5 s later is ridden out too.
test("--helper rides out HQ down for longer than a moment from the run's first poll", async () => {
  const { run } = clone(
    {
      'shared/gates/tests-on-helper.sh': ON_HELPER,
      'kits/adds/sum.ts': sum('a + b'),
      'kits/adds/sum.test.ts': nodeTest('sums two numbers', 'assert.equal(sum(1, 2), 3);'),
    },
    { 'kits/adds/notes.md': 'touched\n' },
  );
  const lent = run(await playedHq(undefined, { RESTARTING: '1', RESTART_MS: '6500' }), 'tests.ts', ['--helper']);
  assert.equal(lent.status, 0, lent.out);
  assert.match(lent.out, /^- kits\/adds \(node --test, 1 file\): 1 passed/m);
});

// (UNREACHED_EXIT, 3: the worker runs it again once HQ answers, never its author)
test('helper reporting rides out disconnects in a row; HQ unreached past the window, or a submission lost once HQ may have it, ends it unreached', async () => {
  for (const [settings, status] of [
    [{ REPORT_DISCONNECTS: '1' }, 0],
    [{ REPORT_DISCONNECTS: '3' }, 0],
    [{ REPORT_DISCONNECTS: '1000', HQ_RETRY_MS: '2500' }, 3],
    [{ DROP_SUBMIT: '1' }, 3],
    [{ DROP_SUBMIT: 'body' }, 3],
  ] as const) {
    const env = await playedHq(undefined, settings);
    const outcomes = join(mkdtempSync(join(tmpdir(), 'tests-transport-')), 'outcomes.json');
    const { run } = clone(
      {
        'kits/adds/sum.ts': sum('a + b'),
        'kits/adds/sum.test.ts': nodeTest('sums two numbers', 'assert.equal(sum(1, 2), 3);'),
        'shared/gates/tests-on-helper.sh': ON_HELPER,
      },
      { 'kits/adds/notes.md': 'touched\n' },
    );
    const ran = run(env, 'tests.ts', ['--helper', '--outcomes', outcomes]);
    assert.equal(ran.status, status, ran.out);
    if (status === 0) assert.deepEqual(JSON.parse(readFileSync(outcomes, 'utf8')), { passed: 1 });
    else {
      assert.match(ran.out, /^The tests could not reach HQ: /m);
      assert.throws(() => readFileSync(outcomes), { code: 'ENOENT' });
    }
  }
});

test('helper failures are compared in the helper environment, while a real regression still blocks', async () => {
  const env = await playedHq(undefined, { HELPER_ENV: JSON.stringify({ TEST_ROOM: 'helper' }) });
  const repo = clone(
    {
      'shared/gates/tests-on-helper.sh': ON_HELPER,
      'kits/adds/sum.ts': sum('a + b'),
      'kits/adds/sum.test.ts':
        nodeTest('sums two numbers', 'assert.equal(sum(1, 2), 3);') +
        "test('helper-only failure', () => { assert.notEqual(process.env.TEST_ROOM, 'helper'); });\n",
    },
    { 'kits/adds/notes.md': 'touched\n' },
  );
  const existing = repo.run(env, 'tests.ts', ['--helper']);
  assert.equal(existing.status, 0, existing.out);
  assert.match(existing.out, /Failing on main too: .*helper-only failure/);
  repo.change({ 'kits/adds/sum.ts': sum('a * b') });
  const broken = repo.run(env, 'tests.ts', ['--helper']);
  assert.equal(broken.status, 1, broken.out);
  assert.match(broken.out, /1 failing, 1 failing on main too/);
});

test('a missing or different comparison helper leaves the check incomplete', async () => {
  for (const state of ['lost', 'done']) {
    const env = await playedHq(undefined, {
      HELPER_ENV: JSON.stringify({ TEST_ROOM: 'helper' }),
      RUN_STATES: JSON.stringify([[['done', 'attic']], [[state, 'elsewhere']]]),
    });
    const repo = clone(
      {
        'shared/gates/tests-on-helper.sh': ON_HELPER,
        'kits/adds/sum.ts': sum('a + b'),
        'kits/adds/sum.test.ts': nodeTest('helper-only failure', "assert.notEqual(process.env.TEST_ROOM, 'helper');"),
      },
      { 'kits/adds/notes.md': 'touched\n' },
    );
    const ran = repo.run(env, 'tests.ts', ['--helper']);
    assert.equal(ran.status, 2, ran.out);
    assert.match(ran.out, /The tests could not run:/);
    assert.doesNotMatch(ran.out, /Tests passed:|Tests failed:|They run here instead/);
  }
});

test('a second helper upload survives an archive that outlasts the connection idle time', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'tests-archive-'));
  const tar = execFileSync('which', ['tar'], { encoding: 'utf8' }).trim();
  // Node's server closes idle connections after five seconds. The archive takes one second longer.
  writeFileSync(
    join(bin, 'tar'),
    `#!/bin/sh
if [ "$1" = '-czf' ] && [ "\${2##*/}" = 'bundle.tar.gz' ]; then sleep 6; fi
exec ${tar} "$@"
`,
    { mode: 0o755 },
  );
  const env = {
    ...(await playedHq(undefined, { KEEP_ALIVE: '1', HELPER_ENV: JSON.stringify({ TEST_ROOM: 'helper' }) })),
    PATH: `${bin}:${process.env.PATH}`,
  };
  const repo = clone(
    {
      'shared/gates/tests-on-helper.sh': ON_HELPER,
      'kits/adds/sum.ts': sum('a + b'),
      'kits/adds/sum.test.ts': nodeTest('helper-only failure', "assert.notEqual(process.env.TEST_ROOM, 'helper');"),
    },
    { 'kits/adds/notes.md': 'touched\n' },
  );
  const ran = repo.run(env, 'tests.ts', ['--helper']);
  assert.equal(ran.status, 0, ran.out);
  assert.match(ran.out, /Failing on main too:/);
});

test("tests too slow for the helper's limit fail as such, naming the files still running and what's known, and never run again here", async () => {
  const sleepy = (seconds: number) =>
    `import { test } from 'node:test';\ntest('waits', () => new Promise(resolve => setTimeout(resolve, ${seconds * 1000})));\n`;
  const outcomes = join(mkdtempSync(join(tmpdir(), 'tests-limit-')), 'outcomes.json');
  const repo = clone(
    {
      'shared/gates/tests-on-helper.sh': ON_HELPER,
      'kits/adds/sum.ts': sum('a + b'),
      'kits/adds/sum.test.ts':
        nodeTest('sums two numbers', 'assert.equal(sum(1, 2), 3);') +
        "test('subtracts', () => { assert.equal(sum(3, -1), 1); });\n",
      // (in TAP's order the slow file comes first, and the four behind it end before it: one that fails to load, and one
      // that exits non-zero after its test passes)
      'kits/slow/a-slow.test.ts': sleepy(50),
      // (and one of its tests registered by a module it imports, declared there)
      'kits/slow/b-quick.test.ts': sleepy(0) + "import { register } from './register.ts';\nregister();\n",
      'kits/slow/register.ts':
        "import { test } from 'node:test';\nexport const register = () => test('registered', () => {});\n",
      'kits/slow/c-broken.test.ts':
        "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('breaks', () => { assert.equal(1, 2); });\n",
      'kits/slow/d-unloadable.test.ts': "throw new Error('cannot load');\n",
      'kits/slow/e-exits.test.ts': sleepy(0) + "process.on('exit', () => { process.exitCode = 3; });\n",
    },
    { 'kits/adds/notes.md': 'touched\n', 'kits/slow/notes.md': 'touched\n' },
  );
  // a limit of 36 s, so they stop themselves 6 s into it
  const env = { ...(await playedHq()), TESTS_HELPER_MINUTES: '0.6' };
  const started = Date.now();
  const stopped = repo.run(env, 'tests.ts', ['--helper', '--outcomes', outcomes]);
  assert.equal(stopped.status, 1, stopped.out);
  assert.ok(Date.now() - started < 30_000, 'they ran again here');
  assert.match(stopped.out, /^Tests failed: too slow for the helper's 0.6-minute limit on attic/m);
  assert.match(stopped.out, /^Still running, with their time so far: kits\/slow\/a-slow\.test\.ts \([\d.]+ s\)$/m);
  assert.match(stopped.out, /^Slowest that ended: .*kits\/slow\/b-quick\.test\.ts/m);
  assert.match(stopped.out, /^Slowest that ended: .*kits\/slow\/c-broken\.test\.ts/m);
  const failing = stopped.out.match(/^Failing so far, not compared with main: (.*)$/m)?.[1].split('; ');
  assert.deepEqual(failing?.sort(), [
    'kits/adds/sum.test.ts › subtracts',
    'kits/slow/c-broken.test.ts › breaks',
    'kits/slow/d-unloadable.test.ts',
    'kits/slow/e-exits.test.ts',
  ]);
  assert.match(stopped.out, /^kits\/slow\/c-broken\.test\.ts: breaks\n {2}Expected values to be strictly equal/m);
  assert.match(stopped.out, /^kits\/slow\/d-unloadable\.test\.ts\n {2}test failed \(exit code 1\)$/m);
  assert.match(stopped.out, /^kits\/slow\/e-exits\.test\.ts\n {2}test failed \(exit code 3\)$/m);
  assert.doesNotMatch(stopped.out, /They run here instead/);
  assert.deepEqual(JSON.parse(readFileSync(outcomes, 'utf8')), { passed: 4 });
  // the helper itself stopping them at the limit, before they could say how far they got
  repo.change({ 'kits/slow/a-slow.test.ts': sleepy(0) });
  const atLimit = repo.run(await playedHq(undefined, { PLAYED_TIMED_OUT: '1' }), 'tests.ts', ['--helper']);
  assert.equal(atLimit.status, 1, atLimit.out);
  assert.match(atLimit.out, /^Tests failed: too slow for the helper's 30-minute limit on attic/m);
  assert.doesNotMatch(atLimit.out, /They run here instead|Tests passed:/);
});
