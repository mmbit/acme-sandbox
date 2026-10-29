// Each job's share of the worker. Every job runs in the one container, under one
// memory cap (infra/compose.yaml), and a slot starts a job only while enough of it is free (worker.ts room).
// The container's cgroup is read-only inside it, so a job can't have one of its own. Its share is kept here instead.
// Everything a job runs uses its slot's uid (slots.ts): its CLI, commands, background processes and its push's checks.
// A uid's processes in /proc are therefore the job's, counted together.
// A job past its share has its heavy run blocked: the command its CLI started that holds the most of what it's past, with
// everything under it (runsOf), never the CLI. The worker tells the job's agent in that command's own output where to run
// it instead (the worker's blocks.ts blockRun, the coordinator's blocks.ts). Each look (sharepass.ts) makes one memory,
// process or sustained-CPU stop first. A priority helper that was killed or timed out then blocks a live, unprotected
// run still past the cores, even right after a cores stop (priority.ts, which rechecks each process and counts only
// the live ones' cores). A disk stop waits for a look with no other stop, though disk use is still sampled.
// - Memory: a job past mostMb in all, and the job holding the most past shareMb while the worker is starved (no slot
//   could start long enough, and work is waiting).
// - Processes: a job with more than `processes` non-CLI processes.
// - CPU: a job's processes using more than half the cores get nice 10, and their sessions' groups too (the kernel shares
//   the CPU between sessions first: sched_autogroup), so the others' come first. Renicing another uid's process takes
//   CAP_SYS_NICE, which the container hasn't got, so it runs as the slot's uid: lowering one's own priority needs nothing.
//   A group asked for stays pending, busy or not, until it's at nice 10 or gone. A job past the cores for long (`hot`,
//   the worker's count) has its busiest run blocked. An interrupted priority helper also blocks a busy job's run.
import type { AccountingFailure } from './accounting.ts';
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import type { Ids } from './slots.ts';
import { procStat, processesOfUids, type ProcStat } from './detached.ts';
import type { DiskUse } from './disk.ts';
import { storedWrites, sharedWritableFiles, diskWrites, diskAccountingError, type WritableFile } from './diskwrites.ts';
import { PLAIN_ENV } from './stoprun.ts';
import { runsOf } from './runs.ts';
export { cliProcesses, runsOf } from './runs.ts';

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
  writeBytes?: number;
  writtenBytes?: number;
  writeCallBytes?: number;
  writtenCallBytes?: number;
  writableFiles?: WritableFile[];
  storedWriteBytes?: number;
  diskAccountingError?: AccountingFailure;
  processReadingError?: string;
  group?: Autogroup;
  cores?: number; // (the cores it used since the look before, in a job's use: tally)
};
// writable: its slot may change the group through this process (a nondumpable process's /proc files are root's)
type Autogroup = { id: string; nice: number; writable: boolean };
export type JobUse = { uid: number; memoryMb: number; cores: number; processes: ProcessSnapshot[] };

const CPU_TICKS_PER_SECOND = 100; // clock ticks a second (getconf CLK_TCK)
// SIGTERM cannot finish a helper stopped by another process in its slot.
const slotOptions = (ids: Required<Ids>) => ({
  ...ids,
  env: PLAIN_ENV,
  timeout: 10_000,
  killSignal: 'SIGKILL' as const,
});

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
  const processReadingErrors = new Map(jobs.map((ids, index) => [ids.uid, read[index].processReadingError]));
  const pss = new Map(read.flatMap(m => [...m.pss]));
  const written = new Map(read.flatMap(m => [...m.written]));
  const calls = new Map(read.flatMap(m => [...m.calls]));
  return stats.flatMap(p => {
    const rssMb = residentOf(p),
      memoryMb = pss.get(p.pid) ?? rssMb;
    if (memoryMb === undefined) return [];
    return [
      {
        ...p,
        rssMb,
        processReadingError: processReadingErrors.get(p.uid),
        writeBytes: written.get(p.pid),
        writeCallBytes: calls.get(p.pid),
        memoryMb,
        memoryMeasure: pss.has(p.pid) ? ('pss' as const) : ('rss' as const),
        group: autogroupOf(p),
      },
    ];
  });
}

type ProcessReading = {
  pss: Map<number, number>;
  written: Map<number, number>;
  calls: Map<number, number>;
  processReadingError?: string;
};

// Each process's PSS in MB and storage writes in bytes. Only its own uid may read them (the worker has no CAP_SYS_PTRACE), so it's read as the job's
// slot, with nothing of the worker's environment. grep goes on past a file it can't read (exit 2).
function pssOf(pids: number[], ids: Required<Ids>): Promise<ProcessReading> {
  if (!pids.length) return Promise.resolve(noReading());
  const files = pids.flatMap(pid => [`/proc/${pid}/smaps_rollup`, `/proc/${pid}/io`]);
  return new Promise(resolve =>
    execFile('grep', ['-HE', '^(Pss|write_bytes|wchar):', ...files], slotOptions(ids), (err, stdout) => {
      if (err && err.code !== 1 && err.code !== 2) return resolve(noReading(`Process reading unavailable: ${err}`));
      const rows = stdout.matchAll(/^\/proc\/(\d+)\/smaps_rollup:Pss:\s+(\d+) kB$/gm);
      const writes = stdout.matchAll(/^\/proc\/(\d+)\/io:write_bytes:\s+(\d+)$/gm);
      const calls = stdout.matchAll(/^\/proc\/(\d+)\/io:wchar:\s+(\d+)$/gm);
      resolve({
        calls: new Map([...calls].map(m => [Number(m[1]), Number(m[2])])),
        pss: new Map([...rows].map(m => [Number(m[1]), Number(m[2]) / 1024])),
        written: new Map([...writes].map(m => [Number(m[1]), Number(m[2])])),
      });
    }),
  );
}

const noReading = (processReadingError?: string): ProcessReading => ({
  pss: new Map(),
  written: new Map(),
  calls: new Map(),
  processReadingError,
});

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
  const current = procStat(p.pid);
  if (current?.start !== p.start || current.state === 'Z') return undefined;
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
  const prior = new Map(before.map(p => [`${p.pid}:${p.start}`, p]));
  const sampledUids = new Set(before.map(p => p.uid));
  const uses = new Map<number, JobUse>();
  const sharedFiles = sharedWritableFiles(now, before);
  for (const p of now) {
    const u = uses.get(p.uid) ?? { uid: p.uid, memoryMb: 0, cores: 0, processes: [] };
    u.memoryMb += p.memoryMb;
    // A newly observed job may be adopted with hours of CPU time. Its first snapshot is the baseline.
    const cores = sampledUids.has(p.uid)
      ? (p.ticks - (had.get(`${p.pid}:${p.start}`) ?? 0)) / CPU_TICKS_PER_SECOND / (ms / 1000)
      : 0;
    u.cores += cores;
    const previous = prior.get(`${p.pid}:${p.start}`);
    const delta = (current: number | undefined, earlier: number | undefined) =>
      current === undefined ? undefined : Math.max(0, current - (earlier ?? (sampledUids.has(p.uid) ? 0 : current)));
    const process = {
      ...p,
      cores,
      writtenBytes: delta(p.writeBytes, previous?.writeBytes),
      writtenCallBytes: delta(p.writeCallBytes, previous?.writeCallBytes),
    };
    u.processes.push({ ...process, storedWriteBytes: storedWrites(process, previous, sharedFiles) });
    uses.set(p.uid, u);
  }
  return uses;
}

// A block measures memory (MiB), process count, sustained cores, or allocated disk bytes.
export type Measure = 'memory' | 'processes' | 'cores' | 'disk';
// A run to block: its job (uid), what the job is past (its use and its share, in the measure's unit), and the run: its
// first process (root, the command the CLI started) and every process under it. starved: a memory block only past the
// share a starved worker leaves, within the job's most: the worker's lack of room.
export type Block = {
  uid: number;
  measure: Measure;
  used: number | null;
  share: number;
  root: ProcessSnapshot;
  run: ProcessSnapshot[];
  accountingError?: AccountingFailure;
  starved?: true;
};

// Select the run to block, the processes to slow down, and one writable process per session group to slow down.
// Busy jobs' groups stay pending until they reach nice 10 or disappear, even after the job stops being busy.
// Each job's use counts its push checks too. cli contains process ids that are never stopped or slowed.
// starved means work has waited for memory past the worker's grace period. Its own session group is left alone.
// hot: the jobs (uids) whose processes have used more than `cores` for long. Memory comes first, then processes, then
// cores: the run blocked is the one holding the most of it.
export function overShare(
  uses: Map<number, JobUse>,
  cli: Set<number>,
  limits: ShareLimits,
  pending = new Set<string>(),
) {
  const jobs = [...uses.values()];
  const others = (u: JobUse) => u.processes.filter(p => !cli.has(p.pid));
  const block = selectBlock(jobs, cli, limits);
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

export type ShareLimits = {
  mostMb: number;
  shareMb: number;
  cores: number;
  processes: number;
  starved: boolean;
  hot?: Set<number>;
  workerSessionId: number;
  disk?: Map<number, DiskUse>;
};

function selectBlock(jobs: JobUse[], cli: Set<number>, limits: ShareLimits): Block | undefined {
  const others = (u: JobUse) => u.processes.filter(p => !cli.has(p.pid));
  const heaviestPast = (memoryMb: number) =>
    jobs.filter(u => u.memoryMb > memoryMb && others(u).length).sort((a, b) => b.memoryMb - a.memoryMb)[0];
  const memory = heaviestPast(limits.mostMb) ?? (limits.starved ? heaviestPast(limits.shareMb) : undefined);
  const crowded = jobs.find(u => others(u).length > limits.processes);
  const disk = jobs.find(u => {
    const use = limits.disk?.get(u.uid);
    return (
      others(u).length > 0 &&
      (use?.accountingError ||
        (use && others(u).some(p => p.diskAccountingError)) ||
        (use?.warned && use.used !== null && use.used > use.share && others(u).some(p => diskWrites(p, use) !== 0)))
    );
  });
  const hot = jobs.find(u => limits.hot?.has(u.uid) && others(u).length);
  const starved = memory && memory.memoryMb <= limits.mostMb;
  const memoryShare = starved ? limits.shareMb : limits.mostMb;
  return memory
    ? {
        ...weightedBlock(memory, cli, 'memory', memory.memoryMb, memoryShare, p => p.memoryMb),
        ...(starved && { starved }),
      }
    : crowded
      ? weightedBlock(crowded, cli, 'processes', others(crowded).length, limits.processes, () => 1)
      : disk
        ? weightedBlock(
            disk,
            cli,
            'disk',
            limits.disk!.get(disk.uid)!.used,
            limits.disk!.get(disk.uid)!.share,
            p =>
              limits.disk!.get(disk.uid)!.accountingError || p.diskAccountingError
                ? Infinity
                : (diskWrites(p, limits.disk!.get(disk.uid)!) ?? Infinity),
            limits.disk!.get(disk.uid)!.accountingError,
          )
        : hot
          ? coresBlock(hot, cli, limits.cores)
          : undefined;
}

// A busy job's run that used the most cores since the look before
export const coresBlock = (u: JobUse, cli: Set<number>, cores: number) =>
  weightedBlock(u, cli, 'cores', u.cores, cores, p => p.cores ?? 0);

function weightedBlock(
  u: JobUse,
  cli: Set<number>,
  measure: Measure,
  used: number | null,
  share: number,
  weigh: (p: ProcessSnapshot) => number,
  scanError?: AccountingFailure,
): Block {
  const weight = (run: ProcessSnapshot[]) => run.reduce((sum, p) => sum + weigh(p), 0);
  const [root, run] = [...runsOf(u.processes, cli)].sort((a, b) => weight(b[1]) - weight(a[1]))[0];
  const accountingError = measure === 'disk' ? (scanError ?? diskAccountingError(run)) : undefined;
  return { uid: u.uid, measure, used, share, root, run, accountingError };
}

// Lowers the priority of what overShare picked, as each process's slot. The kernel takes one group's change in 100 ms
// from a process without CAP_SYS_ADMIN, machine-wide, and refuses the others (EAGAIN). So the groups go one at a time,
// GROUP_GAP_MS apart across calls, and a refused one stays below nice 10 for the next look to pick again (pending). Each
// process is looked at again first: one ended, or moved to a session of its own, is left to the next look too. It
// returns the jobs (uids) whose helper was killed or timed out before it finished: priority.ts blocks a busy one's run.
export async function slowDown(jobs: Required<Ids>[], slow: ProcessSnapshot[], groups: ProcessSnapshot[]) {
  const interrupted = new Set<number>();
  for (const ids of jobs) {
    const pids = slow.filter(p => p.uid === ids.uid).map(p => String(p.pid));
    if (pids.length && (await runAsSlot(ids, 'renice', ['-n', '10', '-p', ...pids]))) interrupted.add(ids.uid);
  }
  for (const p of groups) {
    const ids = jobs.find(j => j.uid === p.uid);
    if (!ids || procStat(p.pid)?.start !== p.start || autogroupOf(p)?.id !== p.group!.id) continue;
    await new Promise(r => setTimeout(r, Math.max(0, groupChangedAt + GROUP_GAP_MS - Date.now())));
    if (await runAsSlot(ids, 'sh', ['-c', 'echo 10 > "/proc/$1/autogroup"', 'sh', String(p.pid)]))
      interrupted.add(ids.uid);
    groupChangedAt = Date.now();
  }
  return interrupted;
}
const GROUP_GAP_MS = 120;
let groupChangedAt = 0;
// True when a signal or the timeout ended the helper. An ended target or a refused group (EAGAIN) exits with a code.
const runAsSlot = (ids: Required<Ids>, cmd: string, args: string[]) =>
  new Promise<boolean>(resolve =>
    execFile(cmd, args, slotOptions(ids), err => resolve(Boolean(err?.signal || err?.killed))),
  );
