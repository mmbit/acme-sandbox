// Measured server pressure for the existing next-step alert. It changes no admission or share rule.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryWatch, type MemoryCause, type MemoryVerdict } from './lowmemory.ts';

type Reading = { freeMb: number; uses: Map<number, number>; room: boolean };
export type Pressure = { verdict: MemoryVerdict; cause?: MemoryCause; reasons: string[] };

export function overloadWatch(lowMb: number, clearMb: number, cgroup = '/sys/fs/cgroup', host = '/proc/pressure/cpu') {
  const memoryOf = memoryWatch(lowMb, clearMb);
  let cpuBusy = false;
  return ({ freeMb, uses, room }: Reading): Pressure => {
    const memory = memoryOf(freeMb, uses);
    const cpu = Math.max(
      cpuStall(readFileSync(host, 'utf8')),
      cpuStall(readFileSync(join(cgroup, 'cpu.pressure'), 'utf8')),
    );
    // PSI measures time with runnable work unable to get a processor. Warn when contention fills at least half
    // the measured time. Clear below one third, when time without contention is at least twice time with it.
    cpuBusy = cpu >= 100 / 2 || (cpuBusy && cpu > 100 / 3);
    const reasons = [];
    if (memory.verdict === 'low') reasons.push(`memory short: ${(freeMb / 1024).toFixed(1)} GB free`);
    if (!room) reasons.push('the worker has no room for another check');
    if (cpuBusy) reasons.push(`CPU pressure ${cpu.toFixed(0)}% over ten seconds`);
    const verdict = reasons.length ? 'low' : memory.verdict;
    if (verdict === 'between') reasons.push(`memory recovering: ${(freeMb / 1024).toFixed(1)} GB free`);
    return { verdict, ...(memory.cause && { cause: memory.cause }), reasons };
  };
}

function cpuStall(pressure: string) {
  const reading = pressure.match(/^some avg10=([\d.]+)/m);
  if (!reading) throw new Error('CPU pressure has no some avg10 reading');
  return Number(reading[1]);
}
