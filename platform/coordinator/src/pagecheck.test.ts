// node --test src/pagecheck.test.ts
// The deploy's page check (pagecheck.ts) through GET /health/page: HQ as it is passes, and HQ with a module that no longer
// exports what the page imports doesn't. A file in the test company's theme/hq stands in for the foundation's of the same
// name (files.ts hqDir), so it breaks the page for this test alone.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { playwright } from '../../../shared/browser/browser.mjs';
import { harness } from './harness.ts';

// (the push checks have Playwright's Chromium: hqloads.test.ts)
process.env.CHROMIUM_PATH ??= playwright().chromium.executablePath();
let theme = '';
const h = await harness('pagecheck', {
  before: repo => mkdirSync((theme = join(repo, 'theme/hq/shell')), { recursive: true }),
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
test.after(() => h.server?.closeAllConnections());

const checked = async () => {
  const res = await fetch(`${h.base}/health/page`, {
    headers: { authorization: `Bearer ${process.env.WORKER_TOKEN}` },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { checked: boolean; problems: string[]; notes: string[] };
};

test("only the server's own containers may ask: without the worker's token it isn't there", async () => {
  assert.equal((await fetch(`${h.base}/health/page`)).status, 404);
});

test('HQ as it is assembles in every look', async () => {
  assert.deepEqual(await checked(), { checked: true, problems: [], notes: [] });
});

test("a module that drops a name the page imports breaks the page, in the check's words", async () => {
  writeFileSync(join(theme, 'tips.js'), 'export const nothing = 1;\n');
  const { checked: ran, problems } = await checked();
  assert.ok(ran);
  assert.ok(problems.length, 'the broken page has problems');
  assert.ok(
    problems.some(p => /page error: SyntaxError: The requested module '.\/tips.js' does not provide/.test(p)),
    problems.join('\n'),
  );
});
