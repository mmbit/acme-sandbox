// Git output adapters with a memory budget for content supplied by agents.
import * as child from 'node:child_process';
import { totalmem } from 'node:os';
import { promisify } from 'node:util';
import { getHeapStatistics } from 'node:v8';

// Two streams, buffers, decoded strings and parsed copies can coexist. Reserve eight copies and leave three
// quarters of the smaller worker/heap limit for the worker's other jobs and state.
export const OUTPUT_BYTES = Math.floor(
  Math.min(process.constrainedMemory() || Infinity, totalmem(), getHeapStatistics().heap_size_limit) / 32,
);

export class GitOutputLimitError extends Error {
  constructor(limit: number, options?: ErrorOptions) {
    super(
      `Git output exceeds its worker memory budget of ${limit} bytes. Reduce the content before publishing.`,
      options,
    );
  }
}

export function execFileSync(
  cmd: string,
  args: readonly string[],
  options: child.ExecFileSyncOptionsWithStringEncoding,
): string;
export function execFileSync(
  cmd: string,
  args: readonly string[],
  options?: child.ExecFileSyncOptionsWithBufferEncoding,
): Buffer;
export function execFileSync(
  cmd: string,
  args: readonly string[],
  options: child.ExecFileSyncOptions = {},
): string | Buffer {
  const bounded = { maxBuffer: OUTPUT_BYTES, ...options };
  try {
    return child.execFileSync(cmd, args, bounded);
  } catch (error) {
    outputFailure(error, bounded.maxBuffer);
    throw error;
  }
}

export function spawnSync(
  cmd: string,
  args: readonly string[],
  options: child.SpawnSyncOptionsWithStringEncoding,
): child.SpawnSyncReturns<string>;
export function spawnSync(
  cmd: string,
  args: readonly string[],
  options?: child.SpawnSyncOptionsWithBufferEncoding,
): child.SpawnSyncReturns<Buffer>;
export function spawnSync(
  cmd: string,
  args: readonly string[],
  options: child.SpawnSyncOptions = {},
): child.SpawnSyncReturns<string | Buffer> {
  const bounded = { maxBuffer: OUTPUT_BYTES, ...options };
  const spawned = child.spawnSync(cmd, args, bounded);
  if (spawned.error) outputFailure(spawned.error, bounded.maxBuffer);
  return spawned;
}

const execFilePromise = promisify(child.execFile);
export async function execFileAsync(
  cmd: string,
  args: readonly string[],
  options: child.ExecFileOptionsWithStringEncoding,
) {
  const bounded = { maxBuffer: OUTPUT_BYTES, ...options };
  try {
    return await execFilePromise(cmd, args, bounded);
  } catch (error) {
    outputFailure(error, bounded.maxBuffer);
    throw error;
  }
}

function outputFailure(error: unknown, limit: number) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOBUFS' || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    throw new GitOutputLimitError(limit, { cause: error });
}
