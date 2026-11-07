// node --test src/gitpins.test.ts (real mirrors, profile publication and borrowed review clones)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { seededMirror } from './mirror.fixture.ts';

for (const mutation of ['withdraw', 'replace', 'merge'] as const) {
  test(`cleanup preserves a pinned review clone through direct profile ${mutation}`, async () => {
    let clones: string[] = [];
    const { folder, remote, mirror, env, git, tree, main, flow } = seededMirror(() => clones);
    const writer = join(folder, 'writer'),
      review = join(folder, 'review');
    const who = { name: 'Test', email: 'test@example.invalid' };
    try {
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
