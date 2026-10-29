// A disk overage reaches the session inbox and every live command's output, leaving cleanup running.
import { randomUUID } from 'node:crypto';
import { procStat } from './detached.ts';
import { runsOf, type JobUse } from './shares.ts';
import { tellRun } from './stoprun.ts';
import type { DiskShares, DiskUse } from './disk.ts';

export async function warnDisk(
  jobs: { job: number; uid: number; gid: number }[],
  disk: Map<number, DiskUse>,
  uses: Map<number, JobUse>,
  cli: Set<number>,
  shares: DiskShares,
  ask: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<{ text: string }>,
) {
  for (const owner of jobs) {
    const use = disk.get(owner.uid)!;
    if (use.accountingError || use.used === null || use.used <= use.share || use.warned) continue;
    const roots = [...runsOf(uses.get(owner.uid)?.processes ?? [], cli).keys()];
    const body = {
      event: randomUUID(),
      job: owner.job,
      measure: 'disk',
      ...use,
      warning: true,
    };
    const { text } = await ask(body, AbortSignal.timeout(5_000));
    shares.warned(owner.job);
    for (const root of roots) if (procStat(root.pid)?.start === root.start) await tellRun(owner, root, text);
  }
}
