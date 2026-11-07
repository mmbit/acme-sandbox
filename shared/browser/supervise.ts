// Browser process supervision, including Chromium's detached processes.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Four Playwright operation budgets (30 s each) without a completed harness step means the render has stalled.
const IDLE_MS = 4 * 30_000;
const MINUTES = 30;
// The machine's one browser slot: an exclusive kernel lock on the shared /run/lock, which only the render's watch holds
// (libuv closes the lock's descriptor in what it starts). HQ_RENDER_SLOT: a test's lock file of its own, so a test never
// takes, or leaves held, the slot every job's renders wait for. The worker ends a holder past its bound (its
// browserslot.ts).
const SLOT = process.env.HQ_RENDER_SLOT ?? '/run/lock';
const SCRIPT = fileURLToPath(import.meta.url);
const REAPER = fileURLToPath(new URL('reaper.pl', import.meta.url)); // the render's parent, and its subreaper

type Options = { cwd: string; env?: NodeJS.ProcessEnv; lock?: boolean; idleMs?: number; minutes?: number };

// One bound for the whole render, from when it's asked for: the wait for this machine's browser slot counts, so a
// render queued behind one that hangs ends too, and can be run again, rather than sitting behind it.
export async function supervise(entry: string, args: string[], options: Options): Promise<number> {
  const minutes = options.minutes ?? MINUTES,
    asked = Date.now();
  const command = [process.execPath, SCRIPT, entry, ...args];
  const flock = ['flock', '--exclusive', '--no-fork', '--timeout', String(minutes * 60), '--conflict-exit-code', '124'];
  const argv = options.lock ? [...flock, SLOT, ...command] : command;
  const child = spawn('perl', [REAPER, ...argv], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      HQ_RENDER_IDLE_MS: String(options.idleMs ?? IDLE_MS),
      HQ_RENDER_ASKED_MS: String(asked),
      HQ_RENDER_MINUTES: String(minutes),
      HQ_RENDER_LOCKED: String(Boolean(options.lock)),
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  let started = false;
  child.once('message', () => (started = true));
  const stop = () => child.kill('SIGTERM');
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 : 2)));
    });
    if (code === 124 && !started)
      console.error(
        `Render stopped: ${relative(options.cwd, entry)} waited its whole ${minutes} min for the browser slot`,
      );
    return code;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

async function watch(entry: string, args: string[]) {
  if (!process.connected) return 143;
  const idleMs = Number(process.env.HQ_RENDER_IDLE_MS),
    asked = Number(process.env.HQ_RENDER_ASKED_MS),
    minutes = Number(process.env.HQ_RENDER_MINUTES),
    until = asked + minutes * 60_000;
  process.send!({ render: 'started' }); // (the slot is ours: a 124 from here on is this watch's, and says why)
  const atBound = boundReached(minutes, asked);
  const child = spawn(process.execPath, [entry, ...args], {
    env: { ...process.env, HQ_RENDER_CHILD: '1' },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  let lastProgress = Date.now(),
    stopped = 0;
  const stop = (code: number, reason: string) => {
    if (stopped) return;
    stopped = code;
    console.error(`Render stopped with ${running()} running: ${relative(process.cwd(), entry)} ${reason}`);
    killDescendants();
  };
  const onTerm = () => stop(143, 'cancelled');
  const onInt = () => stop(130, 'interrupted');
  process.once('disconnect', onTerm);
  process.once('SIGTERM', onTerm);
  process.once('SIGINT', onInt);
  child.on('message', message => {
    if ((message as { render?: string }).render === 'progress') lastProgress = Date.now();
  });
  const idle = setInterval(
    () => {
      if (Date.now() - lastProgress >= idleMs) stop(124, `made no harness progress for ${idleMs / 1000} s`);
    },
    Math.min(1000, idleMs),
  );
  const deadline = setTimeout(() => stop(124, atBound), until - Date.now());
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 : 2)));
    });
    return stopped || code;
  } finally {
    clearInterval(idle);
    clearTimeout(deadline);
    await cleanup();
    process.off('disconnect', onTerm);
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  }
}

// Why a render stopped at its bound, when its watch starts: with a lock, the time since it was asked for is its slot wait
function boundReached(minutes: number, asked: number) {
  if (process.env.HQ_RENDER_LOCKED !== 'true') return `reached its ${minutes} min bound`;
  return `reached its ${minutes} min bound, ${Math.round((Date.now() - asked) / 1000)} s of it waiting for the browser slot`;
}

// The reaper is this watch's parent (it starts the watch, or the flock that execs the watch in its own place with
// --no-fork), so everything the render starts, and every orphan Linux adopts, is under it: its live processes but this
// watch are the render's, its browsers and their leftovers.
const reaper = process.ppid;
function descendants() {
  const parents = new Map<number, number>(),
    live = new Set<number>();
  for (const name of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    const contents = proc(Number(name), 'stat');
    if (contents === undefined) continue;
    const stat = contents.slice(contents.lastIndexOf(')') + 2).split(' ');
    parents.set(Number(name), Number(stat[1]));
    if (stat[0] !== 'Z') live.add(Number(name));
  }
  const ours = new Set([reaper]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, parent] of parents)
      if (ours.has(parent) && !ours.has(pid)) {
        ours.add(pid);
        changed = true;
      }
  }
  return [...ours].filter(pid => pid !== reaper && pid !== process.pid && live.has(pid)).reverse();
}

// A file of /proc/<pid>, or undefined once the process has ended
function proc(pid: number, file: string) {
  try {
    return readFileSync(`/proc/${pid}/${file}`, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH')
      throw error;
  }
}

// What a render had running when it was stopped, by script or program: "screens-compare.mjs, chrome-headless-shell ×4"
function running() {
  const counts = new Map<string, number>();
  for (const pid of descendants().reverse()) {
    const cmdline = proc(pid, 'cmdline');
    if (cmdline === undefined) continue;
    const [program, script] = cmdline.split('\0');
    const scripted = basename(program) === basename(process.execPath) && script && !script.startsWith('-');
    const name = basename(scripted ? script : program);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(', ') || 'nothing';
}

function killDescendants() {
  for (const pid of descendants()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

async function cleanup() {
  const until = Date.now() + 5_000; // the helper uses the same SIGKILL cleanup budget
  while (descendants().length) {
    if (Date.now() >= until) throw new Error('Render cleanup did not finish within 5 s of SIGKILL');
    killDescendants();
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

if (process.argv[1] === SCRIPT) {
  process.exitCode = await watch(process.argv[2], process.argv.slice(3));
  if (process.connected) process.disconnect();
}
