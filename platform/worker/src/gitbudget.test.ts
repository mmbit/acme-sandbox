// node --test src/gitbudget.test.ts (small-heap child bounds the compressible-blob regression's memory use)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runAs } from './git.ts';
import { OUTPUT_BYTES, GitOutputLimitError } from './gitoutput.ts';
import { seededMirror } from './mirror.fixture.ts';

if (!process.argv.includes('--small-heap')) {
  test('agent blobs and patches stop at the worker output budget before publication', () => {
    execFileSync(process.execPath, ['--max-old-space-size=64', import.meta.filename, '--small-heap'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });
} else {
  await oversizedContent();
}

async function oversizedContent() {
  const { folder, remote, env, git, main, flow } = seededMirror();
  const dir = join(folder, 'clone');
  try {
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
