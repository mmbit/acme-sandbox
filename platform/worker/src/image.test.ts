// node --test platform/worker/src/image.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('worker memory evidence loads from its staged source without coordinator files or installed dependencies', t => {
  const staged = mkdtempSync(join(tmpdir(), 'worker-image-'));
  t.after(() => rmSync(staged, { recursive: true, force: true }));
  cpSync(new URL('../package.json', import.meta.url), join(staged, 'package.json'));
  cpSync(new URL('./', import.meta.url), join(staged, 'src'), {
    recursive: true,
    filter: path => !path.endsWith('.test.ts'),
  });
  const code = `
    const { admission } = await import('./src/admission.ts');
    const { overloadWatch } = await import('./src/overload.ts');
    const { roomRecords } = await import('./src/roomrecords.ts');
    if ([admission, overloadWatch, roomRecords].some(entry => typeof entry !== 'function')) process.exit(1);
    roomRecords();
  `;
  const loaded = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: staged,
    encoding: 'utf8',
  });
  assert.equal(loaded.status, 0, loaded.stderr);
  const parsed = spawnSync(process.execPath, ['--check', join(staged, 'src/worker.ts')], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
});
