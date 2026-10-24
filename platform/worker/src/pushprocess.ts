// A privileged Git push owns its transport process group until the command has closed.
import { spawn } from 'node:child_process';

export async function pushProcess(args: string[], env: NodeJS.ProcessEnv, timeout: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const child = spawn('git', args, { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '',
    killed = false,
    failure: Error | undefined;
  child.stderr.setEncoding('utf8').on('data', chunk => {
    stderr += chunk;
  });
  child.once('error', err => {
    failure = err;
  });
  const stop = () => {
    if (child.pid === undefined) return; // A failed spawn has no process group.
    try {
      process.kill(-child.pid, 'SIGKILL');
      killed = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  };
  const closed = new Promise<void>((resolve, reject) => {
    child.once('close', (code, exitSignal) => {
      if (failure || code !== 0)
        reject(Object.assign(failure ?? new Error(`git push ended: ${exitSignal ?? code}`), { stderr, killed }));
      else resolve();
    });
  });
  const timer = setTimeout(stop, timeout);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    await closed;
    signal?.throwIfAborted();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    stop();
  }
}
