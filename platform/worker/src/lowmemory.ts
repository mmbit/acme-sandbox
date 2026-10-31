// Whether the worker is really short of memory now, and which job brought it there: HQ tells every running agent so,
// once a spell (the coordinator's lowmemory.ts), and nudges that job. It stops, blocks or retries nothing.
// Under lowMb free is low. It's calm again at clearMb or more, and in between it stays as it was, so a spell doesn't
// flap. The job that took the most since the last calm look is the spell's cause, if that's a third of what was free
// then: 2 GB of 5 is pushing it, while a gigabyte each across many jobs has no one cause.
import type { AdmissionInput } from './admission.ts';

export type MemorySource = { free: AdmissionInput | null; room: AdmissionInput | null };
export type CalmBaseline = {
  kind: 'initial stand-in' | 'calm';
  freeMb: number;
  uses: Record<string, number>;
  source: MemorySource | null;
};
export type MemoryVerdict = 'low' | 'between' | 'calm';
export type MemoryCause = { job: number; tookMb: number; freeMb: number };
const CAUSE_SHARE = 1 / 3;

// A watch over the worker's looks: each look's free memory (MB) and every job's use (MB, by job), its verdict, and on a
// low look the job that caused it. The first look is calm's stand-in until a calm one comes.
export function memoryWatch(lowMb: number, clearMb: number) {
  let baseline: CalmBaseline | null = null;
  const watch = (
    freeMb: number,
    uses: Map<number, number>,
    source?: MemorySource,
  ): { verdict: MemoryVerdict; cause?: MemoryCause } => {
    if (!baseline || freeMb >= clearMb) {
      baseline = structuredClone({
        kind: freeMb >= clearMb ? 'calm' : 'initial stand-in',
        freeMb,
        uses: Object.fromEntries(uses),
        source: source ?? null,
      });
    }
    if (freeMb >= clearMb) return { verdict: 'calm' };
    if (freeMb >= lowMb) return { verdict: 'between' };
    const took = [...uses].map(([job, mb]) => ({ job, tookMb: mb - (baseline!.uses[job] ?? 0) }));
    const most = took.sort((a, b) => b.tookMb - a.tookMb)[0];
    const cause =
      most && most.tookMb >= baseline.freeMb * CAUSE_SHARE ? { ...most, freeMb: baseline.freeMb } : undefined;
    return { verdict: 'low', ...(cause && { cause }) };
  };
  return Object.assign(watch, {
    inspect: () => (baseline ? { freeMb: baseline.freeMb, uses: { ...baseline.uses } } : null),
    baseline: () => structuredClone(baseline),
  });
}
