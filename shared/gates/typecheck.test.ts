// node --test shared/gates/typecheck.test.ts   (needs the tools: npm ci at the repo root)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import ts from 'typescript';
import { reach } from './reach.ts';
import { compilerOptions, typeErrors } from './typecheck.ts';

const repo = join(import.meta.dirname, '..', '..');

const folders: string[] = [];
after(() => folders.forEach(dir => rmSync(dir, { recursive: true, force: true })));

function folder(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'typecheck-test-'));
  folders.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return { dir, files: Object.keys(files), roots: Object.keys(files).filter(f => f.endsWith('.ts')) };
}

test('a change reaches the files that import it, in turn, and leaves the rest of the program out', () => {
  const side = folder({
    'a/leaf.ts': 'export const leaf = 1;\n',
    'a/mid.ts': "export { leaf } from './leaf.ts';\n",
    'a/top.ts': "import { leaf } from './mid.ts';\nexport const top = leaf;\n",
    'b/other.ts': 'export const other = 2;\n',
    'b/page.js': "import { other } from './other.ts';\nconsole.log(other);\n",
  });
  const options = compilerOptions(ts, repo, side.dir);
  assert.deepEqual(reach(ts, options, [side], ['a/leaf.ts'])?.[0].sort(), ['a/leaf.ts', 'a/mid.ts', 'a/top.ts']);
  assert.deepEqual(reach(ts, options, [side], ['b/page.js']), [[]]);
});

test('a type check past its heap cap fails as not run, never as passed', async () => {
  const side = folder({ 'a.ts': 'export const a: number = 1;\n' });
  assert.deepEqual(await typeErrors(repo, side.dir, side.roots), []);
  await assert.rejects(typeErrors(repo, side.dir, side.roots, 8), /the type check passed its 8 MB cap/);
});
