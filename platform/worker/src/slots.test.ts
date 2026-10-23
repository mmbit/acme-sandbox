// node --test src/slots.test.ts   (the uid tests need root: run them in the worker container,
//   `docker compose exec worker node --test /work/code/current/src/slots.test.ts`; elsewhere they're skipped and say so)
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { CHAT_SLOT, KEEPER, SLOT_IDS, TEST_IDS, WORK_SLOTS, askHome, jobDirs, killAll, makeDir, own, rootDir, sweep } from './slots.ts';

const ROOT = process.getuid!() === 0;
const needsRoot = ROOT ? false : 'needs root to switch uids (run it in the worker container)';
const [A, B] = TEST_IDS;
const env = { PATH: process.env.PATH!, HOME: '/nonexistent' };
// A shell command as a slot's uid; throws if it fails.
const sh = (ids: typeof A, cmd: string, ...args: string[]) =>
  execFileSync('sh', ['-c', cmd, 'sh', ...args], { ...ids, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// The worker runs this file at every start, so it leaves nothing behind.
const made: string[] = [];
const scratch = (name: string) => { const d = mkdtempSync(`${tmpdir()}/${name}-`); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test('every slot has its own uid and gid, none of them the keeper, root or the test users, the intercom\'s last', () => {
  assert.deepEqual(WORK_SLOTS, ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8', 'slot9', 'slot10', 'slot11', 'slot12', 'slot13', 'slot14', 'slot15']);
  const uids = [...SLOT_IDS.values()].map(i => i.uid);
  assert.deepEqual(uids, [1501, 1502, 1503, 1504, 1505, 1506, 1507, 1508, 1509, 1510, 1511, 1512, 1513, 1514, 1515, 1516]);
  assert.deepEqual([...SLOT_IDS.values()].map(i => i.gid), uids);
  assert.deepEqual(SLOT_IDS.get(CHAT_SLOT), { uid: 1516, gid: 1516, name: 'slot16' });
  assert.ok(!uids.includes(KEEPER) && !uids.includes(0) && !TEST_IDS.some(t => uids.includes(t.uid)));
});

test('a job folder is made 0700 (its clone and its home)', () => {
  const work = scratch('slots');
  mkdirSync(`${work}/jobs`); mkdirSync(`${work}/homes`);
  const { dir, home, confirmationHome } = jobDirs(work, 7);
  assert.equal(confirmationHome, `${work}/asks/7`);
  assert.equal(dir, `${work}/jobs/7`); assert.equal(home, `${work}/homes/7`);
  for (const p of [dir, home]) { makeDir(p, {}); assert.equal(statSync(p).mode & 0o777, 0o700); }
});

test('a second slot can not write, read or list the first slot\'s .hq, nor read its HQ_TOKEN', { skip: needsRoot }, async () => {
  const work = scratch('slots'); chmodSync(work, 0o755);
  mkdirSync(`${work}/jobs`, { mode: 0o711 });
  const { dir } = jobDirs(work, 1), hq = `${dir}/.hq`;
  makeDir(dir, A);
  sh(A, 'mkdir -m 700 "$1" && echo \'{"decision":"changes"}\' > "$1/review.json"', hq);   // Quill's verdict, as slot A

  // Slot B, on its own job at the same time: every way at the verdict is refused.
  const forged = '{"decision":"merge"}';
  assert.throws(() => sh(B, 'echo "$2" > "$1/review.json"', hq, forged), /Permission denied/);
  assert.throws(() => sh(B, 'rm -rf "$1"', hq), /Permission denied/);
  assert.throws(() => sh(B, 'mv "$1" "$1.x"', hq), /Permission denied/);
  assert.throws(() => sh(B, 'cat "$1/review.json"', hq), /Permission denied/);
  assert.throws(() => sh(B, 'ls "$1"', dir), /Permission denied/);
  assert.throws(() => sh(B, 'git -C "$1" status', dir));
  assert.equal(sh(A, 'cat "$1/review.json"', hq).trim(), '{"decision":"changes"}');

  // A's agent process holds its HQ_TOKEN in its environment; B can't read it from /proc.
  const agent = spawn('sleep', ['60'], { ...A, env: { ...env, HQ_TOKEN: 'hq-token-of-job-1' }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 200));
  assert.match(sh(A, 'tr "\\0" "\\n" < /proc/$1/environ', String(agent.pid)), /HQ_TOKEN=hq-token-of-job-1/);   // control
  assert.throws(() => sh(B, 'cat /proc/$1/environ', String(agent.pid)), /Permission denied/);
  assert.throws(() => sh(B, 'kill -9 $1', String(agent.pid)));

  // The job ends: its processes go, and while it waits its folder is root's, so not even slot A's next job gets in.
  const gone = new Promise(r => agent.on('exit', r));
  killAll(A);
  await gone;
  own([dir], { uid: 0, gid: 0 });
  assert.throws(() => sh(A, 'echo "$2" > "$1/review.json"', hq, forged), /Permission denied/);
  // It resumes in slot B: now B's alone.
  own([dir], B);
  sh(B, 'echo x > "$1/note"', hq);
  assert.throws(() => sh(A, 'echo "$2" > "$1/review.json"', hq, forged), /Permission denied/);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('a second slot can not read the first slot\'s HQ_TOKEN off the command line of its hq calls', { skip: needsRoot }, async () => {
  const hq = [new URL('../bin/hq', import.meta.url).pathname, '/usr/local/bin/hq'].find(existsSync)!;
  const token = `hq-token-${randomBytes(8).toString('hex')}`;
  let reply = () => {};
  const server = createServer();
  const arrived = new Promise<void>(r => {
    server.on('request', (req, res) => { req.resume(); reply = () => res.end('{}'); r(); });   // held until B has looked
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = spawn('bash', [hq, 'status', 'working'], { ...A, env: { ...env, HQ_URL: url, HQ_TOKEN: token }, stdio: 'ignore' });
  const done = new Promise(r => call.on('exit', r));
  try {
    await arrived;   // A's hq is connected and waiting
    const seen = sh(B, 'for f in /proc/[0-9]*/cmdline; do tr "\\0" " " < "$f" 2>/dev/null; echo; done');
    assert.ok(seen.includes('main.ts status working'), 'control: B sees A\'s hq');
    assert.ok(!seen.includes(token));
  } finally { reply(); await done; server.close(); }
});

test('killing a slot\'s processes hands them none of the worker\'s tokens', { skip: needsRoot }, async () => {
  const d = scratch('slots-spy'); chmodSync(d, 0o755);
  makeDir(`${d}/a`, A);
  const hits = `${d}/a/hits`, mark = `leak-${process.pid}-${Date.now()}`;
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, WORKER_TOKEN: process.env.WORKER_TOKEN };
  Object.assign(process.env, { GITHUB_TOKEN: `${mark}-gh`, WORKER_TOKEN: `${mark}-worker` });
  try {
    // A job's leftover process watches every process of its uid for the tokens, as killAll runs.
    const spy = spawn('sh', ['-c', 'while :; do grep -la -- "$2" /proc/[0-9]*/environ >> "$1" 2>/dev/null; done', 'sh', hits, mark],
      { ...A, env, stdio: 'ignore' });
    const gone = new Promise(r => spy.on('exit', r));
    await new Promise(r => setTimeout(r, 200));
    // Control: a process started as the slot with the worker's own environment is seen.
    execFileSync('sleep', ['0.5'], { ...A });
    await new Promise(r => setTimeout(r, 200));   // let a grep that saw it finish writing
    assert.ok(sh(A, 'cat "$1"', hits).length > 0);
    sh(A, ': > "$1"', hits);
    killAll(A);
    await gone;
    assert.equal(sh(A, 'cat "$1"', hits), '');
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// A reviewer's home with config the reviewed code left in it, and a separate confirmation home (worker.ts).
function ranReview(name: string, ids: { uid?: number; gid?: number }) {
  const work = scratch(name); chmodSync(work, 0o755);
  const home = `${work}/home`;
  makeDir(home, ids);
  execFileSync('sh', ['-c', 'mkdir -p "$1/.claude/projects/p" "$1/.agents/skills/x" && echo turn1 > "$1/.claude/projects/p/s1.jsonl" '
    + '&& echo "{}" > "$1/.claude/settings.json" && echo planted > "$1/.agents/skills/x/SKILL.md"', 'sh', home], { ...ids, env });
  mkdirSync(`${work}/asks`, { mode: 0o711 });
  return { home, confirmationHome: `${work}/asks/1` };
}
const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 50)); return ok(); };

test('a home made to ask in holds nothing the run left, and the run\'s own session stays to resume in', () => {
  const { home, confirmationHome } = ranReview('slots-fresh', {});
  execFileSync('sh', ['-c', 'mkdir -p "$1/.claude" && echo "{}" > "$1/.claude/settings.json"', 'sh', confirmationHome], { env });
  assert.equal(askHome({}, confirmationHome), confirmationHome);
  assert.deepEqual(readdirSync(confirmationHome), []);
  assert.equal(statSync(confirmationHome).mode & 0o777, 0o700);
  assert.equal(readFileSync(`${home}/.claude/projects/p/s1.jsonl`, 'utf8'), 'turn1\n');
});

test('a process the run left behind can\'t plant config in the home made to ask in', { skip: needsRoot }, async () => {
  const { home, confirmationHome } = ranReview('slots-fresh-late', A);
  assert.throws(() => sh(A, 'mkdir "$1"', `${confirmationHome}-planted`), /Permission denied/);
  // the reviewed code's leftover, planting user settings in that home again and again
  const late = spawn('sh', ['-c', 'while :; do mkdir -p "$1/ask/.claude"; echo "{}" > "$1/ask/.claude/settings.json"; sleep 0.05; done', 'sh', home],
    { ...A, env, stdio: 'ignore' });
  assert.ok(await until(() => existsSync(`${home}/ask/.claude/settings.json`)));   // control: it runs
  askHome(A, confirmationHome);
  assert.ok(await until(() => late.signalCode !== null));   // ended by askHome, so nothing can plant anything after this
  assert.deepEqual(readdirSync(confirmationHome), []);
  assert.equal(statSync(confirmationHome).uid, A.uid);
});

test('a root folder an agent made first, with a symlink out inside, is moved aside and never used', { skip: needsRoot }, () => {
  const work = scratch('slots-rootdir'), victim = scratch('slots-victim');
  chmodSync(work, 0o777); chmodSync(victim, 0o777);
  sh(A, 'mkdir "$1/keep" && mkdir "$2/outer" && ln -s "$1" "$2/outer/inner"', victim, work);
  rootDir(`${work}/outer`, 0o750, KEEPER);
  rootDir(`${work}/outer/inner`, 0o750, KEEPER);
  for (const p of [`${work}/outer`, `${work}/outer/inner`]) {
    const st = lstatSync(p);
    assert.ok(st.isDirectory() && st.uid === 0 && st.gid === KEEPER && (st.mode & 0o777) === 0o750);
  }
  assert.deepEqual(readdirSync(`${work}/outer/inner`), []);
  assert.ok(readdirSync(work).some(n => n.startsWith('outer.untrusted-')));
  assert.ok(existsSync(`${victim}/keep`));
  // At the next start root's own folder is kept.
  rootDir(`${work}/outer/inner`, 0o750, KEEPER);
  assert.deepEqual(readdirSync(`${work}/outer`), ['inner']);
});

test('what a slot leaves in shared temp folders (a setuid shell, say) goes when its job ends; others\' stays', { skip: needsRoot }, () => {
  const t = scratch('slots-tmp'); chmodSync(t, 0o1777);
  sh(A, 'cp /bin/sh "$1/sh" && chmod 4755 "$1/sh" && mkdir "$1/d" && touch "$1/d/f"', t);
  sh(B, 'touch "$1/b"', t);
  sweep(A, [t]);
  assert.ok(!existsSync(`${t}/sh`) && !existsSync(`${t}/d`));
  assert.ok(existsSync(`${t}/b`));
});
