// The runs a stopping worker cut off (SIGTERM) are written to a file. The next worker hands them back as interrupted
// before its first claim, so they resume in their sessions and don't count as abandoned. The stopping worker can't
// report them itself, because a deploy recreates the coordinator at the same moment. A worker that dies without a
// SIGTERM writes nothing, so its runs still count as abandoned (jobs.ts claim, GIVE_UP).
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { ResponseError } from './reports.ts';

// lost: what the run had running besides its CLI when it was cut, and when that was looked at (detached.ts processesOf);
// its next run is told (jobs.ts cutNote). lostAt also ends the run at its cut, before restart downtime.
export type RunHandBack = {
  job: number;
  seat: string;
  session?: string;
  usage?: unknown;
  lost?: string[];
  lostAt?: string;
};

// No file is nothing owed. One that can't be read or isn't a list throws: its runs are lost, not handed back.
const owed = (file: string): RunHandBack[] => {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const runs: unknown = JSON.parse(text);
  if (!Array.isArray(runs)) throw new Error(`${file} doesn't hold a list of runs`);
  return runs as RunHandBack[];
};
// Written beside it and renamed over it, so a write that fails leaves the queue as it was.
const keep = (file: string, runs: RunHandBack[]) => {
  if (!runs.length) return rmSync(file, { force: true });
  writeFileSync(`${file}.new`, JSON.stringify(runs), { mode: 0o600 });
  renameSync(`${file}.new`, file);
};

// At SIGTERM, synchronously: added to any a stop during the last start's hand-back left unsent.
export const noteHandBacks = (file: string, runs: RunHandBack[]) => {
  if (runs.length) keep(file, [...owed(file), ...runs]);
};

// A coordinator that can't be reached is still starting: tried again until it answers. One that answers 5xx failed
// to handle it, and is tried again for about a minute: a run it never takes counts as abandoned, but a worker stuck
// here would start no run at all. Any other answer settles it, a refusal too (409: the run was cancelled meanwhile).
async function sendUntilAnswered(
  run: RunHandBack,
  finish: (body: Record<string, unknown>) => Promise<unknown>,
  log: (...a: unknown[]) => void,
  sleep: (ms: number) => Promise<unknown>,
) {
  for (let wait = 1000; ; wait = Math.min(wait * 2, 60_000)) {
    try {
      await finish({ ...run, status: 'interrupted' });
      return log(`job #${run.job}: handed back, cut off by the last stop`);
    } catch (err) {
      const failed = err instanceof ResponseError && err.status >= 500 && wait < 60_000;
      if (!(err instanceof TypeError) && !failed) return log(`job #${run.job}: not handed back:`, err);
      if (failed) log(`job #${run.job}: hand-back failed, trying again:`, err);
      await sleep(wait);
    }
  }
}

// At start, before any claim. finish is the worker's api call. One sent leaves the file at once, so a stop in the
// middle keeps only the rest.
export async function handBack(
  file: string,
  finish: (body: Record<string, unknown>) => Promise<unknown>,
  log: (...a: unknown[]) => void,
  sleep = (ms: number) => new Promise(r => setTimeout(r, ms)),
) {
  while (owed(file).length) {
    await sendUntilAnswered(owed(file)[0], finish, log, sleep);
    keep(file, owed(file).slice(1));
  }
}
