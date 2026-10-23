// node --test src/detached.test.ts   (real processes as this uid)
// A run's CLI writes to files, so a new worker process can take it over where the last one got to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  alive,
  dropRun,
  endOf,
  endSeen,
  exitOf,
  follow,
  keepRecord,
  launch,
  processesOf,
  records,
  sweepRuns,
  type RunRecord,
} from './detached.ts';

const runs = () => mkdtempSync(`${tmpdir()}/runs-test-`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('a launch writes to files, reads its prompt from stdin, and its end lands in its marker', async () => {
  const dir = runs();
  const { child, launched } = launch(
    dir,
    '7',
    'sh',
    ['-c', 'read p; echo "{\\"said\\":\\"$p\\"}"; echo oops >&2; exit 3'],
    { env: { PATH: process.env.PATH } },
  );
  child.stdin!.end('hello\n');
  let over = false,
    code = -1;
  exitOf(child).then(c => {
    over = true;
    code = c;
  });
  let out = '',
    err = '';
  const at = await follow(
    launched,
    { out: 0, err: 0 },
    () => over,
    b => {
      out += b;
    },
    b => {
      err += b;
    },
  );
  assert.equal(out, '{"said":"hello"}\n');
  assert.equal(err, 'oops\n');
  assert.equal(code, 3);
  assert.deepEqual(at, { out: out.length, err: err.length });
  assert.equal(endSeen(dir, launched), 3);
  rmSync(dir, { recursive: true });
});

test('a new worker process takes a run over: it goes on, read from where it got to, and its end is seen without being its parent', async () => {
  const dir = runs();
  // the first worker process launches it and reads its first line, then hands over
  const { child, launched } = launch(
    dir,
    '8',
    'sh',
    ['-c', 'echo one; while [ ! -f "$1/go" ]; do sleep 0.05; done; echo two; exit 0', 'sh', dir],
    { env: { PATH: process.env.PATH } },
  );
  child.stdin!.end();
  child.unref();
  let first = '';
  await follow(
    launched,
    { out: 0, err: 0 },
    () => first.length > 0,
    b => {
      first += b;
    },
    () => {},
  );
  assert.equal(first, 'one\n');
  const record: RunRecord = {
    job: { id: 8, session: null },
    seat: 'claude-1',
    slot: 'claude#1',
    resumed: false,
    launched,
    read: { out: 4, err: 0 },
    session: 's-8',
  };
  keepRecord(dir, record);
  // the next one finds the record, and the run still running
  const [r] = records(dir, () => {});
  assert.deepEqual(r, record);
  assert.ok(alive(r.launched.pid, r.launched.start));
  assert.equal(endSeen(dir, r.launched), undefined);
  let rest = '';
  const reading = follow(
    r.launched,
    { ...r.read },
    () => !alive(r.launched.pid, r.launched.start),
    b => {
      rest += b;
    },
    () => {},
  );
  await sleep(200);
  assert.equal(rest, ''); // (still running)
  spawn('touch', [`${dir}/go`]);
  await reading;
  assert.equal(rest, 'two\n');
  assert.equal(await endOf(dir, r.launched), 0);
  // reported: the run's files go, and a sweep leaves only what a kept record names
  dropRun(dir, 8, launched);
  rmSync(`${dir}/go`);
  assert.deepEqual(readdirSync(dir), []);
  rmSync(dir, { recursive: true });
});

test('a pid alone never names a run: another start is another process', () => {
  const { pid } = process;
  const start = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
  assert.ok(alive(pid, start));
  assert.ok(!alive(pid, String(Number(start) + 1)));
  assert.ok(!alive(2 ** 22 + 1, start));
});

test("records it can't read are set aside, and a sweep clears what no kept record names", () => {
  const dir = runs();
  const l = { pid: 1, start: '1', out: `${dir}/9.out`, err: `${dir}/9.err` };
  const gates = { pid: 2, start: '2', out: `${dir}/9.gates.out`, err: `${dir}/9.gates.err` };
  keepRecord(dir, {
    job: { id: 9 },
    seat: 'claude-1',
    slot: 'claude#2',
    resumed: true,
    launched: l,
    read: { out: 0, err: 0 },
    checks: {
      body: {},
      spent: {},
      runs: { gates: { launched: gates, began: 0, stopped: [] }, tests: { stopped: [] } },
    },
  });
  for (const f of ['9.out', '9.err', 'pid-1-1', '9.gates.out', '9.gates.err', 'pid-2-2', '5.out', 'pid-5-5'])
    writeFileSync(`${dir}/${f}`, '');
  writeFileSync(`${dir}/4.json`, '{not json');
  const kept = records(dir, () => {});
  assert.deepEqual(
    kept.map(r => r.job.id),
    [9],
  );
  sweepRuns(dir, kept);
  assert.deepEqual(
    readdirSync(dir)
      .filter(n => !n.startsWith('4.json.unreadable-'))
      .sort(),
    ['9.err', '9.gates.err', '9.gates.out', '9.json', '9.out', 'pid-1-1', 'pid-2-2'],
  );
  rmSync(dir, { recursive: true });
});

test("what a run has running: each command's own program under its shells, never the CLI or its shells, with its age", async () => {
  // a stand-in CLI (this uid's) with a render under a shell, and a test runner under two
  const cli = spawn('sh', ['-c', 'sh -c "exec sleep 301" & sh -c "sh -c \\"exec sleep 302\\"" & wait'], {
    stdio: 'ignore',
    detached: true,
  });
  await sleep(300);
  try {
    const mine = processesOf(process.getuid!(), cli.pid!, 10_000).filter(p => /^sleep 30[12] /.test(p));
    assert.deepEqual(mine, ['sleep 301 (running 0 min)', 'sleep 302 (running 0 min)']);
    assert.equal(processesOf(process.getuid!(), cli.pid!, 0).at(-1)?.startsWith('and '), true);
  } finally {
    process.kill(-cli.pid!, 'SIGKILL');
  } // (its group: the stand-in and everything under it)
});

test('a command line that holds a key is shown with the key redacted (house rule 8)', async () => {
  // a stand-in CLI with a command under it that has a key among its arguments
  const cli = spawn(
    'sh',
    ['-c', `${process.execPath} -e "setTimeout(() => {}, 30000)" HQ_TOKEN=abcdefgh123456 & wait`],
    {
      stdio: 'ignore',
      detached: true,
    },
  );
  await sleep(300);
  try {
    const mine = processesOf(process.getuid!(), cli.pid!, 10_000).filter(p => p.includes('HQ_TOKEN'));
    assert.equal(mine.length, 1);
    assert.match(mine[0], /HQ_TOKEN=\[redacted\]/);
    assert.doesNotMatch(mine[0], /abcdefgh123456/);
  } finally {
    process.kill(-cli.pid!, 'SIGKILL');
  }
});
