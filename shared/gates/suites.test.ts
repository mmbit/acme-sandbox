// node --test shared/gates/suites.test.ts
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('a test that hangs holding a lock is ended at its timeout, everything it started with it, and the lock frees', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'suites-leftovers-'));
  const [lock, held] = [join(dir, 'lock'), join(dir, 'held')];
  writeFileSync(
    join(dir, 'hangs.test.mjs'),
    `import {test} from 'node:test'; import {spawn} from 'node:child_process'; import {existsSync} from 'node:fs';
    test('hangs holding the lock', {timeout: 1000}, async () => {
      spawn('flock', ['--exclusive', ${JSON.stringify(lock)}, 'sh', '-c', 'touch ${held}; sleep infinity'],
        {detached: true, stdio: 'ignore'});
      for (;;) await new Promise(resolve => setTimeout(resolve, existsSync(${JSON.stringify(held)}) ? 60_000 : 25));
    });`,
  );
  const [command, ...args] = SUITES.node.command(['hangs.test.mjs']);
  const began = Date.now();
  const run = spawn(command, args, {
    cwd: dir,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    stdio: 'ignore',
  });
  const code = await new Promise(resolve => run.once('exit', resolve));
  assert.notEqual(code, 0);
  assert.ok(Date.now() - began < 20_000, `${Date.now() - began} ms`);
  assert.equal(existsSync(held), true);
  assert.equal(spawnSync('flock', ['--nonblock', lock, 'true']).status, 0);
});
