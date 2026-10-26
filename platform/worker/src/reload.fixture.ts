// A disposable worker process using the production reload boundary and report retry.
import { launch } from './detached.ts';
import { hqReports } from './reports.ts';
import { subscribe } from 'node:diagnostics_channel';
import { Reload } from './reload.ts';
import { processesFor, type Block } from './shares.ts';
import { setTimeout as sleep } from 'node:timers/promises';

const [dir, url, job, measure, mode] = process.argv.slice(2);
const owner = { job: Number(job), uid: process.getuid!(), gid: process.getgid!() };
const command = measure === 'cores' ? "sh -c 'while :; do :; done' & wait" : 'sleep 300 & wait';
const { child } = launch(dir, 'command', 'sh', ['-c', command], { env: { PATH: process.env.PATH } });
child.stdin!.end();
let procs = await processesFor([owner]);
while (!procs.some(p => p.ppid === child.pid)) {
  await sleep(10);
  procs = await processesFor([owner]);
}
const run = procs.filter(p => p.pid === child.pid || p.ppid === child.pid);
const block: Block = {
  uid: owner.uid,
  measure: measure as Block['measure'],
  used: measure === 'memory' ? 3100 : measure === 'processes' ? 512 : 8,
  share: measure === 'memory' ? 2560 : measure === 'processes' ? 400 : 4,
  root: run.find(p => p.pid === child.pid)!,
  run,
};
const reload = new Reload();
const reasons: string[] = [];
// Observe the real fetch failure after its retry delay has begun.
subscribe('undici:request:error', () => setImmediate(() => process.send!({ lost: true })));
const options = {
  checking: new Map([[child.pid!, reasons]]),
  stopped: () => process.send!({ stopped: 'admitted', reasons }),
  ask: hqReports(url).blocked,
};
reload.listen(
  {
    stopping: () => false,
    start: () => {
      process.send!({ reloading: true });
      // A share sample that completed after reload began must not admit another stop.
      void reload.block(owner, block, procs, {
        ...options,
        stopped: () => process.send!({ stopped: 'refused' }),
      });
    },
    ready: () => {
      if (mode === 'error-ready') throw new Error('Cannot inspect run state');
      return true;
    },
    keep: () => {
      if (mode === 'error-keep') throw new Error('Cannot write run record');
      process.send!({ kept: true });
    },
    finish: () => process.send!({ finished: true }),
    failed: (err: unknown) => process.send!({ failed: String(err) }),
  },
  mode === 'deadline-delay' || mode === 'deadline-request' ? 0 : 10 * 60_000,
);
process.send!({ run, block });
void reload
  .block(owner, block, procs, options)
  .catch(err => process.send!({ blockFailed: String(err), cause: String(err.cause) }));
