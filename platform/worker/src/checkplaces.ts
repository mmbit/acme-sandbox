// Sessions return their places before push checks take a separate isolated user.
export class CheckPlaces {
  private free: string[];
  private waiting: { go: (slot: string) => void; first: () => boolean }[] = [];
  private runs = new Map<number, { slot?: string; release: () => void }>();
  readonly checking = new Set<number>();

  constructor(slots: string[], occupied: string[] = []) {
    this.free = slots.filter(slot => !occupied.includes(slot));
  }

  async run(job: number, work: () => Promise<void>, failed: (error: unknown) => Promise<void>, adopted?: string) {
    let release!: () => void;
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    const state: { slot?: string; release: () => void } = { slot: adopted, release };
    this.runs.set(job, state);
    let detached = false;
    state.release = () => {
      detached = true;
      release();
    };
    const done = work()
      .catch(async error => {
        if (!detached) throw error;
        await failed(error);
      })
      .finally(() => {
        this.checking.delete(job);
        this.runs.delete(job);
        if (state.slot) this.giveBack(state.slot);
      });
    await Promise.race([done, released]);
  }

  async take(job: number, first: () => boolean, signal?: AbortSignal, adopted?: string) {
    signal?.throwIfAborted();
    const state = this.runs.get(job)!;
    this.checking.add(job);
    state.release();
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
          this.waiting.splice(this.waiting.indexOf(waiter), 1);
          reject(signal!.reason);
        };
        this.waiting.push(waiter);
        signal?.addEventListener('abort', abort, { once: true });
      }));
    state.slot = slot;
    signal?.throwIfAborted();
    return slot;
  }

  private giveBack(slot: string) {
    const first = this.waiting.findIndex(waiter => waiter.first());
    const [next] = this.waiting.splice(Math.max(0, first), 1);
    if (next) next.go(slot);
    else this.free.push(slot);
  }
}
