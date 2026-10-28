// A push's tests run apart from its job's clone: in a clone of the mirror at the pushed commit, made after the session as
// the job's user (git.ts checkout), with a home and temporary folder of its own and the git that pinnedGitEnv allows.
// Nothing the session left (its clone's git config, attributes or replacement refs, files it didn't commit, its home's
// settings) decides what they test or how: the runner and the suites it picks are the pushed commit's, against its base
// on main. Made when the tests first need it, it's kept until the push's checks end, so tests that outlive a reload
// still have it; an ended job's goes with its other folders (worker.ts sweepEnded). (moved out of worker.ts, and taken back from root after a reload)
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { pinnedGitEnv, type Agent } from './git.ts';
import type { CheckOutcome, TestsOutcome } from './pushchecks.ts';
import { readAs } from './signin.ts';
import { makeDir, own } from './slots.ts';

// The job's side of git (git.ts forAgent): commands as its user, and the mirror's clone at a commit.
type AgentGit = { as: (cmd: string, args: string[]) => unknown; checkout: (dir: string, sha: string) => void };
type Tested = { sha: string; base: string; tree: string; baseTree: string }; // (git.ts testedCode)

// The checkout of job `id`'s tested commit under `testedDir` (the worker's /work/tests), for the job's user `me`.
export function testsCheckout(testedDir: string, id: number, me: Agent, g: AgentGit, tested: Tested) {
  const top = `${testedDir}/${id}`,
    at = `${top}/${tested.sha}`,
    outcomes = `${at}/outcomes.json`;
  const made = () => {
    if (!existsSync(at)) {
      execFileSync('rm', ['-rf', '--', top]);
      makeDir(top, me);
      g.as('mkdir', [`${top}/new`, `${top}/new/home`, `${top}/new/tmp`]);
      g.checkout(`${top}/new/repo`, tested.sha);
      g.as('mv', ['-T', `${top}/new`, at]);
    } else if (statSync(top).uid !== me.uid) {
      // One a run before a reload made: root's since (worker.ts takeVolumes parks every job's folders not taken over,
      // and a carry's checks keep no run record to be taken over by), or another slot's. The job's run takes it, as
      // its clone and home.
      own([top], me);
    }
    return { cwd: `${at}/repo`, env: { ...me.env, HOME: `${at}/home`, TMPDIR: `${at}/tmp`, ...pinnedGitEnv } };
  };
  return {
    tested,
    args: ['--commit', tested.sha, '--outcomes', outcomes],
    made,
    // (made, without what an earlier launch's tests said)
    launching: () => {
      const where = made();
      g.as('rm', ['-f', outcomes]);
      return where;
    },
    // What the tests that ran said, with the tests that passed as their --outcomes file has them: none from a branch
    // from before it. One that isn't a count leaves the tests not run, and nothing of them goes to HQ.
    counted: (outcome: CheckOutcome): TestsOutcome => {
      const told = outcome.passed === null ? undefined : readAs(me, outcomes);
      const tests = told === undefined ? 0 : countIn(told);
      if (Number.isSafeInteger(tests) && (tests as number) >= 0) return { ...outcome, tests: tests as number };
      return {
        passed: null,
        report: `The tests ran, but their --outcomes file doesn't count the tests that passed, so they're not kept.\n\n${outcome.report}`,
        tests: 0,
      };
    },
  };
}
export type TestsCheckout = ReturnType<typeof testsCheckout>;

const countIn = (told: string) => {
  try {
    return (JSON.parse(told) as { passed?: unknown }).passed;
  } catch {
    return undefined;
  }
};
