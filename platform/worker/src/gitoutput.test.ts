// node --test src/gitoutput.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, execFileAsync, GitOutputLimitError } from './gitoutput.ts';

test('git adapters honor caller output limits for string and Buffer output', async () => {
  const args = ['-e', 'process.stdout.write("x".repeat(8192))'];
  assert.throws(() => execFileSync(process.execPath, args, { maxBuffer: 1024 }), GitOutputLimitError);
  assert.throws(() => execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1024 }), GitOutputLimitError);
  assert.throws(() => spawnSync(process.execPath, args, { maxBuffer: 1024 }), GitOutputLimitError);
  assert.throws(() => spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1024 }), GitOutputLimitError);
  await assert.rejects(
    () => execFileAsync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1024 }),
    GitOutputLimitError,
  );
  assert.equal(execFileSync(process.execPath, args).length, 8192);
  assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).stdout.length, 8192);
});
