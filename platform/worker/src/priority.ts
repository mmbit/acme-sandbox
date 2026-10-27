// Lowers a busy job's priority, and blocks its busiest run when the helper that would lower it is killed or times out.
import type { Ids } from './slots.ts';
import { procStat } from './detached.ts';
import { coresBlock, overShare, slowDown, type JobUse, type ShareLimits, type Block } from './shares.ts';

// A job counts only its processes still alive, so a run another block of this look ended is neither counted nor picked.
export async function enforcePriority(
  jobs: Required<Ids>[],
  uses: Map<number, JobUse>,
  cli: Set<number>,
  limits: ShareLimits,
  selected: Pick<ReturnType<typeof overShare>, 'slow' | 'groups'>,
): Promise<Block[]> {
  const interrupted = await slowDown(jobs, selected.slow, selected.groups);
  return [...interrupted].flatMap(uid => {
    const use = uses.get(uid)!;
    const processes = use.processes.filter(p => {
      const current = procStat(p.pid);
      return current?.start === p.start && current.state !== 'Z';
    });
    const cores = processes.reduce((sum, p) => sum + (p.cores ?? 0), 0);
    const hasUnprotectedProcess = processes.some(p => !cli.has(p.pid));
    if (cores > limits.cores && hasUnprotectedProcess) {
      return [coresBlock({ ...use, cores, processes }, cli, limits.cores)];
    }
    return [];
  });
}
