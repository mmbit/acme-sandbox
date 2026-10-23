// node --test src/threads.test.ts   (local bare repos stand in for GitHub; runs as one uid, so the uid switch itself isn't covered)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gitFlow } from './git.ts';
import { agentEnv } from './safety.ts';
import {
  bringUpToDate,
  profilePaths,
  rebuildProfile,
  repairFrom,
  restoreProfile,
  splitProfile,
  startRepair,
} from './threads.ts';

const tmp = mkdtempSync(`${tmpdir()}/threads-test-`);
const work = `${tmp}/work`;
mkdirSync(`${work}/jobs`, { recursive: true, mode: 0o755 });
const github = `${tmp}/github.git`,
  seed = `${tmp}/seed`;
const id = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (...args: string[]) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    env: { ...process.env, ...id },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const remoteRef = (b: string) => {
  try {
    return git('--git-dir', github, 'rev-parse', `refs/heads/${b}`);
  } catch {
    return null;
  }
};
const onGitHub = (rev: string, path: string) => git('--git-dir', github, 'show', `${rev}:${path}`);

// "GitHub": main with a README, Ana's profile and the attributes that union-merge profiles
const [profile, archive] = profilePaths('ana');
git('init', '-q', '--bare', '-b', 'main', github);
git('init', '-q', '-b', 'main', seed);
git('-C', seed, 'remote', 'add', 'origin', github);
const write = (dir: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(`${dir}/${path}`.replace(/[^/]+$/, ''), { recursive: true });
    writeFileSync(`${dir}/${path}`, text);
  }
};
// main moves on, as other pull requests merge
const onMain = (files: Record<string, string>) => {
  write(seed, files);
  git('-C', seed, 'add', '-A');
  git('-C', seed, 'commit', '-qm', 'main moves');
  git('-C', seed, 'push', '-q', 'origin', 'HEAD:main');
  flow.fetchMirror();
  return remoteRef('main')!;
};

const flow = gitFlow({
  mirror: `${work}/mirror.git`,
  remote: github,
  base: 'main',
  clones: () => readdirSync(`${work}/jobs`).map(n => `${work}/jobs/${n}`),
});
const agent = flow.forAgent({
  uid: process.getuid!(),
  gid: process.getgid!(),
  env: agentEnv(process.env, { HOME: tmp }),
});
const identity = { name: 'Company agents', email: 'agents@t' };
const ana = { name: 'Ana (Company)', email: 'ana@t' };
flow.ensureMirror();
onMain({ 'README.md': 'hi\n', '.gitattributes': 'company/people/*.md merge=union\n', [profile]: '# Ana\n- joined\n' });

// A task's run: a new clone of its branch (a profile branch's repair keeping the publication it starts from), the
// session's files written and committed as the worker does
function task(n: number, branch: string, files: Record<string, string> = {}) {
  const dir = `${work}/jobs/${n}`;
  mkdirSync(dir, { mode: 0o700 });
  agent.clone(dir, branch, undefined, identity);
  if (branch.startsWith('profile/')) startRepair(agent, dir, branch);
  write(dir, files);
  return dir;
}
const commit = (dir: string) => {
  agent.ag(dir, 'add', '-A');
  agent.ag(dir, '-c', `user.name=${ana.name}`, '-c', `user.email=${ana.email}`, 'commit', '-qm', 'work');
};
// The thread's first task, pushed: its branch is job/<n> on origin
async function firstTask(n: number, files: Record<string, string>) {
  const dir = task(n, `job/${n}`, files);
  commit(dir);
  return (await agent.push(dir, `job/${n}`)).sha;
}

test("a later task's new clone takes main in with a merge committed as the clone's own; the first task starts from main", async () => {
  await firstTask(100, { 'notes/one.md': 'one\n' });
  const main = onMain({ 'other.md': 'landed meanwhile\n' });
  const dir = task(101, 'job/100');
  assert.deepEqual(bringUpToDate(agent, dir, 'job/100', 'main'), []);
  assert.equal(
    git('-C', dir, 'log', '-1', '--format=%s|%an|%P'),
    `Bring up to date with main|${identity.name}|${remoteRef('job/100')} ${main}`,
  );
  assert.equal(readFileSync(`${dir}/other.md`, 'utf8'), 'landed meanwhile\n');
  const first = task(102, 'job/102');
  assert.deepEqual(bringUpToDate(agent, first, 'job/102', 'main'), []);
  assert.equal(git('-C', first, 'rev-parse', 'HEAD'), main);
});

test('a merge of main that conflicts is left in progress with its files named, and the commit at the end completes it', async () => {
  await firstTask(110, { 'README.md': 'thread\n', 'notes/two.md': 'two\n' });
  const main = onMain({ 'README.md': 'main\n' });
  const dir = task(111, 'job/110');
  assert.deepEqual(bringUpToDate(agent, dir, 'job/110', 'main'), ['README.md']);
  assert.ok(existsSync(`${dir}/.git/MERGE_HEAD`));
  write(dir, { 'README.md': 'thread and main\n' });
  commit(dir);
  assert.equal(git('-C', dir, 'log', '-1', '--format=%P'), `${remoteRef('job/110')} ${main}`);
});

// A task's profile split as the worker makes it (worker.ts profileToMain): the commit of its lines pushed to
// profile/<n>, then the thread's files taken back. `failing` stops it after the push, as a run that failed there.
async function publish(dir: string, n: number, failing = false) {
  const branch = `profile/${n}`;
  const lines = splitProfile(agent, dir, { base: 'main', branch, paths, message: `Ana: lines of #${n}`, author: ana });
  if (!lines) return undefined;
  const pushed = lines.push ? await agent.pushProfile(dir, branch, lines.ref, paths, lines.over) : { sha: lines.sha };
  if (!failing)
    restoreProfile(agent, dir, { ...lines, sha: pushed.sha }, { base: 'main', branch, message: 'm', author: ana });
  return pushed.sha;
}
const paths = [profile, archive];
// A pull request merged on GitHub (a merge commit, as review.ts asks for)
const merge = (branch: string) => {
  git('-C', seed, 'fetch', '-q', 'origin');
  git('-C', seed, 'reset', '-q', '--hard', 'origin/main');
  git('-C', seed, 'merge', '-q', '--no-edit', `origin/${branch}`);
  git('-C', seed, 'push', '-q', 'origin', 'HEAD:main');
  flow.fetchMirror();
};
const profileOn = (rev: string) => onGitHub(rev, profile);
// a fix job's clone of a profile branch, its profile written and committed, rebuilt for the push
function repair(n: number, branch: string, text: string) {
  const fix = task(n, branch, { [profile]: text });
  commit(fix);
  return { fix, built: rebuildProfile(agent, fix, { base: 'main', paths, message: 'fix', author: ana }) };
}

test("a task's own profile lines go to main as one commit on main's head, main's newer lines kept, and leave the thread's branch", async () => {
  await firstTask(120, { 'notes/three.md': 'three\n' });
  onMain({ [profile]: '# Ana\n- joined\n- elsewhere\n' }); // (a line from Ana's job elsewhere meanwhile)
  const dir = task(121, 'job/120', {
    'notes/three.md': 'three, again\n',
    [profile]: '# Ana\n- joined\n- second task\n',
    [archive]: '# Ana, archived\n',
  });
  commit(dir);
  const base = remoteRef('job/120')!;
  const sha = (await publish(dir, 121))!;
  assert.equal(remoteRef('profile/121'), sha);
  assert.equal(git('--git-dir', github, 'log', '-1', '--format=%P|%an', sha), `${remoteRef('main')}|${ana.name}`);
  assert.deepEqual(git('--git-dir', github, 'diff', '--name-only', 'main', sha).split('\n').sort(), [...paths].sort());
  assert.equal(profileOn(sha), '# Ana\n- joined\n- elsewhere\n- second task');
  assert.equal(onGitHub(sha, archive), '# Ana, archived');
  assert.equal(git('-C', dir, 'status', '--porcelain'), '');
  const thread = (await agent.push(dir, 'job/120')).sha;
  assert.equal(profileOn(thread), profileOn(base));
  assert.throws(() => onGitHub(thread, archive));
  assert.equal(onGitHub(thread, 'notes/three.md'), 'three, again');
});

test("main's lines a later task's merge brought in stay on main through its profile lines and the thread's merge", async () => {
  await firstTask(160, { 'notes/eight.md': 'eight\n' });
  // main gains a line in Ana's profile and her archive, from her work elsewhere, between the thread's tasks
  onMain({ [profile]: '# Ana\n- joined\n- elsewhere\n- from main\n', [archive]: '# Ana, archived\n- old\n' });
  const dir = task(161, 'job/160');
  assert.deepEqual(bringUpToDate(agent, dir, 'job/160', 'main'), []);
  write(dir, { [profile]: '# Ana\n- joined\n- elsewhere\n- from main\n- thread task\n', 'notes/eight.md': '8\n' });
  commit(dir);
  assert.ok(await publish(dir, 161));
  await agent.push(dir, 'job/160');
  merge('profile/161');
  merge('job/160');
  assert.equal(profileOn('main'), '# Ana\n- joined\n- elsewhere\n- from main\n- thread task');
  assert.equal(onGitHub('main', archive), '# Ana, archived\n- old');
  assert.equal(onGitHub('main', 'notes/eight.md'), '8');
});

test('a run of the task again sends only what was never published, and keeps what was, each line once', async () => {
  await firstTask(170, { 'notes/nine.md': 'nine\n' });
  const before = profileOn('main');
  const first = task(171, 'job/170', { [profile]: `${before}\n- first run\n` });
  commit(first);
  await publish(first, 171);
  await agent.push(first, 'job/170');
  // sent back for its gates: its run again, in a new clone of the thread's branch, adds a line; main moved meanwhile
  onMain({ 'ten.md': 'ten\n' });
  const again = task(172, 'job/170', { [profile]: `${before}\n- second run\n` });
  commit(again);
  assert.equal(profileOn((await publish(again, 171))!), `${before}\n- first run\n- second run`);
  // a run that failed after its push, before the thread took its lines back: its run again sends nothing twice
  write(again, { [profile]: `${before}\n- third run\n` });
  commit(again);
  await publish(again, 171, true);
  const resent = await publish(again, 171);
  assert.equal(profileOn(resent!), `${before}\n- first run\n- second run\n- third run`);
  assert.equal(git('-C', again, 'status', '--porcelain'), '');
  // a run whose thread push failed after its publication: a new clone of the thread keeps what was published
  write(again, { [profile]: `${before}\n- fourth run\n` });
  commit(again);
  await publish(again, 171);
  const fresh = task(173, 'job/170', { [profile]: `${before}\n- fifth run\n` });
  commit(fresh);
  assert.equal(
    profileOn((await publish(fresh, 171))!),
    `${before}\n- first run\n- second run\n- third run\n- fourth run\n- fifth run`,
  );
  await agent.push(fresh, 'job/170');
  // once main has merged them, nothing is owed
  merge('profile/171');
  assert.equal(await publish(fresh, 171), undefined);
});

test('a repair of the published lines holds: a run again before or after its merge never brings back what it took out', async () => {
  await firstTask(190, { 'notes/eleven.md': 'eleven\n' });
  const before = profileOn('main');
  const dir = task(191, 'job/190', { [profile]: `${before}\n- kept\n- a key by mistake\n` });
  commit(dir);
  await publish(dir, 191);
  await agent.push(dir, 'job/190');
  // the review sends it back: the fix job takes the line out on profile/191
  const { built } = repair(192, 'profile/191', `${before}\n- kept\n`);
  await agent.pushProfile(`${work}/jobs/192`, 'profile/191', built!.ref, paths, built!.over);
  // the task runs again (its gates), in a new clone of the thread
  const again = task(193, 'job/190', { [profile]: `${before}\n- later\n` });
  commit(again);
  const sha = (await publish(again, 191))!;
  assert.equal(profileOn(sha), `${before}\n- kept\n- later`);
  await agent.push(again, 'job/190');
  merge('profile/191');
  const last = task(194, 'job/190', { [profile]: `${before}\n- last\n` });
  commit(last);
  assert.equal(profileOn((await publish(last, 191))!), `${profileOn('main')}\n- last`);
  assert.doesNotMatch(profileOn('main'), /a key/);
});

test('a repair that leaves nothing for main withdraws the branch, and a run again sends nothing of it', async () => {
  await firstTask(200, { 'notes/twelve.md': 'twelve\n' });
  const before = profileOn('main');
  const dir = task(201, 'job/200', { [profile]: `${before}\n- a key by mistake\n` });
  commit(dir);
  const published = (await publish(dir, 201))!;
  await agent.push(dir, 'job/200');
  const { fix, built } = repair(202, 'profile/201', `${before}\n`);
  assert.equal(built, undefined, 'nothing left for main');
  await agent.withdrawProfile('profile/201', repairFrom(agent, fix));
  assert.equal(remoteRef('profile/201'), null);
  assert.ok(published);
  const again = task(203, 'job/200');
  assert.equal(await publish(again, 201), undefined);
  await assert.rejects(() => agent.withdrawProfile('job/200', published), /only profile\/<n> branches/);
});

// A run of the task again split from the publication, as worker.ts profileToMain does before it pushes
const splitFor = (dir: string, n: number) =>
  splitProfile(agent, dir, {
    base: 'main',
    branch: `profile/${n}`,
    paths,
    message: `Ana: lines of #${n}`,
    author: ana,
  })!;
const refused = (n: number) => new RegExp(`GitHub refused the push to profile/${n}`);

test("a run again and a repair at once: the repair's push first refuses the run's, whose run again keeps the repair", async () => {
  await firstTask(220, { 'notes/fourteen.md': 'fourteen\n' });
  const before = profileOn('main');
  const dir = task(221, 'job/220', { [profile]: `${before}\n- a\n- a key by mistake\n` });
  commit(dir);
  await publish(dir, 221);
  await agent.push(dir, 'job/220');
  // the run again splits from that publication; the repair taking the key out pushes before it does
  const retry = task(222, 'job/220', { [profile]: `${before}\n- c\n` });
  commit(retry);
  const split = splitFor(retry, 221);
  const { built } = repair(223, 'profile/221', `${before}\n- a\n`);
  await agent.pushProfile(`${work}/jobs/223`, 'profile/221', built!.ref, paths, built!.over);
  await assert.rejects(() => agent.pushProfile(retry, 'profile/221', split.ref, paths, split.over), refused(221));
  assert.equal(profileOn('profile/221'), `${before}\n- a`);
  // its run again: what the repair took out stays out, and its own line goes on
  assert.equal(profileOn((await publish(retry, 221))!), `${before}\n- a\n- c`);
});

test("a run again and a repair at once: the run's push first refuses the repair's, whose repair again keeps the run's lines", async () => {
  await firstTask(230, { 'notes/fifteen.md': 'fifteen\n' });
  const before = profileOn('main');
  const dir = task(231, 'job/230', { [profile]: `${before}\n- a\n- a key by mistake\n` });
  commit(dir);
  await publish(dir, 231);
  await agent.push(dir, 'job/230');
  // the repair is built from that publication; the run again publishes before it pushes
  const { fix, built } = repair(232, 'profile/231', `${before}\n- a\n`);
  const retry = task(233, 'job/230', { [profile]: `${before}\n- c\n` });
  commit(retry);
  await publish(retry, 231);
  await agent.push(retry, 'job/230');
  await assert.rejects(() => agent.pushProfile(fix, 'profile/231', built!.ref, paths, built!.over), refused(231));
  assert.equal(profileOn('profile/231'), `${before}\n- a\n- a key by mistake\n- c`);
  // the repair again, from the publication now, and a later run's line after it
  const { built: again } = repair(234, 'profile/231', `${before}\n- a\n- c\n`);
  await agent.pushProfile(`${work}/jobs/234`, 'profile/231', again!.ref, paths, again!.over);
  const later = task(235, 'job/230', { [profile]: `${before}\n- d\n` });
  commit(later);
  assert.equal(profileOn((await publish(later, 231))!), `${before}\n- a\n- c\n- d`);
});

test('a repair that leaves nothing at once with a run again: neither deletes nor brings back the other side', async () => {
  await firstTask(240, { 'notes/sixteen.md': 'sixteen\n' });
  const before = profileOn('main');
  const dir = task(241, 'job/240', { [profile]: `${before}\n- a key by mistake\n` });
  commit(dir);
  await publish(dir, 241);
  await agent.push(dir, 'job/240');
  // the run again publishes first: the withdrawal from the older publication is refused, and the run's line stays
  const { fix, built } = repair(242, 'profile/241', `${before}\n`);
  assert.equal(built, undefined, 'nothing left for main');
  const retry = task(243, 'job/240', { [profile]: `${before}\n- c\n` });
  commit(retry);
  const published = (await publish(retry, 241))!;
  await agent.push(retry, 'job/240');
  await assert.rejects(() => agent.withdrawProfile('profile/241', repairFrom(agent, fix)), refused(241));
  assert.equal(remoteRef('profile/241'), published);
  // the withdrawal first: the run split before it is refused, and its run again sends only its own line, anew
  const next = task(244, 'job/240', { [profile]: `${before}\n- another key\n` });
  commit(next);
  await publish(next, 244);
  await agent.push(next, 'job/240');
  const late = task(245, 'job/240', { [profile]: `${before}\n- e\n` });
  commit(late);
  const split = splitFor(late, 244);
  const { fix: empty } = repair(246, 'profile/244', `${before}\n`);
  await agent.withdrawProfile('profile/244', repairFrom(agent, empty));
  await assert.rejects(() => agent.pushProfile(late, 'profile/244', split.ref, paths, split.over), refused(244));
  assert.equal(remoteRef('profile/244'), null);
  assert.equal(profileOn((await publish(late, 244))!), `${before}\n- e`);
});

test("main merged into a profile pull request is its one commit on main's head again", async () => {
  await firstTask(210, { 'notes/thirteen.md': 'thirteen\n' });
  const before = profileOn('main');
  const dir = task(211, 'job/210', { [profile]: `${before}\n- from the thread\n` });
  commit(dir);
  const head = (await publish(dir, 211))!;
  const main = onMain({ [profile]: `${before}\n- main meanwhile, 211\n` });
  const m = await flow.mergeBase('profile/211', head, ana);
  assert.ok(m.sha, JSON.stringify(m));
  assert.equal(remoteRef('profile/211'), m.sha);
  assert.equal(git('--git-dir', github, 'log', '-1', '--format=%P', m.sha!), main);
  assert.deepEqual(
    git('--git-dir', github, 'log', '-1', '--format=%(trailers:key=Thread-Head,valueonly)', m.sha!),
    git('--git-dir', github, 'log', '-1', '--format=%(trailers:key=Thread-Head,valueonly)', head),
  );
  const lines = profileOn(m.sha!).split('\n');
  assert.deepEqual(
    ['- main meanwhile, 211', '- from the thread'].map(line => lines.filter(l => l === line).length),
    [1, 1],
  );
});

test("the thread's first task sends the profile lines it changed since it branched from main", async () => {
  const dir = task(150, 'job/150', { [profile]: `${profileOn('main')}\n- first task\n` });
  commit(dir);
  onMain({ 'seven.md': 'seven\n' });
  const sha = (await publish(dir, 150))!;
  assert.match(profileOn(sha), /- first task$/);
  assert.equal(onGitHub(sha, 'seven.md'), 'seven');
});

test('a task that changed no profile line has none to send, and one that deleted its profile leaves that with the thread', async () => {
  await firstTask(130, { 'notes/four.md': 'four\n' });
  const dir = task(131, 'job/130', { 'notes/four.md': 'four, again\n' });
  agent.ag(dir, 'rm', '-q', profile);
  commit(dir);
  assert.equal(await publish(dir, 131), undefined);
});

test("profile lines are refused unless they are one commit on main's head changing only the agent's files, on profile/<n>", async () => {
  await firstTask(140, { 'notes/five.md': 'five\n' });
  const dir = task(141, 'job/140', { [profile]: `${profileOn('main')}\n- fifth\n` });
  commit(dir);
  const lines = splitProfile(agent, dir, { base: 'main', branch: 'profile/141', paths, message: 'm', author: ana })!;
  await assert.rejects(
    () => agent.pushProfile(dir, 'job/141', lines.ref, paths, lines.over),
    /Refused to push job\/141/,
  );
  await assert.rejects(
    () => agent.pushProfile(dir, 'profile/141', lines.ref, [archive], lines.over),
    /more than the agent's profile/,
  );
  // a commit that also changes another file
  const main = agent.ag(dir, 'rev-parse', 'origin/main');
  const wider = agent.ag(dir, 'commit-tree', agent.ag(dir, 'rev-parse', 'HEAD^{tree}'), '-p', main, '-m', 'wider');
  agent.ag(dir, 'update-ref', 'refs/hq/wider', wider);
  await assert.rejects(
    () => agent.pushProfile(dir, 'profile/141', 'refs/hq/wider', paths, lines.over),
    /more than the agent's profile/,
  );
  // main moved on since the commit was built
  onMain({ 'six.md': 'six\n' });
  await assert.rejects(
    () => agent.pushProfile(dir, 'profile/141', lines.ref, paths, lines.over),
    /not one commit on main's head/,
  );
  assert.equal(remoteRef('profile/141'), null);
});

test("a profile branch's repair goes back as one commit on main's head, and changes to other files are refused", async () => {
  const dir = task(180, 'job/180', { [profile]: `${profileOn('main')}\n- repaired\n` });
  commit(dir);
  await publish(dir, 180);
  onMain({ [profile]: `${profileOn('main')}\n- main meanwhile\n` });
  // the fix job's clone of the branch: main merged in, its conflict resolved by hand
  const fix = task(181, 'profile/180');
  try {
    agent.ag(fix, 'merge', '-q', '--no-edit', 'origin/main');
  } catch {
    write(fix, { [profile]: `${profileOn('main')}\n- repaired\n` });
    commit(fix);
  }
  const built = rebuildProfile(agent, fix, { base: 'main', paths, message: 'm', author: ana })!;
  const pushed = await agent.pushProfile(fix, 'profile/180', built.ref, paths, built.over);
  const lines = profileOn(pushed.sha).split('\n');
  assert.deepEqual(
    ['- main meanwhile', '- repaired'].map(line => lines.filter(l => l === line).length),
    [1, 1],
  );
  assert.equal(git('--git-dir', github, 'log', '-1', '--format=%P', pushed.sha), remoteRef('main'));
  write(fix, { 'notes/elsewhere.md': 'not a profile\n' });
  commit(fix);
  assert.throws(
    () => rebuildProfile(agent, fix, { base: 'main', paths, message: 'm', author: ana }),
    /more than the agent's profile/,
  );
});
