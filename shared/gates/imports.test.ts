// node --test shared/gates/imports.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { importProblems } from './imports.ts';

const touching = (path: string) => [{ path, basePath: path, lines: 'all' as const }];

test("a change that drops an export another module imports by HQ's URL fails, and one that keeps it passes", () => {
  const root = repo({
    'shared/review/ring.js': 'export function ringAt() {}\nfunction ringAround() {}\n',
    'shared/review/all.js': "export * from './ring.js';\nexport const [a, { b }] = [];\n",
    'platform/hq/shell/slips.js':
      "import { ringAround } from '/__review/ring.js';\nimport { ringAt, a, b } from '/__review/all.js';\n",
  });
  assert.deepEqual(importProblems(ts, root, touching('shared/review/ring.js')), [
    {
      path: 'platform/hq/shell/slips.js',
      line: 1,
      text: "imports ringAround from /__review/ring.js, which shared/review/ring.js doesn't export",
    },
  ]);
  writeFileSync(join(root, 'shared/review/ring.js'), 'export function ringAt() {}\nexport function ringAround() {}\n');
  assert.deepEqual(importProblems(ts, root, touching('shared/review/ring.js')), []);
  assert.deepEqual(importProblems(ts, root, touching('kits/x.ts')), []);
});

function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'imports-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}
