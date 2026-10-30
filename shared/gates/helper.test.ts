// node --test shared/gates/helper.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

test('browser test areas receive executable runtime assets and their shared libraries, while other areas do not', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tests-browsers-'));
  const browsers = join(directory, 'ms-playwright');
  const shell = 'chromium_headless_shell-fixture/chrome-headless-shell-linux64/chrome-headless-shell';
  mkdirSync(join(browsers, shell, '..'), { recursive: true });
  cpSync('/bin/true', join(browsers, shell));
  for (const name of ['chromium-fixture', 'ffmpeg-fixture']) {
    mkdirSync(join(browsers, name));
    cpSync('/bin/true', join(browsers, name, 'unused'));
  }
  writeFileSync(join(browsers, shell, '..', 'runtime-resource'), 'needed by the shell');
  const env = { ...(await playedHq()), TESTS_BROWSERS_PATH: browsers };
  const bootstrap = {
    'shared/gates/tests-on-helper.sh':
      'export BROWSER_ASSETS="$PWD/../ms-playwright" BROWSER_LIBRARIES="$PWD/../tools"\n' + ON_HELPER,
  };
  const check = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
test('the bundled runtime starts with its libraries', () => {
  const assets = process.env.BROWSER_ASSETS;
  const tools = process.env.BROWSER_LIBRARIES;
  assert.ok(existsSync(tools + '/libc.so.6'));
  assert.ok(existsSync(assets + '/chromium_headless_shell-fixture/chrome-headless-shell-linux64/runtime-resource'));
  assert.equal(existsSync(assets + '/chromium-fixture'), false);
  assert.equal(existsSync(assets + '/ffmpeg-fixture'), false);
  execFileSync(assets + '/${shell}', { env: { LD_LIBRARY_PATH: tools } });
});
`;
  const browser = clone(
    { ...bootstrap, 'platform/coordinator/browser.test.ts': check },
    { 'platform/coordinator/notes.md': 'touched\n' },
  ).run(env, 'tests.ts', ['--helper']);
  assert.equal(browser.status, 0, browser.out);
  assert.match(browser.out, /1 passed/);
  assert.doesNotMatch(browser.out, /failing|flaky/);
  for (const area of ['kits/adds', 'shared/chromium', 'shared/watchalong']) {
    const ordinary = clone(
      {
        ...bootstrap,
        [area + '/sum.ts']: sum('a + b'),
        [area + '/sum.test.ts']: nodeTest('sums', 'assert.equal(sum(1, 2), 3);'),
      },
      { [area + '/notes.md']: 'touched\n' },
    ).run({ ...env, TESTS_BROWSERS_PATH: join(directory, 'absent') }, 'tests.ts', ['--helper']);
    assert.equal(ordinary.status, 0, ordinary.out);
    assert.match(ordinary.out, /1 passed/);
  }
});

test('a missing required tool stops helper bundling instead of counting as a failure shared with main', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'tests-missing-tool-'));
  for (const tool of ['age', 'age-keygen', 'versitygw'])
    writeFileSync(join(bin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const { run } = clone(
    {
      'shared/gates/tests-on-helper.sh': ON_HELPER,
      'infra/test_caddy.sh': 'caddy\n',
    },
    { 'infra/notes.md': 'touched\n' },
  );
  const ran = run({ ...(await playedHq()), TESTS_TOOLS_BIN: bin }, 'tests.ts', ['--helper']);
  assert.equal(ran.status, 2, ran.out);
  assert.match(ran.out, /ENOENT.*caddy/);
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

test('a base comparison waits past takeMinutes for the busy helper, classifies its outcomes there and still blocks a regression', async () => {
  const { env, repo } = await helperFailureCase({
    HELPER_TAKE_MINUTES: '0.001',
    RUN_STATES: JSON.stringify([
      [{ state: 'done', machine: 'attic' }],
      [
        { state: 'waiting', machine: 'attic' },
        { state: 'waiting', machine: 'attic' },
        { state: 'done', machine: 'attic' },
      ],
    ]),
  });
  const existing = repo.run(env, 'tests.ts', ['--helper']);
  assert.equal(existing.status, 0, existing.out);
  assert.match(existing.out, /Failing on main too: .*helper-only failure/);
  repo.change({ 'kits/adds/sum.ts': sum('a * b') });
  const broken = repo.run(env, 'tests.ts', ['--helper']);
  assert.equal(broken.status, 1, broken.out);
  assert.match(broken.out, /1 failing, 1 failing on main too/);
});

test('an unavailable or different comparison helper leaves the check incomplete without local fallback', async () => {
  for (const states of [
    [{ state: 'lost', machine: 'elsewhere' }],
    [{ state: 'done', machine: 'elsewhere' }],
    [{ state: 'waiting', machine: 'attic', helperPresent: false }],
  ]) {
    const { env, repo } = await helperFailureCase({
      HELPER_TAKE_MINUTES: '0.001',
      RUN_STATES: JSON.stringify([[{ state: 'done', machine: 'attic' }], states]),
    });
    const ran = repo.run(env, 'tests.ts', ['--helper']);
    assert.equal(ran.status, 2, ran.out);
    assert.match(ran.out, /The tests could not run:/);
    assert.doesNotMatch(ran.out, /Tests passed:|Tests failed:|They run here instead/);
  }
});

test('a second helper upload survives an archive that outlasts the connection idle time', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'tests-archive-'));
  const tar = execFileSync('which', ['tar'], { encoding: 'utf8' }).trim();
  // Node's server closes idle connections after five seconds. The archive takes one second longer
  writeFileSync(
    join(bin, 'tar'),
    `#!/bin/sh
for argument in "$@"; do
  if [ "\${argument##*/}" = 'bundle.tar.gz' ]; then sleep 6; fi
done
exec ${tar} "$@"
`,
    { mode: 0o755 },
  );
  const { env, repo } = await helperFailureCase({ KEEP_ALIVE: '1', PATH: `${bin}:${process.env.PATH}` });
  const ran = repo.run(env, 'tests.ts', ['--helper']);
  assert.equal(ran.status, 0, ran.out);
  assert.match(ran.out, /Failing on main too:/);
});

async function helperFailureCase(settings: NodeJS.ProcessEnv = {}) {
  const env = await playedHq(undefined, {
    ...settings,
    HELPER_ENV: JSON.stringify({ TEST_ROOM: 'helper' }),
  });
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
  return { env, repo };
}

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

// The check waiting on its helper (up to half an hour) holds the worker's memory all that time, so it must never keep
// the bundle it sent: lentsend.ts sends it from a process that ends with the send.
// Here a ~24 MB bundle (32 MB of base64, which git compresses), which the check sending it itself would hold all of
test("a check waiting on its helper doesn't hold the bundle it sent: the upload's own process ends with the send", async () => {
  const peak = [
    "import { readFileSync } from 'node:fs';",
    "import { onLent } from './lent.ts';",
    "import { git } from './repo.ts';",
    "const kb = (field: string) => Number(readFileSync('/proc/self/status', 'utf8').match(new RegExp(field + ':\\\\s+(\\\\d+)'))![1]);",
    "const root = process.cwd(), before = kb('VmRSS');",
    "const check = { what: 'Peak', script: 'peak', args: [], minutes: 1, bring: [], tools: [] };",
    "const ran = await onLent(root, { ...check, base: git(root, 'rev-parse', 'main').trim(), tree: git(root, 'rev-parse', 'HEAD^{tree}').trim() });",
    "console.log(JSON.stringify({ output: ran?.output, grewMb: (kb('VmHWM') - before) / 1024 }));",
  ].join('\n');
  const { run } = clone(
    { 'shared/gates/peak.ts': peak, 'shared/gates/tests-on-helper.sh': 'echo "ran $1"\n' },
    { 'big.txt': randomBytes(24 * 2 ** 20).toString('base64') },
  );
  const ran = run(await playedHq(), 'peak.ts');
  assert.equal(ran.status, 0, ran.out);
  const { output, grewMb } = JSON.parse(ran.out.trim().split('\n').at(-1)!);
  assert.equal(output, 'ran peak\n');
  assert.ok(grewMb < 16, `the check's peak grew ${grewMb} MB while it sent the bundle`);
});
