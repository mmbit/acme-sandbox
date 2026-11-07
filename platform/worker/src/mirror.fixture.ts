// A bare "GitHub" with an empty main, and a mirror flow on it, for tests that publish through a real mirror.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitFlow } from './git.ts';

export function seededMirror(clones: () => string[] = () => []) {
  const folder = mkdtempSync(join(tmpdir(), 'git-mirror-'));
  const remote = join(folder, 'remote.git'),
    mirror = join(folder, 'mirror.git');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', env }).trim();
  git('init', '-q', '--bare', '-b', 'main', remote);
  const tree = git('--git-dir', remote, 'mktree');
  const main = git('--git-dir', remote, 'commit-tree', tree, '-m', 'seed');
  git('--git-dir', remote, 'update-ref', 'refs/heads/main', main);
  const flow = gitFlow({ mirror, remote, base: 'main', clones });
  flow.ensureMirror();
  flow.fetchMirror();
  return { folder, remote, mirror, env, git, tree, main, flow };
}
