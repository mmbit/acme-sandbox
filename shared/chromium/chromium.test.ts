// node --test shared/chromium/chromium.test.ts   (a failed start leaves no profile behind, and no Chromium is needed)
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ChromiumError, launch } from './chromium.ts';

const temp = mkdtempSync(join(tmpdir(), 'chromium-test-'));
const [path, tmp] = [process.env.CHROMIUM_PATH, process.env.TMPDIR];
process.env.TMPDIR = temp;
after(() => {
  process.env.CHROMIUM_PATH = path;
  process.env.TMPDIR = tmp;
  if (path === undefined) delete process.env.CHROMIUM_PATH;
  if (tmp === undefined) delete process.env.TMPDIR;
  rmSync(temp, { recursive: true, force: true });
});

for (const [what, chromium] of [
  ['not there', join(temp, 'no-chromium')],
  ['stopping at once', '/bin/false'],
]) {
  test(`a Chromium ${what} fails to start and leaves no profile`, async () => {
    process.env.CHROMIUM_PATH = chromium;
    // The profile is gone by the time launch() rejects. launch() removes it when Chromium never started, and the exit
    // handler removes it when Chromium started and stopped.
    await assert.rejects(launch(), ChromiumError);
    assert.deepEqual(readdirSync(temp), []);
  });
}
