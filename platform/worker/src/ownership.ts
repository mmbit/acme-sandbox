// A run's ownership ends when HQ refuses its heartbeat, including work waiting between launches.
import { AsyncLocalStorage } from 'node:async_hooks';
import { rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { ResponseError } from './reports.ts';
import { recordOf } from './detached.ts';

const ownership = new AsyncLocalStorage<AbortSignal>();
export const ownershipSignal = () => ownership.getStore();
export const assertOwned = () => ownershipSignal()?.throwIfAborted();

class RefusedRunError extends Error {
  constructor() {
    super('HQ no longer has this run');
  }
}

type Run<Reply> = {
  job: number;
  runs: string;
  heartbeat: () => Promise<Reply>;
  answered: (reply: Reply) => void;
  stop: () => void;
  log: (line: string) => void;
};

// The heartbeat stays live through cleanup and reporting. Every asynchronous continuation keeps this signal,
// even after the slot starts another job. A refused run cannot write its record again or start another command.
export async function ownRun<T, Reply>(run: Run<Reply>, work: () => Promise<T>): Promise<T | undefined> {
  const controller = new AbortController(),
    { signal } = controller;
  let open = true;
  const beat = setInterval(() => {
    run
      .heartbeat()
      .then(reply => {
        if (open && !signal.aborted) run.answered(reply);
      })
      .catch(err => {
        if (!open || signal.aborted || !(err instanceof ResponseError && err.status === 409)) return;
        rmSync(recordOf(run.runs, run.job), { force: true });
        controller.abort(new RefusedRunError());
        run.stop();
        run.log(`job #${run.job}: HQ refused its heartbeat, run released`);
      });
  }, 60_000);
  try {
    return await ownership.run(signal, async () => {
      try {
        const outcome = await work();
        assertOwned();
        return outcome;
      } catch (err) {
        if (!signal.aborted) throw err;
      }
    });
  } finally {
    open = false;
    clearInterval(beat);
  }
}

// Requests and waits in a run stop with it. Outside a run these are ordinary worker operations.
export function requestSignal(signal?: AbortSignal) {
  const owned = ownershipSignal();
  owned?.throwIfAborted();
  return owned && signal ? AbortSignal.any([owned, signal]) : (owned ?? signal);
}
export async function waitOwned<T>(pending: Promise<T>): Promise<T> {
  const signal = ownershipSignal();
  signal?.throwIfAborted();
  if (!signal) return pending;
  let abort: () => void;
  const refused = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const outcome = await Promise.race([pending, refused]);
    assertOwned();
    return outcome;
  } finally {
    signal.removeEventListener('abort', abort!);
  }
}
export const sleepOwned = (ms: number) => sleep(ms, undefined, { signal: ownershipSignal() });
