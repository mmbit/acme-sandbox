// Enforces one resource look, with disk sampling after memory, process and CPU stops.
import type { Ids } from './slots.ts';
import type { DiskUse } from './disk.ts';
import { sampleWrites } from './diskwrites.ts';
import { enforcePriority } from './priority.ts';
import { overShare, tally, type Block, type JobUse, type ProcessSnapshot, type ShareLimits } from './shares.ts';

type SharePass = {
  jobs: Required<Ids>[];
  procs: ProcessSnapshot[];
  previous: ProcessSnapshot[];
  intervalMs: number;
  uses: Map<number, JobUse>;
  cli: Set<number>;
  limits: ShareLimits;
  pending: Set<string>; // the session groups asked for, carried to the next look (overShare)
  hotSince: Map<number, number>;
  applyBlock: (block: Block | undefined) => Promise<void>;
  disk: (uses: Map<number, JobUse>) => Promise<Map<number, DiskUse>>;
};

export async function enforceShares(pass: SharePass) {
  const { jobs, procs, previous, intervalMs, uses, cli, limits, hotSince } = pass;
  const { block: selectedBlock, slow, groups, pending: stillPending } = overShare(uses, cli, limits, pass.pending);
  pass.pending.clear();
  for (const group of stillPending) pass.pending.add(group);
  await pass.applyBlock(selectedBlock);
  if (selectedBlock?.measure === 'cores') hotSince.delete(selectedBlock.uid);
  const priorityBlocks = await enforcePriority(jobs, uses, cli, limits, { slow, groups });
  for (const priorityBlock of priorityBlocks) {
    await pass.applyBlock(priorityBlock);
    hotSince.delete(priorityBlock.uid);
  }
  // Descriptor sampling cannot delay this pass's memory, process or CPU enforcement.
  await sampleWrites(procs, jobs);
  const diskUses = tally(procs, previous, intervalMs);
  const disk = await pass.disk(diskUses);
  if (!selectedBlock && !priorityBlocks.length)
    await pass.applyBlock(overShare(diskUses, cli, { ...limits, disk }).block);
}
