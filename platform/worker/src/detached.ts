// A run's CLI outlives the worker's own process. A deploy that changes only the worker's code reloads that process
// (supervise.py), and the runs go on: their CLIs, renders and test runs are never stopped. So a run writes to files, not
// pipes: its stdout and stderr go to files in /work/runs that only root can open, and the worker follows them from where
// it got to. Each run has a record there (its job, seat and slot, its launch, how far its output was read), which a new
// worker reads to take the run over. When the worker that launched a CLI has gone, the CLI's end is seen by
// supervise.py, which writes its exit code into the run's marker, pid-<pid>-<start>.
// What can still cut a run is a stop of the whole container (a change to its image or settings) or a crash of the
// server: the run is then handed back, and its next run is told which of its processes were stopped (processesOf).
import { assertOwned } from './ownership.ts';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { redact } from './safety.ts';

// A process as /proc/<pid>/stat has it; its start (clock ticks since boot) and pid together name it, since a pid is
// used again once its process has gone. sid: its session; ticks: the CPU time it has used (user and system).
export function procStat(pid: number) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8'),
      f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return {
      comm: s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')),
      state: f[0],
      ppid: Number(f[1]),
      sid: Number(f[3]),
      ticks: Number(f[11]) + Number(f[12]),
      nice: Number(f[16]),
      start: f[19],
    };
  } catch {
    return undefined;
  }
}
export type ProcStat = NonNullable<ReturnType<typeof procStat>>;
// (a zombie has ended: its parent hasn't read its exit yet)
export const alive = (pid: number, start: string) => {
  const s = procStat(pid);
  return s?.start === start && s.state !== 'Z';
};

export type Launched = { pid: number; start: string; out: string; err: string };
const marker = (runs: string, l: Launched) => `${runs}/pid-${l.pid}-${l.start}`;

// stdin (the prompt) and the sign-in's fd 3 stay pipes: the CLI reads both to their end as it starts. One that can't
// start (no pid) comes back with an empty start; its child's error event ends it.
export function launch(runs: string, name: string, cmd: string, args: string[], o: SpawnOptions & { fd3?: boolean }) {
  assertOwned();
  const out = `${runs}/${name}.out`,
    err = `${runs}/${name}.err`;
  const fds = [openSync(out, 'w', 0o600), openSync(err, 'w', 0o600)];
  let child: ChildProcess;
  try {
    child = spawn(cmd, args, { ...o, stdio: ['pipe', fds[0], fds[1], ...(o.fd3 ? ['pipe' as const] : [])] });
  } finally {
    for (const fd of fds) closeSync(fd);
  }
  const l: Launched = { pid: child.pid ?? 0, start: (child.pid && procStat(child.pid)?.start) || '', out, err };
  if (l.start) {
    writeFileSync(marker(runs, l), '', { mode: 0o600 });
    // its end, noted here too: a worker process that dies before it has reported the run leaves it for the next
    child.on('exit', (c, sig) => {
      try {
        writeFileSync(marker(runs, l), c === null ? `signal ${sig}` : `exit ${c}`);
      } catch {
        /* dropped */
      }
    });
  }
  return { child, launched: l };
}

// How a CLI this process launched ends: its exit code (a signal counts as 1, as a failed run).
export const exitOf = (child: ChildProcess) =>
  new Promise<number>(r => {
    child.on('exit', c => r(c ?? 1));
    child.on('error', () => r(1));
  });

// How a launch ended, as its marker says: the worker that launched it writes it, or supervise.py as it reaps a CLI whose
// worker process had gone. A signal counts as 1. Undefined while nobody has seen it end (it runs, or the container
// stopped meanwhile).
export function endSeen(runs: string, l: Launched) {
  const how = howEnded(runs, l);
  return how && (how.exit ?? 1);
}
// The same, with a signal kept apart from an exit code (a push's check stopped by a signal isn't a finding:
// pushchecks.ts).
export function howEnded(runs: string, l: Launched): { exit?: number; signal?: string } | undefined {
  let how: string;
  try {
    how = readFileSync(marker(runs, l), 'utf8');
  } catch {
    return undefined;
  }
  const m = how.match(/^(exit|signal) (\S+)$/);
  if (!m) return undefined;
  return m[1] === 'exit' ? { exit: Number(m[2]) } : { signal: m[2] };
}
// A CLI another worker process launched: its end, once supervise.py has written it (it reaps the process just after).
export async function endOf(runs: string, l: Launched, wait = (ms: number) => new Promise(r => setTimeout(r, ms))) {
  for (let i = 0; i < 25; i++) {
    const code = endSeen(runs, l);
    if (code !== undefined) return code;
    await wait(200);
  }
  return undefined;
}

// Reads a run's output from where it got to (at), as the CLI writes it, until ended() says it has ended and both files
// are read to their end. onOut gets each piece with the offset its end is at.
export async function follow(
  l: Launched,
  at: { out: number; err: number },
  ended: () => boolean,
  onOut: (piece: Buffer, end: number) => void,
  onErr: (piece: Buffer) => void,
  wait = (ms: number) => new Promise(r => setTimeout(r, ms)),
) {
  const buf = Buffer.alloc(1 << 16);
  const read = (file: string, key: 'out' | 'err', to: (b: Buffer) => void) => {
    let fd: number;
    try {
      fd = openSync(file, 'r');
    } catch {
      return false;
    }
    let got = false;
    try {
      for (let n; (n = readSync(fd, buf, 0, buf.length, at[key])) > 0;) {
        at[key] += n;
        got = true;
        to(Buffer.from(buf.subarray(0, n)));
      }
    } finally {
      closeSync(fd);
    }
    return got;
  };
  for (;;) {
    const done = ended(); // (asked first, so what it wrote before it ended is still read)
    const got = read(l.out, 'out', b => onOut(b, at.out));
    if (read(l.err, 'err', onErr) || got) continue;
    if (done) return at;
    await wait(200);
  }
}

// A run as a new worker takes it over: what its runJob had, and how far its output was read.
// session and usage: the run's so far, for a hand-back; lost: what it had running at its last look (processesOf), and when.
// checks: once its CLI has ended and its work is pushed, its push's checks (pushchecks.ts).
export type RunRecord = {
  job: { id: number; session?: string | null } & Record<string, unknown>;
  seat: string;
  slot: string;
  resumed: boolean;
  launched: Launched;
  read: { out: number; err: number };
  session?: string;
  usage?: unknown;
  handed?: string;
  lost?: string[];
  lostAt?: string;
  checks?: Checks;
};
// A run past its push: its finish report so far (body) and its account (spent), and each of its push's checks by name.
export type Checks = { body: Record<string, unknown>; spent: unknown; runs: Record<string, CheckRun> };
// A check launched (and when, for its time in the log and a lent launch's limit ms), or none while it waits for its
// turn. lent: the launch sends it to a lent machine's helper (pushchecks.ts CheckSpec). stopped: what the job's shares
// stopped of it, so it couldn't complete (worker.ts stopProcess). unreached: its launches in a row that lost HQ
// (pushchecks.ts runCheck). (ms, lent);
export type CheckRun = {
  launched?: Launched;
  began?: number;
  ms?: number;
  lent?: boolean;
  stopped: string[];
  unreached?: number;
};
export const recordOf = (runs: string, job: number) => `${runs}/${job}.json`;
export function keepRecord(runs: string, r: RunRecord) {
  assertOwned();
  writeFileSync(`${recordOf(runs, r.job.id)}.new`, JSON.stringify(r), { mode: 0o600 });
  renameSync(`${recordOf(runs, r.job.id)}.new`, recordOf(runs, r.job.id));
}
// Every record there; one that can't be read is set aside, and its run is lost (its job is requeued once it's stale).
export function records(runs: string, log: (...a: unknown[]) => void) {
  const out: RunRecord[] = [];
  for (const n of readdirSync(runs)) {
    if (!/^\d+\.json$/.test(n)) continue;
    try {
      out.push(JSON.parse(readFileSync(`${runs}/${n}`, 'utf8')));
    } catch (err) {
      log(`run record ${n} unreadable, set aside:`, err);
      renameSync(`${runs}/${n}`, `${runs}/${n}.unreadable-${Date.now()}`);
    }
  }
  return out;
}
// A run's files go when its runJob has ended (and what an ended launch left: its output and marker).
export function dropRun(runs: string, job: number, ...launches: (Launched | undefined)[]) {
  for (const l of launches) if (l) dropLaunch(runs, l);
  rmSync(recordOf(runs, job), { force: true });
}
export const dropLaunch = (runs: string, l: Launched) => {
  for (const f of [l.out, l.err, marker(runs, l)]) rmSync(f, { force: true });
};
// Every launch a record names: its CLI's and its push's checks'.
export const launchesOf = (r: RunRecord) => [
  r.launched,
  ...Object.values(r.checks?.runs ?? {}).flatMap(c => (c.launched ? [c.launched] : [])),
];
// Remove unreferenced run output, markers and folders after takeover or handback.
export function sweepRuns(runs: string, keep: RunRecord[]) {
  const kept = new Set(
    keep.flatMap(r => [...launchesOf(r).flatMap(l => [l.out, l.err, marker(runs, l)]), recordOf(runs, r.job.id)]),
  );
  for (const n of readdirSync(runs))
    if (!kept.has(`${runs}/${n}`) && !n.includes('.unreadable-'))
      rmSync(`${runs}/${n}`, { force: true, recursive: true });
}

// Every live process of these uids, as procStat has it
export function processesOfUids(uids: Set<number>) {
  const found: (ProcStat & { pid: number; uid: number })[] = [];
  for (const n of readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const uid = statSync(`/proc/${n}`).uid,
        s = uids.has(uid) ? procStat(Number(n)) : undefined;
      if (s && s.state !== 'Z') found.push({ ...s, pid: Number(n), uid });
    } catch {
      /* gone meanwhile */
    }
  }
  return found;
}

// The CLIs' own programs as /proc names them (its comm: at most 15 characters): a launch's native agent and helpers
export const CLI_PROGRAMS = new Set(['claude', 'codex', 'codex-linux-san', 'codex-code-mode']);
// What a run's uid has running besides its CLI: each command's own program (the first one under the CLI that isn't a
// shell or the CLI's own), with how long it has run, oldest first. Its next run hears these when a stop cuts them.
export const WRAPPERS = new Set(['sh', 'bash', 'dash', 'zsh', ...CLI_PROGRAMS]);
export function processesOf(uid: number, cli: number, max = 10) {
  const ps = new Map<number, ProcStat & { args: string }>();
  for (const p of processesOfUids(new Set([uid]))) {
    try {
      const args = redact(readFileSync(`/proc/${p.pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')); // (a command line can hold a token)
      if (args) ps.set(p.pid, { ...p, args });
    } catch {
      /* gone meanwhile */
    }
  }
  const wrapper = (pid: number) => pid === cli || WRAPPERS.has(ps.get(pid)!.comm);
  // (looked for below the CLI only: what started the CLI is no command of the run)
  const under = (pid: number) => {
    for (let p = ps.get(pid)!.ppid; ps.has(p) && p !== cli; p = ps.get(p)!.ppid) if (!wrapper(p)) return true;
    return false;
  };
  const up = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
  const shown = [...ps.keys()]
    .filter(p => !wrapper(p) && !under(p))
    .sort((a, b) => Number(ps.get(a)!.start) - Number(ps.get(b)!.start));
  const lines = shown.slice(0, max).map(p => {
    const { args, start } = ps.get(p)!,
      min = Math.max(0, Math.round((up - Number(start) / 100) / 60));
    return `${args.length > 160 ? `${args.slice(0, 160)}…` : args} (running ${min} min)`;
  });
  return shown.length > max ? [...lines, `and ${shown.length - max} more`] : lines;
}
