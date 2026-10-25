// node --test src/pushchecks.test.ts   (real processes as this uid)
// A push's checks outlive the worker's process: a reload writes their record and goes, and the next process reports
// their outcome without running them again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { blockRun } from './blocks.ts';
import { processesFor, type ProcessSnapshot } from './shares.ts';
import {
  alive,
  procStat,
  keepRecord,
  launch,
  records,
  type Checks,
  type Launched,
  type RunRecord,
} from './detached.ts';
import type { CheckOptions, CheckOutcome, CheckSpec, TestsClaim, TestsOnce, TestsOutcome } from './pushchecks.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (done: () => boolean, what: string) => {
  for (const end = Date.now() + 10_000; !done(); await sleep(20))
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
};
// A worker process's own copy of the module (its inChecks), as a reload's next process has a fresh one
let processes = 0;
const workerProcess = async () =>
  (await import(`./pushchecks.ts?process=${++processes}`)) as typeof import('./pushchecks.ts');

// A stand-in check: a shell script, launched as worker.ts launches one, each launch counted in the folder's `launches`
function stand(dir: string, name: string, script: string): CheckSpec {
  return {
    name,
    launch: (): Launched => {
      writeFileSync(`${dir}/launches`, `${name}\n`, { flag: 'a' });
      const { child, launched } = launch(dir, `8.${name}`, 'sh', ['-c', script, 'sh', dir], {
        env: { PATH: process.env.PATH },
      });
      child.on('error', () => {});
      child.stdin!.end();
      child.unref();
      return launched;
    },
  };
}
// A lent launch of the gates, stopped at its own `ms`
const lentOf = (dir: string, script: string, ms: number) => ({ ms, launch: stand(dir, 'gates-lent', script).launch });
const launches = (dir: string) => (existsSync(`${dir}/launches`) ? readFileSync(`${dir}/launches`, 'utf8') : '');
const options = (dir: string, said: string[]): CheckOptions => ({
  runs: dir,
  keep: checks => keepRecord(dir, { ...base(dir), checks }),
  watch: () => {},
  unwatch: () => {},
  said: (name, words) => said.push(`${name} ${words.replace(/ in \d+ s$/, '')}`),
});
const base = (dir: string): RunRecord => ({
  job: { id: 8, session: null },
  seat: 'claude-1',
  slot: 'claude#1',
  resumed: false,
  launched: { pid: 1, start: '1', out: `${dir}/8.out`, err: `${dir}/8.err` },
  read: { out: 0, err: 0 },
});
const pushed = () => ({ status: 'done', pr: 41, sha: 'abc123', files: ['a.ts'] });

test('a reload in the checks: the record is written at once, and the next process reports their outcome without running them again', async () => {
  const dir = mkdtempSync(`${tmpdir()}/pushchecks-test-`);
  const gates = 'echo "gates: clean"';
  const tests = 'echo started >> "$1/tests-ran"; while [ ! -f "$1/go" ]; do sleep 0.05; done; echo "2 failing"; exit 1';
  // the first process: its push done, its checks launched
  const first = await workerProcess(),
    firstSaid: string[] = [];
  const checks: Checks = { body: pushed(), spent: { usage: { input: 7 }, delegated: false }, runs: {} };
  void first.runChecks(8, checks, [stand(dir, 'gates', gates), stand(dir, 'tests', tests)], options(dir, firstSaid));
  await until(() => existsSync(`${dir}/tests-ran`), 'the tests started');
  // the reload: the run is steady as it stands (handOver doesn't wait for it), and its record is written as it goes
  assert.ok(first.inChecks.has(8));
  first.inChecks.get(8)!();
  // the next process takes it over from its record
  const [r] = records(dir, () => {});
  assert.deepEqual(r.checks!.body, pushed());
  assert.deepEqual(r.checks!.spent, { usage: { input: 7 }, delegated: false });
  assert.deepEqual(Object.keys(r.checks!.runs).sort(), ['gates', 'tests']);
  const next = await workerProcess(),
    said: string[] = [];
  const turns: string[] = [];
  const reporting = next.runChecks(
    8,
    r.checks!,
    [
      stand(dir, 'gates', gates),
      { ...stand(dir, 'tests', tests), turn: (f: () => Promise<CheckOutcome>) => (turns.push('tests'), f()) },
    ],
    options(dir, said),
  );
  await sleep(300);
  assert.ok(next.inChecks.has(8), 'still waiting for the tests');
  writeFileSync(`${dir}/go`, '');
  const report = await reporting;
  assert.deepEqual(report, {
    ...pushed(),
    gates: { passed: true, report: 'gates: clean' },
    tests: { passed: false, report: '2 failing' },
  });
  assert.equal(launches(dir), 'gates\ntests\n', 'each launched once, by the first process');
  assert.deepEqual(turns, ['tests'], 'the running tests take their place in the turns, still counted');
  assert.equal(readFileSync(`${dir}/tests-ran`, 'utf8'), 'started\n', 'the tests ran once');
  assert.deepEqual(said.sort(), ['gates passed', 'tests failed']);
  assert.ok(!next.inChecks.has(8));
  rmSync(dir, { recursive: true });
});

test('a check cut before its end was seen runs again, and one still waiting for its turn starts in the next process', async () => {
  const dir = mkdtempSync(`${tmpdir()}/pushchecks-test-`);
  // gates launched by a process the container stop took with it: not running, and no end in its marker
  const cut: Launched = { pid: 2 ** 22 + 1, start: '1', out: `${dir}/8.gates.out`, err: `${dir}/8.gates.err` };
  writeFileSync(cut.out, 'half a report');
  const checks: Checks = {
    body: pushed(),
    spent: {},
    runs: { gates: { launched: cut, began: Date.now() - 60_000, stopped: [] } },
  };
  const next = await workerProcess(),
    said: string[] = [];
  const turns: string[] = [];
  const tests = {
    ...stand(dir, 'tests', 'echo ok'),
    turn: (f: () => Promise<CheckOutcome>) => (turns.push('tests'), f()),
  };
  const report = await next.runChecks(8, checks, [stand(dir, 'gates', 'echo clean'), tests], {
    ...options(dir, said),
    wait: () => sleep(5),
  });
  assert.deepEqual(report, {
    ...pushed(),
    gates: { passed: true, report: 'clean' },
    tests: { passed: true, report: 'ok' },
  });
  assert.equal(launches(dir).split('\n').sort().join(' '), ' gates tests');
  assert.deepEqual(turns, ['tests'], 'the tests waited for their turn here');
  assert.deepEqual(said.sort(), [
    'gates cut before its end was seen, so it runs again',
    'gates passed',
    'tests passed',
  ]);
  rmSync(dir, { recursive: true });
});

test("a check sent to a lent machine first: a verdict there is the check's, and with none it launches here", async () => {
  const dir = mkdtempSync(`${tmpdir()}/pushchecks-test-`);
  const here = stand(dir, 'gates', 'sleep 0.6; echo clean');
  const passedThere = { ...here, lent: lentOf(dir, 'echo "clean (on attic)"', 1000) };
  const said: string[] = [];
  const there = await (
    await workerProcess()
  ).runChecks(8, { body: pushed(), spent: {}, runs: {} }, [passedThere], options(dir, said));
  assert.deepEqual(there.gates, { passed: true, report: 'clean (on attic)' });
  assert.equal(launches(dir), 'gates-lent\n');
  // stopped at its limit, it takes a while to end (its run stopped on HQ), and then the run here goes to its end
  const slow = 'trap "sleep 0.8; exit 2" TERM; while :; do sleep 0.05; done';
  const handedBack = { ...here, lent: lentOf(dir, slow, 300) };
  const checks: Checks = { body: pushed(), spent: {}, runs: {} };
  const report = await (await workerProcess()).runChecks(8, checks, [handedBack], options(dir, said));
  assert.deepEqual(report.gates, { passed: true, report: 'clean' });
  assert.equal(launches(dir), 'gates-lent\ngates-lent\ngates\n');
  assert.ok(said.includes('gates had no verdict from the lent machine, so it runs here'), said.join('; '));
  rmSync(dir, { recursive: true });
});

test('a check that lost HQ (exit 3) waits until HQ answers and runs again on the same commit, never counted; three in a row, and the next counts', async () => {
  const dir = mkdtempSync(`${tmpdir()}/pushchecks-test-`);
  // unreached on its first launch, passing on its second
  const flaky =
    'if [ -f "$1/tried" ]; then echo clean; else touch "$1/tried"; echo "The tests could not reach HQ"; exit 3; fi';
  const said: string[] = [];
  let asked = 0;
  const waiting = { ...options(dir, said), reachable: async () => void asked++ };
  const report = await (
    await workerProcess()
  ).runChecks(8, { body: pushed(), spent: {}, runs: {} }, [stand(dir, 'tests', flaky)], waiting);
  assert.deepEqual(report.tests, { passed: true, report: 'clean' });
  assert.equal(launches(dir), 'tests\ntests\n');
  assert.equal(asked, 1, 'it waited for HQ before it ran again');
  assert.deepEqual(said, [
    'tests could not reach HQ',
    'tests lost HQ, so it runs again on the same commit once HQ answers',
    'tests passed',
  ]);
  // HQ answering the worker but never the check: past UNREACHED_TRIES it's one that couldn't run
  rmSync(`${dir}/launches`);
  const never = await (
    await workerProcess()
  ).runChecks(8, { body: pushed(), spent: {}, runs: {} }, [stand(dir, 'tests', 'echo lost; exit 3')], waiting);
  assert.deepEqual(never.tests, { passed: null, report: 'lost' });
  assert.equal(launches(dir), 'tests\n'.repeat(4));
  rmSync(dir, { recursive: true });
});

test("a lent check that lost HQ runs again on the lent machine; past UNREACHED_TRIES it runs here, and one that still loses HQ couldn't run", async () => {
  const dir = mkdtempSync(`${tmpdir()}/pushchecks-test-`);
  const said: string[] = [];
  const waiting = { ...options(dir, said), reachable: async () => {} };
  const lostOnce =
    'if [ -f "$1/tried" ]; then echo "clean (on attic)"; else touch "$1/tried"; echo "could not reach HQ"; exit 3; fi';
  const there = await (
    await workerProcess()
  ).runChecks(
    8,
    { body: pushed(), spent: {}, runs: {} },
    [{ ...stand(dir, 'gates', 'echo here'), lent: lentOf(dir, lostOnce, 10_000) }],
    waiting,
  );
  assert.deepEqual(there.gates, { passed: true, report: 'clean (on attic)' });
  assert.equal(launches(dir), 'gates-lent\ngates-lent\n');
  rmSync(`${dir}/launches`);
  const never = await (
    await workerProcess()
  ).runChecks(
    8,
    { body: pushed(), spent: {}, runs: {} },
    [{ ...stand(dir, 'gates', 'echo lost here; exit 3'), lent: lentOf(dir, 'echo lost; exit 3', 10_000) }],
    waiting,
  );
  assert.deepEqual(never.gates, { passed: null, report: 'lost here' });
  assert.equal(launches(dir), 'gates-lent\n'.repeat(4) + 'gates\n');
  rmSync(dir, { recursive: true });
});

test("a reload keeps a lent launch's own limit, whatever the spec the next process builds", async () => {
  const dir = mkdtempSync(`${tmpdir()}/pushchecks-test-`);
  const there = 'echo started > "$1/lent-ran"; while [ ! -f "$1/go" ]; do sleep 0.05; done; echo "clean (on attic)"';
  const here = stand(dir, 'gates', 'echo here');
  // the first process, with a helper: the gates sent to it, and the record written as the reload goes
  const first = await workerProcess();
  const checks: Checks = { body: pushed(), spent: {}, runs: {} };
  const lent = { ...here, lent: lentOf(dir, there, 10_000) };
  void first.runChecks(8, checks, [lent], options(dir, []));
  await until(() => existsSync(`${dir}/lent-ran`), 'the lent launch started');
  first.inChecks.get(8)!();
  const [r] = records(dir, () => {});
  // the next finds no helper, and builds the spec here alone: the lent launch goes on to its verdict
  const said: string[] = [];
  const reporting = (await workerProcess()).runChecks(8, r.checks!, [here], options(dir, said));
  await sleep(600);
  writeFileSync(`${dir}/go`, '');
  const report = await reporting;
  assert.deepEqual(report.gates, { passed: true, report: 'clean (on attic)' });
  assert.equal(launches(dir), 'gates-lent\n');
  assert.deepEqual(said, ['gates passed']);
  rmSync(dir, { recursive: true });
});

test('a push check keeps its worker stop reason even when HQ cannot confirm the block report', async context => {
  for (const confirmed of [true, false])
    await context.test(confirmed ? 'HQ confirms' : 'HQ reply lost', async () => {
      const dir = mkdtempSync(`${tmpdir()}/pushchecks-test-`);
      const said: string[] = [],
        stoppedLog: string[] = [];
      const checks: Checks = { body: pushed(), spent: {}, runs: {} };
      const commandValue = 'fixture-argument-' + 'v'.repeat(400);
      writeFileSync(
        `${dir}/command.cjs`,
        `require('node:fs').writeFileSync(process.argv[2], 'ready'); setTimeout(() => {}, 30000);`,
      );
      const checking = new Map<number, string[]>();
      const owner = { job: 8, uid: process.getuid!(), gid: process.getgid!() };
      let stopping: Promise<void> | undefined, failure: Error | undefined;
      let run: ProcessSnapshot[] = [];
      const report = await (
        await workerProcess()
      ).runChecks(
        8,
        checks,
        [
          stand(
            dir,
            'tests',
            `sh -c 'node "$1/command.cjs" "$1/ready" "$2" & wait' sh "$1" "${commandValue}"; echo ok`,
          ),
        ],
        {
          ...options(dir, said),
          watch: (pid, stopped) => {
            checking.set(pid, stopped);
            if (stopping) return;
            stopping = (async () => {
              await until(() => existsSync(`${dir}/ready`), 'check child ready');
              const procs = await processesFor([owner]);
              const root = procs.find(p => p.ppid === pid && p.comm === 'sh')!;
              assert.ok(root, 'the check runs a child command');
              run = procs.filter(p => p.pid === root.pid || p.ppid === root.pid);
              await blockRun(owner, { uid: owner.uid, measure: 'memory', used: 3100, share: 2560, root, run }, procs, {
                checking,
                stopped: text => stoppedLog.push(text),
                ask: async body => {
                  assert.equal(typeof body.event, 'string', 'the blocked delivery has an identity');
                  assert.ok(
                    String(body.command).includes(commandValue),
                    'HQ receives the full value before redaction and shortening',
                  );
                  await until(
                    () => run.every(p => procStat(p.pid)?.state === 'T'),
                    'the command tree is frozen while reporting',
                  );
                  assert.match(stopped[0], /the worker blocked its run/);
                  if (!confirmed) throw new TypeError('fetch failed');
                  return { text: 'HQ stopped this command. Offload it.' };
                },
              });
            })().catch(err => {
              failure = err;
            });
          },
          unwatch: pid => {
            checking.delete(pid);
          },
        },
      );
      await stopping;
      const outcome = report.tests as CheckOutcome;
      assert.equal(outcome.passed, null, 'the parent exits zero but this check could not complete');
      assert.match(outcome.report, /Could not complete: the worker blocked its run/);
      assert.match(outcome.report, /3,?100 MB.*2,?560 MB/);
      assert.match(outcome.report, /ok/);
      assert.equal(stoppedLog.length, 1, 'the worker records the stop even without a reply');
      assert.ok(!stoppedLog.join().includes(commandValue), 'the worker log never includes the command');
      assert.ok(run.length >= 2 && run.every(p => !alive(p.pid, p.start)), 'the whole tree ends');
      if (confirmed) assert.equal(failure, undefined);
      else assert.match(String(failure), /block report outcome is unknown.*may have recorded it/);
      rmSync(dir, { recursive: true });
    });
});

// ---- the tests, once on the same code

// HQ's claims as testsOnce meets them, one answer after another, and what it was told
function playedClaims(...answers: (TestsClaim | Error)[]) {
  const said: string[] = [];
  const o: TestsOnce = {
    claim: async () => {
      const answer = answers.shift()!;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    done: async () => {},
    wait: async () => {},
    later: async () => said.push('(later)'),
    said: words => said.push(words),
  };
  return { o, said };
}
const ran: TestsOutcome = { passed: true, report: 'Tests passed: 1 area against origin/main, 4 s', tests: 4 };

test("a push of code already tested runs nothing and reports the kept result, after the push that held it, and a claim HQ couldn't take runs nothing either", async () => {
  const { testsOnce } = await workerProcess();
  let runs = 0;
  const run = async () => (runs++, ran);
  const kept = { kept: { passed: false, report: 'Tests failed: 1 test', job: 41 } };
  const waited = playedClaims({ running: 41 }, kept);
  assert.deepEqual(await testsOnce(run, waited.o), {
    passed: false,
    report: "Tests kept from job #41's push of the same code, not run again:\nTests failed: 1 test",
  });
  const refused = playedClaims(new Error('HQ answered 400'));
  assert.deepEqual(await testsOnce(run, refused.o), {
    passed: null,
    report: "The tests' claim in HQ couldn't be made: HQ answered 400",
  });
  assert.deepEqual(refused.said, []);
  const away = playedClaims(new TypeError('fetch failed'), new TypeError('fetch failed'));
  assert.deepEqual(await testsOnce(run, away.o), {
    passed: null,
    report: "The tests' claim in HQ couldn't be made: fetch failed",
  });
  assert.equal(runs, 0);
});

test("a claim that didn't reach HQ (it was restarting) is made once more a little later, and the tests run then", async () => {
  const { testsOnce } = await workerProcess();
  let runs = 0;
  const run = async () => (runs++, ran);
  const back = playedClaims(new TypeError('fetch failed'), { yours: true });
  assert.deepEqual(await testsOnce(run, back.o), { passed: true, report: ran.report });
  assert.equal(runs, 1);
  assert.deepEqual(back.said, ["claim didn't reach HQ (fetch failed), made again a little later", '(later)']);
});

test("a result HQ didn't keep leaves the push's outcome as the run gave it, its report saying so", async () => {
  const { testsOnce } = await workerProcess();
  const failed: TestsOutcome = { passed: false, report: 'Tests failed: 1 test the change breaks', tests: 3 };
  for (const outcome of [ran, failed]) {
    const { o } = playedClaims({ yours: true });
    o.done = async () => {
      throw new Error('HQ answered 500');
    };
    assert.deepEqual(await testsOnce(async () => outcome, o), {
      passed: outcome.passed,
      report: `HQ didn't keep the result (HQ answered 500), so the next push of this code runs them again.\n\n${outcome.report}`,
    });
  }
});
