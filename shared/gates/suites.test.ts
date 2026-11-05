// node --test shared/gates/suites.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SUITES } from './suites.ts';

const concurrency = (serial?: boolean) =>
  SUITES.node.command(['a.test.ts'], serial).find(arg => arg.startsWith('--test-concurrency='));

test("a push's tests the worker runs on itself take at most TESTS_CONCURRENCY files at once; a second run of a failure, one", () => {
  const before = process.env.TESTS_CONCURRENCY;
  try {
    process.env.TESTS_CONCURRENCY = '1';
    assert.equal(concurrency(), '--test-concurrency=1');
    delete process.env.TESTS_CONCURRENCY;
    assert.notEqual(concurrency(), undefined);
    assert.equal(concurrency(true), '--test-concurrency=1');
  } finally {
    if (before === undefined) delete process.env.TESTS_CONCURRENCY;
    else process.env.TESTS_CONCURRENCY = before;
  }
});
