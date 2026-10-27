// Shared real commands, receipts and production passes for disposable interruption fixtures.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { procStat } from './detached.ts';
import type { DiskUse } from './disk.ts';
import { enforceShares } from './sharepass.ts';
import { processesFor, tally, type Block, type JobUse, type ProcessSnapshot, type ShareLimits } from './shares.ts';
import { Reload } from './reload.ts';
import type { Ids } from './slots.ts';

export const ids = { uid: process.getuid!(), gid: process.getgid!() };
export const limits = {
  mostMb: Infinity,
  shareMb: Infinity,
  cores: Infinity,
  processes: Infinity,
  starved: false,
  workerSessionId: procStat(process.pid)!.sid,
};
export type Command = { child: ChildProcessWithoutNullStreams; ended: Promise<unknown[]>; stopped: string[] };
type PassOptions = {
  limits: ShareLimits;
  cli?: Set<number>;
  disk?: (uses: Map<number, JobUse>) => Promise<Map<number, DiskUse>>;
};

export function shareFixture(jobs: Required<Ids>[] = [ids]) {
  // One sample cadence bounds a pass, including a helper's existing ten-second timeout.
  const watchdog = setTimeout(() => {
    throw new Error('Resource enforcement missed its next sample');
  }, 15_000);
  const commands: Command[] = [];
  const receipts: Record<string, unknown>[] = [];
  const reload = new Reload();
  const hotSince = new Map(jobs.map(job => [job.uid, Date.now()]));
  const pending = new Set<string>();
  const track = (child: ChildProcessWithoutNullStreams) => {
    const command = { child, ended: once(child, 'close'), stopped: [] as string[] };
    commands.push(command);
    return command;
  };
  const snapshots = async () => {
    const pids = new Set(commands.map(command => command.child.pid));
    return (await processesFor(jobs)).filter(p => pids.has(p.pid));
  };
  const applyBlock = (block: Block | undefined, procs: ProcessSnapshot[]) =>
    stopCommand({ jobs, commands, receipts, reload }, block, procs);
  const pass = (procs: ProcessSnapshot[], previous: ProcessSnapshot[], options: PassOptions) =>
    enforceShares({
      jobs,
      procs,
      previous,
      intervalMs: 1000,
      uses: tally(procs, previous, 1000),
      cli: options.cli ?? new Set(),
      limits: options.limits,
      pending,
      hotSince,
      applyBlock: block => applyBlock(block, procs),
      disk: options.disk ?? (async () => new Map()),
    });
  const close = async () => {
    clearTimeout(watchdog);
    for (const command of commands) command.child.kill('SIGKILL');
    await Promise.all(commands.map(command => command.ended));
  };
  return { track, snapshots, pass, receipts, hotSince, close };
}

async function stopCommand(
  fixture: { jobs: Required<Ids>[]; commands: Command[]; receipts: Record<string, unknown>[]; reload: Reload },
  block: Block | undefined,
  procs: ProcessSnapshot[],
) {
  if (!block) return;
  const { commands, receipts, reload } = fixture;
  const owner = fixture.jobs.find(job => job.uid === block.uid)!;
  await reload.block({ job: 1, ...owner }, block, procs, {
    checking: new Map(commands.map(command => [command.child.pid!, { stopped: command.stopped }])),
    stopped: () => {},
    ask: async body => {
      receipts.push(body);
      return { text: 'Resource share exceeded' };
    },
  });
  await commands.find(command => command.child.pid === block.root.pid)!.ended;
}
