// Stops a run past its share and attributes it to its push check before asking HQ for the report.
import { randomUUID } from 'node:crypto';
import { procStat } from './detached.ts';
import { ResponseError } from './reports.ts';
import { commandOf, stopRun, type Block, type ProcessSnapshot } from './shares.ts';

type BlockOptions = {
  ask: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<{ text: string }>;
  checking: Map<number, string[]>;
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
  const reason = `the worker blocked its run ${block.root.pid} (the job's ${used}, past a job's share of ${share})`;
  const parent = new Map(procs.map(p => [p.pid, p.ppid]));
  for (let pid: number | undefined = block.root.pid; pid !== undefined; pid = parent.get(pid))
    options.checking.get(pid)?.push(reason);
  const body = {
    event: randomUUID(),
    job: owner.job,
    measure: block.measure,
    used: block.used,
    share: block.share,
    command: commandOf(live),
  };
  try {
    await stopRun(live, owner, block.root, () => options.ask(body));
  } catch (err) {
    if (err instanceof ResponseError) throw err;
    throw new Error(`Job #${owner.job}: HQ's block report outcome is unknown. HQ may have recorded it.`, {
      cause: err,
    });
  } finally {
    options.stopped(
      `job #${owner.job}: blocked its run ${block.root.pid} (${live.length} processes), ${used} past ${share}`,
    );
  }
}

const shareWords = (measure: Block['measure'], n: number) =>
  measure === 'memory'
    ? `${Math.round(n)} MB`
    : measure === 'cores'
      ? `${Math.round(n * 10) / 10} cores`
      : `${n} processes`;
