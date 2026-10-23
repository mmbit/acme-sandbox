// Each job's share of the worker. Every job runs in the one container, under one
// memory cap (infra/compose.yaml), and a slot starts a job only while enough of it is free (worker.ts room).
// The container's cgroup is read-only inside it, so a job can't have one of its own. Its share is kept here instead.
// Everything a job runs uses its slot's uid (slots.ts): its CLI, commands, background processes and its push's checks.
// A uid's processes in /proc are therefore the job's, counted together.
// - Memory: a job past mostMb in all loses its biggest process (never its CLI), and so does the job holding the most
//   past shareMb while the worker is starved (no slot could start long enough, and work is waiting). One process per
//   look, so it goes on only while it's still past.
// - CPU: a job's processes using more than half the cores get nice 10, and their sessions' groups too (the kernel shares
//   the CPU between sessions first: sched_autogroup), so the others' come first. Renicing another uid's process takes
//   CAP_SYS_NICE, which the container hasn't got, so it runs as the slot's uid: lowering one's own priority needs nothing.
//   A group asked for stays pending, busy or not, until it's at nice 10 or gone.
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import type { Ids } from './slots.ts';
import { CLI_PROGRAMS, procStat, processesOfUids, type ProcStat } from './detached.ts';

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
    if (sampledUids.has(p.uid))
      u.cores += (p.ticks - (had.get(`${p.pid}:${p.start}`) ?? 0)) / CPU_TICKS_PER_SECOND / (ms / 1000);
    u.processes.push(p);
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

// Select the process to stop, the processes to slow down, and one writable process per session group to slow down.
// Busy jobs' groups stay pending until they reach nice 10 or disappear, even after the job stops being busy.
// Each job's use counts its push checks too. cli contains process ids that are never stopped or slowed.
// starved means work has waited for memory past the worker's grace period. Its own session group is left alone.
export function overShare(
  uses: Map<number, JobUse>,
  cli: Set<number>,
  limits: {
    mostMb: number;
    shareMb: number;
    cores: number;
    starved: boolean;
    workerSessionId: number;
  },
  pending = new Set<string>(),
) {
  const jobs = [...uses.values()];
  const others = (u: JobUse) => u.processes.filter(p => !cli.has(p.pid));
  const biggest = (u: JobUse) => others(u).sort((a, b) => b.memoryMb - a.memoryMb)[0];
  const heaviestPast = (memoryMb: number) =>
    jobs.filter(u => u.memoryMb > memoryMb && biggest(u)).sort((a, b) => b.memoryMb - a.memoryMb)[0];
  const over = heaviestPast(limits.mostMb) ?? (limits.starved ? heaviestPast(limits.shareMb) : undefined);
  const stop = over && { uid: over.uid, memoryMb: over.memoryMb, process: biggest(over)! };
  const busy = jobs.filter(u => u.cores > limits.cores).flatMap(others);
  const slow = busy.filter(p => p.nice < 10);
  const wanted = new Set([...pending, ...busy.flatMap(p => (p.group ? [p.group.id] : []))]);
  const members = jobs
    .flatMap(others)
    .filter(p => p.group && wanted.has(p.group.id) && p.group.nice < 10 && p.sid !== limits.workerSessionId);
  // (through a process of the group its slot may write for: a nondumpable one's is root's. A group none of whose
  // processes it may write for now stays pending, for a look when one may.)
  const groups = [...new Map(members.filter(p => p.group!.writable).map(p => [p.group!.id, p])).values()];
  return { stop, slow, groups, pending: new Set(members.map(p => p.group!.id)) };
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
