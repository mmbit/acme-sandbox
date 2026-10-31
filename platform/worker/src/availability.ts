// Pure reclaim-aware availability from live or recorded memory readings.
export const QUIET_MS = 10_000; // PSI's shortest reported averaging window.
// Admission stops when tasks stall on memory at least a tenth of the ten-second average.
export const PRESSURE_PERCENT = 10;

export function pressureReading(memoryPressure: string, memoryEvents: string, previousOomEvents: number[] | null) {
  const some = memoryPressure.match(/^some avg10=([\d.]+)/m);
  if (!some) throw new Error('Memory pressure has no some reading');
  const someAvg10 = Number(some[1]);
  const oomEvents = ['oom', 'oom_kill'].map(name => cgroupField(memoryEvents, name));
  const newOomEvent = previousOomEvents !== null && oomEvents.some((count, index) => count > previousOomEvents[index]);
  return { someAvg10, psiThreshold: someAvg10 >= PRESSURE_PERCENT, oomEvents, newOomEvent };
}

type MemoryReading = {
  memoryCurrentBytes: number;
  memoryMaxBytes: string;
  raw: { file: number; shmem: number; file_dirty: number; file_writeback: number; unevictable: number };
};

export function memoryAvailability(reading: MemoryReading, hostAvailableBytes: number, underPressure: boolean) {
  const { memoryCurrentBytes, memoryMaxBytes, raw } = reading;
  // File includes tmpfs. Dirty, writeback and locked pages cannot be treated as immediately free.
  const retainedFileBytes = raw.shmem + raw.file_dirty + raw.file_writeback + raw.unevictable;
  const reclaimableFileBytes = Math.min(memoryCurrentBytes, Math.max(0, raw.file - retainedFileBytes));
  const heldBytes = memoryCurrentBytes - reclaimableFileBytes;
  const cap = memoryMaxBytes === 'max' ? Infinity : Number(memoryMaxBytes);
  const availableBytes = underPressure ? 0 : Math.min(hostAvailableBytes, cap - heldBytes);
  return { reclaimableFileBytes, heldBytes, availableBytes };
}

export function cgroupField(text: string, name: string) {
  const reading = text.match(new RegExp(`^${name} (\\d+)$`, 'm'));
  if (!reading) throw new Error(`Memory measurement has no ${name} reading`);
  return decimal(reading[1]);
}

export function decimal(text: string) {
  if (!/^\d+$/.test(text)) throw new Error(`Invalid memory measurement: ${text}`);
  return Number(text);
}
