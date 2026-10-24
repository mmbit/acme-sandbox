// node --test shared/gates/repo.test.ts (real Git indexes and confined snapshots)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { git, workingTree } from './repo.ts';

const confine = new URL('../../platform/worker/hq/confine.py', import.meta.url).pathname;

test('a confined snapshot includes same-second edits and staged ignored files without changing the real index', () => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-'));
  const scratch = mkdtempSync(join(tmpdir(), 'snapshot-scratch-'));
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'core.checkStat', 'minimal');
    git(root, 'config', 'core.trustctime', 'false');
    writeFileSync(join(root, '.gitignore'), 'ignored\n');
    const names = ['same size', 'tab\tline\ncafé'];
    for (const name of names) writeFileSync(join(root, name), 'before\n');
    writeFileSync(join(root, 'deleted'), 'remove me\n');
    const time = new Date(Math.floor(Date.now() / 1000 - 10) * 1000);
    for (const name of names) utimesSync(join(root, name), time, time);
    git(root, 'add', '-A');
    writeFileSync(join(root, 'ignored'), 'staged\n');
    git(root, 'add', '-f', 'ignored');
    writeFileSync(join(root, 'sparse'), 'index only\n');
    writeFileSync(join(root, 'assumed'), 'unchanged\n');
    git(root, 'add', 'sparse', 'assumed');
    git(root, 'update-index', '--skip-worktree', 'sparse');
    git(root, 'update-index', '--assume-unchanged', 'assumed');
    rmSync(join(root, 'sparse'));
    writeFileSync(join(root, 'assumed'), 'worktree\n');
    const index = join(root, '.git/index');
    utimesSync(index, time, time);
    for (const name of names) writeFileSync(join(root, name), 'after!\n');
    writeFileSync(join(root, 'ignored'), 'edited ignored file\n');
    rmSync(join(root, 'deleted'));
    for (const name of names) utimesSync(join(root, name), time, time);
    mkdirSync(join(root, 'new'));
    writeFileSync(join(root, 'new/café'), 'untracked\n');
    const before = readFileSync(index);
    const modified = statSync(index).mtimeMs;
    // The original index must recognize the edit even though its cached size and file time still match.
    assert.match(git(root, 'diff-files', '--name-only'), /same size/);
    const tree = confinedTree(root, scratch);
    for (const name of names) assert.equal(git(root, 'show', `${tree}:${name}`), 'after!\n');
    assert.equal(git(root, 'show', `${tree}:ignored`), 'edited ignored file\n');
    assert.equal(git(root, 'ls-tree', tree, 'deleted'), '');
    assert.equal(git(root, 'show', `${tree}:sparse`), 'index only\n');
    assert.equal(git(root, 'show', `${tree}:assumed`), 'unchanged\n');
    assert.equal(git(root, 'show', `${tree}:new/café`), 'untracked\n');
    assert.deepEqual(readFileSync(index), before);
    assert.equal(statSync(index).mtimeMs, modified);
    assert.equal(workingTree(root), tree);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a confined snapshot reuses unchanged tracked contents and stages changed contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-cache-'));
  const scratch = mkdtempSync(join(tmpdir(), 'snapshot-scratch-'));
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'filter.audit.clean', 'node clean.mjs');
    writeFileSync(
      join(root, 'clean.mjs'),
      `
      import { appendFileSync, readFileSync } from 'node:fs';
      const contents = readFileSync(0);
      appendFileSync('.git/filter-reads', contents);
      process.stdout.write(contents);
    `,
    );
    writeFileSync(join(root, '.gitattributes'), '*.filtered filter=audit\n');
    writeFileSync(join(root, 'unchanged.filtered'), 'cached contents\n');
    writeFileSync(join(root, 'changed.filtered'), 'before\n');
    const time = new Date(Date.now() - 10_000);
    for (const name of ['unchanged.filtered', 'changed.filtered']) utimesSync(join(root, name), time, time);
    git(root, 'add', '-A');
    const index = join(root, '.git/index');
    const before = readFileSync(index);
    const modified = statSync(index).mtimeMs;
    writeFileSync(join(root, '.git/filter-reads'), '');
    writeFileSync(join(root, 'changed.filtered'), 'changed contents\n');
    const tree = confinedTree(root, scratch);
    assert.equal(git(root, 'show', `${tree}:unchanged.filtered`), 'cached contents\n');
    assert.equal(git(root, 'show', `${tree}:changed.filtered`), 'changed contents\n');
    const reads = readFileSync(join(root, '.git/filter-reads'), 'utf8');
    assert.match(reads, /changed contents/);
    assert.doesNotMatch(reads, /cached contents/);
    assert.deepEqual(readFileSync(index), before);
    assert.equal(statSync(index).mtimeMs, modified);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

function confinedTree(root: string, scratch: string) {
  const source = new URL('./repo.ts', import.meta.url).href;
  const script = `import { workingTree } from ${JSON.stringify(source)}; console.log(workingTree(process.cwd()));`;
  const readable = new URL('../..', import.meta.url).pathname;
  return execFileSync(
    'python3',
    [confine, '--write', root, scratch, '--read', readable, '--', 'node', '--input-type=module', '-e', script],
    {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch },
      encoding: 'utf8',
    },
  ).trim();
}
