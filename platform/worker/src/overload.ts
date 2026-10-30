// Measured server pressure for the existing next-step alert. It changes no admission or share rule.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryWatch, type MemoryCause, type MemoryVerdict } from './lowmemory.ts';

type Reading = { freeMb: number; uses: Map<number, number>; room: boolean };
export type Pressure = {
  verdict: MemoryVerdict;
  cause?: MemoryCause;
  reasons: string[];
  inputs: {
    readStartedAt: number;
    readEndedAt: number;
    freeMb: number;
    room: boolean;
    uses: Record<string, number>;
    memoryVerdict: MemoryVerdict;
    calm: { freeMb: number; uses: Record<string, number> } | null;
    lowMb: number;
    clearMb: number;
    hostCpuPressure: string;
    workerCpuPressure: string;
    cpuBusy: boolean;
  };
};

export function overloadWatch(lowMb: number, clearMb: number, cgroup = '/sys/fs/cgroup', host = '/proc/pressure/cpu') {
  const memoryOf = memoryWatch(lowMb, clearMb);
  let cpuBusy = false;
  return ({ freeMb, uses, room }: Reading): Pressure => {
    const readStartedAt = Date.now();
    const memory = memoryOf(freeMb, uses);
    const hostCpuPressure = readFileSync(host, 'utf8'),
      workerCpuPressure = readFileSync(join(cgroup, 'cpu.pressure'), 'utf8');
    const cpu = Math.max(cpuStall(hostCpuPressure), cpuStall(workerCpuPressure));
    // PSI measures time with runnable work unable to get a processor. Warn when contention fills at least half
    // the measured time. Clear below one third, when time without contention is at least twice time with it.
    cpuBusy = cpu >= 100 / 2 || (cpuBusy && cpu > 100 / 3);
    const reasons = [];
    if (memory.verdict === 'low') reasons.push(`memory short: ${(freeMb / 1024).toFixed(1)} GB free`);
    if (!room) reasons.push('the worker has no room for another check');
    if (cpuBusy) reasons.push(`CPU pressure ${cpu.toFixed(0)}% over ten seconds`);
    const verdict = reasons.length ? 'low' : memory.verdict;
    if (verdict === 'between') reasons.push(`memory recovering: ${(freeMb / 1024).toFixed(1)} GB free`);
    return {
      verdict,
      ...(memory.cause && { cause: memory.cause }),
      reasons,
      inputs: {
        readStartedAt,
        readEndedAt: Date.now(),
        freeMb,
        room,
        uses: Object.fromEntries(uses),
        memoryVerdict: memory.verdict,
        calm: memoryOf.inspect(),
        lowMb,
        clearMb,
        hostCpuPressure,
        workerCpuPressure,
        cpuBusy,
      },
    };
  };
}

function cpuStall(pressure: string) {
  const reading = pressure.match(/^some avg10=([\d.]+)/m);
  if (!reading) throw new Error('CPU pressure has no some avg10 reading');
  return Number(reading[1]);
}
