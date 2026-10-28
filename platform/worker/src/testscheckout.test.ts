// node --test src/testscheckout.test.ts   (a local bare repo stands in for GitHub.
//   The uid test needs root: run it in the worker container, `docker compose exec worker node --test
//   /work/code/current/src/testscheckout.test.ts`; elsewhere it's skipped and says so)
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gitFlow, type Agent } from './git.ts';
import { TEST_IDS, own, rootDir } from './slots.ts';
import { testsCheckout } from './testscheckout.ts';

const ROOT = process.getuid!() === 0;
const needsRoot = ROOT ? false : 'needs root to switch uids (run it in the worker container)';
const tmp = mkdtempSync(`${tmpdir()}/testscheckout-`);
chmodSync(tmp, 0o755); // (the slots read the mirror, as they read the worker's)
after(() => rmSync(tmp, { recursive: true, force: true }));
const id = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (...args: string[]) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    env: { ...process.env, ...id },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

// "GitHub": main with a commit main took outside a pull request on top of its first.
const github = `${tmp}/github.git`,
  seed = `${tmp}/seed`;
git('init', '-q', '--bare', '-b', 'main', github);
git('clone', '-q', github, seed);
for (const [file, words] of [
  ['README.md', 'hi\n'],
  ['direct.md', 'straight onto main\n'],
]) {
  writeFileSync(`${seed}/${file}`, words);
  git('-C', seed, 'add', '-A');
  git('-C', seed, 'commit', '-qm', file);
}
git('-C', seed, 'push', '-q', 'origin', 'HEAD:main');
const flow = gitFlow({ mirror: `${tmp}/mirror.git`, remote: github, base: 'main', clones: () => [] });
flow.ensureMirror();
flow.fetchMirror();
const carry = flow.testedCode(git('-C', seed, 'rev-parse', 'HEAD'), 'parent');

const agent = (ids: { uid?: number; gid?: number }): Agent => ({
  ...ids,
  env: { PATH: process.env.PATH!, HOME: '/nonexistent' },
});
// One run of a job's checks: its tests launched once in the checkout (made by the first), with what they said left after.
function run(tested: string, me: Agent) {
  const at = testsCheckout(tested, 21607, me, flow.forAgent(me), carry);
  const { cwd } = at.launching();
  const outcomes = at.args[at.args.indexOf('--outcomes') + 1];
  execFileSync('sh', ['-c', 'echo \'{"passed":3}\' > "$1"', 'sh', outcomes], { ...me, env: me.env });
  return { cwd, outcomes, counted: at.counted({ passed: true, report: 'ok' }) };
}

test("a carry's next run, after a reload, takes its tests' checkout as it is, without the last launch's outcomes", () => {
  const tested = `${tmp}/plain`;
  mkdirSync(tested);
  const me = agent({ uid: process.getuid!(), gid: process.getgid!() });
  const first = run(tested, me);
  assert.equal(readFileSync(`${first.cwd}/direct.md`, 'utf8'), 'straight onto main\n');
  assert.equal(first.counted.tests, 3);
  writeFileSync(`${first.cwd}/built.txt`, 'what the first run built\n');

  const at = testsCheckout(tested, 21607, me, flow.forAgent(me), carry);
  assert.equal(at.launching().cwd, first.cwd);
  assert.ok(!existsSync(first.outcomes), "the last launch's outcomes are gone");
  assert.ok(existsSync(`${first.cwd}/built.txt`), 'the checkout is the same one, not made again');
});

// #21607: a carry's checks keep no run record, so the reload's takeVolumes parked the checkout root's (0700), and the next
// run's `rm -f outcomes.json` as its slot was refused.
test("a checkout a reload parked root's goes to the slot of the job's next run", { skip: needsRoot }, () => {
  const [A, B] = TEST_IDS;
  const tested = `${tmp}/tests`;
  rootDir(tested, 0o711);
  // (the worker's own mirror is a safe.directory for every slot, the Dockerfile's; this one is A's, who clones it)
  execFileSync('chown', ['-R', `${A.uid}:${A.gid}`, '--', `${tmp}/mirror.git`]);
  const first = run(tested, agent(A));
  own([`${tested}/21607`], { uid: 0, gid: 0 }); // (as worker.ts takeVolumes parks a job's folders not taken over)

  const next = run(tested, agent(B));
  assert.equal(next.cwd, first.cwd);
  assert.equal(next.counted.tests, 3);
  assert.equal(statSync(`${tested}/21607`).uid, B.uid);
  assert.equal(statSync(next.cwd).uid, B.uid);
});
