// Each job's share of the worker. Every job runs in the one container, under one
// memory cap (infra/compose.yaml), and a slot starts a job only while enough of it is free (worker.ts room).
// The container's cgroup is read-only inside it, so a job can't have one of its own. Its share is kept here instead.
// Everything a job runs uses its slot's uid (slots.ts): its CLI, commands, background processes and its push's checks.
// A uid's processes in /proc are therefore the job's, counted together.
// A job past its share has its heavy run blocked: the command its CLI started that holds the most of what it's past, with
// everything under it (runsOf), never the CLI. The worker tells the job's agent in that command's own output where to run
// it instead (worker.ts blockRun, the coordinator's blocks.ts). One run per look, so it goes on only while it's still past.
// - Memory: a job past mostMb in all, and the job holding the most past shareMb while the worker is starved (no slot
//   could start long enough, and work is waiting).
// - Processes: a job with more than `processes` of them.
// - CPU: a job's processes using more than half the cores get nice 10, and their sessions' groups too (the kernel shares
//   the CPU between sessions first: sched_autogroup), so the others' come first. Renicing another uid's process takes
//   CAP_SYS_NICE, which the container hasn't got, so it runs as the slot's uid: lowering one's own priority needs nothing.
//   A group asked for stays pending, busy or not, until it's at nice 10 or gone. A job past the cores for long (`hot`,
//   the worker's count) has its busiest run blocked.
import { execFile, spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import type { Ids } from './slots.ts';
import { CLI_PROGRAMS, WRAPPERS, procStat, processesOfUids, type ProcStat } from './detached.ts';
import { redact } from './safety.ts';

// memoryMb: its proportional share of mapped memory (PSS), or resident memory (RSS) when PSS cannot be read.
// memoryMeasure identifies which measure was available. RSS counts shared memory in full.
// group: its session's group (sched_autogroup), when the kernel has them.
type MemoryMeasure = 'pss' | 'rss';
export type ProcessSnapshot = ProcStat & {
  pid: number;
  uid: number;
  memoryMb: number;
  memoryMeasure: MemoryMeasure;
  rssMb?: number;
  group?: Autogroup;
  cores?: number; // (the cores it used since the look before, in a job's use: tally)
};
// writable: its slot may change the group through this process (a nondumpable process's /proc files are root's)
type Autogroup = { id: string; nice: number; writable: boolean };
export type JobUse = { uid: number; memoryMb: number; cores: number; processes: ProcessSnapshot[] };

const CPU_TICKS_PER_SECOND = 100; // clock ticks a second (getconf CLK_TCK)
const PLAIN_ENV = { PATH: '/usr/bin:/bin' }; // (a slot's command gets nothing of the worker's environment)

// The processes of these jobs (each by its slot's ids) as /proc has them now. A page shared by n processes counts 1/n
// in each one's PSS, so a job's processes add up to what it really holds: forked workers share most of theirs.
export async function processesFor(jobs: Required<Ids>[]): Promise<ProcessSnapshot[]> {
  const stats = processesOfUids(new Set(jobs.map(j => j.uid)));
  const read = await Promise.all(
    jobs.map(ids =>
      pssOf(
        stats.filter(p => p.uid === ids.uid).map(p => p.pid),
        ids,
      ),
    ),
  );
  const pss = new Map(read.flatMap(m => [...m]));
  return stats.flatMap(p => {
    const rssMb = residentOf(p),
      memoryMb = pss.get(p.pid) ?? rssMb;
    if (memoryMb === undefined) return [];
    return [
      {
        ...p,
        rssMb,
        memoryMb,
        memoryMeasure: pss.has(p.pid) ? ('pss' as const) : ('rss' as const),
        group: autogroupOf(p),
      },
    ];
  });
}

// Each process's PSS in MB. Only its own uid may read it (the worker has no CAP_SYS_PTRACE), so it's read as the job's
// slot, with nothing of the worker's environment. grep goes on past a file it can't read (exit 2).
function pssOf(pids: number[], ids: Required<Ids>) {
  if (!pids.length) return Promise.resolve(new Map<number, number>());
  const files = pids.map(pid => `/proc/${pid}/smaps_rollup`);
  const options = { ...ids, env: PLAIN_ENV, timeout: 10_000 };
  return new Promise<Map<number, number>>((resolve, reject) =>
    execFile('grep', ['-H', '^Pss:', ...files], options, (err, stdout) => {
      if (err && typeof err.code !== 'number') return reject(err);
      const rows = stdout.matchAll(/^\/proc\/(\d+)\/smaps_rollup:Pss:\s+(\d+) kB$/gm);
      resolve(new Map([...rows].map(m => [Number(m[1]), Number(m[2]) / 1024])));
    }),
  );
}

// A process whose PSS its own uid can't read either: one that made itself nondumpable (a sandbox does), or one that has
// ended. Its status is open to all: the memory it holds resident in MB (anonymous, shared and mapped files, what it
// shares counted in full), or undefined once it has ended.
function residentOf(p: ProcStat & { pid: number }) {
  let status: string;
  try {
    status = readFileSync(`/proc/${p.pid}/status`, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ESRCH')
      return undefined;
    throw err;
  }
  if (procStat(p.pid)?.start !== p.start) return undefined;
  const kb = (field: string) => Number(status.match(new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm'))?.[1] ?? 0);
  // (a process exiting meanwhile has no memory left, and no lines for it)
  return kb('VmRSS') / 1024;
}

function autogroupOf(p: { pid: number; uid: number }): Autogroup | undefined {
  try {
    const file = `/proc/${p.pid}/autogroup`;
    const [, id, nice] = readFileSync(file, 'utf8').match(/^\/autogroup-(\d+) nice (-?\d+)/) ?? [];
    return id ? { id, nice: Number(nice), writable: statSync(file).uid === p.uid } : undefined;
  } catch {
    return undefined; /* no session groups in this kernel, or the process has ended */
  }
}

// Each uid's memory now, and the cores its processes used since the look before (ms earlier)
export function tally(now: ProcessSnapshot[], before: ProcessSnapshot[], ms: number) {
  const had = new Map(before.map(p => [`${p.pid}:${p.start}`, p.ticks]));
  const sampledUids = new Set(before.map(p => p.uid));
  const uses = new Map<number, JobUse>();
  for (const p of now) {
    const u = uses.get(p.uid) ?? { uid: p.uid, memoryMb: 0, cores: 0, processes: [] };
    u.memoryMb += p.memoryMb;
    // A newly observed job may be adopted with hours of CPU time. Its first snapshot is the baseline.
    const cores = sampledUids.has(p.uid)
      ? (p.ticks - (had.get(`${p.pid}:${p.start}`) ?? 0)) / CPU_TICKS_PER_SECOND / (ms / 1000)
      : 0;
    u.cores += cores;
    u.processes.push({ ...p, cores });
    uses.set(p.uid, u);
  }
  return uses;
}

// A job's CLI as /proc has it now: the launch running (pid and start) and, under it, the CLI's own programs (a Node
// launcher's native agent and that agent's helpers), never the commands they run. Empty once the launch has ended.
export function cliProcesses(processes: ProcessSnapshot[], launch: { pid: number; start: string }) {
  const own = new Set<number>();
  if (!processes.some(p => p.pid === launch.pid && p.start === launch.start)) return own;
  own.add(launch.pid);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of processes)
      if (!own.has(p.pid) && own.has(p.ppid) && CLI_PROGRAMS.has(p.comm)) {
        own.add(p.pid);
        grew = true;
      }
  }
  return own;
}

// What a run is blocked for: its job's memory (MB), its number of processes, or its cores kept up past the share.
export type Measure = 'memory' | 'processes' | 'cores';
// A run to block: its job (uid), what the job is past (its use and its share, in the measure's unit), and the run: its
// first process (root, the command the CLI started) and every process under it.
export type Block = {
  uid: number;
  measure: Measure;
  used: number;
  share: number;
  root: ProcessSnapshot;
  run: ProcessSnapshot[];
};

// A job's runs, each by its first process: a command its CLI started (its parent is the CLI's, or none of the job's
// processes: a push's checks, run after the CLI has ended, or one left behind) with every process under it, the first
// one first. The CLI's own processes are in none.
export function runsOf(processes: ProcessSnapshot[], cli: Set<number>) {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const rootOf = (p: ProcessSnapshot) => {
    const seen = new Set([p.pid]);
    let root = p;
    for (let up = byPid.get(root.ppid); up && !cli.has(up.pid) && !seen.has(up.pid); up = byPid.get(up.ppid)) {
      seen.add(up.pid);
      root = up;
    }
    return root;
  };
  const runs = new Map<ProcessSnapshot, ProcessSnapshot[]>();
  for (const p of processes) {
    if (cli.has(p.pid)) continue;
    const root = rootOf(p);
    if (!runs.has(root)) runs.set(root, [root]);
    if (p !== root) runs.get(root)!.push(p);
  }
  return runs;
}

// Select the run to block, the processes to slow down, and one writable process per session group to slow down.
// Busy jobs' groups stay pending until they reach nice 10 or disappear, even after the job stops being busy.
// Each job's use counts its push checks too. cli contains process ids that are never stopped or slowed.
// starved means work has waited for memory past the worker's grace period. Its own session group is left alone.
// hot: the jobs (uids) whose processes have used more than `cores` for long. Memory comes first, then processes, then
// cores: the run blocked is the one holding the most of it.
export function overShare(
  uses: Map<number, JobUse>,
  cli: Set<number>,
  limits: {
    mostMb: number;
    shareMb: number;
    cores: number;
    processes: number;
    starved: boolean;
    hot?: Set<number>;
    workerSessionId: number;
  },
  pending = new Set<string>(),
) {
  const jobs = [...uses.values()];
  const others = (u: JobUse) => u.processes.filter(p => !cli.has(p.pid));
  const blockOf = (u: JobUse, measure: Measure, used: number, share: number, weigh: (p: ProcessSnapshot) => number) => {
    const weight = (run: ProcessSnapshot[]) => run.reduce((sum, p) => sum + weigh(p), 0);
    const [root, run] = [...runsOf(u.processes, cli)].sort((a, b) => weight(b[1]) - weight(a[1]))[0];
    return { uid: u.uid, measure, used, share, root, run };
  };
  const heaviestPast = (memoryMb: number) =>
    jobs.filter(u => u.memoryMb > memoryMb && others(u).length).sort((a, b) => b.memoryMb - a.memoryMb)[0];
  const memory = heaviestPast(limits.mostMb) ?? (limits.starved ? heaviestPast(limits.shareMb) : undefined);
  const crowded = jobs.find(u => others(u).length > limits.processes);
  const hot = jobs.find(u => limits.hot?.has(u.uid) && others(u).length);
  const block: Block | undefined = memory
    ? blockOf(
        memory,
        'memory',
        memory.memoryMb,
        memory.memoryMb > limits.mostMb ? limits.mostMb : limits.shareMb,
        p => p.memoryMb,
      )
    : crowded
      ? blockOf(crowded, 'processes', others(crowded).length, limits.processes, () => 1)
      : hot
        ? blockOf(hot, 'cores', hot.cores, limits.cores, p => p.cores ?? 0)
        : undefined;
  const busy = jobs.filter(u => u.cores > limits.cores).flatMap(others);
  const slow = busy.filter(p => p.nice < 10);
  const wanted = new Set([...pending, ...busy.flatMap(p => (p.group ? [p.group.id] : []))]);
  const members = jobs
    .flatMap(others)
    .filter(p => p.group && wanted.has(p.group.id) && p.group.nice < 10 && p.sid !== limits.workerSessionId);
  // (through a process of the group its slot may write for: a nondumpable one's is root's. A group none of whose
  // processes it may write for now stays pending, for a look when one may.)
  const groups = [...new Map(members.filter(p => p.group!.writable).map(p => [p.group!.id, p])).values()];
  return { block, slow, groups, pending: new Set(members.map(p => p.group!.id)) };
}

// Lowers the priority of what overShare picked, as each process's slot. The kernel takes one group's change in 100 ms
// from a process without CAP_SYS_ADMIN, machine-wide, and refuses the others (EAGAIN). So the groups go one at a time,
// GROUP_GAP_MS apart across calls, and a refused one stays below nice 10 for the next look to pick again (pending). Each
// process is looked at again first: one ended, or moved to a session of its own, is left to the next look too.
export async function slowDown(jobs: Required<Ids>[], slow: ProcessSnapshot[], groups: ProcessSnapshot[]) {
  for (const ids of jobs) {
    const pids = slow.filter(p => p.uid === ids.uid).map(p => String(p.pid));
    if (pids.length) await runAsSlot(ids, 'renice', ['-n', '10', '-p', ...pids]);
  }
  for (const p of groups) {
    const ids = jobs.find(j => j.uid === p.uid);
    if (!ids || procStat(p.pid)?.start !== p.start || autogroupOf(p)?.id !== p.group!.id) continue;
    await new Promise(r => setTimeout(r, Math.max(0, groupChangedAt + GROUP_GAP_MS - Date.now())));
    await runAsSlot(ids, 'sh', ['-c', 'echo 10 > "/proc/$1/autogroup"', 'sh', String(p.pid)]);
    groupChangedAt = Date.now();
  }
}
const GROUP_GAP_MS = 120;
let groupChangedAt = 0;
// (a process gone meanwhile is skipped, and a group refused is picked again: neither needs an answer)
const runAsSlot = (ids: Required<Ids>, cmd: string, args: string[]) =>
  new Promise<void>(resolve => execFile(cmd, args, { ...ids, env: PLAIN_ENV, timeout: 10_000 }, () => resolve()));

// A blocked run's processes, each still the one looked at, sent the signal: SIGSTOP freezes it (it neither grows nor
// starts anything), SIGKILL ends it
export function signal(run: ProcessSnapshot[], name: NodeJS.Signals) {
  for (const p of run)
    try {
      if (procStat(p.pid)?.start === p.start) process.kill(p.pid, name);
    } catch {
      /* ended meanwhile */
    }
}

// A blocked run: frozen while HQ is asked for its words (ask: the coordinator's blocks.ts), told them in its own output,
// then ended. An ask that fails still ends the run, never leaving it frozen, and goes on to the caller: the run hears
// no words but HQ's.
export async function stopRun(
  run: ProcessSnapshot[],
  ids: Required<Ids>,
  root: { pid: number },
  ask: () => Promise<{ text: string }>,
) {
  signal(run, 'SIGSTOP');
  try {
    await tellRun(ids, root, (await ask()).text);
  } finally {
    signal(run, 'SIGKILL');
  }
}

// The command the agent ran, as the words about its block name it: the run's first program that isn't a shell (a tool's
// bash -c around it says nothing), its arguments redacted (a command line can hold a token) and cut short.
export function commandOf(run: ProcessSnapshot[]) {
  const named = run.find(p => !WRAPPERS.has(p.comm)) ?? run[0];
  try {
    const args = readFileSync(`/proc/${named.pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    return redact(args).slice(0, COMMAND_SHOWN) || named.comm;
  } catch {
    return named.comm;
  }
}
const COMMAND_SHOWN = 300;

// The words about a block go where the agent reads its command's end: the run's first process's stderr (what its tool
// returns), opened as the job's own user and appended to (root opening another's descriptor could write where the job may
// not). A run whose stderr isn't there to open (closed, a socket) loses them; HQ's log keeps them.
export function tellRun(ids: Required<Ids>, root: { pid: number }, words: string) {
  return new Promise<void>(resolve => {
    const c = spawn('sh', ['-c', 'cat >> "/proc/$1/fd/2"', 'sh', String(root.pid)], {
      ...ids,
      env: PLAIN_ENV,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 5_000,
    });
    c.on('error', () => resolve());
    c.on('close', () => resolve());
    c.stdin.on('error', () => {});
    c.stdin.end(`\n${words}\n`);
  });
}
