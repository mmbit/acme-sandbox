// The tests' results HQ keeps: each push's tests (shared/gates/tests.ts) as the worker ran them, by the code they tested,
// so the same code is tested once. The key is the git tree of the pushed commit and of its base on main: the whole
// repository as tested and as compared with, so a change anywhere (another area a suite imports included) is new code.
// Only the worker records a push result. Base comparisons also require its signed ticket for that claimed push.
//
// Before a push's tests the worker claims their key (claimTests): a result kept already is the push's report; else the
// claim is the push's, or another push of the same code holds it and the worker waits for that one's result. A check
// that ends without a result (it couldn't run, or couldn't complete) gives its claim up (doneTests, passed null), and a
// claim whose job no longer runs is taken over. A kept result counts its tests onto the day
// (work.ts) and shows them as a step on its job's log.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { WORKER_TOKEN } from './config.ts';
import { db } from './db.ts';
import { publish } from './events.ts';
import * as jobs from './jobs.ts';
import * as work from './work.ts';

const TREE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

type Row = { tree: string; base: string; job: number; passed: number | null; report: string; at: string };
type Code = { tree: string; base: string; job: number };

const codeOf = (given: any): Code | undefined =>
  TREE.test(String(given?.tree)) && TREE.test(String(given?.base)) && jobs.jobAgent(Number(given?.job))
    ? { tree: given.tree, base: given.base, job: Number(given.job) }
    : undefined;

// { tree, base, job }: a kept result ({ kept: { passed, report, job } }), the claim (yours), or the job whose push holds
// it (running)
export function claimTests(given: unknown) {
  const code = codeOf(given);
  if (!code) return 400;
  const row = db.prepare('select * from test_results where tree = ? and base = ?').get(code.tree, code.base) as
    Row | undefined;
  if (row && row.passed !== null) return { kept: { passed: !!row.passed, report: row.report, job: row.job } };
  if (row && row.job !== code.job && db.prepare("select 1 from jobs where id = ? and status = 'running'").get(row.job))
    return { running: row.job };
  const now = new Date().toISOString();
  db.prepare(
    `insert into test_results (tree, base, job, at, began) values (?, ?, ?, ?, ?)
    on conflict (tree, base) do update set job = excluded.job, at = excluded.at,
      began = case when test_results.job = excluded.job then test_results.began
        else excluded.began end`,
  ).run(code.tree, code.base, code.job, now, now);
  return { yours: true };
}

// { tree, base, job, passed, report, tests }: the claimed check's result (passed: true or false, the tests that passed),
// kept; or passed null, the claim given up
export function doneTests(given: any) {
  const code = codeOf(given);
  if (!code) return 400;
  const claimed = [code.tree, code.base, code.job];
  if (given.passed === null) {
    const released = db
      .prepare('delete from test_results where tree = ? and base = ? and job = ? and passed is null')
      .run(...claimed).changes;
    if (released) releaseBaseTests(code.job);
    return { ok: true };
  }
  const { passed, report, tests } = given;
  if (typeof passed !== 'boolean' || typeof report !== 'string' || !Number.isSafeInteger(tests) || tests < 0)
    return 400;
  const kept = db
    .prepare(
      'update test_results set passed = ?, report = ?, at = ? where tree = ? and base = ? and job = ? and passed is null',
    )
    .run(passed ? 1 : 0, report, new Date().toISOString(), ...claimed).changes;
  if (kept) releaseBaseTests(code.job);
  if (kept && tests) {
    work.count({ tests });
    const agent = jobs.jobAgent(code.job);
    publish({ type: 'log', agent, text: `${tests} ${tests === 1 ? 'test' : 'tests'} passed`, tests }, 'agent');
  }
  return { ok: true };
}

// Only a worker-started check can compare its pinned base. Its ticket stays in the check's environment.
export function comparisonTicket(given: any) {
  const code = codeOf(given);
  if (!code || !TREE.test(String(given.commit))) return 400;
  return { ...code, commit: given.commit, signature: signComparison({ ...code, commit: given.commit }) };
}

// Claims are per base commit and test in its execution environment. A dead job's comparison can be taken over.
// The stored test identity pairs the environment and test name.
export function claimBaseTests(given: any, job: number) {
  const code = comparisonOf(given, job);
  if (!code) return 403;
  if (typeof given.environment !== 'string' || !given.environment) return 400;
  if (!Array.isArray(given.tests) || !given.tests.every((name: unknown) => typeof name === 'string' && name))
    return 400;
  return given.tests.map((name: string) => {
    const identity = JSON.stringify([given.environment, name]);
    const row = db
      .prepare('select job, failed from base_test_results where base = ? and test = ?')
      .get(code.commit, identity) as { job: number; failed: number | null } | undefined;
    if (row && row.failed !== null) return { test: name, failed: !!row.failed };
    if (row && row.job !== job && db.prepare("select 1 from jobs where id = ? and status = 'running'").get(row.job))
      return { test: name, running: row.job };
    db.prepare(
      `insert into base_test_results (base, test, job) values (?, ?, ?)
      on conflict (base, test) do update set job = excluded.job`,
    ).run(code.commit, identity, job);
    return { test: name, yours: true };
  });
}

export function doneBaseTests(given: any, job: number) {
  const code = comparisonOf(given, job);
  if (!code) return 403;
  if (typeof given.environment !== 'string' || !given.environment) return 400;
  if (
    !Array.isArray(given.tests) ||
    !given.tests.every(
      (test: any) =>
        typeof test?.test === 'string' && test.test && (test.failed === null || typeof test.failed === 'boolean'),
    )
  )
    return 400;
  for (const test of given.tests) {
    const claimed = [code.commit, JSON.stringify([given.environment, test.test]), job];
    if (test.failed === null)
      db.prepare('delete from base_test_results where base = ? and test = ? and job = ? and failed is null').run(
        ...claimed,
      );
    else
      db.prepare(
        'update base_test_results set failed = ? where base = ? and test = ? and job = ? and failed is null',
      ).run(test.failed ? 1 : 0, ...claimed);
  }
  return { ok: true };
}

function comparisonOf(given: any, job: number) {
  const code = codeOf(given);
  if (!code || code.job !== job || !TREE.test(String(given.commit)) || typeof given.signature !== 'string') return;
  const signature = Buffer.from(given.signature);
  const expected = Buffer.from(signComparison({ ...code, commit: given.commit }));
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return;
  const claimed = db
    .prepare('select 1 from test_results where tree = ? and base = ? and job = ? and passed is null')
    .get(code.tree, code.base, job);
  return claimed ? { ...code, commit: given.commit } : undefined;
}

function signComparison(code: Code & { commit: string }) {
  return createHmac('sha256', WORKER_TOKEN)
    .update(JSON.stringify([code.tree, code.base, code.job, code.commit]))
    .digest('hex');
}

function releaseBaseTests(job: number) {
  db.prepare('delete from base_test_results where job = ? and failed is null').run(job);
}
