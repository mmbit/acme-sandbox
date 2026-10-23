// Who last changed a file in the deployed checkout (REPO_DIR), for the files a GitHub workflow commits for the
// server to trust: the enrollment codes' hashes (auth.ts) and the mail Worker's token hash (mail.ts).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { REPO_DIR } from './config.ts';

const run = promisify(execFile);
// The workflows commit as GitHub Actions' bot (its git config: .github/workflows/enroll.yml, email.yml), straight to the
// deploy branch. Everything else that reaches it is a merge commit: pull requests are merged as merges (github.ts), and
// sync.sh refuses an agent's commit pushed straight to it. A merged file's last change on the first-parent line is that
// merge, whoever wrote the commits inside it.
const BOT = '41898282+github-actions[bot]@users.noreply.github.com';

// When the workflow's own commit with this subject last changed path (ms); null when the last change is a merge, someone
// else's commit or another subject; undefined when git can't be read (a full or slow disk: worth trying again).
export async function workflowCommit(path: string, subject: string) {
  let line: string;
  try {
    // safe.directory: the checkout is root's on the server, mounted read-only for the coordinator's own user;
    // --literal-pathspecs: a file name is never a glob (a merged `*.sha256` would stand for every enrollment file)
    const args = ['-c', `safe.directory=${REPO_DIR}`, '--literal-pathspecs', '-C', REPO_DIR, 'log', '-1', '--first-parent',
      '--format=%P%x00%ae%x00%ce%x00%ct%x00%s', 'HEAD', '--', path];
    line = (await run('git', args, { timeout: 10_000 })).stdout.trim();
  } catch (err) {
    console.error(`Could not read who committed ${path}:`, (err as Error).message);
    return undefined;
  }
  const [parents, author, committer, at, message] = line.split('\0');
  // (one parent: not a merge, nor a shallow clone's first commit, which shows none)
  const ours = /^[0-9a-f]+$/.test(parents) && author === BOT && committer === BOT && message === subject;
  return ours ? Number(at) * 1000 : null;
}
