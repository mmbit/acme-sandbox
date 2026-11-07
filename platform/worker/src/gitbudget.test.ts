// node --test src/gitbudget.test.ts (small-heap child bounds the compressible-blob regression's memory use)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync as nodeExec } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitFlow, runAs } from './git.ts';
import { execFileSync, spawnSync, execFileAsync, OUTPUT_BYTES, GitOutputLimitError } from './gitoutput.ts';

if (!process.argv.includes('--small-heap')) {
  test('agent blobs and patches stop at the worker output budget before publication', () => {
    nodeExec(process.execPath, ['--max-old-space-size=64', import.meta.filename, '--small-heap'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });
} else {
  await oversizedContent();
}

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

async function oversizedContent() {
  const folder = mkdtempSync(join(tmpdir(), 'git-budget-'));
  const remote = join(folder, 'remote.git'),
    mirror = join(folder, 'mirror.git'),
    dir = join(folder, 'clone');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const git = (...args: string[]) => nodeExec('git', args, { encoding: 'utf8', env }).trim();
  try {
    git('init', '-q', '--bare', '-b', 'main', remote);
    const tree = git('--git-dir', remote, 'mktree');
    const main = git('--git-dir', remote, 'commit-tree', tree, '-m', 'seed');
    git('--git-dir', remote, 'update-ref', 'refs/heads/main', main);
    const flow = gitFlow({ mirror, remote, base: 'main', clones: () => [] });
    flow.ensureMirror();
    flow.fetchMirror();
    const agent = { env };
    const job = flow.forAgent(agent);
    job.clone(dir, 'job/1');
    // Repeated text stays tiny in the bundle while expanding past the worker's allocation budget.
    const content = 'x'.repeat(OUTPUT_BYTES + 4096);
    for (const path of ['company/playbooks/large.md', 'company/large.yaml', 'app.txt']) {
      job.ag(dir, 'reset', '--hard', main);
      job.ag(dir, 'clean', '-fdq');
      mkdirSync(join(dir, 'company/playbooks'), { recursive: true });
      writeFileSync(join(dir, path), content);
      job.ag(dir, 'add', '-A');
      job.ag(dir, 'commit', '-qm', 'large blob');
      assert.throws(() => runAs(agent, 'git', ['-C', dir, 'cat-file', 'blob', `HEAD:${path}`]), GitOutputLimitError);
      await assert.rejects(
        () => job.push(dir, 'job/1'),
        (error: Error) => {
          assert.ok(error instanceof GitOutputLimitError);
          if (path.startsWith('company/playbooks/'))
            assert.equal(error.cause, undefined, 'the blob size stops the read before a child output buffer fills');
          return true;
        },
      );
      assert.throws(() => git('--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/job/1'));
    }
    // Whole runAs output has the same boundary, including stderr.
    assert.throws(
      () => runAs(agent, process.execPath, ['-e', `process.stderr.write('x'.repeat(${OUTPUT_BYTES + 4096}))`]),
      GitOutputLimitError,
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
