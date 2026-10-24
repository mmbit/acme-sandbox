// A worker reload closes block admission and finishes its command stops before handing runs over.
import { setTimeout as sleep } from 'node:timers/promises';
import { blockRun } from './blocks.ts';

type Handover = {
  stopping: () => boolean;
  start: () => void;
  ready: () => boolean;
  keep: () => void;
  finish: () => void;
  failed: (err: unknown) => void;
};

export class Reload {
  private closed = false;
  private stopping = new Set<Promise<void>>();
  private reports = new AbortController();

  get handingOver() {
    return this.closed;
  }

  async block(...[owner, block, procs, options]: Parameters<typeof blockRun>) {
    if (this.closed) {
      options.stopped(
        `job #${owner.job}: block of run ${block.root.pid} left to the next worker process, this one is reloading`,
      );
      return;
    }
    const stopped = blockRun(owner, block, procs, {
      ...options,
      ask: body => options.ask(body, this.reports.signal),
    });
    this.stopping.add(stopped);
    try {
      await stopped;
    } finally {
      this.stopping.delete(stopped);
    }
  }

  listen(handover: Handover, ms: number) {
    process.on('SIGUSR2', () => {
      if (this.closed || handover.stopping()) return;
      this.handOver(handover, ms)
        .then(() => {
          if (handover.stopping()) return;
          handover.finish();
          process.exit(0);
        })
        .catch(err => {
          handover.failed(err);
          process.exit(0);
        });
    });
  }

  private async handOver(handover: Handover, ms: number) {
    this.closed = true;
    try {
      handover.start();
      const until = Date.now() + ms;
      while ((!handover.ready() || this.stopping.size > 0) && Date.now() < until) await sleep(500);
    } finally {
      // A deadline or a failed handover must unwind stopRun's finally before the process exits.
      this.reports.abort(new Error('Worker reloading'));
      await Promise.allSettled(this.stopping);
    }
    if (!handover.stopping()) handover.keep();
  }
}
