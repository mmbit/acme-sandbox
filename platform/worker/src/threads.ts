// A task in a thread as the worker runs it: its branch brought up to date with main as it starts, its briefing's lines,
// and its own profile lines sent to main apart from the thread's work (and their branch's repair).

// The claim's answer for a task in a thread (the coordinator's claim).
export type InThread = {
  id: string;
  name: string;
  goal: string;
  place: number;
  of: number;
  before: { id: number; agent: string; title: string } | null;
};

// The job's side of git in its clone (git.ts forAgent): git with stdin and variables of its own, output untrimmed, and any
// other command as the job's user.
export type InClone = {
  git: (args: string[], o?: { input?: string; env?: Record<string, string> }) => string;
  as: (cmd: string, args: string[], input?: string) => string;
};

// Main merged into a later task's new clone of the thread's branch, so the thread never drifts further than one task. A
// clean merge is committed with the clone's own identity. One that conflicts is left in progress (MERGE_HEAD stays) for
// the session to resolve, and its files come back. The first task (no branch on origin yet) started from main.
export function bringUpToDate(clone: InClone, dir: string, branch: string, base: string): string[] {
  const inClone = (...args: string[]) => clone.git(['-C', dir, ...args]);
  if (!onOrigin(clone, dir, branch)) return [];
  try {
    inClone('merge', '-q', '--no-edit', '-m', `Bring up to date with ${base}`, `origin/${base}`);
    return [];
  } catch (err) {
    if (!has(clone, dir, 'MERGE_HEAD')) throw err;
    return inClone('diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter(Boolean);
  }
}

// The briefing's lines for a task in a thread (a deliverable, in the board's word), after its title: the merge it must finish first, where it stands in the
// thread, and what isn't part of it
export function threadBriefing(thread: InThread, conflicts: string[]) {
  const merge = conflicts.length
    ? `First: bringing the deliverable's branch up to date with main left a merge in progress, with conflicts in ` +
      `${conflicts.join(', ')}. Resolve each (keep both sides' intent), \`git add\` them and leave the rest to the ` +
      `worker, which commits the merge with your work.\n\n`
    : '';
  const after = thread.before
    ? `It comes after #${thread.before.id}, ${thread.before.agent}'s "${thread.before.title}": that work is on this branch.`
    : "It starts the deliverable's branch.";
  return (
    `${merge}This is task ${thread.place} of ${thread.of} in the deliverable "${thread.name}" (${thread.id}), done when: ` +
    `${thread.goal.replace(/\.$/, '')}. ${after} Anything beyond the "done when" is a proposal (\`hq propose\`), not part of this task.`
  );
}

export type Pull = { title: string; body: string };

// A task's own profile and archive files, the lines that go to main apart from the thread
export const profilePaths = (agent: string) => [`company/people/${agent}.md`, `company/people/archive/${agent}.md`];

type Author = { name: string; email: string };
// A commit of profile lines on `ref` in the clone, and its files
type Commit = { sha: string; ref: string; files: string[] };
// One built for a profile branch, and `over`: the branch's commit on origin it was built on ('' when there was none),
// which its push (git.ts pushProfile) replaces only while it's still there
export type Built = Commit & { over: string };
// A task's split: the commit (its own to push, or the one published already), the thread files to take back, and
// whether its pull request is still to merge
export type ProfileLines = Built & { restore: string[]; push: boolean; open: boolean };

// A task's own profile lines, split from its thread's branch: one commit on main alone, on `ref` in the clone, for git.ts
// pushProfile to `branch` (profile/<the task's id>), whose pull request merges as records do. The branch on origin is what
// was published: its commit, rebased onto main as it is now while main hasn't merged it (with any repair made on it),
// takes in the lines the thread gained since that publication (each file three-way merged, --union: a profile is
// merge=union). Each commit names the thread's commit it holds the lines of (its Thread-Head trailer), and the thread's
// commit that took them back (restoreProfile) names the branch, so a run again (sent back for its gates, or after a
// failure) sends only lines that were never published, and none twice. Lines since main last merged into the thread go
// back to that version of main (restore), so the thread never carries a profile change and its merge leaves main's lines
// be. None when there's nothing to send or take back.
export function splitProfile(
  clone: InClone,
  dir: string,
  o: { base: string; branch: string; paths: string[]; message: string; author: Author },
): ProfileLines | undefined {
  const inClone = (...args: string[]) => clone.git(['-C', dir, ...args]).trim();
  const main = fetchMain(clone, dir, o.base);
  const from = inClone('merge-base', 'HEAD', main);
  const published = publishedOn(clone, dir, o.branch);
  const owed = published && !merged(clone, dir, published, main) ? published : undefined;
  const since = sinceOf(clone, dir, o.branch, main, published) ?? from;
  const restore = changedFiles(clone, dir, from, 'HEAD', o.paths);
  const gained = changedFiles(clone, dir, since, 'HEAD', o.paths);
  if (!gained.length) {
    // (published already: its pull request, if main hasn't merged it, and the thread's files back)
    if (!published || (!owed && !restore.length)) return undefined;
    const files = diffOf(clone, dir, `${published}^`, published, o.paths).map(c => c.path);
    const ref = `refs/remotes/origin/${o.branch}`;
    return { sha: published, ref, files, over: published, restore, push: false, open: !!owed };
  }
  const folds = [...(owed ? [{ base: `${owed}^`, ours: owed }] : []), { base: since, ours: 'HEAD' }];
  const head = inClone('rev-parse', 'HEAD');
  const lines = buildOnMain(clone, dir, main, o.paths, folds, `${o.message}\n\n${THREAD_HEAD}: ${head}`, o.author);
  return lines && { ...lines, over: published ?? '', restore, push: true, open: true };
}

// Once its lines are published, the thread's branch takes the task's profile files back to the version of main it was
// last brought up to (one that version lacks goes), as a commit naming the branch they went to
export function restoreProfile(
  clone: InClone,
  dir: string,
  lines: ProfileLines,
  o: { base: string; branch: string; message: string; author: Author },
) {
  if (!lines.restore.length) return;
  const inClone = (...args: string[]) => clone.git(['-C', dir, ...args]).trim();
  const from = inClone('merge-base', 'HEAD', `refs/remotes/origin/${o.base}`);
  for (const path of lines.restore) {
    if (has(clone, dir, from, path)) inClone('checkout', from, '--', `:(literal)${path}`);
    else inClone('rm', '-q', '--', `:(literal)${path}`);
  }
  const message = `${o.message}\n\n${PROFILE_LINES}: ${o.branch} ${lines.sha}`;
  const { name, email } = o.author;
  inClone('-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '--no-verify', '-m', message);
}

// A profile branch's repair (a fix job on profile/<n>) as its clone is made: the publication it starts from, kept apart
// from origin's refs, which a later fetch moves (the session's, a resumed run's)
export function startRepair(clone: InClone, dir: string, branch: string) {
  const inClone = (...args: string[]) => clone.git(['-C', dir, ...args]).trim();
  inClone('update-ref', REPAIR_FROM, inClone('rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`));
}
// The publication a profile branch's repair started from (startRepair): what its push replaces, or its withdrawal
// deletes (git.ts withdrawProfile), only while the branch is still there
export const repairFrom = (clone: InClone, dir: string) =>
  clone.git(['-C', dir, 'rev-parse', '--verify', `${REPAIR_FROM}^{commit}`]).trim();

// A profile branch's own repair (a fix job on profile/<n>: its merge with main, a key taken out): what it changes in
// `paths` since main as it last merged, rebuilt as one commit on main's head for git.ts pushProfile, over the publication
// it started from and naming the thread's commit that one held the lines of. Any other file it changes is refused. None
// when the repair leaves nothing for main: the pull request is withdrawn (git.ts withdrawProfile).
export function rebuildProfile(
  clone: InClone,
  dir: string,
  o: { base: string; paths: string[]; message: string; author: Author },
): Built | undefined {
  const main = fetchMain(clone, dir, o.base);
  const from = clone.git(['-C', dir, 'merge-base', 'HEAD', main]).trim();
  const outside = diffOf(clone, dir, from, 'HEAD', []).filter(c => !o.paths.includes(c.path));
  if (outside.length)
    throw new Error(
      `the profile branch changes more than the agent's profile and archive: ${outside
        .slice(0, 10)
        .map(c => c.path)
        .join(', ')}`,
    );
  const over = repairFrom(clone, dir);
  const head = trailer(clone, dir, over, THREAD_HEAD)[0];
  const message = head ? `${o.message}\n\n${THREAD_HEAD}: ${head}` : o.message;
  const lines = buildOnMain(clone, dir, main, o.paths, [{ base: from, ours: 'HEAD' }], message, o.author);
  return lines && { ...lines, over };
}

const THREAD_HEAD = 'Thread-Head';
const PROFILE_LINES = 'Profile-Lines';
const REPAIR_FROM = 'refs/hq/repair-from';
const fetchMain = (clone: InClone, dir: string, base: string) => {
  clone.git(['-C', dir, 'fetch', '-q', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
  return clone.git(['-C', dir, 'rev-parse', `refs/remotes/origin/${base}^{commit}`]).trim();
};
// The commit on `branch` on origin now, if there's one
function publishedOn(clone: InClone, dir: string, branch: string) {
  const inClone = (...args: string[]) => clone.git(['-C', dir, ...args]).trim();
  if (!inClone('ls-remote', 'origin', `refs/heads/${branch}`)) return undefined;
  inClone('fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  return inClone('rev-parse', `refs/remotes/origin/${branch}^{commit}`);
}
// The thread's latest commit whose profile lines are published already: the one the publication names, or one that took
// lines published on `branch` back, whichever is later; none since main
function sinceOf(clone: InClone, dir: string, branch: string, main: string, published: string | undefined) {
  const named = published && trailer(clone, dir, published, THREAD_HEAD)[0];
  const commits = clone
    .git(['-C', dir, 'log', `--format=%H`, `${main}..HEAD`])
    .split('\n')
    .map(sha => sha.trim())
    .filter(Boolean);
  return commits.find(
    sha => sha === named || trailer(clone, dir, sha, PROFILE_LINES).some(value => value.split(' ')[0] === branch),
  );
}
// A commit's trailer values for `key`
const trailer = (clone: InClone, dir: string, sha: string, key: string) =>
  clone
    .git(['-C', dir, 'log', '-1', `--format=%(trailers:key=${key},valueonly)`, sha])
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean);
const merged = (clone: InClone, dir: string, sha: string, main: string) => {
  try {
    clone.git(['-C', dir, 'merge-base', '--is-ancestor', sha, main]);
    return true;
  } catch {
    return false;
  }
};

// One commit on main whose `paths` are main's versions with each fold's change (base to ours) merged in turn, built in an
// index of its own (the working tree and its index untouched) and kept on refs/hq/profile; none when it changes nothing.
// A file a fold deletes stays as it is.
function buildOnMain(
  clone: InClone,
  dir: string,
  main: string,
  paths: string[],
  folds: { base: string; ours: string }[],
  message: string,
  author: Author,
): Commit | undefined {
  const inClone = (...args: string[]) => clone.git(['-C', dir, ...args]).trim();
  const env = { GIT_INDEX_FILE: `${dir}/.git/hq-profile-index` };
  const inIndex = (...args: string[]) => clone.git(['-C', dir, ...args], { env }).trim();
  try {
    inIndex('read-tree', main);
    for (const path of paths) {
      const changes = folds.filter(f => changedFiles(clone, dir, f.base, f.ours, [path]).length);
      if (!changes.length) continue;
      let text = has(clone, dir, main, path) ? clone.git(['-C', dir, 'cat-file', 'blob', `${main}:${path}`]) : '';
      for (const f of changes) text = mergeText(clone, dir, text, f, path);
      const blob = clone.git(['-C', dir, 'hash-object', '-w', '--no-filters', '--stdin'], { input: text }).trim();
      const mode = inClone('ls-tree', changes.at(-1)!.ours, '--', `:(literal)${path}`).split(' ')[0];
      inIndex('update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`);
    }
    const tree = inIndex('write-tree');
    const files = diffOf(clone, dir, main, tree, paths).map(c => c.path);
    if (!files.length) return undefined;
    const who = {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    };
    const sha = clone.git(['-C', dir, 'commit-tree', tree, '-p', main, '-m', message], { env: who }).trim();
    const ref = 'refs/hq/profile';
    inClone('update-ref', ref, sha);
    return { sha, ref, files };
  } finally {
    clone.as('rm', ['-f', '--', env.GIT_INDEX_FILE]);
  }
}

// The files in `paths` (all, when none) a change from `base` to `ours` adds or edits, as plain files
const changedFiles = (clone: InClone, dir: string, base: string, ours: string, paths: string[]) =>
  diffOf(clone, dir, base, ours, paths)
    .filter(c => /^:\d{6} 100(644|755) \S+ \S+ [AM]$/.test(c.mode))
    .map(c => c.path);
function diffOf(clone: InClone, dir: string, base: string, ours: string, paths: string[]) {
  const literal = paths.map(path => `:(literal)${path}`);
  const raw = clone
    .git(['-C', dir, 'diff', '--no-renames', '--raw', '--no-abbrev', '-z', base, ours, '--', ...literal])
    .split('\0');
  return raw.flatMap((mode, i) => (i % 2 || !mode ? [] : [{ mode, path: raw[i + 1] }]));
}

// `text` with a fold's change to `path` merged in (git merge-file --union), a version a side lacks counting as empty
function mergeText(clone: InClone, dir: string, text: string, fold: { base: string; ours: string }, path: string) {
  const gitDir = `${dir}/.git`;
  const blobOf = (input: string) =>
    clone.git(['-C', dir, 'hash-object', '-w', '--no-filters', '--stdin'], { input }).trim();
  const versionOf = (rev: string) =>
    has(clone, dir, rev, path) ? clone.git(['-C', dir, 'rev-parse', `${rev}:${path}`]).trim() : blobOf('');
  // (unpack-file writes each into the folder it runs in: the clone's .git, never its working tree)
  const blobs = [blobOf(text), versionOf(fold.base), versionOf(fold.ours)];
  const unpacked = blobs.map(blob => clone.git(['-C', gitDir, 'unpack-file', blob]).trim());
  try {
    return clone.git(['-C', gitDir, 'merge-file', '-p', '--union', ...unpacked]);
  } finally {
    clone.as('rm', ['-f', '--', ...unpacked.map(file => `${gitDir}/${file}`)]);
  }
}

const onOrigin = (clone: InClone, dir: string, branch: string) =>
  clone.git(['-C', dir, 'for-each-ref', '--format=%(refname)', `refs/remotes/origin/${branch}`]).trim() !== '';
// Whether the clone has a commit, or a file in one
const has = (clone: InClone, dir: string, rev: string, path?: string) => {
  try {
    clone.git(['-C', dir, 'cat-file', '-e', path === undefined ? rev : `${rev}:${path}`]);
    return true;
  } catch {
    return false;
  }
};
