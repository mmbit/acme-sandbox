// node --test src/runs.test.ts   (uses a throwaway DATA_DIR; starts the real helper, as its setup command does, and as
// this server's compose.yaml does. Its last two tests run as root only, the runs as another user; elsewhere they're
// skipped and say so. The DATA_DIR starts with a key saved on a card, as a single lent machine's was.)
import { harness, until } from './harness.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';

const RUNS_TOKEN = 'runs-secret';
const CARD_KEY = `helper_${'c'.repeat(43)}`;
const h = await harness('runs', {
  env: { RUNS_TOKEN },
  before: () => {
    mkdirSync(process.env.SECRETS_DIR!, { recursive: true });
    writeFileSync(`${process.env.SECRETS_DIR}/RUN_HELPER_KEY`, `${CARD_KEY}\n`);
  },
});
const secrets = await import('./secrets.ts');
const runs = await import('./runs.ts');
const events = await import('./events.ts');
const HQ = new URL('../../worker/bin/hq', import.meta.url).pathname;
const HELPER = new URL('../../helper/helper.mjs', import.meta.url).pathname;
const ROOT = process.getuid!() === 0;
const OTHER_UID = ROOT ? unusedId() : 0;

// A uid and gid no account, group or process has: outside a container the helper's kill(-1) and IPC clearing as that
// user reach nothing but the test's runs
function unusedId() {
  const id = 1_500_000_000 + Math.floor(Math.random() * 100_000_000);
  const named = ['passwd', 'group'].some(table => spawnSync('getent', [table, String(id)]).status === 0);
  const running = readdirSync('/proc')
    .filter(entry => /^\d+$/.test(entry))
    .some(pid => idsOf(pid).includes(id));
  if (named || running) throw new Error(`uid ${id} is in use here: run the tests again`);
  return id;
}

// A process's uids and gids: real, effective, saved and file system's (none once it ended)
function idsOf(pid: string) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    return [...status.matchAll(/^[UG]id:\s+(.*)$/gm)].flatMap(line => line[1].split(/\s+/).map(Number));
  } catch {
    return []; /* ended */
  }
}

// A job's tree: a git repo with sim/ committed, and a file in it that isn't committed yet
function jobTree() {
  const tree = mkdtempSync(`${tmpdir()}/runs-tree-`);
  mkdirSync(`${tree}/sim`);
  mkdirSync(`${tree}/other`);
  writeFileSync(`${tree}/sim/seed.txt`, '42\n');
  writeFileSync(`${tree}/other/big.txt`, 'not needed\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', tree, ...args]);
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'tree');
  writeFileSync(`${tree}/sim/extra.txt`, 'not committed yet\n');
  return tree;
}

// The real hq, as the job's agent runs it from a folder of its tree, with the job's own temp folder (a lent machine's
// test run may write nowhere else)
const hqIn = (cwd: string, job: { token: string; agent: string }, ...args: string[]) =>
  new Promise<{ code: number; out: string }>(done =>
    execFile(
      'bash',
      [HQ, ...args],
      {
        cwd,
        env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HQ_URL: h.base, HQ_TOKEN: job.token, HQ_AGENT: job.agent },
      },
      (error, out, err) => done({ code: error ? Number(error.code) : 0, out: out + err }),
    ),
  );

const stateOf = (id: number) =>
  (h.db.prepare('select state from helper_runs where id = ?').get(id) as { state: string }).state;
const helperOf = (id: number) =>
  (h.db.prepare('select helper from helper_runs where id = ?').get(id) as { helper: string }).helper;
// The id a take answers with, which its helper's calls name: the run's id and the take's number
const takeOf = (id: number, take = 1) => `${id}-${take}`;
const lastRun = () => (h.db.prepare('select max(id) as id from helper_runs').get() as { id: number }).id;

// What the run does: reads its folders' files (one not committed), tries the network (HQ itself) and the job's own
// token, and leaves a file
const command = [
  'node',
  '-e',
  "const fs = require('fs'); const ended = word => { console.log('network', word); fs.mkdirSync('out'); " +
    "fs.writeFileSync('out/copy.txt', fs.readFileSync('extra.txt', 'utf8') + fs.readFileSync('seed.txt', 'utf8')); " +
    "console.log('other there:', fs.existsSync('../other'), 'token there:', 'HQ_TOKEN' in process.env); " +
    'process.exit(3) }; ' +
    `require('net').connect(${new URL(h.base).port}, '127.0.0.1')` +
    ".on('connect', () => ended('open')).on('error', e => ended(e.code))",
];

// A helper on a machine of its own: this server's, started as run_helpers.py starts it (its key given), or a lent
// machine's, by the bootstrap its setup command pastes, its key saved by the key command the board was shown. The runs
// go as the test's own user, or as another when the test is root (a helper never runs them as root). It reaches HQ at
// hqUrl. Each takes runs of its kind (the only one declared unless named), and a lent one keeps its key in state (its
// own folder unless named). Tools stands for what the kind's image has besides the helper's needs.
async function startHelper(
  t: TestContext,
  how: ({ server: true } | { bootstrap: string; keyCommand?: string; state?: string }) & {
    kind?: string;
    tools?: string;
  },
  hqUrl = h.base,
) {
  const uid = ROOT ? OTHER_UID : process.getuid!();
  const machine = mkdtempSync(`${tmpdir()}/runs-helper-`);
  chmodSync(machine, 0o755);
  mkdirSync(`${machine}/work`, { mode: 0o1777 });
  chmodSync(`${machine}/work`, 0o1777);
  const keyFile = `${'state' in how && how.state ? how.state : machine}/key`;
  if ('server' in how) writeFileSync(keyFile, `${RUNS_TOKEN}\n`, { mode: 0o600 });
  else if (how.keyCommand) saveKey(how.keyCommand, keyFile);
  const helper = spawn('node', 'server' in how ? [HELPER] : ['-e', how.bootstrap], {
    env: {
      PATH: how.tools ? `${how.tools}:${process.env.PATH}` : process.env.PATH,
      HQ_URL: hqUrl,
      ...(how.kind ? { RUN_KIND: how.kind } : {}),
      TMPDIR: machine,
      KEY_FILE: keyFile,
      WORK_DIR: `${machine}/work`,
      NONET_FILE: `${machine}/nonet.pl`,
      TASK_UID: String(uid),
      TASK_GID: String(uid === process.getuid!() ? process.getgid!() : uid),
      POLL_MS: '200',
      BEAT_MS: '500',
    },
    stdio: 'ignore',
  });
  t.after(() => helper.kill());
  return machine;
}

// A machine's key command as it's pasted there (outside a container: the key file named)
const saveKey = (keyCommand: string, keyFile: string) =>
  execFileSync('node', ['-e', / -e "(.*)"$/.exec(keyCommand)![1]], { env: { ...process.env, KEY_FILE: keyFile } });

// A lent machine as the board adds it in Settings › Machines: its id, key command and setup, and its key as the key
// command has it
async function lend(name: string) {
  const added = await h.board('/api/machines/add', { name });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  return { ...added.body, key: /'(helper_[\w-]{43})\\n'/.exec(added.body.keyCommand)![1] as string };
}

// No lent machine: each the board lent before is removed, as the board removes one
async function lendNone() {
  for (const { id } of (await h.board('/api/machines')).body.filter((one: { id: unknown }) => one.id !== 'server'))
    assert.equal((await h.board('/api/machines/remove', { machine: id })).status, 200);
}

// One lent machine, the one asHelper calls as
let lentKey = '';
async function lendOne() {
  await lendNone();
  lentKey = (await lend('the lent machine')).key;
}

// Nothing of a run left on its helper's machine
async function leftNothing(machine: string) {
  for (let tries = 0; tries < 50 && readdirSync(`${machine}/work`).length; tries++)
    await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(readdirSync(`${machine}/work`), [], 'nothing of the run is left on the helper');
}

test("a key saved on a card for the lent machine is the first machine's: its helpers are still let in, and no card asks for that key again", async () => {
  const [first, ...others] = (await h.board('/api/machines')).body;
  assert.equal(first.name, 'The first machine');
  assert.deepEqual(
    others.map((other: { id: unknown }) => other.id),
    ['server'],
  );
  assert.equal(existsSync(`${process.env.SECRETS_DIR}/RUN_HELPER_KEY`), false, 'kept by its hash alone');
  assert.equal(secrets.validNames('RUN_HELPER_KEY'), false);
  assert.equal((await h.send('/api/helper/take', { authorization: `Bearer ${CARD_KEY}` }, {})).status, 204);
  assert.equal((await h.board('/api/machines')).body[0].state, 'taking');
});

test("with no lent helper, this server's takes the run at once, shut in from the network and the job's token, on a copy of its folders as the tree has them; its files come back once every process it started ended, and never from behind a link", async t => {
  await lendNone();
  const job = await h.start({ agent: 'bolt' });
  const machine = await startHelper(t, { server: true });
  const outside = mkdtempSync(`${tmpdir()}/runs-outside-`);
  writeFileSync(`${outside}/x`, 'outside fixture\n');
  const tree = jobTree();
  const ran = await hqIn(
    `${tree}/sim`,
    job,
    'run',
    '--bring',
    'out,linked/x',
    '--',
    'sh',
    '-c',
    `ln -s ${outside} linked && (sleep 1; echo late > out/late.txt) & exec "$@"`,
    'sh',
    ...command,
  );
  assert.equal(ran.code, 3, ran.out);
  assert.match(ran.out, /network EACCES/);
  assert.match(ran.out, /other there: false token there: false/);
  assert.match(ran.out, /sim\/linked\/x: behind a link/);
  assert.match(ran.out, /done on this server's helper/);
  assert.equal(readFileSync(`${tree}/sim/out/copy.txt`, 'utf8'), 'not committed yet\n42\n');
  assert.equal(
    existsSync(`${tree}/sim/out/late.txt`),
    false,
    'the process the run left ended before its files were read',
  );
  assert.equal(existsSync(`${tree}/sim/linked`), false);
  assert.equal(stateOf(lastRun()), 'done');
  assert.equal(helperOf(lastRun()), 'server');
  await leftNothing(machine);
  await h.finish(job);
});

test("the helper its setup command starts, on the key its key command saved, takes the run with no network, its output, files and code come back, and the board sees its machine live: its speed, load, run and the run's output as it comes", async t => {
  await lendNone();
  const job = await h.start({ agent: 'bolt', title: 'Seeds' });
  const lent = await lend("the board's desktop");
  assert.deepEqual(
    lent.kinds.map((kind: { name: string }) => kind.name),
    ['default'],
  );
  const { start } = lent.kinds[0].commands;
  const machine = await startHelper(t, { bootstrap: / -e "(.*)"$/.exec(start)![1], keyCommand: lent.keyCommand });

  const tree = jobTree();
  const running = hqIn(
    `${tree}/sim`,
    job,
    'run',
    '--bring',
    'out',
    '--',
    'sh',
    '-c',
    'echo \'<b>first</b> line\'; sleep 2; mkdir ../../../left && touch ../../../left/file && chmod 000 ../../../left && exec "$@"',
    'sh',
    ...command,
  );
  const shown = async () => (await h.board('/api/machines')).body.find((one: { id: number }) => one.id === lent.id);
  let live = await shown();
  for (let tries = 0; tries < 100 && !live.live?.lines.length; tries++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    live = await shown();
  }
  assert.equal(live.state, 'running');
  const { since, cores, ...run } = live.run;
  assert.deepEqual(run, { kind: 'default', job: job.id, job_code: h.job(job.id).code, agent: 'bolt', title: 'Seeds' });
  assert.ok(Date.parse(since) > 0 && cores === live.cpus, 'since it was taken, on the cores its helper has');
  assert.deepEqual(live.live.lines, ['<b>first</b> line'], 'as text');
  assert.ok(live.speed > 0 && live.cpus > 0, JSON.stringify(live));
  assert.ok(live.live.cpu >= 0 && live.live.mem > 0 && live.live.history.length > 0, JSON.stringify(live.live));
  const ran = await running;
  assert.equal(ran.code, 3, ran.out);
  assert.match(ran.out, /done on the board's desktop/);
  assert.equal((await shown()).run, undefined);
  assert.match(ran.out, /network EACCES/);
  assert.match(ran.out, /other there: false token there: false/);
  assert.equal(readFileSync(`${tree}/sim/out/copy.txt`, 'utf8'), 'not committed yet\n42\n');
  assert.equal(stateOf(lastRun()), 'done');
  assert.equal(helperOf(lastRun()), 'lent');
  await leftNothing(machine);
  await h.finish(job);
});

// A run as hq sends it: the spec in a header, a bundle as the body
const sendRun = (token: string, spec: Record<string, unknown>) => {
  const bundle = execFileSync('tar', ['-czf', '-', '-C', jobTree(), 'sim']);
  const header = Buffer.from(JSON.stringify({ cwd: 'sim', bring: [], minutes: 5, ...spec })).toString('base64url');
  return h.send('/api/agent/runs', { authorization: `Bearer ${token}`, 'x-run': header }, bundle);
};
// A helper's call on a key: a lent machine's (the one lendOne lent, unless named) or this server's
const asKey = (key: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  h.send(path, { authorization: `Bearer ${key}`, ...headers }, body);
const asHelper = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  asKey(lentKey, path, body, headers);
const asServer = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  h.send(path, { authorization: `Bearer ${RUNS_TOKEN}`, ...headers }, body);

test("a lent helper that goes quiet hands its run to this server's, which alone takes it then; what the lent one sends late is refused, and a quiet server's helper loses it", async t => {
  await lendOne();
  const job = await h.start({ agent: 'bolt' });
  const sent = await sendRun(job.token, { command: 'sleep 1' });
  assert.equal(sent.status, 200, sent.text);
  const lentTake = (await asHelper('/api/helper/take', {})).json.id;
  assert.equal(lentTake, takeOf(sent.json.id));
  assert.notEqual(lentTake, sent.json.id);
  assert.equal((await asServer('/api/helper/take', {})).status, 204, 'the lent helper has it');
  assert.equal((await h.agent(`runs/${sent.json.id}`, job.token)).body.state, 'running');

  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 4 * 60_000 });
  const passed = await h.agent(`runs/${sent.json.id}`, job.token);
  assert.equal(passed.body.state, 'waiting');
  assert.equal(passed.body.passed, true);
  assert.match(passed.body.why, /went quiet: this server's helper takes it/);
  assert.equal((await asHelper('/api/helper/take', {})).status, 204, 'the lent helper never takes it again');
  const serverTake = (await asServer('/api/helper/take', {})).json.id;
  assert.equal(serverTake, takeOf(sent.json.id, 2));
  const late = await asHelper(`/api/helper/runs/${lentTake}/finish`, Buffer.alloc(0), { 'x-run-exit': '0' });
  assert.equal(late.status, 409);
  assert.equal((await asHelper(`/api/helper/runs/${lentTake}/beat`, {})).json.go, false);
  assert.equal((await asServer(`/api/helper/runs/${serverTake}/beat`, {})).json.go, true);

  t.mock.timers.tick(4 * 60_000);
  assert.equal((await h.agent(`runs/${sent.json.id}`, job.token)).body.state, 'lost');
  t.mock.timers.reset();
  await h.finish(job);
});

test("this server's helper leaves a run to the lent one while that asks for work, and takes it after takeMinutes", async t => {
  await lendOne();
  const job = await h.start({ agent: 'bolt' });
  const first = await sendRun(job.token, { command: 'true' });
  const firstTake = (await asHelper('/api/helper/take', {})).json.id;
  assert.equal(firstTake, takeOf(first.json.id));
  const second = await sendRun(job.token, { command: 'true' });
  assert.equal((await asServer('/api/helper/take', {})).status, 204, 'the lent helper is there, busy with the first');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 4 * 60_000 });
  assert.equal((await asHelper(`/api/helper/runs/${firstTake}/beat`, {})).json.go, true);
  assert.equal((await asServer('/api/helper/take', {})).json.id, takeOf(second.json.id), 'past takeMinutes');
  t.mock.timers.reset();
  await h.finish(job);
});

// A board's machine as GET /api/machines shows it
const shownMachine = async (id: number) =>
  (await h.board('/api/machines')).body.find((one: { id: number }) => one.id === id);
const finishAs = (key: string, take: string) =>
  asKey(key, `/api/helper/runs/${take}/finish`, Buffer.alloc(0), { 'x-run-exit': '0' });

test('a waiting run goes to the fastest free machine: a slower one leaves it while a faster one is free, takes it after takeMinutes while that one is busy and at once once it stopped asking, and a paused one takes none', async t => {
  await lendNone();
  const fast = await lend('the rig');
  const slow = await lend('an old laptop');
  const job = await h.start({ agent: 'bolt' });
  const asFast = () => asKey(fast.key, '/api/helper/take', { cpus: 16, memoryGb: 64, bench: 120 });
  const asSlow = () => asKey(slow.key, '/api/helper/take', { cpus: 4, memoryGb: 8, bench: 60 });
  assert.equal((await asFast()).status, 204);
  assert.equal((await asSlow()).status, 204);
  assert.deepEqual([(await shownMachine(fast.id)).speed, (await shownMachine(slow.id)).speed], [1920, 240]);

  const first = await sendRun(job.token, { command: 'true' });
  assert.equal((await asSlow()).status, 204, 'the rig asked for work just now and has no run');
  const fastTake = (await asFast()).json.id;
  assert.equal(fastTake, takeOf(first.json.id));

  const second = await sendRun(job.token, { command: 'true' });
  assert.equal((await asSlow()).status, 204, 'the rig is busy: the run waits takeMinutes for it');
  assert.equal((await asServer('/api/helper/take', {})).status, 204, 'and this server leaves it to the machines');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 4 * 60_000 });
  assert.equal((await asKey(fast.key, `/api/helper/runs/${fastTake}/beat`, {})).json.go, true);
  const slowTake = (await asSlow()).json.id;
  assert.equal(slowTake, takeOf(second.json.id), 'past takeMinutes, the laptop takes it');
  assert.equal((await finishAs(fast.key, fastTake)).status, 200);
  assert.equal((await finishAs(slow.key, slowTake)).status, 200);

  t.mock.timers.tick(30_000);
  const third = await sendRun(job.token, { command: 'true' });
  const thirdTake = (await asSlow()).json.id;
  assert.equal(thirdTake, takeOf(third.json.id), "the rig hasn't asked for work in 30 s");
  assert.equal((await finishAs(slow.key, thirdTake)).status, 200);

  assert.equal((await h.board('/api/machines/pause', { machine: slow.id, paused: true })).status, 200);
  t.mock.timers.tick(2 * 60_000);
  const fourth = await sendRun(job.token, { command: 'true' });
  assert.equal((await asSlow()).status, 204, 'paused');
  assert.equal((await asServer('/api/helper/take', {})).json.id, takeOf(fourth.json.id), 'no machine is there');
  assert.deepEqual([(await shownMachine(fast.id)).state, (await shownMachine(slow.id)).state], ['away', 'paused']);
  t.mock.timers.reset();
  await h.finish(job);
});

test("a machine's readings and its run's new output reach the board's HQ live: its load and a few minutes of it, the run's last lines as text with keys redacted, and an event as they change; agents see none of it", async t => {
  await lendNone();
  const lent = await lend('the rig');
  const job = await h.start({ agent: 'bolt', title: 'Sweep' });
  const said: { name: string; live?: { lines: string[] } }[][] = [];
  const off = events.onPublish(event => {
    if (event.type === 'machines') said.push(event.machines as (typeof said)[number]);
  });
  t.after(() => off());
  const report = { cpus: 8, memoryGb: 16, bench: 100, gpu: 'RTX 4090', live: { cpu: 12, mem: 40, gpu: 5 } };
  assert.equal((await asKey(lent.key, '/api/helper/take', report)).status, 204);
  const sent = await sendRun(job.token, { command: 'true' });
  const take = (await asKey(lent.key, '/api/helper/take', { live: { cpu: 30, mem: 41 } })).json.id;
  assert.equal(take, takeOf(sent.json.id));
  const lines = `step 1\nstep 2 ${'x'.repeat(400)}\r\nkey sk-ant-api03-${'k'.repeat(30)}\n<img src=x onerror=alert(1)>\n`;
  const beat = await asKey(lent.key, `/api/helper/runs/${take}/beat`, {
    live: { cpu: 95, mem: 42, freeMb: 9300, cores: 16, gpu: 80 },
    lines,
  });
  assert.equal(beat.json.go, true);

  const shown = await shownMachine(lent.id);
  assert.equal(shown.state, 'running');
  assert.deepEqual(shown.run, {
    kind: 'default',
    job: job.id,
    job_code: h.job(job.id).code,
    agent: 'bolt',
    title: 'Sweep',
    since: shown.run.since,
    cores: 8,
  });
  assert.deepEqual([shown.gpu, shown.gpuCount, shown.cpus, shown.memoryGb, shown.speed], ['RTX 4090', 1, 8, 16, 800]);
  assert.deepEqual([shown.live.cpu, shown.live.mem, shown.live.gpu], [95, 42, 80]);
  assert.deepEqual(
    [shown.live.freeMb, shown.live.cores],
    [9300, 16],
    "what's free of the machine, as its helper read it",
  );
  assert.deepEqual(
    shown.live.history.map(({ cpu, mem }: { cpu: number; mem: number }) => [cpu, mem]),
    [[95, 42]],
    'readings seconds apart are one point',
  );
  assert.deepEqual(
    shown.live.history.map(({ gpu }: { gpu: number }) => gpu),
    [80],
    "with the GPU's",
  );
  assert.deepEqual(shown.live.lines.length, 4);
  assert.equal(shown.live.lines[0], 'step 1');
  assert.equal(shown.live.lines[1].length, 300, 'a long line cut short');
  assert.match(shown.live.lines[2], /^key .*\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(shown), /kkkkkkkk/);
  assert.equal(shown.live.lines[3], '<img src=x onerror=alert(1)>', 'text, to show as text');

  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 10_000 });
  const many = Array.from({ length: 120 }, (_, n) => `line ${n + 1}`).join('\n');
  await asKey(lent.key, `/api/helper/runs/${take}/beat`, {
    live: { cpu: 50, mem: 43 },
    gpu: '2× RTX 4090',
    lines: `${many}\n`,
  });
  const later = await shownMachine(lent.id);
  assert.deepEqual(
    later.live.history.map(({ cpu }: { cpu: number }) => cpu),
    [95, 50],
  );
  assert.equal(later.live.lines.length, 100);
  assert.equal(later.live.lines.at(-1), 'line 120');
  assert.equal(later.live.gpu, 80, 'the GPU reading of 10 s before');
  assert.deepEqual([later.gpu, later.gpuCount], ['2× RTX 4090', 2], 'its helper names two of them');
  t.mock.timers.reset();
  for (let tries = 0; tries < 50 && !said.some(list => list.some(one => one.live?.lines.length === 100)); tries++)
    await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(
    said.some(list => list.some(one => one.name === 'the rig' && one.live?.lines.length === 100)),
    'an event with the change',
  );
  assert.doesNotMatch(JSON.stringify((await h.agent('runs/helper', job.token)).body), /step 1|line 120/);

  assert.equal((await finishAs(lent.key, take)).status, 200);
  const done = await shownMachine(lent.id);
  assert.deepEqual([done.state, done.run, done.live.lines], ['taking', undefined, []]);
  await h.finish(job);
});

test("the board's Machines: a machine added with its key command, renamed, paused and coloured, a taken or empty name refused, and one removed loses its key and hands its run to this server; none of it is anyone's but the board's", async () => {
  await lendNone();
  const lent = await lend('the rig');
  assert.match(
    lent.keyCommand,
    /^docker run --rm --network none --user 0:0 --entrypoint node -v run-helper:\/state node:24.22.1-slim -e "[^"$`]*"$/,
  );
  assert.equal(lent.removeKey, 'docker volume rm run-helper');
  for (const name of ['', 'The Rig', 'x'.repeat(41)])
    assert.equal((await h.board('/api/machines/add', { name })).status, 400, name);
  assert.equal((await h.board('/api/machines/rename', { machine: lent.id, name: 'the big rig' })).status, 200);
  assert.equal((await h.board('/api/machines/pause', { machine: lent.id, paused: true })).status, 200);
  assert.deepEqual(
    [(await shownMachine(lent.id)).name, (await shownMachine(lent.id)).state, (await shownMachine(lent.id)).paused],
    ['the big rig', 'paused', true],
  );
  assert.equal((await h.board('/api/machines/pause', { machine: lent.id, paused: false })).status, 200);
  assert.equal((await h.board('/api/machines/pause', { machine: 999, paused: false })).status, 400);
  assert.equal((await h.send('/api/machines')).status, 401, 'not without the board');
  const colours = { machine: lent.id, body: '#111114', glow: '#E5243B' };
  assert.equal((await h.board('/api/machines/colour', colours)).status, 200);
  for (const refused of [{ body: '#111114' }, { body: 'black', glow: 'red' }, { body: '#111', glow: '#e5243b' }])
    assert.equal((await h.board('/api/machines/colour', { machine: lent.id, ...refused })).status, 400, refused.body);
  const coloured = await shownMachine(lent.id);
  assert.deepEqual([coloured.body, coloured.glow], ['#111114', '#e5243b'], 'as given, the refusals changed nothing');
  assert.equal((await h.board('/api/machines/colour', { machine: lent.id })).status, 200, "none: the look's own");
  const plain = await shownMachine(lent.id);
  assert.deepEqual([plain.body, plain.glow], [null, null]);

  const job = await h.start({ agent: 'bolt' });
  const sent = await sendRun(job.token, { command: 'true' });
  assert.equal((await asKey(lent.key, '/api/helper/take', {})).json.id, takeOf(sent.json.id));
  assert.equal((await h.board('/api/machines/remove', { machine: lent.id })).status, 200);
  assert.equal((await asKey(lent.key, '/api/helper/take', {})).status, 401, 'its key no longer works');
  const passed = (await h.agent(`runs/${sent.json.id}`, job.token)).body;
  assert.deepEqual([passed.state, passed.passed], ['waiting', true]);
  assert.match(passed.why, /its machine was removed: this server's helper takes it/);
  assert.equal(await shownMachine(lent.id), undefined);
  await h.finish(job);
});

test('files a helper sends back come into the tree only inside the paths named, never as links or through one', async () => {
  await lendOne();
  const job = await h.start({ agent: 'bolt' });
  const sent = await sendRun(job.token, { command: 'true', bring: ['sim/out'] });
  const taken = (await asHelper('/api/helper/take', {})).json.id;
  assert.equal(taken, takeOf(sent.json.id));
  const outside = mkdtempSync(`${tmpdir()}/runs-outside-`);
  const made = mkdtempSync(`${tmpdir()}/runs-made-`);
  mkdirSync(`${made}/sim/out/through`, { recursive: true });
  mkdirSync(`${made}/other`);
  writeFileSync(`${made}/sim/out/result.txt`, 'kept\n');
  writeFileSync(`${made}/sim/out/through/planted.txt`, 'planted\n');
  writeFileSync(`${made}/other/big.txt`, 'overwritten\n');
  symlinkSync(outside, `${made}/sim/out/link`);
  writeFileSync(`${made}/sim/out/original.txt`, 'named by a global header\n');
  // (then a pax global header naming the member after it, which GNU tar lists as sim/out/renamed.txt: one archive, the
  // first without its two closing blocks)
  const files = execFileSync('sh', [
    '-c',
    '{ tar -cf - -b1 -C "$1" --exclude=original.txt sim other | head -c -1024; ' +
      'tar -cf - -b1 --format=pax --pax-option=path=sim/out/renamed.txt -C "$1" sim/out/original.txt; } | gzip',
    'sh',
    made,
  ]);
  assert.equal((await asHelper(`/api/helper/runs/${taken}/output`, Buffer.from('ran\n'))).status, 200);
  const finished = await asHelper(`/api/helper/runs/${taken}/finish`, files, { 'x-run-exit': '0' });
  assert.equal(finished.status, 200, finished.text);

  const tree = jobTree();
  mkdirSync(`${tree}/sim/out`);
  writeFileSync(`${outside}/original.txt`, 'original fixture\n');
  linkSync(`${outside}/original.txt`, `${tree}/sim/out/result.txt`);
  symlinkSync(outside, `${tree}/sim/out/through`);
  const collected = await hqIn(`${tree}/sim`, job, 'run', String(sent.json.id));
  assert.equal(collected.code, 0, collected.out);
  assert.equal(readFileSync(`${tree}/sim/out/result.txt`, 'utf8'), 'kept\n');
  assert.equal(readFileSync(`${tree}/sim/out/renamed.txt`, 'utf8'), 'named by a global header\n');
  assert.equal(readFileSync(`${tree}/other/big.txt`, 'utf8'), 'not needed\n');
  assert.equal(existsSync(`${tree}/sim/out/link`), false);
  assert.equal(readFileSync(`${outside}/original.txt`, 'utf8'), 'original fixture\n');
  assert.deepEqual(readdirSync(outside), ['original.txt']);
  assert.match(collected.out, /left out other\/big\.txt/);
  await h.finish(job);
});

test("a run is its job's alone, a waiting one goes when its job ends, and a wrong key is turned away", async () => {
  await lendOne();
  const job = await h.start({ agent: 'bolt' });
  const other = await h.start({ agent: 'chime' });
  assert.equal((await sendRun(job.token, { command: 'true', bring: ['../etc'] })).status, 400);
  const sent = await sendRun(job.token, { command: 'true' });
  assert.equal((await h.agent(`runs/${sent.json.id}`, other.token)).status, 404);
  assert.equal((await h.send('/api/helper/take', { authorization: 'Bearer helper_wrong' }, {})).status, 401);

  await h.finish(job);
  assert.equal((await asHelper('/api/helper/take', {})).status, 204);
  assert.equal(stateOf(sent.json.id), 'withdrawn');
  await h.finish(other);
});

test("a job's runs waiting for a helper are four at most: each holds its bundle on HQ's volume", async () => {
  await lendOne();
  const job = await h.start({ agent: 'bolt' });
  // five sent at once: the ones still coming in count, so they can't all pass before any is there
  const sent = await Promise.all([...Array(5)].map(() => sendRun(job.token, { command: 'true' })));
  assert.deepEqual(sent.map(r => r.status).sort(), [200, 200, 200, 200, 429]);
  assert.equal((await sendRun(job.token, { command: 'true' })).status, 429);
  const other = await h.start({ agent: 'chime' });
  assert.equal((await sendRun(other.token, { command: 'true' })).status, 200, "another job's aren't counted");
  await h.finish(job);
  await h.finish(other);
});

// Kinds of run as a company declares them in org.yaml, for one test
function declareKinds(t: TestContext, kinds: string, settings = '  helper: the lent machine\n') {
  const file = `${h.repo}/company/org.yaml`;
  const before = readFileSync(file, 'utf8');
  writeFileSync(file, `${before}\nruns:\n${settings}  kinds:\n${kinds}`);
  t.after(() => writeFileSync(file, before));
}

const TWO_KINDS = `
    simulation:
      about: long simulation runs
      cpus: 24
      memoryGb: 40
    render:
      about: films
      image: registry.example/render@sha256:0a1b
      cpus: 32
      memoryGb: 64
      diskGb: 100
      gpus: true
    Films: { image: node }
    shell:
      image: node;rm -rf /
    bad-cpus: { cpus: "24" }
    bad-memory: { memoryGb: 40.5 }
    bad-disk: { diskGb: null }
`;

test("with two kinds declared, each kind's helper takes only its kind's runs, and a run whose kind has no helper there goes to this server's helper of its kind at once", async t => {
  declareKinds(t, TWO_KINDS);
  await lendOne();
  const job = await h.start({ agent: 'bolt' });
  const render = await sendRun(job.token, { command: 'true', kind: 'render' });
  assert.equal(render.status, 200, render.text);
  assert.equal((await asHelper('/api/helper/take', { kind: 'simulation' })).status, 204, 'not the render');
  assert.equal((await h.agent(`runs/${render.json.id}`, job.token)).body.helper.present, false);
  assert.equal((await asServer('/api/helper/take', {})).status, 400, "this server's names its kind too");
  assert.equal(
    (await asServer('/api/helper/take', { kind: 'simulation' })).status,
    204,
    "not this server's of the kind",
  );
  assert.equal(
    (await asServer('/api/helper/take', { kind: 'render' })).json.id,
    takeOf(render.json.id),
    'no render helper is there',
  );

  const simulation = await sendRun(job.token, { command: 'true', kind: 'simulation' });
  assert.equal((await h.agent(`runs/${simulation.json.id}`, job.token)).body.helper.present, true);
  assert.equal(
    (await asServer('/api/helper/take', { kind: 'simulation' })).status,
    204,
    "the simulation helper is there: it's its run",
  );
  assert.equal((await asHelper('/api/helper/take', { kind: 'simulation' })).json.id, takeOf(simulation.json.id));
  assert.equal((await asHelper('/api/helper/take', { kind: 'render' })).status, 204);
  assert.equal(stateOf(simulation.json.id), 'running', "the render helper's start leaves the simulation run alone");
  assert.equal(helperOf(simulation.json.id), 'lent');
  await h.finish(job);
});

test("with a kind's lent helper away, its run uses that kind's tools on this server's helper, and never another kind's", async t => {
  declareKinds(t, TWO_KINDS);
  await lendNone();
  const job = await h.start({ agent: 'bolt' });
  // (what the render kind's image has and the simulation kind's lacks, as ffmpeg would be)
  const tools = mkdtempSync(`${tmpdir()}/runs-tools-`);
  chmodSync(tools, 0o755);
  writeFileSync(`${tools}/rendertool`, '#!/bin/sh\necho "rendered $1"\n', { mode: 0o755 });
  await startHelper(t, { server: true, kind: 'simulation' });
  const machine = await startHelper(t, { server: true, kind: 'render', tools });
  const tree = jobTree();
  const render = await hqIn(
    `${tree}/sim`,
    job,
    'run',
    '--kind',
    'render',
    '--bring',
    'out',
    '--',
    'sh',
    '-c',
    'mkdir out && rendertool film > out/film.txt',
  );
  assert.equal(render.code, 0, render.out);
  assert.match(render.out, /done on this server's helper/);
  assert.equal(readFileSync(`${tree}/sim/out/film.txt`, 'utf8'), 'rendered film\n');
  assert.equal(helperOf(lastRun()), 'server');
  const simulation = await hqIn(`${tree}/sim`, job, 'run', '--kind', 'simulation', '--', 'rendertool', 'film');
  assert.equal(simulation.code, 127, "the simulation kind's image has no such tool");
  const listed = await hqIn(tree, job, 'run', 'helper');
  assert.match(
    listed.out,
    /this server's helper, one per kind of run in the kind's image:\n {2}simulation: asking for work.*\n {2}render: asking for work/,
  );
  await leftNothing(machine);
  await h.finish(job);
});

test('a run must name a kind HQ knows when several are declared, and a helper must name its own', async t => {
  declareKinds(t, TWO_KINDS);
  await lendOne();
  const job = await h.start({ agent: 'bolt' });
  const unnamed = await sendRun(job.token, { command: 'true' });
  assert.equal(unnamed.status, 400);
  assert.match(unnamed.json.error, /simulation .*render/);
  const tree = jobTree();
  const unknown = await hqIn(`${tree}/sim`, job, 'run', '--kind', 'shell', '--', 'true');
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.out, /HQ refused it: .*simulation .*render/);
  assert.equal((await asHelper('/api/helper/take', { kind: 'shell' })).status, 400);
  assert.equal((await asHelper('/api/helper/take', {})).status, 400);
  assert.equal(
    (h.db.prepare('select count(*) as runs from helper_runs where job = ?').get(job.id) as { runs: number }).runs,
    0,
  );
  await h.finish(job);
});

test("each kind's start command runs its own container, image, caps and GPUs on the one key volume, and a kind that breaks a rule is left out and said why", async t => {
  declareKinds(t, TWO_KINDS);
  const job = await h.start({ agent: 'bolt' });
  const machine = (await h.agent('runs/helper', job.token)).body;
  const start = Object.fromEntries(
    machine.kinds.map((kind: { name: string; setup: { start: string } }) => [kind.name, kind.setup.start]),
  );
  assert.deepEqual(Object.keys(start), ['simulation', 'render']);
  for (const command of Object.values(start)) assert.match(String(command), / --user 0:0 --entrypoint node /);
  assert.match(
    start.render,
    / --name run-helper-render.*,size=100g --cpus 32 --memory 64g --pids-limit 4096 --gpus all -v run-helper:\/state .* -e RUN_KIND=render registry\.example\/render@sha256:0a1b -e /,
  );
  assert.match(
    start.simulation,
    / --name run-helper-simulation.*,size=16g --cpus 24 --memory 40g --pids-limit 4096 -v run-helper:\/state .* -e RUN_KIND=simulation node:24.22.1-slim -e /,
  );
  assert.deepEqual(
    machine.leftOut.map((kind: { name: string }) => kind.name),
    ['Films', 'shell', 'bad-cpus', 'bad-memory', 'bad-disk'],
  );
  const listed = await hqIn(jobTree(), job, 'run', 'helper');
  assert.match(listed.out, /Films: left out/);
  assert.match(listed.out, /shell: left out .*image/);
  await h.finish(job);
});

test("this server's helpers are made from the kinds HQ takes, as it read them: their names and images, published for the deploy", t => {
  const published = () => JSON.parse(readFileSync(`${h.dataDir}/run-kinds.json`, 'utf8'));
  declareKinds(t, TWO_KINDS);
  runs.publishKinds();
  assert.deepEqual(published(), [
    { name: 'simulation', image: 'node:24.22.1-slim' },
    { name: 'render', image: 'registry.example/render@sha256:0a1b' },
  ]);
});

const RIG_ONLY = `
    simulation:
      about: long simulation runs
    voice:
      about: speech on the graphics card
      gpus: true
      lentOnly: true
    bad-only: { lentOnly: "yes" }
`;

test('a kind for the lent machine only: this server has no helper of it and never takes its runs, which wait for the lent machine, also after it goes quiet mid-run', async t => {
  declareKinds(t, RIG_ONLY);
  await lendOne();
  runs.publishKinds();
  assert.deepEqual(JSON.parse(readFileSync(`${h.dataDir}/run-kinds.json`, 'utf8')), [
    { name: 'simulation', image: 'node:24.22.1-slim' },
  ]);
  const job = await h.start({ agent: 'bolt' });
  const sent = await sendRun(job.token, { command: 'true', kind: 'voice' });
  assert.equal(sent.status, 200, sent.text);
  const waiting = (await h.agent(`runs/${sent.json.id}`, job.token)).body;
  assert.equal(waiting.helper.lentOnly, true, 'hq run waits for it, however long');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 60 * 60_000 });
  assert.equal(
    (await asServer('/api/helper/take', { kind: 'voice' })).status,
    204,
    'not even after takeMinutes, the lent machine away',
  );
  assert.equal((await asHelper('/api/helper/take', { kind: 'voice' })).json.id, takeOf(sent.json.id));
  t.mock.timers.tick(4 * 60_000);
  const passed = (await h.agent(`runs/${sent.json.id}`, job.token)).body;
  assert.deepEqual([passed.state, passed.passed], ['waiting', true]);
  assert.match(passed.why, /went quiet: it waits for the lent machine again/);
  assert.equal((await asServer('/api/helper/take', { kind: 'voice' })).status, 204);
  assert.equal(
    (await asHelper('/api/helper/take', { kind: 'voice' })).json.id,
    takeOf(sent.json.id, 2),
    'the lent machine, back',
  );
  t.mock.timers.reset();
  await h.finish(job);
});

test('files git ignores go with a run that names them with --with, and no other file git ignores does', async t => {
  await lendNone();
  const job = await h.start({ agent: 'bolt' });
  const machine = await startHelper(t, { server: true });
  const tree = jobTree();
  writeFileSync(`${tree}/.gitignore`, '*.wav\n');
  writeFileSync(`${tree}/sim/track.wav`, 'music\n');
  writeFileSync(`${tree}/sim/other.wav`, 'not named\n');
  const ran = await hqIn(`${tree}/sim`, job, 'run', '--with', 'track.wav', '--bring', 'out', '--', 'sh', '-c', SEEN);
  assert.equal(ran.code, 0, ran.out);
  assert.equal(readFileSync(`${tree}/sim/out/seen.txt`, 'utf8'), 'track.wav\n');
  await leftNothing(machine);
  await h.finish(job);
});

test('with --fallback here, a run no helper may take runs in the job: its kind undeclared, or for the lent machine alone with none asking', async t => {
  declareKinds(t, RIG_ONLY);
  await lendOne();
  const job = await h.start({ agent: 'bolt' });
  const tree = jobTree();
  for (const kind of ['voice', 'film']) {
    const ran = await hqIn(`${tree}/sim`, job, 'run', '--kind', kind, '--fallback', 'here', '--', 'sh', '-c', HERE);
    assert.equal(ran.code, 0, ran.out);
    assert.match(ran.out, /running it here/);
    assert.equal(readFileSync(`${tree}/sim/here.txt`, 'utf8'), '1 seed.txt\n', 'run in the tree, told so');
  }
  const runsOf = h.db.prepare('select count(*) as runs from helper_runs where job = ?').get(job.id) as { runs: number };
  assert.equal(runsOf.runs, 0, 'nothing sent to HQ');
  await h.finish(job);
});

test('with --fallback here, a run a machine took and then lost runs in the job', async t => {
  await lendOne();
  const job = await h.start({ agent: 'bolt' });
  const tree = jobTree();
  assert.equal((await asHelper('/api/helper/take', {})).status, 204, 'the lent machine asks for work');
  const before = lastRun();
  const ran = hqIn(`${tree}/sim`, job, 'run', '--fallback', 'here', '--', 'sh', '-c', HERE);
  while (lastRun() === before) await new Promise(resolve => setTimeout(resolve, 100));
  const id = lastRun();
  assert.equal((await asHelper('/api/helper/take', {})).json.id, takeOf(id));
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 4 * 60_000 });
  assert.equal((await h.agent(`runs/${id}`, job.token)).body.passed, true);
  assert.equal((await asServer('/api/helper/take', {})).json.id, takeOf(id, 2), "the lent one quiet: this server's");
  t.mock.timers.tick(4 * 60_000);
  assert.equal((await h.agent(`runs/${id}`, job.token)).body.state, 'lost');
  const here = await ran;
  t.mock.timers.reset();
  assert.equal(here.code, 0, here.out);
  assert.match(here.out, /lost .*: running it here/);
  assert.equal(readFileSync(`${tree}/sim/here.txt`, 'utf8'), '1 seed.txt\n', 'run in the tree, told so');
  await h.finish(job);
});

// What the three tests above run: the .wav files the run sees, and where it runs and whether it's told so
const SEEN = 'mkdir out && ls *.wav > out/seen.txt';
const HERE = 'echo "$HQ_RUN_HERE $(ls seed.txt)" > here.txt';

test("the machines in HQ's org read, for every look's rig: none lent but this server; then the lent machine away, and the run it has, since when and on how many cores", async t => {
  declareKinds(t, RIG_ONLY);
  await lendNone();
  h.db.exec('delete from helper_runs');
  const lent = async () =>
    (await h.board('/api/org')).body.machines.filter((one: { id: unknown }) => one.id !== 'server');
  assert.deepEqual(await lent(), [], 'no machine lent');
  await lendOne();
  assert.deepEqual(
    (await lent()).map(({ name, state, run }: { name: string; state: string; run?: unknown }) => [name, state, run]),
    [['the lent machine', 'away', undefined]],
  );
  const job = await h.start({ agent: 'bolt', title: 'Speak the episode' });
  const sent = await sendRun(job.token, { command: 'true', kind: 'voice' });
  assert.equal((await asHelper('/api/helper/take', { kind: 'voice' })).json.id, takeOf(sent.json.id));
  const [{ state, run }] = await lent();
  assert.equal(state, 'running');
  assert.deepEqual(
    { ...run, since: undefined },
    {
      job: job.id,
      job_code: h.job(job.id).code,
      agent: 'bolt',
      kind: 'voice',
      title: 'Speak the episode',
      since: undefined,
      cores: 4,
    },
  );
  assert.ok(Date.now() - Date.parse(run.since) < 60_000, 'since the helper took it');
  await h.finish(job);
});

const HELD_KIND = `
    sweep:
      serverAfterLent: true
      holdUntilLent: [studio]
`;

test("a kind held for the lent machine: this server's helper takes none of its runs, and the departments named start no work, until the lent helper has finished one", async t => {
  declareKinds(t, HELD_KIND);
  await lendOne();
  runs.publishHolds();
  const job = await h.start({ agent: 'bolt' });
  const fix = h.queue({ agent: 'wren', stage: 'fix', pr: 7, engine: 'held-fix' });
  const review = h.queue({ agent: 'wren', kind: 'review', pr: 7, engine: 'held-review' });
  assert.equal(await h.claim('held-fix'), null, "wren's fix round waits");
  assert.equal(h.job(fix).ready, 0);
  assert.ok(h.job(fix).wakes.length > 0);
  const claimedReview = await h.claim('held-review');
  assert.equal(claimedReview?.id, review, 'a review is not work: it runs');

  const sent = await sendRun(job.token, { command: 'true' });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.helper.serverTakes, false);
  assert.equal((await asServer('/api/helper/take', { kind: 'sweep' })).status, 204, 'no lent helper asks, still not');
  const firstTake = (await asHelper('/api/helper/take', { kind: 'sweep' })).json.id;
  assert.equal(firstTake, takeOf(sent.json.id));
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(4 * 60_000);
  const lost = (await h.agent(`runs/${sent.json.id}`, job.token)).body;
  assert.equal(lost.state, 'waiting');
  assert.ok(lost.why);
  assert.equal((await asServer('/api/helper/take', { kind: 'sweep' })).status, 204, 'nor one the lent helper lost');
  const secondTake = (await asHelper('/api/helper/take', { kind: 'sweep' })).json.id;
  assert.equal(secondTake, takeOf(sent.json.id, 2), 'the lent one again');
  assert.notEqual(secondTake, firstTake);
  assert.equal((await asHelper(`/api/helper/runs/${firstTake}/bundle`)).status, 404, 'the first take gets nothing');
  assert.equal((await asHelper(`/api/helper/runs/${firstTake}/beat`, {})).json.go, false);
  assert.equal((await asHelper(`/api/helper/runs/${firstTake}/output`, Buffer.from('late\n'))).status, 409);
  const late = await asHelper(`/api/helper/runs/${firstTake}/finish`, Buffer.alloc(0), { 'x-run-exit': '0' });
  assert.equal(late.status, 409);
  assert.equal(stateOf(sent.json.id), 'running');
  assert.ok(h.job(fix).wakes.length > 0, "the first take's finish lifts nothing");
  assert.equal((await asHelper(`/api/helper/runs/${secondTake}/beat`, {})).json.go, true);
  const finished = await asHelper(`/api/helper/runs/${secondTake}/finish`, Buffer.alloc(0), { 'x-run-exit': '1' });
  assert.equal(finished.status, 200, finished.text);

  assert.deepEqual(h.job(fix).wakes, []);
  const fixRound = await h.claim('held-fix');
  assert.equal(fixRound?.id, fix, 'the fix round starts once the lent helper has finished a run');
  const next = await sendRun(job.token, { command: 'true' });
  assert.equal(next.json.helper.serverTakes, true);
  t.mock.timers.tick(4 * 60_000);
  assert.equal(
    (await asServer('/api/helper/take', { kind: 'sweep' })).json.id,
    takeOf(next.json.id),
    'and this server, as usual',
  );
  for (const running of [job, claimedReview!, fixRound!]) await h.finish(running);
});

test("an upload under way when the same lent helper takes its run again is refused, and the run waits for the new take's", async t => {
  declareKinds(t, '    retake:\n      serverAfterLent: true\n      holdUntilLent: [studio]\n');
  await lendOne();
  runs.publishHolds();
  const job = await h.start({ agent: 'bolt' });
  const fix = h.queue({ agent: 'wren', stage: 'fix', pr: 8, engine: 'retake-fix' });
  const sent = await sendRun(job.token, { command: 'true' });
  const firstTake = (await asHelper('/api/helper/take', { kind: 'retake' })).json.id;

  let endUpload!: () => void;
  const files = new ReadableStream({
    async start(controller) {
      controller.enqueue(new Uint8Array(1024));
      await new Promise<void>(resolve => (endUpload = resolve));
      controller.close();
    },
  });
  const upload = fetch(`${h.base}/api/helper/runs/${firstTake}/finish`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lentKey}`, 'x-run-exit': '0' },
    body: files,
    duplex: 'half',
  } as RequestInit);
  t.after(async () => {
    endUpload();
    await upload;
  });
  const receiving = () => readdirSync(`${h.dataDir}/runs/${sent.json.id}`).some(name => name.startsWith('files-'));
  await until(receiving, 'the upload started');

  const secondTake = (await asHelper('/api/helper/take', { kind: 'retake' })).json.id;
  assert.equal(secondTake, takeOf(sent.json.id, 2), 'started again: the lent helper takes it anew');
  assert.notEqual(secondTake, firstTake);
  endUpload();
  assert.equal((await upload).status, 409, 'the first take finishes nothing');
  assert.equal(stateOf(sent.json.id), 'running');
  assert.ok(h.job(fix).wakes.length > 0, 'and lifts no hold');

  const finished = await asHelper(`/api/helper/runs/${secondTake}/finish`, Buffer.alloc(0), { 'x-run-exit': '0' });
  assert.equal(finished.status, 200, finished.text);
  assert.deepEqual(h.job(fix).wakes, []);
  await h.finish(job);
});

test('a kinds list is refused instead of silently becoming the default kind', async t => {
  declareKinds(t, '    - simulation\n');
  const job = await h.start({ agent: 'bolt' });
  const machine = (await h.agent('runs/helper', job.token)).body;
  assert.deepEqual(machine.kinds, []);
  assert.deepEqual(machine.leftOut, [{ name: 'kinds', why: 'a map of kinds, keyed by name' }]);
  await h.finish(job);
});

test("the browser harnesses' kind is runs.browser, render when it names none, left out when it names no kind", async t => {
  const job = await h.start({ agent: 'bolt' });
  for (const [browser, expected, leftOut] of [
    ['', 'render', false],
    ['  browser: shots\n', 'shots', false],
    ['  browser: Shots!\n', '', true],
  ] as const)
    await t.test(browser || 'none', async row => {
      declareKinds(row, TWO_KINDS, browser);
      const machine = (await h.agent('runs/helper', job.token)).body;
      assert.equal(machine.browser, expected);
      assert.equal(
        machine.leftOut.some((kind: { name: string }) => kind.name === 'browser'),
        leftOut,
      );
    });
  await h.finish(job);
});

test("two kinds' helpers started on one volume before the machine's key command wait for its key, then both are let in", async t => {
  declareKinds(t, TWO_KINDS);
  await lendNone();
  const job = await h.start({ agent: 'bolt' });
  const lent = await lend('the lent machine');
  const bootstrap = / -e "(.*)"$/.exec(lent.kinds[0].commands.start)![1];
  const state = mkdtempSync(`${tmpdir()}/runs-state-`);
  await Promise.all(['simulation', 'render'].map(kind => startHelper(t, { bootstrap, kind, state })));
  const present = async () =>
    (await h.agent('runs/helper', job.token)).body.kinds.map((kind: { present: boolean }) => kind.present);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.deepEqual(await present(), [false, false], 'no key yet');
  saveKey(lent.keyCommand, `${state}/key`);
  for (let tries = 0; tries < 100 && (await present()).includes(false); tries++)
    await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(await present(), [true, true]);
  assert.deepEqual(readdirSync(state), ['key']);
  await h.finish(job);
});

test(
  "as another user, a run on this server's helper can't signal a process outside it, and nothing it started outlives it",
  { skip: ROOT ? false : 'as root only: the runs go as another user' },
  async t => {
    const job = await h.start({ agent: 'bolt' });
    const machine = await startHelper(t, { server: true });
    // a process outside the run, which says so if a signal reaches it
    const outside = spawn(
      'node',
      ['-e', "process.on('SIGUSR2', () => console.log('signalled')); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    t.after(() => outside.kill());
    let heard = '';
    outside.stdout.on('data', chunk => (heard += chunk));
    const tree = jobTree();
    const ran = await hqIn(
      `${tree}/sim`,
      job,
      'run',
      '--bring',
      'out',
      '--',
      'sh',
      '-c',
      `mkdir out; kill -USR2 ${outside.pid} 2> out/refused.txt; ` +
        "setsid sh -c 'echo $$ > out/detached.txt; exec sleep 300' & sleep 1",
    );
    assert.equal(ran.code, 0, ran.out);
    assert.match(readFileSync(`${tree}/sim/out/refused.txt`, 'utf8'), /not permitted/i);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(heard, '', 'the signal never reached the process outside');
    const detached = Number(readFileSync(`${tree}/sim/out/detached.txt`, 'utf8'));
    assert.throws(() => process.kill(detached, 0), /ESRCH/, 'the detached process ended with the run');
    await leftNothing(machine);
    await h.finish(job);
  },
);

// What a run leaves behind it outside its workspace, as its user: a file in shared memory and one in a folder it locked,
// a message queue, and a shared memory segment, message queue and semaphore set of System V's
const leaveIpc = `
mkdir '/dev/shm/locked' or die "$!"; open my $file, '>', '/dev/shm/locked/file' or die "$!"; chmod 0, '/dev/shm/locked';
open $file, '>', '/dev/shm/left' or die "$!";
my $queue = 'left'; syscall(240, $queue, 0x42, 0600, 0) >= 0 or die "mq_open: $!";
syscall(29, 0, 4096, 01600) >= 0 && syscall(68, 0, 01600) >= 0 && syscall(64, 0, 1, 01600) >= 0 or die "$!";
sleep 1;
`;
// What a run finds of its user's outside its workspace
const findIpc = `
my @left = grep { (lstat)[4] == $< } glob '/dev/shm/* /dev/mqueue/*';
for my $name (qw(shm msg sem)) {
  open my $list, '<', "/proc/sysvipc/$name" or die "$!";
  my @columns = split ' ', <$list>;
  my ($creator) = grep { $columns[$_] eq 'cuid' } 0 .. $#columns;
  push @left, map { "$name " . (split)[1] } grep { (split)[$creator] == $< } <$list>;
}
print 'left: ', (join(', ', @left) || 'nothing'), "\n";
`;

// HQ as a helper reaches it, but for the first run's first beat: that one is held until the next run beats, then told
// to stop, a late answer for a run that ended
async function stopLate(t: TestContext) {
  let held: { run: string; response: ServerResponse } | undefined;
  const between = createServer(async (request, response) => {
    const body = Buffer.concat(await Array.fromAsync(request));
    const beat = /^\/api\/helper\/runs\/(\d+)\/beat$/.exec(request.url!)?.[1];
    if (beat && !held) return void (held = { run: beat, response });
    if (beat && beat !== held!.run && !held!.response.headersSent)
      held!.response.writeHead(200).end(JSON.stringify({ go: false }));
    const headers = Object.entries(request.headers).filter(
      ([name]) => name === 'authorization' || name === 'content-type' || name.startsWith('x-'),
    );
    const answer = await fetch(`${h.base}${request.url}`, {
      method: request.method,
      headers: headers as [string, string][],
      body: request.method === 'GET' ? undefined : body,
    });
    response.writeHead(answer.status).end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise<void>(resolve => between.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    between.closeAllConnections();
    between.close();
  });
  return `http://127.0.0.1:${(between.address() as AddressInfo).port}`;
}

test(
  'as another user, a run leaves the next one nothing: no shared memory, message queue or IPC object, and no late stop',
  { skip: ROOT ? false : 'as root only: the runs go as another user' },
  async t => {
    const job = await h.start({ agent: 'bolt' });
    const machine = await startHelper(t, { server: true }, await stopLate(t));
    const tree = jobTree();
    const first = await hqIn(`${tree}/sim`, job, 'run', '--', 'perl', '-e', leaveIpc);
    assert.equal(first.code, 0, first.out);
    const second = await hqIn(`${tree}/sim`, job, 'run', '--', 'sh', '-c', 'perl -e "$1" && sleep 2', 'sh', findIpc);
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /left: nothing/);
    await leftNothing(machine);
    await h.finish(job);
  },
);

const TESTS_KIND = `
    tests:
      about: a push's tests
      image: node:24.22.1-bookworm
      cpus: 8
      memoryGb: 10
      helpers: 2
      sockets: true
`;

test("a machine set up with its install command: one command with its key, the manager's code pinned by its hash, its setup with each kind's helpers and those that have a run; a kind's runs that keep their sockets go to its locked helpers alone, two at once, each helper's start losing only its own", async t => {
  declareKinds(t, TESTS_KIND);
  await lendNone();
  const added = await lend('the rig');
  lentKey = added.key;
  assert.match(
    added.install,
    new RegExp(`-e MANAGER=install -e HQ_URL=\\S+ -e HELPER_KEY=${added.key} node:24.22.1-slim -e "`),
  );
  const manager = await fetch(`${h.base}/api/helper/manager`).then(r => r.text());
  const pinned = /digest\('hex'\)!='([0-9a-f]{64})'/.exec(added.install)![1];
  assert.equal(
    createHash('sha256').update(manager).digest('hex'),
    pinned,
    'the install command trusts the code HQ serves',
  );
  assert.doesNotMatch(
    (await h.board('/api/machines/setup')).body.install,
    /HELPER_KEY/,
    'without a key, to install again',
  );

  const setup = await asHelper('/api/helper/setup', {});
  assert.deepEqual(setup.json, {
    kinds: [
      {
        name: 'tests',
        image: 'node:24.22.1-bookworm',
        cpus: 8,
        memoryGb: 10,
        diskGb: 16,
        gpus: false,
        helpers: 2,
        sockets: true,
      },
    ],
    busy: [],
  });
  assert.equal((await asServer('/api/helper/setup', {})).status, 403, 'never this server');

  const job = await h.start({ agent: 'bolt' });
  const [first, second, third] = [
    await sendRun(job.token, { command: 'true', kind: 'tests' }),
    await sendRun(job.token, { command: 'true', kind: 'tests' }),
    await sendRun(job.token, { command: 'true', kind: 'tests' }),
  ];
  assert.equal((await sendRun(job.token, { command: 'true' })).status, 400, 'named always');
  assert.equal(
    (await asServer('/api/helper/take', { kind: 'tests' })).status,
    400,
    "its runs keep their sockets: never this server's helper",
  );
  assert.equal(
    (await asHelper('/api/helper/take', { kind: 'tests', slot: 1 })).status,
    400,
    'nor a helper started by hand',
  );
  const one = await asHelper('/api/helper/take', { kind: 'tests', slot: 1, locked: true });
  assert.equal(one.json.id, takeOf(first.json.id));
  assert.equal(one.json.sockets, true);
  assert.equal(
    (await asHelper('/api/helper/take', { kind: 'tests', slot: 2, locked: true })).json.id,
    takeOf(second.json.id),
    'the second helper takes one at the same time',
  );
  assert.deepEqual((await asHelper('/api/helper/setup', {})).json.busy, [
    { kind: 'tests', slot: 1 },
    { kind: 'tests', slot: 2 },
  ]);
  // the first helper starts again: its run waits again, the second's goes on
  assert.equal(
    (await asHelper('/api/helper/take', { kind: 'tests', slot: 1, locked: true })).json.id,
    takeOf(first.json.id, 2),
  );
  assert.equal(stateOf(second.json.id), 'running');
  assert.equal(stateOf(third.json.id), 'waiting', 'two helpers, two runs at once');

  // a new install command: a new key, the old one let in no more
  const again = await h.board('/api/machines/install', { machine: added.id });
  const key = /HELPER_KEY=(helper_[\w-]{43})/.exec(again.body.install)![1];
  assert.equal((await asHelper('/api/helper/setup', {})).status, 401);
  assert.equal((await asKey(key, '/api/helper/setup', {})).status, 200);
  await h.finish(job);
});

test("a lent machine's pull of a kind's private image signs in with HQ's registry key, for an image a kind names alone", async t => {
  // (an owner whose sign-in isn't a multiple of 3 bytes long, so its base64 needs padding)
  const voice = `ghcr.io/acme1/voice@sha256:${'a'.repeat(64)}`;
  declareKinds(
    t,
    `${TESTS_KIND}
    voice:
      about: speech
      image: ${voice}
      gpus: true
      lentOnly: true
`,
  );
  await lendOne();
  const pull = async (image: string) => (await asHelper('/api/helper/pull', { image })).json;
  const cards = () =>
    h.db
      .prepare("select agent, title from requests where kind = 'credential' and secrets = 'REGISTRY_GHCR_TOKEN'")
      .all();
  assert.equal((await asHelper('/api/helper/pull', { image: voice })).status, 409, 'no key at HQ yet: no sign-in');
  assert.equal((await asHelper('/api/helper/pull', { image: voice })).status, 409);
  assert.equal(cards().length, 1, 'the board gets one card for the key, however often the machine asks');
  const keyFile = `${h.dataDir}/secrets/REGISTRY_GHCR_TOKEN`;
  mkdirSync(`${h.dataDir}/secrets`, { recursive: true });
  writeFileSync(keyFile, `ghp_${'k'.repeat(36)}\n`);
  t.after(() => rmSync(keyFile, { force: true }));
  const { auth } = await pull(voice);
  assert.match(auth, /^[\w-]+={0,2}$/, 'base64url');
  assert.equal(auth.length % 4, 0, 'padded, as Docker reads it');
  assert.deepEqual(JSON.parse(Buffer.from(auth, 'base64url').toString()), {
    username: 'acme1',
    password: `ghp_${'k'.repeat(36)}`,
    serveraddress: 'ghcr.io',
  });
  assert.deepEqual(await pull('node:24.22.1-bookworm'), {}, "a public image's registry: none");
  const other = await asHelper('/api/helper/pull', { image: 'ghcr.io/acme/other:1' });
  assert.equal(other.status, 404, 'an image no kind names: none');
  assert.equal((await asServer('/api/helper/pull', { image: voice })).status, 403, 'never this server');
  assert.equal((await asKey('not-a-key', '/api/helper/pull', { image: voice })).status, 401);
});

test("a lent machine's runs fit its own memory cap together: a run of another kind waits while they'd pass it, and goes once one ends", async t => {
  const file = `${h.repo}/company/org.yaml`;
  const before = readFileSync(file, 'utf8');
  writeFileSync(
    file,
    `${before}\nruns:\n  helper: the lent machine\n  machineMemoryGb: 12\n  kinds:\n` +
      '    simulation:\n      memoryGb: 8\n    render:\n      memoryGb: 6\n      helpers: 2\n',
  );
  t.after(() => writeFileSync(file, before));
  await lendOne();
  const job = await h.start({ agent: 'bolt' });
  const sim = await sendRun(job.token, { command: 'true', kind: 'simulation' });
  const render = await sendRun(job.token, { command: 'true', kind: 'render' });
  const simTake = (await asHelper('/api/helper/take', { kind: 'simulation' })).json.id;
  assert.equal(simTake, takeOf(sim.json.id));
  assert.equal(
    (await asHelper('/api/helper/take', { kind: 'render', slot: 1 })).status,
    204,
    '8 GB held and 6 more would pass the 12 GB the machine gives its runs',
  );
  assert.equal(stateOf(render.json.id), 'waiting');
  await asHelper(`/api/helper/runs/${simTake}/finish`, Buffer.alloc(0), { 'x-run-exit': '0' });
  assert.equal((await asHelper('/api/helper/take', { kind: 'render', slot: 1 })).json.id, takeOf(render.json.id));
  await h.finish(job);
});
