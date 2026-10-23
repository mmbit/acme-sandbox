// node --test src/git.test.ts   (local bare repos stand in for GitHub; runs as one uid, so the uid switch itself isn't covered)
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { answerMainMerge, branchLines, gitFlow, REPORT_MS, setsOff, SHELVES, FetchUnreachedError, PushUnreachedError } from './git.ts';
import { agentEnv } from './safety.ts';

const TOKEN = 'ghp_' + 'T'.repeat(36);
process.env.GITHUB_TOKEN = TOKEN;   // root's env: must never land in a config file
const tmp = mkdtempSync(`${tmpdir()}/git-test-`);
const work = `${tmp}/work`; mkdirSync(work, { mode: 0o755 });
const github = `${tmp}/github.git`;
const id = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, ...id } }).trim();

// "GitHub": main with one file.
git('init', '-q', '--bare', '-b', 'main', github);
git('clone', '-q', github, `${tmp}/seed`);
writeFileSync(`${tmp}/seed/README.md`, 'hi\n');
git('-C', `${tmp}/seed`, 'add', '-A'); git('-C', `${tmp}/seed`, 'commit', '-qm', 'seed'); git('-C', `${tmp}/seed`, 'push', '-q', 'origin', 'HEAD:main');

const clones = () => readdirSync(`${work}/jobs`).map(n => `${work}/jobs/${n}`);
const flow = gitFlow({ mirror: `${work}/mirror.git`, remote: github, base: 'main', clones });
// uid/gid go through the same spawn options as in production (here: our own uid, as we aren't root)
const job = flow.forAgent({ uid: process.getuid!(), gid: process.getgid!(), env: agentEnv(process.env, { HOME: tmp }) });
mkdirSync(`${work}/jobs`);
const markers = `${tmp}/markers`; mkdirSync(markers);
const ran = () => readdirSync(markers);
const remoteRef = (b: string) => { try { return git('--git-dir', github, 'rev-parse', `refs/heads/${b}`); } catch { return null; } };

function newJob(n: number, file: string, content: string) {
  const dir = `${work}/jobs/${n}`;
  mkdirSync(dir, { mode: 0o700 });
  job.clone(dir, `job/${n}`);
  const path = `${dir}/${file}`; mkdirSync(path.replace(/[^/]+$/, ''), { recursive: true });
  writeFileSync(path, content);
  job.ag(dir, 'add', '-A'); job.ag(dir, 'commit', '-qm', `job ${n}`);
  return dir;
}

test('mirror and a job clone set up with no token in any config', () => {
  flow.ensureMirror(); flow.fetchMirror();
  const dir = `${work}/jobs/1`; mkdirSync(dir, { mode: 0o700 });
  job.clone(dir, 'job/1');
  const mirrorConfig = readFileSync(`${work}/mirror.git/config`, 'utf8');
  const cloneConfig = readFileSync(`${dir}/.git/config`, 'utf8');
  assert.ok(!mirrorConfig.includes(TOKEN) && !cloneConfig.includes(TOKEN));
  assert.ok(!/x-access-token:[^@\s]+@/.test(mirrorConfig + cloneConfig));
  assert.match(mirrorConfig, /helper = .*\$GITHUB_TOKEN/);   // the helper names the variable, never the value
  assert.equal(git('-C', dir, 'remote', 'get-url', 'origin'), `file://${work}/mirror.git`);
  assert.equal(git('--git-dir', `${work}/mirror.git`, 'config', 'transfer.fsckObjects'), 'true');
  assert.equal(git('--git-dir', `${work}/mirror.git`, 'config', 'http.version'), 'HTTP/1.1');   // a push as one request
  assert.match(readFileSync(`${dir}/.git/info/exclude`, 'utf8'), /^\.hq\/$/m);
  assert.equal(git('-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'job/1');   // a new branch starts from main
});

test('two job clones share nothing git writes: own objects, refs, config and hooks; their history is read from the mirror', () => {
  const a = newJob(2, 'a.md', 'a\n'), b = newJob(3, 'b.md', 'b\n');
  for (const dir of [a, b]) {
    assert.equal(git('-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'), `${dir}/.git`);
    assert.equal(readFileSync(`${dir}/.git/objects/info/alternates`, 'utf8').trim(), `${work}/mirror.git/objects`);
    for (const f of readdirSync(`${dir}/.git/objects/pack`)) assert.equal(statSync(`${dir}/.git/objects/pack/${f}`).nlink, 1);
  }
  // a's commit is in a's own objects: not in b's, nor in the mirror they both read
  const commit = git('-C', a, 'rev-parse', 'HEAD');
  assert.throws(() => git('-C', b, 'cat-file', '-e', commit));
  assert.throws(() => git('--git-dir', `${work}/mirror.git`, 'cat-file', '-e', commit));
  job.ag(a, 'config', 'core.hooksPath', `${tmp}/nowhere`);
  assert.throws(() => git('-C', b, 'config', 'core.hooksPath'));   // unset in b
  assert.throws(() => git('-C', b, 'rev-parse', '--verify', 'refs/heads/job/2'));
});

test("a job clone copies none of the mirror's objects, its leftovers included", () => {
  const pack = `${work}/mirror.git/objects/pack`;
  writeFileSync(`${pack}/tmp_pack_killed`, 'x'.repeat(4096));   // what a gc killed mid-repack leaves
  try {
    const dir = newJob(4, 'c.md', 'c\n'), packs = readdirSync(`${dir}/.git/objects/pack`);
    assert.deepEqual(packs, []);
    assert.equal(git('-C', dir, 'cat-file', '-t', 'origin/main'), 'commit');   // main's history, read from the mirror
  } finally { rmSync(`${pack}/tmp_pack_killed`); }
});

test("a killed gc's leftovers go at the worker's start, and the mirror gcs only when asked, in the foreground", async () => {
  const m = `${work}/mirror.git`, mgit = (...a: string[]) => git('--git-dir', m, ...a);
  // what a gc killed with its container leaves; the stale gc.log.lock made every later detached gc die at once
  const dead = ['gc.pid', 'gc.log.lock', 'packed-refs.lock', 'objects/pack/tmp_pack_x6OV1E', 'objects/info/commit-graph.lock'];
  for (const f of dead) writeFileSync(`${m}/${f}`, '1234 an-old-container\n');
  flow.ensureMirror();
  assert.deepEqual(dead.filter(f => existsSync(`${m}/${f}`)), []);
  assert.ok(existsSync(`${m}/HEAD`) && existsSync(`${m}/config`));
  // git would gc after any fetch at these limits; the mirror's fetches never start one
  mgit('config', 'gc.auto', '1'); mgit('config', 'gc.autoPackLimit', '1');
  try {
    git('-C', `${tmp}/seed`, 'pull', '-q');
    writeFileSync(`${tmp}/seed/gc.md`, 'gc\n');
    git('-C', `${tmp}/seed`, 'add', '-A'); git('-C', `${tmp}/seed`, 'commit', '-qm', 'for gc'); git('-C', `${tmp}/seed`, 'push', '-q', 'origin', 'HEAD:main');
    flow.fetchMirror();
    await new Promise(r => setTimeout(r, 500));   // time for a detached gc, were one started
    const packs = () => readdirSync(`${m}/objects/pack`).filter(f => f.endsWith('.pack')).length;
    assert.ok(packs() > 1, "the fetch's pack is still on its own: no gc ran");
    await flow.gcMirror();
    assert.equal(packs(), 1);   // done when the promise is: it didn't detach
  } finally { mgit('config', '--unset', 'gc.auto'); mgit('config', '--unset', 'gc.autoPackLimit'); }
});

test('a bundle push lands job/<n> on the remote, with the sha and files from the mirror', async () => {
  const dir = newJob(7, 'notes/a.md', 'one\n');
  const head = job.ag(dir, 'rev-parse', 'HEAD');
  const r = await job.push(dir, 'job/7');
  assert.equal(r.sha, head);
  assert.equal(remoteRef('job/7'), head);
  assert.deepEqual(r.files, ['notes/a.md']);
});

test("a push's tests test the pushed commit, read and checked out from the mirror, whatever the session left: the worker's git in its clone runs none of its hooks or filters and reads none of its replacement refs", async () => {
  const dir = newJob(150, 'notes/b.md', 'two\n');
  const main = git('--git-dir', `${work}/mirror.git`, 'rev-parse', 'refs/heads/main');
  // What the session leaves: a hook; a filter, in the clone's config and attributes and in its home's; its home's default
  // attributes file re-encoding what's checked out; a replacement of its commit by one with main's files, and a graft;
  // and a commondir lending the clone another repository's config
  const hook = `${dir}/.git/hooks/pre-commit`;
  writeFileSync(hook, `#!/bin/sh\ntouch ${markers}/hook-ran\n`);
  chmodSync(hook, 0o755);
  git('-C', dir, 'config', 'filter.planted.clean', `sh -c 'touch ${markers}/filter-ran; cat'`);
  writeFileSync(`${dir}/.git/info/attributes`, '* filter=planted\n');
  writeFileSync(`${tmp}/.gitconfig`, `[filter "planted"]\n\tclean = sh -c 'touch ${markers}/home-filter-ran; cat'\n[core]\n\tattributesFile = ${dir}/.git/info/attributes\n`);
  mkdirSync(`${tmp}/.config/git`, { recursive: true });
  writeFileSync(`${tmp}/.config/git/attributes`, '*.md working-tree-encoding=UTF-16\n');
  try {
    writeFileSync(`${dir}/notes/c.md`, 'three\n');
    git('-C', dir, 'add', '-A');
    git('-C', dir, 'reset', '-q');
    assert.ok(ran().includes('filter-ran'), "the planted filter doesn't run in the session's own git");
    rmSync(`${markers}/filter-ran`);
    git('-C', dir, 'replace', 'HEAD', git('-C', dir, 'commit-tree', '-p', main, '-m', 'stand-in', `${main}^{tree}`));
    assert.equal(git('-C', dir, 'rev-parse', 'HEAD^{tree}'), git('-C', dir, 'rev-parse', `${main}^{tree}`));
    writeFileSync(`${dir}/.git/info/grafts`, `${git('-C', dir, 'rev-parse', 'HEAD')}\n`);   // (its commit with no parent)
    mkdirSync(`${tmp}/elsewhere.git`);
    writeFileSync(`${dir}/.git/commondir`, `${tmp}/elsewhere.git\n`);

    job.settle(dir, { name: 'Knop agents', email: 'agents@knop.invalid' });
    assert.ok(!existsSync(`${dir}/.git/commondir`));
    assert.equal(job.ag(dir, 'config', 'user.name'), 'Knop agents');
    assert.throws(() => job.ag(dir, 'config', 'filter.planted.clean'));
    assert.equal(job.ag(dir, 'rev-parse', 'HEAD^'), main);
    job.ag(dir, 'add', '-A');
    job.ag(dir, 'commit', '-qm', 'job 150 again');
    const left = ran().filter(m => /hook|filter/.test(m));
    assert.deepEqual(left, [], `the worker's commit ran what the session left: ${left}`);
    const pushed = await job.push(dir, 'job/150');
    assert.deepEqual(pushed.files.sort(), ['notes/b.md', 'notes/c.md']);
    writeFileSync(`${dir}/notes/b.md`, 'moved on\n');
    job.ag(dir, 'commit', '-qam', 'after the push');

    const tested = flow.testedCode(pushed.sha);
    assert.deepEqual(tested, {
      sha: pushed.sha,
      base: main,
      tree: git('--git-dir', `${work}/mirror.git`, 'rev-parse', `${pushed.sha}^{tree}`),
      baseTree: git('--git-dir', `${work}/mirror.git`, 'rev-parse', `${main}^{tree}`),
    });
    const at = `${tmp}/tested-150`;
    job.checkout(at, tested.sha);
    assert.equal(git('-C', at, 'rev-parse', 'HEAD'), pushed.sha);
    assert.equal(readFileSync(`${at}/notes/b.md`, 'utf8'), 'two\n');
    assert.equal(readFileSync(`${at}/notes/c.md`, 'utf8'), 'three\n');
    // (control: the home's attributes are live for a git that skips its config but doesn't pin them)
    const env = { ...process.env, HOME: tmp, GIT_CONFIG_GLOBAL: '/dev/null' };
    const homeGit = execFileSync('git', ['-C', at, 'check-attr', 'working-tree-encoding', 'notes/b.md'], { encoding: 'utf8', env });
    assert.equal(homeGit.trim(), 'notes/b.md: working-tree-encoding: UTF-16');
    assert.equal(git('-C', at, 'status', '--porcelain'), '');
    assert.equal(git('-C', at, 'for-each-ref', 'refs/replace/'), '');
  } finally {
    rmSync(`${tmp}/.gitconfig`);
    rmSync(`${tmp}/.config`, { recursive: true });
  }
});

// What a push changed since the branch's last head, which a fix round's review reads
test("a push says which of the pull request's files it changed since the branch's last head, leaving out what a merge of main brought", async () => {
  const dir = newJob(40, 'notes/fix.md', 'one\n');
  writeFileSync(`${dir}/notes/other.md`, 'two\n'); job.ag(dir, 'add', '-A'); job.ag(dir, 'commit', '-qm', 'more');
  const first = await job.push(dir, 'job/40');
  assert.equal(first.pushedSince, undefined);   // the branch's first push: nothing before it
  // main moves on, and the fix round merges it in and changes one line
  git('-C', `${tmp}/seed`, 'pull', '-q');
  writeFileSync(`${tmp}/seed/CHANGELOG.md`, 'x\n');
  git('-C', `${tmp}/seed`, 'add', '-A'); git('-C', `${tmp}/seed`, 'commit', '-qm', 'main moves'); git('-C', `${tmp}/seed`, 'push', '-q', 'origin', 'HEAD:main');
  flow.fetchMirror();
  job.ag(dir, 'fetch', '-q', 'origin'); job.ag(dir, 'merge', '-q', '--no-edit', 'origin/main');
  writeFileSync(`${dir}/notes/fix.md`, 'fixed\n'); job.ag(dir, 'commit', '-qam', 'fix');
  const second = await job.push(dir, 'job/40');
  assert.deepEqual(second.files, ['notes/fix.md', 'notes/other.md']);
  assert.deepEqual(second.pushedSince, { sha: first.sha, files: ['notes/fix.md'] });
});

test('a fix that puts a file back as main has it still counts among the fixes: the code the pull request keeps runs against it', async () => {
  writeFileSync(`${tmp}/seed/auth.ts`, 'check()\n');
  git('-C', `${tmp}/seed`, 'add', '-A'); git('-C', `${tmp}/seed`, 'commit', '-qm', 'auth'); git('-C', `${tmp}/seed`, 'push', '-q', 'origin', 'HEAD:main');
  flow.fetchMirror();
  const dir = newJob(41, 'app/app.js', 'one\n');
  writeFileSync(`${dir}/auth.ts`, 'checkBetter()\n'); job.ag(dir, 'commit', '-qam', 'auth');
  const first = await job.push(dir, 'job/41');
  assert.deepEqual(first.files, ['app/app.js', 'auth.ts']);
  job.ag(dir, 'checkout', 'origin/main', '--', 'auth.ts');
  writeFileSync(`${dir}/app/app.js`, 'two\n'); job.ag(dir, 'commit', '-qam', 'fix');
  const second = await job.push(dir, 'job/41');
  assert.deepEqual(second.files, ['app/app.js']);
  assert.deepEqual(second.pushedSince, { sha: first.sha, files: ['app/app.js', 'auth.ts'] });
});

test('a push carries the lines it adds or alters in each file, a deletion as the lines around it, and no line of a removed file', async () => {
  writeFileSync(`${tmp}/seed/long.txt`, Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join(''));
  writeFileSync(`${tmp}/seed/gone.txt`, 'bye\n');
  git('-C', `${tmp}/seed`, 'add', '-A'); git('-C', `${tmp}/seed`, 'commit', '-qm', 'long'); git('-C', `${tmp}/seed`, 'push', '-q', 'origin', 'HEAD:main');
  flow.fetchMirror();
  // a content line that reads like a header ("++ x" added shows as "+++ x") doesn't move the lines to another file
  const dir = newJob(42, 'new.md', 'a\n++ b/elsewhere\n');
  const lines = readFileSync(`${dir}/long.txt`, 'utf8').split('\n');
  lines[4] = 'changed 5'; lines.splice(19, 2);
  writeFileSync(`${dir}/long.txt`, lines.join('\n'));
  job.ag(dir, 'rm', '-q', 'gone.txt');
  job.ag(dir, 'commit', '-qam', 'edit');
  assert.deepEqual((await job.push(dir, 'job/42')).lines, { 'long.txt': [[5, 5], [19, 20]], 'new.md': [[1, 2]] });
});

test('a push can delete a textual trace larger than its line-range output buffer', async () => {
  const room = mkdtempSync(`${tmpdir()}/git-deletion-`);
  try {
    const remote = `${room}/github.git`, seed = `${room}/seed`, dir = `${room}/job`;
    git('init', '-q', '--bare', '-b', 'main', remote);
    git('clone', '-q', remote, seed);
    writeFileSync(`${seed}/trace.txt`, '');
    for (let chunk = 0; chunk < 65; chunk++) appendFileSync(`${seed}/trace.txt`, 'x'.repeat(1 << 20));
    appendFileSync(`${seed}/trace.txt`, '\n');
    writeFileSync(`${seed}/keep.txt`, 'before\n');
    git('-C', seed, 'add', '-A'); git('-C', seed, 'commit', '-qm', 'seed');
    git('-C', seed, 'push', '-q', 'origin', 'HEAD:main');
    const deletionFlow = gitFlow({ mirror: `${room}/mirror.git`, remote, base: 'main', clones: () => [dir] });
    deletionFlow.ensureMirror(); deletionFlow.fetchMirror();
    const deletionJob = deletionFlow.forAgent({ uid: process.getuid!(), gid: process.getgid!(), env: agentEnv(process.env, { HOME: room }) });
    mkdirSync(dir, { mode: 0o700 }); deletionJob.clone(dir, 'job/1');
    deletionJob.ag(dir, 'rm', '-q', 'trace.txt');
    writeFileSync(`${dir}/keep.txt`, 'after\n');
    deletionJob.ag(dir, 'commit', '-qam', 'remove trace');
    const pushed = await deletionJob.push(dir, 'job/1');
    assert.deepEqual(pushed.files, ['keep.txt', 'trace.txt']);
    assert.deepEqual(pushed.lines, { 'keep.txt': [[1, 1]] });
    assert.equal(git('--git-dir', remote, 'rev-parse', 'refs/heads/job/1'), pushed.sha);
  } finally { rmSync(room, { recursive: true, force: true }); }
});

test('a rename lists both paths, and submodules come back as links', async () => {
  const dir = newJob(30, 'company/people/zed.md', 'x\n');
  job.ag(dir, 'mv', 'README.md', 'company/people/zed2.md');   // a file moved into a new profile
  mkdirSync(`${dir}/platform`); writeFileSync(`${dir}/platform/é.ts`, 'x\n');   // unquoted, so HIGH_RISK sees it
  job.ag(dir, 'add', '-A');
  job.ag(dir, 'update-index', '--add', '--cacheinfo', `160000,${job.ag(dir, 'rev-parse', 'HEAD')},company/people/zed3.md`);   // a submodule
  job.ag(dir, 'commit', '-qm', 'moves');
  const r = await job.push(dir, 'job/30');
  assert.deepEqual(r.files, ['README.md', 'company/people/zed.md', 'company/people/zed2.md', 'company/people/zed3.md', 'platform/é.ts']);
  assert.deepEqual(r.links, ['company/people/zed3.md']);
});

test('a push with a symlink in it is refused and names it, wherever it points; one the branch removed again goes', async () => {
  const dir = newJob(35, 'products/_cycles/x/index.html', 'x\n');
  symlinkSync('/data/caddy', `${dir}/products/_cycles/x/keys`);
  symlinkSync('index.html', `${dir}/products/_cycles/x/home.html`);   // inside the repo too
  job.ag(dir, 'add', '-A'); job.ag(dir, 'commit', '-qm', 'links');
  await assert.rejects(() => job.push(dir, 'job/35'), (e: Error) => ['products/_cycles/x/home.html', 'products/_cycles/x/keys'].every(f => e.message.includes(f)));
  assert.equal(remoteRef('job/35'), null);
  job.ag(dir, 'rm', '-q', 'products/_cycles/x/keys', 'products/_cycles/x/home.html'); job.ag(dir, 'commit', '-qm', 'no links');
  assert.deepEqual((await job.push(dir, 'job/35')).files, ['products/_cycles/x/index.html']);
});

test("a push carries the frontmatter of the changed files on the Library's shelves, as pushed, and nothing else", async () => {
  const fm = (t: string) => `---\n${t}\n---\n# Heading\nbody\n`;
  const dir = newJob(31, 'knowledge/notes/platform/a.md', fm('title: A: B'));
  const put = (f: string, c: string) => { mkdirSync(`${dir}/${f}`.replace(/[^/]+$/, ''), { recursive: true }); writeFileSync(`${dir}/${f}`, c); };
  put('knowledge/posts/2026-09-30-x/index.md', fm('verified: 2026-09-28 (x, job #1)'));
  put('company/playbooks/p.md', 'no frontmatter\n');
  put('company/people/zed.md', fm('title: A: B'));                 // profiles aren't on the shelves
  put('knowledge/notes/platform/README.md', fm('title: A: B'));      // nor are READMEs
  put('knowledge/notes/platform/deep/b.md', fm('title: A: B'));      // nor a folder inside a topic
  put('company/big.md', fm(`title: ${'x'.repeat(10_000)}`));
  put('company/playbooks/x.md', fm('title: X: Y')); chmodSync(`${dir}/company/playbooks/x.md`, 0o755);   // executable is still a file
  job.ag(dir, 'add', '-A'); job.ag(dir, 'commit', '-qm', 'notes');
  const r = await job.push(dir, 'job/31');
  assert.deepEqual(r.frontmatter, [{ path: 'company/big.md', text: null },   // over 8 KB: not sent, but named
    { path: 'company/playbooks/x.md', text: 'title: X: Y' },
    { path: 'knowledge/notes/platform/a.md', text: 'title: A: B' },
    { path: 'knowledge/posts/2026-09-30-x/index.md', text: 'verified: 2026-09-28 (x, job #1)' }]);
  // a deleted one isn't read
  job.ag(dir, 'rm', '-q', 'knowledge/notes/platform/a.md'); job.ag(dir, 'commit', '-qm', 'gone');
  assert.ok(!(await job.push(dir, 'job/31')).frontmatter.some(f => f.path === 'knowledge/notes/platform/a.md'));
});

test('a push carries its changed posts and notes whole, with the files under knowledge/, so the review can see a missing picture', async () => {
  const post = 'knowledge/posts/2026-10-01-x/index.md', text = '---\ntitle: X\n---\n![a](burst.jpg)\n';
  const dir = newJob(32, post, text);
  const put = (f: string, c: string) => { mkdirSync(`${dir}/${f}`.replace(/[^/]+$/, ''), { recursive: true }); writeFileSync(`${dir}/${f}`, c); };
  put('knowledge/posts/2026-10-01-x/burst.jpg', 'jpg');
  put('company/playbooks/p.md', '![b](p.png)\n');                   // the handbook's links aren't fetched from /knowledge/
  put('knowledge/notes/platform/big.md', 'x'.repeat(70_000));          // over 64 KB: not checked
  job.ag(dir, 'add', '-A'); job.ag(dir, 'commit', '-qm', 'a post');
  const r = await job.push(dir, 'job/32');
  assert.deepEqual(r.knowledge.docs, [{ path: post, text }]);
  assert.deepEqual(r.knowledge.files, ['knowledge/notes/platform/big.md', 'knowledge/posts/2026-10-01-x/burst.jpg', post]);
  // a push with no post or note sends neither
  put('company/playbooks/q.md', 'q\n'); job.ag(dir, 'add', '-A'); job.ag(dir, 'commit', '-qm', 'q');
  job.ag(dir, 'rm', '-q', post); job.ag(dir, 'commit', '-qm', 'gone');
  assert.deepEqual((await job.push(dir, 'job/32')).knowledge, { docs: [], files: [] });
});

test('a push that deletes or moves a picture sends the posts and notes that name it, though they are unchanged', async () => {
  const post = 'knowledge/posts/2026-10-02-y/index.md', text = '---\ntitle: Y\n---\n![a](snap.png)\n', note = 'knowledge/notes/platform/n.md';
  for (const [f, c] of [[post, text], ['knowledge/posts/2026-10-02-y/snap.png', 'png'], [note, '[the snap](../../posts/2026-10-02-y/snap.png)\n'],
    ['knowledge/notes/platform/other.md', 'other\n']] as const) {
    mkdirSync(`${tmp}/seed/${f}`.replace(/[^/]+$/, ''), { recursive: true }); writeFileSync(`${tmp}/seed/${f}`, c);
  }
  git('-C', `${tmp}/seed`, 'add', '-A'); git('-C', `${tmp}/seed`, 'commit', '-qm', 'a post with a picture'); git('-C', `${tmp}/seed`, 'push', '-q', 'origin', 'HEAD:main');
  flow.fetchMirror();
  const dir = newJob(33, 'company/playbooks/r.md', 'r\n');
  job.ag(dir, 'mv', 'knowledge/posts/2026-10-02-y/snap.png', 'knowledge/posts/2026-10-02-y/snap-1.png'); job.ag(dir, 'commit', '-qm', 'moved');
  const r = await job.push(dir, 'job/33');
  assert.deepEqual(r.knowledge.docs.map(d => d.path).sort(), [note, post]);
  assert.ok(r.knowledge.files.includes('knowledge/posts/2026-10-02-y/snap-1.png') && !r.knowledge.files.includes('knowledge/posts/2026-10-02-y/snap.png'));
});

test("a push carries each changed settings file before and after, as pushed; null where there's no plain file or it's too big", async () => {
  const dir = newJob(34, 'company/infra.env', 'SEATS=3\n');
  const put = (f: string, c: string) => { mkdirSync(`${dir}/${f}`.replace(/[^/]+$/, ''), { recursive: true }); writeFileSync(`${dir}/${f}`, c); };
  put('company/big.yaml', `a: ${'x'.repeat(70_000)}\n`);
  put('company/people/zed.yaml', 'a: 1\n');   // not at the top of company/
  put('company/notes.md', 'x\n');
  job.ag(dir, 'add', '-A'); job.ag(dir, 'commit', '-qm', 'settings');
  assert.deepEqual((await job.push(dir, 'job/34')).settings, [{ path: 'company/big.yaml', before: null, after: null },
    { path: 'company/infra.env', before: null, after: 'SEATS=3\n' }]);
});

test("the shelves are the files the Library reads", () => {
  for (const f of ['company/CHARTER.md', 'company/DECISIONS.md', 'company/playbooks/knowledge.md', 'company/departments/platform.md',
    'knowledge/notes/platform/payments.md', 'knowledge/posts/2026-09-25-were-open/index.md', 'shared/craft/decks.md']) assert.ok(SHELVES.test(f), f);
  for (const f of ['company/README.md', 'company/people/bolt.md', 'company/playbooks/README.md', 'company/org.yaml', 'knowledge/notes/README.md',
    'knowledge/notes/care/support-chat/README.md', 'knowledge/notes/care/support-chat/x.md', 'knowledge/posts/2026-09-25-were-open/other.md',
    'products/pebblet/README.md', 'knowledge/notes/platform/x.mdx', 'shared/craft/README.md', 'shared/deck/README.md']) assert.ok(!SHELVES.test(f), f);
});

test('pushing any branch but job/<n> is refused and the remote is untouched', async () => {
  const main = remoteRef('main');
  const dir = `${work}/jobs/7`;
  for (const b of ['main', 'job/7x', 'refs/heads/main', 'job/7:main'])
    await assert.rejects(() => job.push(dir, b), /Refused to push/);
  assert.equal(remoteRef('main'), main);
});

test('hooks and config planted in the agent repo never run on the root side', async () => {
  const dir = newJob(8, 'b.md', 'two\n');
  const hook = (name: string) => { const f = `${tmp}/hooks/${name}`; writeFileSync(f, `#!/bin/sh\ntouch ${markers}/${name}\n`); chmodSync(f, 0o755); };
  mkdirSync(`${tmp}/hooks`);
  for (const h of ['pre-push', 'post-checkout', 'reference-transaction', 'post-update', 'pre-receive']) hook(h);
  writeFileSync(`${tmp}/fsmonitor`, `#!/bin/sh\ntouch ${markers}/fsmonitor\n`); chmodSync(`${tmp}/fsmonitor`, 0o755);
  job.ag(dir, 'config', 'core.hooksPath', `${tmp}/hooks`);
  job.ag(dir, 'config', 'core.fsmonitor', `${tmp}/fsmonitor`);
  job.ag(dir, 'config', `url.${tmp}/evil.git.insteadOf`, github);   // would redirect a push made from here
  for (const h of ['pre-push', 'post-checkout']) { writeFileSync(`${dir}/.git/hooks/${h}`, `#!/bin/sh\ntouch ${markers}/repo-${h}\n`); chmodSync(`${dir}/.git/hooks/${h}`, 0o755); }
  const r = await job.push(dir, 'job/8');
  assert.deepEqual(ran(), [], `hooks ran: ${ran()}`);
  assert.equal(remoteRef('job/8'), r.sha);
  assert.ok(!existsSync(`${tmp}/evil.git`));
  // Control: the planted hooks are live, they just only ever run in the agent's own git (the worker's runs none:
  // git.ts pinnedArgs).
  git('-C', dir, 'checkout', '-q', '--detach');
  assert.ok(ran().includes('post-checkout'));
});

test('a refused push fails with a clear, redacted reason', async () => {
  // Stand-in for GitHub refusing workflow changes to a token without the workflow permission.
  writeFileSync(`${github}/hooks/pre-receive`, `#!/bin/sh\nwhile read o n r; do git diff --name-only main $n | grep -q '^.github/workflows/' && { echo "refusing to allow a Personal Access Token ${TOKEN} to create or update workflow"; exit 1; }; done; exit 0\n`);
  chmodSync(`${github}/hooks/pre-receive`, 0o755);
  const dir = newJob(9, '.github/workflows/x.yml', 'on: workflow_dispatch\n');
  await assert.rejects(() => job.push(dir, 'job/9'), (e: Error) => /GitHub refused the push to job\/9: .*workflow/s.test(e.message) && !e.message.includes(TOKEN));
  assert.equal(remoteRef('job/9'), null);
});

test("a push that doesn't reach GitHub goes again after a pause; one GitHub refuses, or lost every time, fails with why", async t => {
  const { as, dropping, tried, logged } = pushConnection(t);
  dropping(1);
  const dir = newJob(80, 'a.md', 'lost once\n');
  const r = await as.push(dir, 'job/80');
  assert.equal(remoteRef('job/80'), r.sha);
  assert.equal(tried(), 2);
  assert.match(logged.join('\n'), /push to job\/80 didn't reach GitHub, trying again in 0 s: .*unexpected disconnect/);

  dropping(3);
  const lost = await as.push(newJob(81, 'a.md', 'lost every time\n'), 'job/81').catch((e: Error) => e);
  assert.match(String(lost), /The push to job\/81 didn't reach GitHub in 3 tries: .*RPC failed/s);
  // (the worker's own snag, so the job goes back in the queue: worker.ts land.)
  assert.ok(lost instanceof PushUnreachedError);
  assert.equal(tried(), 3);
  assert.equal(remoteRef('job/81'), null);

  // A refusal is GitHub's answer: one try. Here job/82 moved on GitHub since, so ours isn't a fast-forward.
  dropping(0);
  const other = `${tmp}/other82`; git('clone', '-q', github, other);
  git('-C', other, 'commit', '-q', '--allow-empty', '-m', 'elsewhere'); git('-C', other, 'push', '-q', 'origin', 'HEAD:job/82');
  const refused = await as.push(newJob(82, 'a.md', 'refused\n'), 'job/82').catch((e: Error) => e);
  assert.match(String(refused), /GitHub refused the push to job\/82: .*fast-forwards/s);
  assert.ok(!(refused instanceof PushUnreachedError), "a refusal is GitHub's answer, not a snag");
  assert.equal(tried(), 1);
});

test('pushes stop on HTTP or unpack refusals and recover from server or DNS failures', async t => {
  const { as, dropping, tried } = pushConnection(t);
  for (const [i, { says, refused }] of [
    { says: 'error: RPC failed; HTTP 401 curl 22 The requested URL returned error: 401', refused: true },
    { says: 'error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403', refused: true },
    { says: 'error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413', refused: true },
    { says: 'remote: fatal: pack exceeds maximum allowed size\nerror: remote unpack failed: index-pack abnormal exit', refused: true },
    { says: 'error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502', refused: false },
    { says: 'fatal: Could not resolve host: github.com', refused: false },
  ].entries()) {
    dropping(1, says);
    const branch = `job/${83 + i}`, dir = newJob(83 + i, 'a.md', 'push\n');
    if (refused) {
      await assert.rejects(() => as.push(dir, branch), /GitHub refused/);
      assert.equal(tried(), 1);
      assert.equal(remoteRef(branch), null);
    } else {
      const pushed = await as.push(dir, branch);
      assert.equal(tried(), 2);
      assert.equal(remoteRef(branch), pushed.sha);
    }
  }
});

test('a retried push cannot substitute another job commit on the same branch', async t => {
  const first = newJob(180, 'first.txt', 'first\n'), second = newJob(181, 'second.txt', 'second\n');
  const secondSha = job.ag(second, 'rev-parse', 'HEAD');
  // Another worker call completes while the first push is between attempts.
  const { as, dropping, mgit } = pushConnection(t, () => {
    const script = `import { gitFlow } from ${JSON.stringify(new URL('./git.ts', import.meta.url).href)};
      const flow = gitFlow({ mirror: ${JSON.stringify(`${work}/mirror.git`)}, remote: ${JSON.stringify(github)}, base: 'main', clones: () => [] });
      await flow.forAgent({ uid: process.getuid(), gid: process.getgid(), env: process.env }).push(${JSON.stringify(second)}, 'job/180');`;
    execFileSync(process.execPath, ['--input-type=module', '-e', script]);
  });
  dropping(1);
  await assert.rejects(() => as.push(first, 'job/180'), /GitHub refused/);
  assert.equal(remoteRef('job/180'), secondSha);
  assert.equal(mgit('rev-parse', 'refs/heads/job/180'), secondSha);
});

test('reviews check out exactly the pinned sha; the branch tip only without one', async () => {
  const dir = `${work}/jobs/7`;
  const first = remoteRef('job/7')!;
  writeFileSync(`${dir}/notes/a.md`, 'pushed after the review started\n');
  job.ag(dir, 'commit', '-qam', 'later');
  const second = (await job.push(dir, 'job/7')).sha;
  flow.fetchMirror();
  const review = (n: string, sha: string | null) => { const d = `${work}/jobs/${n}`; mkdirSync(d); job.clone(d, 'job/7', { sha }); return d; };
  assert.equal(job.ag(review('r1', first), 'rev-parse', 'HEAD'), first);
  assert.equal(readFileSync(`${work}/jobs/r1/notes/a.md`, 'utf8'), 'one\n');
  assert.equal(job.ag(review('r2', null), 'rev-parse', 'HEAD'), second);
  assert.throws(() => review('r3', '--output=/tmp/x'), /Not a commit id/);
});

test('a review still checks out its pinned sha once the branch was force-pushed away from it', () => {
  const seed = `${tmp}/seed`;
  git('-C', seed, 'checkout', '-qb', 'job/50', 'main');
  writeFileSync(`${seed}/old.md`, 'reviewed\n'); git('-C', seed, 'add', '-A'); git('-C', seed, 'commit', '-qm', 'reviewed');
  git('-C', seed, 'push', '-q', 'origin', 'job/50');
  flow.fetchMirror();
  const pinned = remoteRef('job/50')!;
  git('-C', seed, 'checkout', '-q', '--orphan', 'other'); git('-C', seed, 'commit', '-qm', 'unrelated');
  git('-C', seed, 'push', '-qf', 'origin', 'HEAD:job/50');
  git('-C', seed, 'checkout', '-q', 'main');
  flow.fetchMirror();
  assert.notEqual(git('--git-dir', `${work}/mirror.git`, 'rev-parse', 'refs/heads/job/50'), pinned);
  const d = `${work}/jobs/r50`; mkdirSync(d);
  job.clone(d, 'job/50', { sha: pinned });
  assert.equal(job.ag(d, 'rev-parse', 'HEAD'), pinned);
  assert.equal(readFileSync(`${d}/old.md`, 'utf8'), 'reviewed\n');
});

test('a mirror that others could write is moved aside, never used', () => {
  const m = `${tmp}/w2`; mkdirSync(m, { mode: 0o755 });
  git('init', '-q', '--bare', `${m}/mirror.git`);
  git('--git-dir', `${m}/mirror.git`, 'config', 'core.hooksPath', `${tmp}/hooks`);
  chmodSync(`${m}/mirror.git`, 0o777);
  const f2 = gitFlow({ mirror: `${m}/mirror.git`, remote: github, base: 'main', clones: () => [] });
  f2.ensureMirror();
  assert.ok(readdirSync(m).some(n => n.startsWith('mirror.git.untrusted-')));
  assert.equal(readFileSync(`${m}/mirror.git/config`, 'utf8').includes('hooksPath'), false);
  // and a parent directory others can write is refused outright
  chmodSync(m, 0o777);
  assert.throws(() => f2.ensureMirror(), /must be ours alone/);
});

test('H3: a job branch whose own workflows would run on it is not pushed, whatever it changes, until they run on main only', async () => {
  rmSync(`${github}/hooks/pre-receive`);   // main takes workflow files here
  const seed = `${tmp}/seed`, wf = `${seed}/.github/workflows`;
  const toMain = () => {
    git('-C', seed, 'add', '-A'); git('-C', seed, 'commit', '-qm', 'workflows'); git('-C', seed, 'push', '-q', 'origin', 'HEAD:main');
    flow.fetchMirror();
    return git('-C', seed, 'rev-parse', 'HEAD');
  };
  const server = (limit: string) => `name: Server\non:\n  workflow_dispatch:\n  push:\n${limit}    paths: [infra/provision.sh, 'infra/cloud-init.yaml']\njobs:\n  provision:\n    runs-on: ubuntu-latest\n`;
  const dns = (limit: string) => `on:\n  push:\n${limit}    paths:\n      - infra/host\n      - "infra/dns/**"\n`;
  mkdirSync(wf, { recursive: true });
  writeFileSync(`${wf}/server.yml`, server(''));
  writeFileSync(`${wf}/dns.yml`, dns(''));
  writeFileSync(`${wf}/email.yml`, 'on:\n  push:\n    branches: [main]\n    paths: [infra/mail/worker.js]\n');
  writeFileSync(`${wf}/release.yml`, 'on:\n  push:\n    tags: [v*]\n');
  const before = toMain();   // main before the board's edit
  // GitHub matches paths against its own range, not the job's diff, so it isn't only trigger paths that are refused.
  for (const [n, file] of [[20, 'infra/provision.sh'], [21, 'infra/dns/zones/a.txt'], [22, 'docs/notes.md']] as const) {
    await assert.rejects(() => job.push(newJob(n, file, 'x\n'), `job/${n}`), new RegExp(`Refused to push job/${n}: .*dns\\.yml, .*server\\.yml runs on pushes to any branch`, 's'));
    assert.equal(remoteRef(`job/${n}`), null);
  }

  // The board's edit: both run on main only. A branch cut before it carries the old copies, which GitHub would run.
  writeFileSync(`${wf}/server.yml`, server('    branches: [main]\n'));
  writeFileSync(`${wf}/dns.yml`, dns('    branches:\n      - main\n'));
  toMain();
  await assert.rejects(() => job.push(`${work}/jobs/22`, 'job/22'), /Refused to push job\/22: .*server\.yml/s);
  assert.equal(remoteRef('job/22'), null);
  // once it merges main it goes up for review; so does a branch cut after the edit, trigger paths and all
  job.ag(`${work}/jobs/20`, 'fetch', '-q', 'origin');
  job.ag(`${work}/jobs/20`, 'merge', '-q', '--no-edit', 'origin/main');
  assert.deepEqual((await job.push(`${work}/jobs/20`, 'job/20')).files, ['infra/provision.sh']);
  assert.ok(remoteRef('job/20'));
  assert.ok((await job.push(newJob(24, 'infra/mail/worker.js', 'x\n'), 'job/24')).sha);
  assert.ok((await job.push(newJob(26, 'infra/cloud-init.yaml', 'x\n'), 'job/26')).sha);

  // Bypass (1): job/27 is on GitHub from before, adding infra/cloud-init.yaml. The job takes it out again and changes
  // infra/github_token.py: its own diff against main shows only that, but GitHub's before..after has cloud-init.yaml.
  const old = `${tmp}/old`;
  git('clone', '-q', github, old); git('-C', old, 'checkout', '-q', '-b', 'job/27', before);
  mkdirSync(`${old}/infra`); writeFileSync(`${old}/infra/cloud-init.yaml`, 'x\n');
  git('-C', old, 'add', '-A'); git('-C', old, 'commit', '-qm', 'earlier push'); git('-C', old, 'push', '-q', 'origin', 'job/27');
  flow.fetchMirror();
  const tip = remoteRef('job/27'), d27 = `${work}/jobs/27`;
  mkdirSync(d27, { mode: 0o700 }); job.clone(d27, 'job/27');
  writeFileSync(`${d27}/infra/github_token.py`, 'seal = "changed"\n');
  job.ag(d27, 'rm', '-q', 'infra/cloud-init.yaml');
  job.ag(d27, 'add', '-A'); job.ag(d27, 'commit', '-qm', 'put it back, change the sealer');
  assert.equal(job.ag(d27, 'diff', '--name-only', 'origin/main...HEAD'), 'infra/github_token.py');
  assert.match(job.ag(d27, 'diff', '--name-only', `${tip}..HEAD`), /infra\/cloud-init\.yaml/);
  await assert.rejects(() => job.push(d27, 'job/27'), /Refused to push job\/27: .*server\.yml/s);
  assert.equal(remoteRef('job/27'), tip);

  // Bypass (3): over 1,000 commits GitHub runs push workflows whatever the paths. A pre-edit branch with 1,001.
  const d28 = `${work}/jobs/28`;
  mkdirSync(d28, { mode: 0o700 }); job.clone(d28, 'job/28');
  job.ag(d28, 'checkout', '-q', '-B', 'job/28', before);
  mkdirSync(`${d28}/infra`); writeFileSync(`${d28}/infra/github_token.py`, 'seal = "changed"\n');
  job.ag(d28, 'add', '-A'); job.ag(d28, 'commit', '-qm', 'change the sealer');
  let stream = '';
  for (let i = 0; i < 1000; i++) stream += `commit refs/heads/job/28\ncommitter t <t@t> ${i} +0000\ndata 1\ne\n${i ? '' : 'from refs/heads/job/28^0\n'}\n`;
  job.as('git', ['-C', d28, 'fast-import', '--quiet', '--force'], stream);
  assert.equal(job.ag(d28, 'rev-list', '--count', `${before}..HEAD`), '1001');
  await assert.rejects(() => job.push(d28, 'job/28'), /Refused to push job\/28: .*server\.yml/s);
  assert.equal(remoteRef('job/28'), null);
});

test('H3 reads the trigger forms GitHub accepts; filters that let job/<n> through, or none, count as running', () => {
  const runs = ['on: push', 'on: [push, pull_request]', "'on':\n  push:\n", 'on:\n  create:\n', 'on:\n    push:\n        paths: [a]\n',
    'on:\n  push: {paths: [x]}\n', 'on:\n  push:\n    branches: ["**"]\n', 'on:\n  push:\n    branches:\n      - main\n      - job/*\n',
    'on:\n  push:\n    branches: [ "job/[0-9]+" ]\n', 'on:\n  push:\n    branches-ignore: [main]\n'];
  const not = ['on: workflow_dispatch', 'on:\n  push:\n    branches: [main]\n', 'on:\n  push: {branches: [main]}\n', 'on:\n  push:\n    tags: [v*]\n',
    'on:\n  push:\n    branches: # main only\n      - main\n      - release/**\n', 'on:\n  push:\n    branches-ignore: [job/**]\n',
    'on:\n  workflow_dispatch:\n    inputs:\n      push: {description: x}\n'];
  for (const w of runs) assert.equal(setsOff(w, 'job/12'), true, w);
  for (const w of not) assert.equal(setsOff(w, 'job/12'), false, w);
});

const author = { name: 'Company agents', email: 'agents@t' };
test("main merged into a passed head by git's own merge, with main's attributes: union files merge and are pushed; real conflicts are named and nothing moves", async () => {
  onMain('.gitattributes', 'people/*.md merge=union\n');
  onMain('people/a.md', 'top\n');
  onMain('app.js', 'one\n');
  flow.fetchMirror();
  // a passed branch that logged a line in its profile, and one that also changed code main changed since
  const profile = newJob(90, 'people/a.md', 'top\nfrom the branch\n'), passed = (await job.push(profile, 'job/90')).sha;
  const code = newJob(91, 'people/a.md', 'top\nfrom the other branch\n');
  writeFileSync(`${code}/app.js`, 'branch\n'); job.ag(code, 'commit', '-qam', 'code');
  // the branch's own attributes would union-merge code: only main's count
  writeFileSync(`${code}/.gitattributes`, '* merge=union\n'); job.ag(code, 'add', '-A'); job.ag(code, 'commit', '-qm', 'attrs');
  const conflicting = (await job.push(code, 'job/91')).sha;
  onMain('people/a.md', 'top\nfrom main\n');
  onMain('app.js', 'main\n');
  flow.fetchMirror();

  const merged = await flow.mergeBase('job/90', passed, author);
  assert.ok(merged.sha && merged.sha !== passed);
  assert.equal(remoteRef('job/90'), merged.sha);
  assert.deepEqual(git('--git-dir', github, 'log', '-1', '--format=%P', merged.sha!).split(' '), [passed, remoteRef('main')]);
  assert.deepEqual(git('--git-dir', github, 'show', `${merged.sha}:people/a.md`).split('\n').sort(), ['from main', 'from the branch', 'top']);
  assert.equal(git('--git-dir', github, 'log', '-1', '--format=%an', merged.sha!), 'Company agents');
  assert.deepEqual(await flow.mergeBase('job/90', merged.sha!, author), { sha: merged.sha }, 'has main already: nothing pushed');

  assert.deepEqual(await flow.mergeBase('job/91', conflicting, author), { conflicts: ['app.js'] });
  assert.equal(remoteRef('job/91'), conflicting);

  // the branch moved since the panel passed it: nothing merged or pushed
  const moved = await flow.mergeBase('job/90', passed, author);
  assert.equal(moved.moved, true);
  assert.match(moved.why!, /isn't at/);
  assert.equal(remoteRef('job/90'), merged.sha);
  await assert.rejects(() => flow.mergeBase('main', passed, author), /only pushes job\/<n>/);
});

test("a merge of main pushes nothing once the coordinator's wait is up: none when it's reached late, no try again past it", async t => {
  const passed = (await job.push(newJob(92, 'b.md', 'branch\n'), 'job/92')).sha;
  onMain('c.md', 'main\n');
  flow.fetchMirror();
  const { patient, dropping, stall, tried } = pushConnection(t, undefined, [10, 60_000]);

  dropping(0);
  assert.deepEqual(await patient.mergeBase('job/92', passed, author, Date.now() - 1), { why: 'its time was up before the worker reached it' });
  assert.equal(tried(), 0);

  dropping(2);
  const started = Date.now();
  const lost = await patient.mergeBase('job/92', passed, author, started + 5_000);
  assert.match(lost.why!, /didn't reach GitHub in 2 tries/);
  assert.ok(Date.now() - started < 5_000, 'no pause past the time left');
  assert.equal(tried(), 2);
  assert.equal(remoteRef('job/92'), passed);

  dropping(0);
  stall();
  const stalledAt = Date.now();
  const stalled = await patient.mergeBase('job/92', passed, author, stalledAt + 1_000);
  assert.match(stalled.why!, /didn't reach GitHub in 1 tries/);
  assert.ok(Date.now() - stalledAt < 5_000, 'a stalled try ends within the time left');
  assert.equal(remoteRef('job/92'), passed);

  dropping(1);
  const merged = await patient.mergeBase('job/92', passed, author, Date.now() + 5_000);
  assert.equal(remoteRef('job/92'), merged.sha);
});

test("an ask to merge main without a finite time budget is answered without a merge; a budget sets the pushes' end", async () => {
  const asked: number[] = [];
  const merge = async (by: number) => { asked.push(by); return { sha: 'a'.repeat(40) }; };
  for (const msLeft of [undefined, null, NaN, Infinity, '60000']) {
    assert.match((await answerMainMerge(1_000, msLeft, merge)).why!, /no time to merge in/, String(msLeft));
  }
  assert.deepEqual(asked, [], 'never merged');
  assert.deepEqual(await answerMainMerge(1_000, 60_000, merge), { sha: 'a'.repeat(40) });
  assert.deepEqual(asked, [1_000 + 60_000 - REPORT_MS]);
  // a merge that throws is answered with why, redacted
  assert.deepEqual(await answerMainMerge(1_000, 60_000, async () => { throw new Error(`no: ${TOKEN}`); }), { why: 'Error: no: [redacted]' });
});

function pushConnection(t: TestContext, onRetry?: () => void, pushPausesMs = [10, 20]) {
  // Stand-in for GitHub's connection. The first `drops` attempts fail, then receive-pack accepts the push.
  const tries = `${tmp}/receive-tries`, wrapper = `${tmp}/receive-pack`;
  writeFileSync(wrapper, `#!/bin/sh\necho x >> ${tries}\n[ -e ${tmp}/stall ] && exec sleep 30\n[ "$(wc -l < ${tries})" -gt "$(cat ${tmp}/drops)" ] && exec git-receive-pack "$@"\n`
    + `cat ${tmp}/says >&2\nexit 1\n`);
  chmodSync(wrapper, 0o755);
  const mgit = (...a: string[]) => git('--git-dir', `${work}/mirror.git`, ...a);
  const logged: string[] = [];
  const patient = gitFlow({ mirror: `${work}/mirror.git`, remote: github, base: 'main', clones, pushPausesMs,
    log: (...a) => { logged.push(a.join(' ')); onRetry?.(); } });
  const as = patient.forAgent({ uid: process.getuid!(), gid: process.getgid!(), env: agentEnv(process.env, { HOME: tmp }) });
  const dropping = (drops: number, says = 'error: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly\nsend-pack: unexpected disconnect') => {
    writeFileSync(`${tmp}/drops`, `${drops}\n`);
    writeFileSync(`${tmp}/says`, `${says}\nfatal: the remote end hung up unexpectedly\n`);
    rmSync(tries, { force: true });
    rmSync(`${tmp}/stall`, { force: true });
  };
  const stall = () => writeFileSync(`${tmp}/stall`, '');
  const tried = () => existsSync(tries) ? readFileSync(tries, 'utf8').split('\n').filter(Boolean).length : 0;
  mgit('config', 'remote.origin.receivepack', wrapper);
  t.after(() => mgit('config', '--unset', 'remote.origin.receivepack'));
  return { patient, as, dropping, stall, tried, logged, mgit };
}

function onMain(file: string, text: string) {
  const seed = `${tmp}/seed`;
  git('-C', seed, 'pull', '-q', 'origin', 'main');
  mkdirSync(`${seed}/${file}`.replace(/[^/]+$/, ''), { recursive: true });
  writeFileSync(`${seed}/${file}`, text);
  git('-C', seed, 'add', '-A'); git('-C', seed, 'commit', '-qm', `main: ${file}`); git('-C', seed, 'push', '-q', 'origin', 'HEAD:main');
}

test("a consolidator's touch-up goes on the branch as one commit of its edits to the files it may change, and nothing else", async () => {
  const dir = newJob(70, 'app/a.js', 'one\ntwo\n');
  writeFileSync(`${dir}/app/b.js`, 'b\n'); job.ag(dir, 'add', '-A'); job.ag(dir, 'commit', '-qm', 'b');
  const base = (await job.push(dir, 'job/70')).sha;
  const review = `${work}/jobs/r70`; mkdirSync(review); job.clone(review, 'job/70', { sha: base });
  const commit = { message: 'Quill: touch-ups from the review (job #1)', name: 'Quill (Company)', email: 'quill@t' };
  // its edits, plus what the run left behind: an edit it may not make, a new file, a staged change, a planted hook
  writeFileSync(`${review}/app/a.js`, 'one\n2\n');
  writeFileSync(`${review}/app/b.js`, 'not allowed\n');
  writeFileSync(`${review}/app/new.js`, 'new\n'); job.ag(review, 'add', 'app/new.js');
  writeFileSync(`${review}/.git/hooks/pre-commit`, `#!/bin/sh\ntouch ${markers}/touchup-pre-commit\n`); chmodSync(`${review}/.git/hooks/pre-commit`, 0o755);
  const touchup = await job.touchUp(review, 'job/70', base, ['app/a.js', 'app/gone.js'], commit);
  assert.deepEqual(touchup.files, ['app/a.js']);
  assert.equal(remoteRef('job/70'), touchup.sha);
  assert.equal(git('--git-dir', github, 'log', '-1', '--format=%P %an', touchup.sha), `${base} Quill (Company)`);
  assert.equal(git('--git-dir', github, 'show', `${touchup.sha}:app/b.js`), 'b');
  assert.ok(!ran().includes('touchup-pre-commit'), 'a hook in the review clone ran');
  // the branch moved on since: nothing is pushed
  const again = `${work}/jobs/r70b`; mkdirSync(again); job.clone(again, 'job/70', { sha: base });
  writeFileSync(`${again}/app/a.js`, 'one\nzwei\n');
  await assert.rejects(() => job.touchUp(again, 'job/70', base, ['app/a.js'], commit), /isn't at/);
  assert.equal(remoteRef('job/70'), touchup.sha);
});

test('a touch-up is refused when it edits none of its files, deletes one, is too big, or is for another branch', async () => {
  const lines = Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n');
  const dir = newJob(71, 'app/a.js', `${lines}\n`);
  const base = (await job.push(dir, 'job/71')).sha;
  const commit = { message: 'touch-ups', name: 'Quill', email: 'quill@t' };
  const review = (name: string) => { const d = `${work}/jobs/${name}`; mkdirSync(d); job.clone(d, 'job/71', { sha: base }); return d; };
  const none = review('r71a');
  writeFileSync(`${none}/app/other.js`, 'x\n');
  await assert.rejects(() => job.touchUp(none, 'job/71', base, ['app/a.js'], commit));
  const gone = review('r71b');
  rmSync(`${gone}/app/a.js`);
  await assert.rejects(() => job.touchUp(gone, 'job/71', base, ['app/a.js'], commit));
  const big = review('r71c');
  writeFileSync(`${big}/app/a.js`, `${lines.replaceAll('line', 'row')}\n`);
  await assert.rejects(() => job.touchUp(big, 'job/71', base, ['app/a.js'], commit));
  await assert.rejects(() => job.touchUp(review('r71d'), 'main', base, ['app/a.js'], commit), /only pushes job\/<n>/);
  assert.equal(remoteRef('job/71'), base);
});

test("H3: a touch-up of a branch whose own workflows would run on its push isn't pushed", async () => {
  const old = `${tmp}/old72`;   // a job branch from before the board limited its workflows, on GitHub already
  git('clone', '-q', github, old); git('-C', old, 'checkout', '-q', '-b', 'job/72');
  mkdirSync(`${old}/.github/workflows`, { recursive: true }); mkdirSync(`${old}/app`, { recursive: true });
  writeFileSync(`${old}/.github/workflows/ci.yml`, 'on: push\n'); writeFileSync(`${old}/app/a.js`, 'one\n');
  git('-C', old, 'add', '-A'); git('-C', old, 'commit', '-qm', 'legacy'); git('-C', old, 'push', '-q', 'origin', 'job/72');
  flow.fetchMirror();
  const base = remoteRef('job/72')!;
  const review = `${work}/jobs/r72`; mkdirSync(review); job.clone(review, 'job/72', { sha: base });
  writeFileSync(`${review}/app/a.js`, 'two\n');
  await assert.rejects(() => job.touchUp(review, 'job/72', base, ['app/a.js'], { message: 'touch-ups', name: 'Quill', email: 'quill@t' }), /ci\.yml/);
  assert.equal(remoteRef('job/72'), base);
});

test('the mirror refreshes in the background and takes what landed since', async () => {
  flow.fetchMirror();
  const mirrorMain = () => git('--git-dir', `${work}/mirror.git`, 'rev-parse', 'main');
  git('-C', `${tmp}/seed`, 'pull', '-q', 'origin', 'main');
  git('-C', `${tmp}/seed`, 'commit', '-q', '--allow-empty', '-m', 'landed later');
  git('-C', `${tmp}/seed`, 'push', '-q', 'origin', 'HEAD:main');
  assert.notEqual(mirrorMain(), remoteRef('main'));
  await flow.refreshMirror();
  assert.equal(mirrorMain(), remoteRef('main'));
});

test("the mirror's gc keeps what a clone reads after its branch is gone, until no clone made before then is left", async () => {
  const seed = `${tmp}/seed`, mirrorDir = `${work}/mirror.git`, mirrorGit = (...a: string[]) => git('--git-dir', mirrorDir, ...a);
  git('-C', seed, 'checkout', '-qb', 'job/60', 'main');
  writeFileSync(`${seed}/gone.md`, 'deleted upstream\n'); git('-C', seed, 'add', '-A'); git('-C', seed, 'commit', '-qm', 'gone');
  git('-C', seed, 'push', '-q', 'origin', 'job/60'); git('-C', seed, 'checkout', '-q', 'main');
  flow.fetchMirror();
  const sha = remoteRef('job/60')!, originalCloneDir = `${work}/jobs/60`;
  mkdirSync(originalCloneDir, { mode: 0o700 }); job.clone(originalCloneDir, 'job/60');
  git('-C', seed, 'push', '-q', 'origin', ':job/60');
  await flow.refreshMirror();
  assert.throws(() => mirrorGit('rev-parse', '--verify', 'refs/heads/job/60'));
  assert.ok(!job.ag(originalCloneDir, 'ls-remote', 'origin').includes('refs/kept/'));   // the kept tips are hidden from clones
  // gc as hard as it goes: a full repack at the next gc (two packs or more), every unreachable object pruned at once
  mirrorGit('config', 'gc.auto', '1'); mirrorGit('config', 'gc.autoPackLimit', '1'); mirrorGit('config', 'gc.pruneExpire', 'now');
  const gc = async (f: typeof flow) => {
    for (let i = 0; i < 2; i++) execFileSync('git', ['--git-dir', mirrorDir, 'pack-objects', '-q', `${mirrorDir}/objects/pack/pack`], { input: `${remoteRef('main')}\n` });
    await f.gcMirror();
    assert.equal(readdirSync(`${mirrorDir}/objects/pack`).filter(f => f.endsWith('.pack')).length, 1);   // it did run
  };
  try {
    await gc(flow);
    assert.equal(job.ag(originalCloneDir, 'show', 'origin/job/60:gone.md'), 'deleted upstream');
    assert.equal(job.ag(`${work}/jobs/r50`, 'show', 'HEAD:old.md'), 'reviewed');   // the force-pushed-away pinned review
    // A review made after the branch went is no reason to keep its tip, but its own pinned sha is kept for it
    let live: string[] = [];
    const later = gitFlow({ mirror: mirrorDir, remote: github, base: 'main', clones: () => live });
    const pinnedReviewDir = `${work}/jobs/61`; mkdirSync(pinnedReviewDir, { mode: 0o700 }); job.clone(pinnedReviewDir, 'job/60', { sha });
    live = [pinnedReviewDir];
    await gc(later);
    assert.equal(job.ag(pinnedReviewDir, 'show', 'HEAD:gone.md'), 'deleted upstream');
    live = [];
    await gc(later);
    assert.throws(() => mirrorGit('cat-file', '-e', sha));   // no clone left that could read it
    assert.equal(mirrorGit('for-each-ref', 'refs/kept/'), '');
  } finally { for (const k of ['gc.auto', 'gc.autoPackLimit', 'gc.pruneExpire']) mirrorGit('config', '--unset', k); }
});

test('a fetch keeps the branch tips before it can drop any, so a worker killed mid-fetch leaves them kept', async () => {
  const seed = `${tmp}/seed`, mirrorDir = `${work}/killed.git`, mirrorGit = (...a: string[]) => git('--git-dir', mirrorDir, ...a);
  const cloneDir = `${work}/jobs/62`, started = `${tmp}/fetch-started`, hungUploadPack = `${tmp}/hung-upload-pack`;
  const killedFlow = gitFlow({ mirror: mirrorDir, remote: github, base: 'main', clones: () => [cloneDir] });
  const killedJob = killedFlow.forAgent({ uid: process.getuid!(), gid: process.getgid!(), env: agentEnv(process.env, { HOME: tmp }) });
  killedFlow.ensureMirror();
  git('-C', seed, 'checkout', '-qb', 'job/62', 'main');
  writeFileSync(`${seed}/killed.md`, 'before the fast-forward\n'); git('-C', seed, 'add', '-A'); git('-C', seed, 'commit', '-qm', 'killed');
  git('-C', seed, 'push', '-q', 'origin', 'job/62');
  killedFlow.fetchMirror();
  writeFileSync(`${seed}/killed.md`, 'read after the kill\n'); git('-C', seed, 'commit', '-qam', 'fast-forward');
  git('-C', seed, 'push', '-q', 'origin', 'job/62'); git('-C', seed, 'checkout', '-q', 'main');
  const sha = remoteRef('job/62')!;
  killedFlow.fetchMirror();
  assert.equal(mirrorGit('for-each-ref', 'refs/kept/'), '');   // a fetch that drops no tip, and only fast-forwards one, keeps none
  mkdirSync(cloneDir, { mode: 0o700 }); killedJob.clone(cloneDir, 'job/62');
  git('-C', seed, 'push', '-q', 'origin', ':job/62');
  // The next fetch hangs on "GitHub", and the worker running it is killed
  writeFileSync(hungUploadPack, `#!/bin/sh\ntouch '${started}'\nexec sleep 60\n`, { mode: 0o755 });
  mirrorGit('config', 'remote.origin.uploadpack', hungUploadPack);
  const options = JSON.stringify({ mirror: mirrorDir, remote: github, base: 'main' });
  const worker = spawn(process.execPath, ['--input-type=module', '-e',
    `import { gitFlow } from ${JSON.stringify(new URL('./git.ts', import.meta.url).href)}; gitFlow({ ...${options}, clones: () => [] }).fetchMirror();`],
  { detached: true, stdio: 'ignore' });
  try {
    for (let i = 0; i < 200 && !existsSync(started); i++) await new Promise(ok => setTimeout(ok, 50));
    assert.ok(existsSync(started), 'the fetch never started');
    assert.ok(mirrorGit('for-each-ref', '--format=%(objectname)', 'refs/kept/').split('\n').includes(sha));   // kept while the fetch runs
    process.kill(-worker.pid!, 'SIGKILL');
    await once(worker, 'exit');
    mirrorGit('config', '--unset', 'remote.origin.uploadpack');
    // What --prune had done before the kill: the branch is gone from the mirror. Then the worker's restart, and its gc.
    mirrorGit('update-ref', '-d', 'refs/heads/job/62');
    killedFlow.ensureMirror();
    await killedFlow.gcMirror();
    mirrorGit('gc', '-q', '--prune=now');
    assert.equal(killedJob.ag(cloneDir, 'show', 'origin/job/62:killed.md'), 'read after the kill');
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) process.kill(-worker.pid!, 'SIGKILL');
    rmSync(cloneDir, { recursive: true, force: true }); rmSync(mirrorDir, { recursive: true, force: true });
  }
});

test("a job's lines: its commits and what it hasn't committed, new files whole, its own index untouched", async () => {
  flow.fetchMirror();
  const dir = newJob(140, 'a.md', 'one\ntwo\nthree\n');   // committed: 3 added
  writeFileSync(`${dir}/README.md`, 'hello\n');            // changed, not committed: 1 added, 1 removed
  writeFileSync(`${dir}/new.md`, 'x\ny\n');               // new, never added: 2 added
  mkdirSync(`${dir}/.hq`, { recursive: true }); writeFileSync(`${dir}/.hq/report.md`, 'not counted\n');
  writeFileSync(`${dir}/pic.bin`, Buffer.from([0, 1, 2, 0, 255]));   // binary: no lines
  // data and generated code: no lines either
  writeFileSync(`${dir}/trace.json`, '[1]\n'.repeat(500));
  writeFileSync(`${dir}/bundle.js`, 'x\n'.repeat(50));
  writeFileSync(`${dir}/.gitattributes`, 'bundle.js linguist-generated\n');
  const before = job.ag(dir, 'status', '--porcelain');
  assert.deepEqual(await branchLines({ uid: process.getuid!(), gid: process.getgid!(), env: agentEnv(process.env, { HOME: tmp }) }, dir, 'main'), { add: 6, del: 1 });
  assert.equal(job.ag(dir, 'status', '--porcelain'), before);
});

//
test("a job's lines while it merges main: main's own files aren't the job's", async () => {
  flow.fetchMirror();
  const dir = newJob(141, 'mine.md', 'one\ntwo\n'); // the job's own: 2 added
  const seed = `${tmp}/seed`;
  git('-C', seed, 'pull', '-q', 'origin', 'main');
  writeFileSync(`${seed}/qa.json`, `${'[1]\n'.repeat(5000)}`);
  git('-C', seed, 'add', '-A'); git('-C', seed, 'commit', '-qm', 'main: qa'); git('-C', seed, 'push', '-q', 'origin', 'HEAD:main');
  flow.fetchMirror(); job.ag(dir, 'fetch', '-q', 'origin');
  job.ag(dir, 'merge', '-q', '--no-commit', '--no-ff', 'origin/main');   // staged, not committed: MERGE_HEAD
  const me = { uid: process.getuid!(), gid: process.getgid!(), env: agentEnv(process.env, { HOME: tmp }) };
  assert.deepEqual(await branchLines(me, dir, 'main'), { add: 2, del: 0 });
  job.ag(dir, 'commit', '-qm', 'merge main');
  assert.deepEqual(await branchLines(me, dir, 'main'), { add: 2, del: 0 }, 'the same once committed');
});

test("a mirror fetch that can't reach GitHub is told apart from one GitHub refuses", () => {
  const lost = gitFlow({ mirror: `${work}/lost.git`, remote: 'http://127.0.0.1:9/github.git', base: 'main', clones });
  lost.ensureMirror();
  assert.throws(() => lost.fetchMirror(), (e: Error) => e instanceof FetchUnreachedError && /Failed to connect/.test(e.message));
  const refused = gitFlow({ mirror: `${work}/refused.git`, remote: `${tmp}/no-such.git`, base: 'main', clones });
  refused.ensureMirror();
  assert.throws(() => refused.fetchMirror(), (e: Error) => !(e instanceof FetchUnreachedError) && /no-such\.git/.test(e.message));
});
