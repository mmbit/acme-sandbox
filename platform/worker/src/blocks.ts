// Stops a run past its share and attributes it to its push check before asking HQ for the report.
import { workerAccountingFailure } from './accounting.ts';
import { randomUUID } from 'node:crypto';
import { procStat, type CheckRun } from './detached.ts';
import { ResponseError } from './reports.ts';
import type { Block, ProcessSnapshot } from './shares.ts';
import { commandOf, stopRun } from './stoprun.ts';

type BlockOptions = {
  ask: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<{ text: string }>;
  checking: Map<number, CheckRun>;
  stopped: (text: string) => void;
};

export async function blockRun(
  owner: { job: number; uid: number; gid: number },
  block: Block,
  procs: ProcessSnapshot[],
  options: BlockOptions,
) {
  const live = block.run.filter(p => procStat(p.pid)?.start === p.start);
  if (!live.includes(block.root)) return;
  const used = shareWords(block.measure, block.used),
    share = shareWords(block.measure, block.share);
  const reason =
    block.accountingError?.message ??
    `the worker blocked its run ${block.root.pid} (the job's ${used}, past a job's share of ${share})`;
  const parent = new Map(procs.map(p => [p.pid, p.ppid]));
  for (let pid: number | undefined = block.root.pid; pid !== undefined; pid = parent.get(pid)) {
    const check = options.checking.get(pid);
    if (!check) continue;
    check.stopped.push(reason);
    if (block.starved) check.roomStops = (check.roomStops ?? 0) + 1;
    else if (block.accountingError && workerAccountingFailure(block.accountingError.reason))
      check.platformStops = (check.platformStops ?? 0) + 1;
  }
  const body = {
    event: randomUUID(),
    job: owner.job,
    measure: block.measure,
    used: block.used,
    share: block.share,
    command: commandOf(live),
    accountingError: block.accountingError,
  };
  // A run not frozen whole, said in the worker's log.
  const said = (words: string) => options.stopped(`job #${owner.job}: ${words}`);
  try {
    await stopRun(live, owner, block.root, () => options.ask(body), said);
  } catch (err) {
    if (err instanceof ResponseError) throw err;
    throw new Error(`Job #${owner.job}: HQ's block report outcome is unknown. HQ may have recorded it.`, {
      cause: err,
    });
  } finally {
    options.stopped(
      block.accountingError
        ? `job #${owner.job}: ${block.accountingError.message}`
        : `job #${owner.job}: blocked its run ${block.root.pid} (${live.length} processes), ${used} past ${share}`,
    );
  }
}

const shareWords = (measure: Block['measure'], n: number | null) =>
  n === null
    ? 'unknown disk use'
    : measure === 'disk'
      ? `${(n / 2 ** 30).toFixed(2)} GiB of disk`
      : measure === 'memory'
        ? `${Math.round(n)} MB`
        : measure === 'cores'
          ? `${Math.round(n * 10) / 10} cores`
          : `${n} processes`;
