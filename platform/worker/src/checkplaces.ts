// Sessions return their places before push checks take a separate isolated user.
import { waitingLine } from './turns.ts';

// A job's run, until it ends. handedOver resolves as its push checks queue (take): the session's caller goes on from
// there, and an error after it is the checks' (`failed`), no longer the session's.
type Run = { slot?: string; handedOver: PromiseWithResolvers<void>; detached: boolean };

export class CheckPlaces {
  private free: string[];
  private waiting = waitingLine<{ go: (slot: string) => void; first: () => boolean }>();
  private runs = new Map<number, Run>();
  private checkingJobs = new Set<number>();

  constructor(slots: string[], occupied: string[] = []) {
    this.free = slots.filter(slot => !occupied.includes(slot));
  }

  // The jobs in their push checks, waiting for a checks user or on one: they hold no session slot or seat place.
  get checking(): ReadonlySet<number> {
    return this.checkingJobs;
  }

  // The job counts as in its checks from here (the room report's `checks`), before it takes its turn.
  enter(job: number) {
    this.checkingJobs.add(job);
  }

  // Resolves once the session ends or hands over to its checks (take).
  async run(job: number, work: () => Promise<void>, failed: (error: unknown) => Promise<void>, adopted?: string) {
    const run: Run = { slot: adopted, handedOver: Promise.withResolvers<void>(), detached: false };
    this.runs.set(job, run);
    const done = work()
      .catch(async error => {
        if (!run.detached) throw error;
        await failed(error);
      })
      .finally(() => {
        this.checkingJobs.delete(job);
        this.runs.delete(job);
        if (run.slot) this.giveBack(run.slot);
      });
    await Promise.race([done, run.handedOver.promise]);
  }

  // Hands the job's session back and waits for a checks user (`adopted`: the one a reload kept for it).
  async take(job: number, first: () => boolean, signal?: AbortSignal, adopted?: string) {
    signal?.throwIfAborted();
    const run = this.runs.get(job)!;
    this.enter(job);
    run.detached = true;
    run.handedOver.resolve();
    const slot =
      adopted ??
      this.free.shift() ??
      (await new Promise<string>((go, reject) => {
        const waiter = {
          go: (slot: string) => {
            signal?.removeEventListener('abort', abort);
            go(slot);
          },
          first,
        };
        const abort = () => {
          this.waiting.remove(waiter);
          reject(signal!.reason);
        };
        this.waiting.add(waiter);
        signal?.addEventListener('abort', abort, { once: true });
      }));
    run.slot = slot;
    signal?.throwIfAborted();
    return slot;
  }

  private giveBack(slot: string) {
    const next = this.waiting.next();
    if (next) next.go(slot);
    else this.free.push(slot);
  }
}
