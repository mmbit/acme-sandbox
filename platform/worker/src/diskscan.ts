// A slot-owned scanner keeps command-controlled paths away from worker filesystem privileges.
import { AccountingError, type AccountingFailure } from './accounting.ts';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
// Keep the supported 2 GiB logical tree ceiling independently of scanner RSS.
const PROBE_BUDGET_MB = 2048;

export class DiskScan {
  private child: ChildProcessWithoutNullStreams;
  private pending?: { resolve: (bytes: number) => void; reject: (failure: Error) => void };
  private measuring?: Promise<number>;
  private failure?: Error;
  private closed = false;
  private lastStderrLine = '';

  constructor(roots: string[], ids: { uid: number; gid: number }, budgetMb = PROBE_BUDGET_MB) {
    this.child = spawn(
      'python3',
      [
        '-I',
        '-u',
        fileURLToPath(new URL('./diskprobe.py', import.meta.url)),
        JSON.stringify(ids),
        String(budgetMb),
        ...roots,
      ],
      { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const errors = createInterface({ input: this.child.stderr });
    errors.on('line', line => {
      this.lastStderrLine = line;
    });
    const replies = createInterface({ input: this.child.stdout });
    replies.on('line', line => {
      if (this.closed) return;
      const reading = JSON.parse(line) as { bytes: number; error?: AccountingFailure };
      const pending = this.pending!;
      this.pending = undefined;
      this.measuring = undefined;
      if (reading.error) pending.reject(new AccountingError(reading.error.reason, reading.error.message));
      else pending.resolve(reading.bytes);
    });
    this.child.stdin.on('error', failure => this.fail(failure));
    this.child.on('error', failure => this.fail(failure));
    this.child.on('close', (code, signal) => {
      const cause = this.lastStderrLine ? `: ${this.lastStderrLine}` : '';
      this.fail(new Error(`Disk scanner exited: ${signal ?? code}${cause}`));
    });
  }

  get pid() {
    return this.child.exitCode === null && this.child.signalCode === null && !this.closed ? this.child.pid : undefined;
  }

  measure(): Promise<number> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.measuring) return this.measuring;
    this.measuring = new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.child.stdin.write('measure\n', failure => {
        if (failure) this.fail(failure);
      });
    });
    return this.measuring;
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
    this.measuring = undefined;
  }
}
