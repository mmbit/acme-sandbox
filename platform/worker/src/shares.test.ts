// node --test src/shares.test.ts
// Each job's share of the worker: its processes counted together, its heavy run blocked past its share, never its CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { alive, procStat } from './detached.ts';
import {
  cliProcesses,
  commandOf,
  processesFor,
  overShare,
  runsOf,
  slowDown,
  stopRun,
  tally,
  type ProcessSnapshot,
} from './shares.ts';

const proc = (pid: number, uid: number, mb: number, ticks = 0, o: Partial<ProcessSnapshot> = {}): ProcessSnapshot => ({
  pid,
  uid,
  ppid: 1,
  sid: 1,
  comm: 'node',
  state: 'S',
  start: '100',
  memoryMb: mb,
  memoryMeasure: 'pss',
  ticks,
  nice: 0,
  ...o,
});
const group = (id: string, nice = 0, writable = true) => ({ group: { id, nice, writable } });
const opts = { mostMb: 2560, shareMb: 1536, cores: 4, processes: 400, starved: false, workerSessionId: 1 };
const launch = { pid: 10, start: '100' };

test("a uid's processes count together: its memory now, and its cores since the last look", () => {
  const before = [proc(10, 1501, 200, 1000), proc(11, 1501, 900, 500)];
  const now = [proc(10, 1501, 210, 1100), proc(11, 1501, 1800, 2500), proc(12, 1501, 50, 300), proc(20, 1502, 300, 50)];
  const uses = tally(now, before, 10_000);
  assert.equal(uses.get(1501)!.memoryMb, 2060);
  // 100 + 2000 + 300 (new: all its time) ticks in 10 s, at 100 a second
  assert.equal(uses.get(1501)!.cores, 2.4);
  assert.deepEqual(
    uses.get(1501)!.processes.map(p => p.cores),
    [0.1, 2, 0.3],
    'each process its own',
  );
  assert.equal(uses.get(1501)!.processes.length, 3);
  // a pid used again by a new process is a new process
  assert.equal(tally([proc(10, 1501, 1, 40, { start: '999' })], before, 1000).get(1501)!.cores, 0.4);
});

test('past its share a job has its heaviest run blocked, never its CLI; starved, the heaviest past the smaller share', () => {
  const uses = (a: ProcessSnapshot[]) => tally(a, a, 1000);
  const cli = new Set([10, 20]);
  const hog = uses([proc(10, 1501, 300), proc(11, 1501, 2400), proc(12, 1501, 100), proc(20, 1502, 1700)]);
  const block = overShare(hog, cli, opts).block!;
  assert.deepEqual([block.root.pid, block.measure, block.used, block.share], [11, 'memory', 2800, 2560]);
  assert.equal(overShare(uses([proc(10, 1501, 2700)]), cli, opts).block, undefined, 'only its CLI: nothing to block');
  const mid = uses([proc(10, 1501, 300), proc(11, 1501, 1400), proc(20, 1502, 200), proc(21, 1502, 1500)]);
  assert.equal(overShare(mid, cli, opts).block, undefined, 'under its share, and nobody waits');
  const starved = overShare(mid, cli, { ...opts, starved: true }).block!;
  assert.deepEqual([starved.root.pid, starved.share], [11, 1536], 'the job holding the most');
});

// The incident of 23 October: browsers under a tool's shell, each renderer small. Stopping the biggest process left the
// browser to open another page; the run is the shell's command, everything under it.
test('a run is the command the CLI started, with everything under it: the browser goes with all its pages', () => {
  const tree = [
    proc(10, 1501, 300, 0, { comm: 'claude' }),
    proc(30, 1501, 4, 0, { ppid: 10, comm: 'bash' }),
    proc(31, 1501, 250, 0, { ppid: 30, comm: 'node' }),
    proc(32, 1501, 400, 0, { ppid: 31, comm: 'chrome' }),
    ...[33, 34, 35, 36, 37].map(pid => proc(pid, 1501, 380, 0, { ppid: 32, comm: 'chrome' })),
    proc(40, 1501, 4, 0, { ppid: 10, comm: 'bash' }),
    proc(41, 1501, 600, 0, { ppid: 40, comm: 'tsc' }), // (the biggest process, in a smaller run)
    proc(50, 1501, 90, 0, { comm: 'node' }), // (left behind: its parent is none of the job's)
  ];
  const cli = cliProcesses(tree, launch);
  const runs = runsOf(tree, cli);
  assert.deepEqual(
    [...runs].map(([root, run]) => [root.pid, run.map(p => p.pid)]),
    [
      [30, [30, 31, 32, 33, 34, 35, 36, 37]],
      [40, [40, 41]],
      [50, [50]],
    ],
  );
  const block = overShare(tally(tree, tree, 1000), cli, opts).block!;
  assert.equal(block.root.pid, 30, 'the run holding the most, not the biggest process');
  assert.equal(block.run.length, 8);
  assert.ok(!block.run.some(p => p.pid === 10), 'never the CLI');
});

test('a job running too many processes has the run with the most blocked; one past the cores for long, its busiest', () => {
  const many = [
    proc(30, 1501, 4),
    ...Array.from({ length: 6 }, (_, i) => proc(31 + i, 1501, 10, 0, { ppid: 30 })),
    proc(40, 1501, 5),
  ];
  const crowded = overShare(tally(many, many, 1000), new Set(), { ...opts, processes: 5 }).block!;
  assert.deepEqual([crowded.root.pid, crowded.measure, crowded.used, crowded.share], [30, 'processes', 8, 5]);
  const before = [proc(30, 1501, 50, 0), proc(31, 1501, 50, 0, { ppid: 30 }), proc(40, 1501, 50, 0)];
  const now = [proc(30, 1501, 50, 10), proc(31, 1501, 50, 600, { ppid: 30 }), proc(40, 1501, 50, 100)];
  const uses = tally(now, before, 1000);
  assert.equal(overShare(uses, new Set(), opts).block, undefined, 'busy, not for long yet: slowed only');
  const hot = overShare(uses, new Set(), { ...opts, hot: new Set([1501]) }).block!;
  assert.deepEqual([hot.root.pid, hot.measure, hot.used, hot.share], [30, 'cores', 7.1, 4]);
});

test("a blocked run hears why in its own output, then ends: frozen first, its words before it's Killed", async () => {
  // (as Claude Code runs a command: its output to a file the tool reads back)
  const me = { uid: process.getuid!(), gid: process.getgid!() };
  const out = `${mkdtempSync(`${tmpdir()}/blocked-`)}/output`;
  writeFileSync(out, 'started\n');
  const fd = openSync(out, 'a');
  const run = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: ['ignore', fd, fd] });
  closeSync(fd);
  await new Promise(r => setTimeout(r, 300));
  const own = (await processesFor([me])).filter(p => p.pid === run.pid || p.ppid === run.pid);
  const root = own.find(p => p.pid === run.pid)!;
  assert.equal(commandOf(own), 'sleep 30', 'the program, not the shell around it');
  await stopRun(own, me, root, async () => ({ text: "HQ's worker stopped this command: offload it." }));
  const killed = await new Promise(r => run.on('close', (_code, sig) => r(sig)));
  assert.equal(killed, 'SIGKILL');
  assert.equal(readFileSync(out, 'utf8'), "started\n\nHQ's worker stopped this command: offload it.\n");
  assert.ok(
    own.every(p => !alive(p.pid, p.start)),
    'every process of it ended',
  );
});

test("a blocked run HQ can't be asked about still ends, and hears no words but HQ's", async () => {
  const me = { uid: process.getuid!(), gid: process.getgid!() };
  const out = `${mkdtempSync(`${tmpdir()}/blocked-`)}/output`;
  writeFileSync(out, 'started\n');
  const fd = openSync(out, 'a');
  const run = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: ['ignore', fd, fd] });
  closeSync(fd);
  await new Promise(r => setTimeout(r, 300));
  const own = (await processesFor([me])).filter(p => p.pid === run.pid || p.ppid === run.pid);
  const root = own.find(p => p.pid === run.pid)!;
  const away = new TypeError('fetch failed');
  await assert.rejects(
    stopRun(own, me, root, () => Promise.reject(away)),
    away,
    'the failure goes on to the shares loop',
  );
  assert.equal(await new Promise(r => run.on('close', (_code, sig) => r(sig))), 'SIGKILL', 'never left frozen');
  assert.equal(readFileSync(out, 'utf8'), 'started\n');
});

test("a job's push checks, run after its CLI has ended, are held to its share too", () => {
  const checks = [proc(30, 1503, 200, 0, { comm: 'nice' }), proc(31, 1503, 2900, 0, { ppid: 30 })];
  const uses = tally(checks, checks, 1000);
  const block = overShare(uses, cliProcesses(checks, { pid: 9, start: '100' }), opts).block!;
  assert.deepEqual(
    block.run.map(p => p.pid),
    [30, 31],
    'the checks, from their first process',
  );
});

test("a Node launcher's native agent is the CLI too; the commands it runs are not", () => {
  const codex = [
    proc(10, 1501, 60, 0, { comm: 'MainThread' }),
    proc(11, 1501, 1700, 0, { ppid: 10, comm: 'codex' }),
    proc(12, 1501, 40, 0, { ppid: 11, comm: 'codex-code-mode' }),
    proc(13, 1501, 5, 0, { ppid: 11, comm: 'bash' }),
    proc(14, 1501, 900, 0, { ppid: 13, comm: 'node' }),
    proc(15, 1501, 30, 0, { ppid: 13, comm: 'codex' }), // (a codex the agent ran itself: a command)
  ];
  const cli = cliProcesses(codex, launch);
  assert.deepEqual([...cli].sort(), [10, 11, 12]);
  assert.deepEqual(
    overShare(tally(codex, codex, 1000), cli, opts).block?.run.map(p => p.pid),
    [13, 14, 15],
  );
});

test("a job's CLI is the launch running now: a second launch is protected, a reused pid isn't", () => {
  const asked = [proc(40, 1501, 300, 0, { start: '500', comm: 'claude' }), proc(41, 1501, 2600, 0, { ppid: 40 })];
  assert.deepEqual([...cliProcesses(asked, launch)], [], 'the first launch has ended');
  assert.deepEqual([...cliProcesses(asked, { pid: 40, start: '500' })], [40]);
  const reused = [proc(10, 1501, 2700, 0, { start: '900' })];
  assert.equal(overShare(tally(reused, reused, 1000), cliProcesses(reused, launch), opts).block?.root.pid, 10);
});

test('an adopted job needs a CPU baseline before any of its processes are slowed', () => {
  const adopted = [proc(10, 1501, 200, 50_000), proc(11, 1501, 500, 120_000)];
  const cli = new Set([10]);
  for (const before of [[], [proc(20, 1502, 100, 100)]]) {
    const uses = tally(adopted, before, 15_000);
    assert.equal(uses.get(1501)!.memoryMb, 700, 'memory is reported immediately');
    assert.equal(uses.get(1501)!.cores, 0);
    assert.deepEqual(overShare(uses, cli, opts).slow, []);
  }
  const active = adopted.map(p => ({ ...p, ticks: p.ticks + 5000 }));
  assert.deepEqual(
    overShare(tally(active, adopted, 15_000), cli, opts).slow.map(p => p.pid),
    [11],
  );
});

test('a job past half the cores has its other processes niced, once', () => {
  const cli = new Set([10]);
  const before = [proc(10, 1501, 100, 0), proc(11, 1501, 500, 0), proc(12, 1501, 500, 0, { nice: 10 })];
  const now = [proc(10, 1501, 100, 100), proc(11, 1501, 500, 400, { sid: 77 }), proc(12, 1501, 500, 400, { nice: 10 })];
  assert.deepEqual(
    overShare(tally(now, before, 1000), cli, opts).slow.map(p => p.pid),
    [11],
  );
  assert.deepEqual(overShare(tally(now, now, 1000), cli, opts).slow, [], 'idle: left as it is');
});

test("a busy job's session groups are slowed one process each, until their own nice is 10, never the worker's", () => {
  const before = [
    proc(10, 1501, 100),
    proc(11, 1501, 100),
    proc(12, 1501, 100),
    proc(13, 1501, 100),
    proc(14, 1501, 100),
  ];
  const now = [
    proc(10, 1501, 100, 100, group('1')),
    proc(11, 1501, 100, 300, { sid: 77, nice: 10, ...group('5') }), // (its process niced, its group's change refused)
    proc(12, 1501, 100, 300, { sid: 77, ...group('5') }),
    proc(13, 1501, 100, 300, group('1')), // (a command in the worker's session)
    proc(14, 1501, 100, 300, { sid: 78, ...group('6', 10) }),
  ];
  const { slow, groups } = overShare(tally(now, before, 1000), new Set([10]), opts);
  assert.deepEqual(
    slow.map(p => p.pid),
    [12, 13, 14],
  );
  assert.deepEqual(
    groups.map(p => p.group!.id),
    ['5'],
  );
});

test('a pending group is slowed though its job is idle now, through a process its slot may write for', () => {
  const idle = [
    proc(11, 1501, 100, 0, { sid: 77, ...group('5') }),
    proc(12, 1501, 100, 0, { sid: 77, ...group('5', 0, false) }), // (nondumpable: its group file is root's)
    proc(13, 1501, 100, 0, { sid: 78, ...group('6', 10) }),
    proc(14, 1501, 100, 0, { sid: 79, ...group('7') }),
  ];
  const look = (pending: string[]) => overShare(tally(idle, idle, 1000), new Set(), opts, new Set(pending)).groups;
  assert.deepEqual(
    look(['5', '6', '9']).map(p => p.pid),
    [11],
    'at nice 10 or gone: no longer pending',
  );
  assert.deepEqual(look([]), [], 'nothing pending, nothing busy');
  assert.deepEqual(look(['1']), [], "never the worker's");
});

test('a pending group none of whose processes its slot may write for now stays pending, until one may', () => {
  const idle = (writable: boolean) => [proc(12, 1501, 100, 0, { sid: 77, ...group('5', 0, writable) })];
  const look = (writable: boolean, pending: Set<string>) =>
    overShare(tally(idle(writable), idle(writable), 1000), new Set(), opts, pending);
  const hidden = look(false, new Set(['5', '9']));
  assert.deepEqual(hidden.groups, [], 'nothing it may write through');
  assert.deepEqual([...hidden.pending], ['5'], 'still there and below nice 10: kept; gone: dropped');
  assert.deepEqual(
    look(true, hidden.pending).groups.map(p => p.pid),
    [12],
  );
});

test('a process that hides its memory map still counts, by what it holds, and keeps its place in the CLI', async () => {
  // The launch forks a sandbox that makes itself nondumpable (its PSS is then closed to its own uid too) and holds
  // 16 MB of its own and 16 MB of a temporary file it maps, and the sandbox forks the agent
  const launched = spawn('python3', [
    '-c',
    [
      'import ctypes, mmap, os, tempfile, time',
      'libc = ctypes.CDLL(None)',
      'if os.fork() == 0:',
      "  libc.prctl(15, b'codex-linux-san'); libc.prctl(4, 0)",
      '  b = bytearray(16 << 20)',
      '  for i in range(0, len(b), 4096): b[i] = 1',
      '  f = tempfile.TemporaryFile(); f.truncate(16 << 20); m = mmap.mmap(f.fileno(), 16 << 20)',
      '  for i in range(0, len(m), 4096): m[i] = 1',
      "  if os.fork() == 0: libc.prctl(15, b'codex')",
      'time.sleep(30)',
    ].join('\n'),
  ]);
  await new Promise(r => setTimeout(r, 1500));
  const me = { uid: process.getuid!(), gid: process.getgid!() };
  const procs = await processesFor([me]);
  const sandbox = procs.find(p => p.ppid === launched.pid);
  const agent = sandbox && procs.find(p => p.ppid === sandbox.pid);
  try {
    assert.ok(sandbox && agent, 'both are listed');
    assert.equal(sandbox.memoryMeasure, 'rss');
    assert.ok(sandbox.memoryMb >= 32, `its 16 MB and the file's counted (${Math.round(sandbox.memoryMb)} MB)`);
    const launch = { pid: launched.pid!, start: procStat(launched.pid!)!.start };
    assert.deepEqual([...cliProcesses(procs, launch)].sort(), [launched.pid, sandbox.pid, agent.pid].sort());
  } finally {
    for (const p of [agent, sandbox]) if (p) process.kill(p.pid);
    launched.kill();
  }
});

test("each of a busy job's sessions gets its group slowed, a refused one at the next look", async () => {
  const sessions = [0, 1, 2].map(() => spawn('sleep', ['30'], { detached: true }));
  await new Promise(r => setTimeout(r, 500));
  const me = { uid: process.getuid!(), gid: process.getgid!() };
  const pids = new Set(sessions.map(s => s.pid));
  const look = async () => {
    const pair = (await processesFor([me])).filter(p => p.pid !== sessions[2].pid && pids.has(p.pid));
    const busy = pair.map(p => ({ ...p, ticks: p.ticks - 500 }));
    return overShare(tally(pair, busy, 1000), new Set(), { ...opts, workerSessionId: procStat(process.pid)!.sid });
  };
  try {
    const first = await look();
    assert.equal(first.groups.length, 2, 'one group per session');
    // Another session's change just now: the kernel refuses the next one for 100 ms
    try {
      writeFileSync(`/proc/${sessions[2].pid}/autogroup`, '10');
    } catch {
      /* the limit was already taken */
    }
    await slowDown([me], first.slow, first.groups);
    const second = await look();
    assert.deepEqual(second.slow, [], 'the processes are niced');
    await slowDown([me], second.slow, second.groups);
    assert.deepEqual((await look()).groups, [], 'both groups are at nice 10');
  } finally {
    for (const s of sessions) s.kill();
  }
});

test("a session's group is slowed through its leader when the last of it is nondumpable", async () => {
  const session = spawn(
    'python3',
    ['-c', 'import ctypes, os, time\nif os.fork() == 0: ctypes.CDLL(None).prctl(4, 0)\ntime.sleep(30)'],
    { detached: true },
  );
  await new Promise(r => setTimeout(r, 1000));
  const me = { uid: process.getuid!(), gid: process.getgid!() };
  const look = async () => {
    const own = (await processesFor([me])).filter(p => p.pid === session.pid || p.ppid === session.pid);
    const busy = own.map(p => ({ ...p, ticks: p.ticks - 500 }));
    return {
      own,
      ...overShare(tally(own, busy, 1000), new Set(), { ...opts, workerSessionId: procStat(process.pid)!.sid }),
    };
  };
  try {
    const { own, slow, groups } = await look();
    assert.equal(own.length, 2);
    assert.deepEqual(
      groups.map(p => p.pid),
      [session.pid],
    );
    await slowDown([me], slow, groups);
    assert.ok(
      (await look()).own.every(p => p.group?.nice === 10),
      'the group is at nice 10',
    );
  } finally {
    for (const p of (await processesFor([me])).filter(p => p.ppid === session.pid)) process.kill(p.pid);
    session.kill();
  }
});

test('a group refused while its job was busy is slowed at the next look, the job idle by then', async () => {
  const [busy, other] = [0, 1].map(() => spawn('sleep', ['30'], { detached: true }));
  await new Promise(r => setTimeout(r, 500));
  const me = { uid: process.getuid!(), gid: process.getgid!() };
  const session = procStat(process.pid)!.sid;
  const look = async (cpu: number, pending?: Set<string>) => {
    const own = (await processesFor([me])).filter(p => p.pid === busy.pid);
    const before = own.map(p => ({ ...p, ticks: p.ticks - cpu }));
    return { own, ...overShare(tally(own, before, 1000), new Set(), { ...opts, workerSessionId: session }, pending) };
  };
  try {
    const first = await look(500);
    assert.equal(first.groups.length, 1);
    // Another session's change just now: the kernel refuses this one (EAGAIN)
    for (let taken = false; !taken;)
      try {
        writeFileSync(`/proc/${other.pid}/autogroup`, '10');
        taken = true;
      } catch {
        await new Promise(r => setTimeout(r, 20));
      }
    await slowDown([me], [], first.groups);
    const second = await look(0, new Set(first.groups.map(p => p.group!.id)));
    assert.equal(second.own[0].group?.nice, 0, 'refused');
    assert.deepEqual(second.slow, [], 'below the threshold now');
    assert.equal(second.groups.length, 1, 'still pending');
    await slowDown([me], second.slow, second.groups);
    assert.equal((await look(0)).own[0].group?.nice, 10);
  } finally {
    for (const s of [busy, other]) s.kill();
  }
});

test('a group refused, then nondumpable for a look while its job is idle, is slowed once it may be written again', async () => {
  // a session of one process that hides its /proc files on SIGUSR1 (nondumpable: they're root's) and shows them on SIGUSR2
  const hider = spawn(
    'python3',
    [
      '-c',
      'import ctypes, signal, time\nset = lambda on: lambda *_: ctypes.CDLL(None).prctl(4, on)\n' +
        'signal.signal(signal.SIGUSR1, set(0)); signal.signal(signal.SIGUSR2, set(1))\ntime.sleep(30)',
    ],
    { detached: true },
  );
  const other = spawn('sleep', ['30'], { detached: true });
  await new Promise(r => setTimeout(r, 1000));
  const me = { uid: process.getuid!(), gid: process.getgid!() };
  const session = procStat(process.pid)!.sid;
  const look = async (cpu: number, pending?: Set<string>) => {
    const own = (await processesFor([me])).filter(p => p.pid === hider.pid);
    const before = own.map(p => ({ ...p, ticks: p.ticks - cpu }));
    return { own, ...overShare(tally(own, before, 1000), new Set(), { ...opts, workerSessionId: session }, pending) };
  };
  try {
    const first = await look(500);
    assert.equal(first.groups.length, 1);
    // Another session's change just now: the kernel refuses this one (EAGAIN)
    for (let taken = false; !taken;)
      try {
        writeFileSync(`/proc/${other.pid}/autogroup`, '10');
        taken = true;
      } catch {
        await new Promise(r => setTimeout(r, 20));
      }
    await slowDown([me], [], first.groups);
    hider.kill('SIGUSR1');
    await new Promise(r => setTimeout(r, 200));
    const hidden = await look(0, first.pending);
    assert.equal(hidden.own[0].group?.writable, false, 'nondumpable now');
    assert.deepEqual(hidden.groups, [], 'nothing its slot may write through');
    assert.equal(hidden.pending.size, 1, 'still pending');
    hider.kill('SIGUSR2');
    await new Promise(r => setTimeout(r, 200));
    const shown = await look(0, hidden.pending);
    assert.equal(shown.own[0].group?.nice, 0, 'never slowed meanwhile');
    assert.equal(shown.groups.length, 1, 'picked again');
    await slowDown([me], shown.slow, shown.groups);
    const done = await look(0, shown.pending);
    assert.equal(done.own[0].group?.nice, 10);
    assert.equal(done.pending.size, 0, 'at nice 10: no longer pending');
  } finally {
    for (const s of [hider, other]) s.kill();
  }
});

test('a snapshot has only the jobs asked for, and memory a fork shares counts once', async () => {
  // 64 MB written, then forked: each process maps all of it, and holds half
  const forked = spawn('python3', [
    '-c',
    'import os, time\nb = bytearray(64 << 20)\nfor i in range(0, len(b), 4096): b[i] = 1\nos.fork()\ntime.sleep(30)',
  ]);
  await new Promise(r => setTimeout(r, 1500));
  const me = { uid: process.getuid!(), gid: process.getgid!() };
  const pair = (await processesFor([me])).filter(p => p.pid === forked.pid || p.ppid === forked.pid);
  try {
    assert.equal(pair.length, 2);
    const total = pair.reduce((mb, p) => mb + p.memoryMb, 0);
    assert.ok(total > 60 && total < 110, `the 64 MB counted once (${Math.round(total)} MB in all)`);
    assert.equal((await processesFor([{ uid: 65_000, gid: 65_000 }])).length, 0);
  } finally {
    for (const p of pair) process.kill(p.pid);
  }
});
