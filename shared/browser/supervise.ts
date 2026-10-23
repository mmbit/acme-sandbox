// Browser process supervision, including Chromium's detached processes.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Four Playwright operation budgets (30 s each) without a completed harness step means the render has stalled.
const IDLE_MS = 4 * 30_000;
const MINUTES = 30;
const SCRIPT = fileURLToPath(import.meta.url);
// Linux adopts orphaned Chromium processes into the supervisor, so cleanup still finds them after a script exits.
const ADOPT = 'syscall(157,36,1,0,0,0)==0 or die "subreaper: $!"; exec @ARGV or die "supervisor: $!";';

type Options = { cwd: string; env?: NodeJS.ProcessEnv; lock?: boolean; idleMs?: number; minutes?: number };

export async function supervise(entry: string, args: string[], options: Options): Promise<number> {
  const command = [process.execPath, SCRIPT, entry, ...args];
  const argv = options.lock ? ['flock', '--exclusive', '--no-fork', '/run/lock', ...command] : command;
  const child = spawn('perl', ['-e', ADOPT, ...argv], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      HQ_RENDER_IDLE_MS: String(options.idleMs ?? IDLE_MS),
      HQ_RENDER_MINUTES: String(options.minutes ?? MINUTES),
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 : 2)));
    });
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

async function watch(entry: string, args: string[]) {
  if (!process.connected) return 143;
  const idleMs = Number(process.env.HQ_RENDER_IDLE_MS),
    minutes = Number(process.env.HQ_RENDER_MINUTES);
  const child = spawn(process.execPath, [entry, ...args], {
    env: { ...process.env, HQ_RENDER_CHILD: '1' },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  let lastProgress = Date.now(),
    stopped = 0;
  const stop = (code: number, reason: string) => {
    if (stopped) return;
    stopped = code;
    console.error(`Render stopped: ${reason}`);
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
      if (Date.now() - lastProgress >= idleMs) stop(124, `no harness progress for ${idleMs / 1000} s`);
    },
    Math.min(1000, idleMs),
  );
  const deadline = setTimeout(() => stop(124, `the ${minutes} min render budget ended`), minutes * 60_000);
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

function descendants() {
  const parents = new Map<number, number>(),
    live = new Set<number>();
  for (const name of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      const contents = readFileSync(`/proc/${name}/stat`, 'utf8');
      const stat = contents.slice(contents.lastIndexOf(')') + 2).split(' ');
      parents.set(Number(name), Number(stat[1]));
      if (stat[0] !== 'Z') live.add(Number(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH')
        throw error;
    }
  }
  const ours = new Set([process.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, parent] of parents)
      if (ours.has(parent) && !ours.has(pid)) {
        ours.add(pid);
        changed = true;
      }
  }
  return [...ours].filter(pid => pid !== process.pid && live.has(pid)).reverse();
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
