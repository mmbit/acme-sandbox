// Freeze a blocked run, relay HQ's report and end its processes before reclaiming staging.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { WRAPPERS, procStat, processesOfUids } from './detached.ts';
import { removeBundles } from './bundles.ts';
import { redact } from './safety.ts';
import type { ProcessSnapshot } from './shares.ts';
import type { Ids } from './slots.ts';

export const PLAIN_ENV = { PATH: '/usr/bin:/bin' }; // (a slot's command gets nothing of the worker's environment)

// A blocked run's processes, each still the one looked at, sent the signal: SIGSTOP freezes it (it neither grows nor
// starts anything), SIGKILL ends it
export function signal(run: { pid: number; start: string }[], name: NodeJS.Signals) {
  for (const p of run)
    try {
      if (procStat(p.pid)?.start === p.start) process.kill(p.pid, name);
    } catch {
      /* ended meanwhile */
    }
}

// A blocked run: frozen while HQ is asked for its words (ask: the coordinator's blocks.ts), told them in its own output,
// then ended. An ask that fails still ends the run, never leaving it frozen, and goes on to the caller: the run hears
// no words but HQ's. A run that couldn't be frozen whole is ended all the same, and said (the worker's log).
export async function stopRun(
  run: ProcessSnapshot[],
  ids: Required<Ids>,
  root: { pid: number },
  ask: () => Promise<{ text: string }>,
  log: (words: string) => void,
  tmpdir?: string,
) {
  const frozen: { pid: number; start: string }[] = [...run];
  const failures: unknown[] = [];
  try {
    const left = await freeze(frozen, ids.uid);
    if (left)
      log(
        `run ${root.pid} not wholly frozen after ${FREEZE_MS} ms (${left.rounds} rounds): ` +
          `${pidWords(left.stopping)} still stopping, ${pidWords(left.forking)} still forking`,
      );
    await tellRun(ids, root, (await ask()).text);
  } catch (error) {
    failures.push(error);
  } finally {
    signal(frozen, 'SIGKILL');
  }
  if (tmpdir)
    try {
      await removeBundles(ids, tmpdir, frozen);
    } catch (error) {
      failures.push(error);
    }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Run stop and bundle cleanup failed');
}

// The run frozen as it is now, not as the look saw it: a disk stop comes after the look's scan, seconds on, and a test
// runner starts a file's process every few seconds meanwhile. One left out outlives the stop and writes on into the tests'
// folder as the worker removes it ("Directory not empty"). So each round freezes the uid's
// processes under a frozen one, until every frozen one has stopped (one stopping can still finish a fork) and a round
// finds none new. A process stops on its next way out of the kernel, a scheduler tick or so (a few ms) after its signal,
// so a round waits FREEZE_ROUND_MS. One still running FREEZE_MS on, hundreds of ticks, waits in the kernel where no
// signal but a kill reaches it (state D: a write stalled on the very disk the stop is for, or a vfork's parent), and
// every other job's look waits behind this one (the worker's shares loop): the freeze gives up, saying what it left.
const FREEZE_MS = 1_000,
  FREEZE_ROUND_MS = 10;
async function freeze(frozen: { pid: number; start: string }[], uid: number) {
  signal(frozen, 'SIGSTOP');
  const end = Date.now() + FREEZE_MS;
  for (let rounds = 1; ; rounds++) {
    const pids = new Set(frozen.filter(p => procStat(p.pid)?.start === p.start).map(p => p.pid)); // (a pid used again: none of it)
    const fresh = processesOfUids(new Set([uid])).filter(p => pids.has(p.ppid) && !frozen.some(f => f.pid === p.pid));
    const stopping = frozen.filter(p => {
      const now = procStat(p.pid);
      return now?.start === p.start && !['T', 't', 'Z'].includes(now.state);
    });
    if (!fresh.length && !stopping.length) return undefined;
    signal(fresh, 'SIGSTOP');
    frozen.push(...fresh);
    if (Date.now() >= end) return { rounds, stopping: stopping.map(p => p.pid), forking: fresh.map(p => p.ppid) };
    await new Promise(r => setTimeout(r, FREEZE_ROUND_MS));
  }
}
const pidWords = (pids: number[]) => (pids.length ? `pids ${[...new Set(pids)].join(', ')}` : 'none');

// The command the agent ran, as the words about its block name it: the run's first program that isn't a shell (a tool's
// bash -c around it says nothing). HQ redacts full saved secret values before shortening it for the run output.
export function commandOf(run: ProcessSnapshot[]) {
  const named = run.find(p => !WRAPPERS.has(p.comm)) ?? run[0];
  try {
    const args = readFileSync(`/proc/${named.pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    return redact(args) || named.comm;
  } catch {
    return named.comm;
  }
}

// The words about a block go where the agent reads its command's end: the run's first process's stderr (what its tool
// returns), opened as the job's own user and appended to (root opening another's descriptor could write where the job may
// not). A run whose stderr isn't there to open (closed, a socket) loses them; HQ's log keeps them.
export function tellRun(ids: Required<Ids>, root: { pid: number }, words: string) {
  return new Promise<boolean>(resolve => {
    const c = spawn('sh', ['-c', 'cat >> "/proc/$1/fd/2"', 'sh', String(root.pid)], {
      ...ids,
      env: PLAIN_ENV,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 5_000,
    });
    c.on('error', () => resolve(false));
    c.on('close', code => resolve(code === 0));
    c.stdin.on('error', () => {});
    c.stdin.end(`\n${words}\n`);
  });
}
