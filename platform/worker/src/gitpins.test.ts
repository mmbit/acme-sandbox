// node --test src/gitpins.test.ts (real mirrors, profile publication and borrowed review clones)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitFlow } from './git.ts';

for (const mutation of ['withdraw', 'replace', 'merge'] as const) {
  test(`cleanup preserves a pinned review clone through direct profile ${mutation}`, async () => {
    const folder = mkdtempSync(join(tmpdir(), 'git-pin-'));
    const remote = join(folder, 'remote.git'),
      mirror = join(folder, 'mirror.git');
    const writer = join(folder, 'writer'),
      review = join(folder, 'review');
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', env }).trim();
    const who = { name: 'Test', email: 'test@example.invalid' };
    try {
      git('init', '-q', '--bare', '-b', 'main', remote);
      const tree = git('--git-dir', remote, 'mktree');
      const main = git('--git-dir', remote, 'commit-tree', tree, '-m', 'seed');
      git('--git-dir', remote, 'update-ref', 'refs/heads/main', main);
      let clones: string[] = [];
      const flow = gitFlow({ mirror, remote, base: 'main', clones: () => clones });
      flow.ensureMirror();
      flow.fetchMirror();
      const job = flow.forAgent({ env });
      job.clone(writer, 'job/1');
      mkdirSync(join(writer, 'company/people'), { recursive: true });
      const path = 'company/people/test.md';
      writeFileSync(join(writer, path), 'borrowed profile history\n');
      job.ag(writer, 'add', '-A');
      job.ag(writer, 'commit', '-qm', 'profile');
      const old = (await job.pushProfile(writer, 'profile/1', 'HEAD', [path], '')).sha;
      mkdirSync(review);
      job.clone(review, 'profile/1', { sha: old });
      clones = [review];
      await flow.gcMirror();
      if (mutation === 'withdraw') await job.withdrawProfile('profile/1', old);
      if (mutation === 'replace') {
        job.ag(writer, 'reset', '--hard', main);
        mkdirSync(join(writer, 'company/people'), { recursive: true });
        writeFileSync(join(writer, path), 'replacement profile\n');
        job.ag(writer, 'add', '-A');
        job.ag(writer, 'commit', '-qm', 'replacement');
        await job.pushProfile(writer, 'profile/1', 'HEAD', [path], old);
      }
      if (mutation === 'merge') {
        const next = git('--git-dir', remote, 'commit-tree', tree, '-p', main, '-m', 'main advances');
        git('--git-dir', remote, 'update-ref', 'refs/heads/main', next);
        flow.fetchMirror();
        const merged = await flow.mergeBase('profile/1', old, who);
        assert.ok(merged.sha && merged.sha !== old);
      }
      git('--git-dir', mirror, 'reflog', 'expire', '--expire=now', '--all');
      git('--git-dir', mirror, 'gc', '-q', '--prune=now');
      assert.equal(job.ag(review, 'show', `HEAD:${path}`), 'borrowed profile history');
      clones = [];
      await flow.gcMirror();
      git('--git-dir', mirror, 'gc', '-q', '--prune=now');
      assert.throws(() => git('--git-dir', mirror, 'cat-file', '-e', old));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
}
