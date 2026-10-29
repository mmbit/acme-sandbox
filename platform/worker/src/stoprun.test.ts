// node --test src/stoprun.test.ts
// A blocked run's stop: frozen whole, told why in its own output, then ended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { alive, procStat, processesOfUids } from './detached.ts';
import { processesFor } from './shares.ts';
import { commandOf, stopRun } from './stoprun.ts';

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
  await stopRun(
    own,
    me,
    root,
    async () => ({ text: "HQ's worker stopped this command: offload it." }),
    () => {},
  );
  const killed = await new Promise(r => run.on('close', (_code, sig) => r(sig)));
  assert.equal(killed, 'SIGKILL');
  assert.equal(readFileSync(out, 'utf8'), "started\n\nHQ's worker stopped this command: offload it.\n");
  assert.ok(
    own.every(p => !alive(p.pid, p.start)),
    'every process of it ended',
  );
});

test('a blocked run ends with what it started after the look: nothing of it writes on', async () => {
  // (a test runner starting a file's process every few seconds; the disk stop comes seconds after its look)
  const me = { uid: process.getuid!(), gid: process.getgid!() };
  const nap = `${30 + Math.random()}`.slice(0, 8);
  const run = spawn('sh', ['-c', `while :; do sleep ${nap} & sleep 0.02; done`], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 100));
  const looked = (await processesFor([me])).filter(p => p.pid === run.pid || p.ppid === run.pid);
  await new Promise(r => setTimeout(r, 300));
  const root = looked.find(p => p.pid === run.pid)!;
  const said: string[] = [];
  await stopRun(
    looked,
    me,
    root,
    async () => ({ text: 'stopped' }),
    words => said.push(words),
  );
  assert.deepEqual(said, [], 'frozen whole');
  await new Promise(r => run.on('close', r));
  await new Promise(r => setTimeout(r, 100));
  const napping = processesOfUids(new Set([me.uid])).filter(p => {
    try {
      return readFileSync(`/proc/${p.pid}/cmdline`, 'utf8') === `sleep\0${nap}\0`;
    } catch {
      return false;
    }
  });
  for (const p of napping) process.kill(p.pid, 'SIGKILL');
  assert.equal(napping.length, 0, 'every process started since the look ended too');
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
    stopRun(
      own,
      me,
      root,
      () => Promise.reject(away),
      () => {},
    ),
    away,
    'the failure goes on to the shares loop',
  );
  assert.equal(await new Promise(r => run.on('close', (_code, sig) => r(sig))), 'SIGKILL', 'never left frozen');
  assert.equal(readFileSync(out, 'utf8'), 'started\n');
});

test("a run that can't be frozen whole is said so, and ended all the same", async () => {
  // (a vfork's parent waits in the kernel, state D, where SIGSTOP never reaches it; its child is frozen, so it waits on)
  const me = { uid: process.getuid!(), gid: process.getgid!() };
  const run = spawn('python3', ['-c', 'import ctypes\nlibc = ctypes.CDLL(None)\nif libc.vfork() == 0: libc.pause()'], {
    stdio: 'ignore',
  });
  await new Promise(r => setTimeout(r, 300));
  const own = (await processesFor([me])).filter(p => p.pid === run.pid);
  assert.equal(procStat(run.pid!)?.state, 'D', 'the parent waits on its vfork');
  const said: string[] = [];
  const started = Date.now();
  await stopRun(
    own,
    me,
    own[0],
    async () => ({ text: 'stopped' }),
    words => said.push(words),
  );
  assert.ok(Date.now() - started >= 1_000, 'the freeze waited out its time');
  assert.equal(said.length, 1);
  assert.match(
    said[0],
    new RegExp(`^run ${run.pid} not wholly frozen after 1000 ms \\(\\d+ rounds\\): pids ${run.pid} still stopping`),
  );
  assert.equal(await new Promise(r => run.on('close', (_code, sig) => r(sig))), 'SIGKILL', 'ended all the same');
});
