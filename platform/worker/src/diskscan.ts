// A slot-owned scanner keeps command-controlled paths away from worker filesystem privileges.
import { AccountingError, type AccountingFailure } from './accounting.ts';
import { fork, type ChildProcess } from 'node:child_process';
import { PROBE_OLD_SPACE_MB } from './disktree.ts';

export class DiskScan {
  private child: ChildProcess;
  private pending?: { resolve: (bytes: number) => void; reject: (failure: Error) => void };
  private failure?: Error;
  private closed = false;

  constructor(roots: string[], ids: { uid: number; gid: number }, oldSpaceMb = PROBE_OLD_SPACE_MB) {
    this.child = fork(new URL('./diskprobe.ts', import.meta.url), [JSON.stringify(ids), String(oldSpaceMb), ...roots], {
      env: { PATH: '/usr/bin:/bin' },
      // One probe runs for each job its whole life. Its tree is ~30 MB of heap for a job's checkout, but V8's default
      // young generation (sized for a 2 GB heap) kept ~40 MB more resident in each, memory the worker's admission
      // counts against every start (diskscan.test.ts).
      // Its old space is set too: the tree's bound is a share of it (disktree.ts).
      execArgv: ['--max-semi-space-size=1', `--max-old-space-size=${oldSpaceMb}`],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.child.on('message', (reading: { bytes: number; error?: AccountingFailure }) => {
      if (this.closed) return;
      const pending = this.pending;
      this.pending = undefined;
      if (reading.error) pending!.reject(new AccountingError(reading.error.reason, reading.error.message));
      else pending!.resolve(reading.bytes);
    });
    this.child.on('error', failure => this.fail(failure));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Disk scanner exited: ${signal ?? code}`)));
  }

  get pid() {
    return this.child.exitCode === null && this.child.signalCode === null && !this.closed ? this.child.pid : undefined;
  }

  measure(): Promise<number> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.child.send('measure', failure => {
        if (failure) this.fail(failure);
      });
    });
  }

  close() {
    this.closed = true;
    this.fail(new Error('Disk scanner closed'));
    this.child.kill();
  }

  private fail(failure: Error) {
    this.failure = failure;
    this.pending?.reject(failure);
    this.pending = undefined;
  }
}
