// Stops a run past its share and attributes it to its push check before asking HQ for the report.
import { workerAccountingFailure } from './accounting.ts';
import { randomUUID } from 'node:crypto';
import { procStat, type CheckRun, type Launched } from './detached.ts';
import { ResponseError } from './reports.ts';
import type { Block, ProcessSnapshot } from './shares.ts';
import { commandOf, stopRun } from './stoprun.ts';

type BlockOptions = {
  launches?: Launched[];
  ask: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<{ text: string }>;
  checking: Map<number, CheckRun>;
  log: (text: string) => void;
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
  const processes = new Map(procs.map(p => [p.pid, p]));
  let launched: Launched | undefined;
  for (let pid: number | undefined = block.root.pid; pid !== undefined; pid = processes.get(pid)?.ppid) {
    launched ??= options.launches?.find(launch => launch.pid === pid && launch.start === processes.get(pid)?.start);
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
  const log = (words: string) => options.log(`job #${owner.job}: ${words}`);
  try {
    const ask = () => askBlockReport(owner.job, body, options.ask);
    await stopRun(live, owner, block.root, ask, log, launched?.tmpdir);
  } finally {
    options.log(
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

async function askBlockReport(job: number, body: Record<string, unknown>, ask: BlockOptions['ask']) {
  try {
    return await ask(body);
  } catch (err) {
    if (err instanceof ResponseError) throw err;
    throw new Error(`Job #${job}: HQ's block report outcome is unknown. HQ may have recorded it.`, { cause: err });
  }
}
