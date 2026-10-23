// The lines each merged pull request changed, so the sizer can show how much a done job changed and not only in how
// many files (sizer.ts). Read from the deployed checkout (REPO_DIR): review.ts
// merges every pull request as a merge commit titled "Merge PR #<n> …", and that merge against its first parent (main
// before it) is what the pull request brought. The whole history at the first read, then the merges since the last one,
// each time the checkout has moved (a deploy).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { REPO_DIR } from './config.ts';
import { db, remember, setting } from './db.ts';

const run = promisify(execFile);
// safe.directory: the checkout is root's on the server, mounted read-only for the coordinator's own user (committed.ts)
const git = async (...args: string[]) =>
  (
    await run('git', ['-c', `safe.directory=${REPO_DIR}`, '-C', REPO_DIR, ...args], {
      timeout: 120_000,
      maxBuffer: 1 << 28,
    })
  ).stdout;

// The checkout's commit the merges were read up to.
const READ_TO = 'merged lines read to';
const EVERY_MS = 2 * 60_000;
const MERGE = /^Merge PR #(\d+)\b/;

let reading: Promise<number> | undefined;
// The merges since the last read: each one's pull request gets its lines added and removed (binary files count none).
// Returns how many it read.
export function read() {
  return (reading ??= readMerges().finally(() => (reading = undefined)));
}
async function readMerges() {
  const head = (await git('rev-parse', 'HEAD')).trim(),
    from = setting(READ_TO);
  if (from === head) return 0;
  // (a commit gone from the checkout's history, as after a force push: everything again)
  const known =
    from &&
    (await git('merge-base', '--is-ancestor', from, head).then(
      () => true,
      () => false,
    ));
  const log = await git(
    'log',
    '--first-parent',
    '--diff-merges=first-parent',
    '--numstat',
    '--format=%x01%P%x00%s',
    known ? `${from}..${head}` : head,
  );
  const update = db.prepare('update prs set added = ?, removed = ? where number = ?');
  let merges = 0;
  for (const commit of log.split('\x01').slice(1)) {
    const [top, ...rows] = commit.split('\n');
    const [parents, subject] = top.split('\0');
    const pr = MERGE.exec(subject)?.[1];
    // (two parents: a shallow history's first commit shows none, and its diff would be the whole tree)
    if (!pr || parents.split(' ').length !== 2) continue;
    let added = 0,
      removed = 0;
    for (const row of rows) {
      const [a, d] = row.split('\t').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(d)) continue;
      added += a;
      removed += d;
    }
    update.run(added, removed, Number(pr));
    merges++;
  }
  remember(READ_TO, head);
  return merges;
}

// At start, then every EVERY_MS: a read that fails (a full or slow disk) is tried again then.
export function start() {
  const once = () => read().catch(err => console.error("Could not read the merged pull requests' lines:", err.message));
  once();
  setInterval(once, EVERY_MS).unref();
}
