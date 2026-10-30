// Reclaim-aware worker memory, with a shared pressure brake for admission and diagnostics.
import { readFileSync } from 'node:fs';
import { recordIdentity } from './roomrecords.ts';

export const readCgroup = (name: string) => readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim();
export const QUIET_MS = 10_000; // PSI's shortest reported averaging window.
// Admission stops when tasks stall on memory at least a tenth of the ten-second average.
export const PRESSURE_PERCENT = 10;
export const workerMemory = memoryMeter();

export function memoryMeter(read = readCgroup, now = Date.now) {
  let previousEvents: number[] | undefined;
  let pressureUntil = 0;
  return (hostAvailableBytes: number) => {
    const identity = recordIdentity(),
      readStartedAt = now();
    const reading = readMemory(read);
    const { memoryEvents, memoryPressure } = reading;
    const events = ['oom', 'oom_kill'].map(name => field(memoryEvents, name));
    const at = now();
    const someAvg10 = memoryPressure.match(/^some avg10=([\d.]+)/m);
    if (!someAvg10) throw new Error('Memory pressure has no some reading');
    const newEvent = previousEvents && events.some((count, i) => count > previousEvents![i]);
    // High/max events and tiny stalls can accompany successful cache reclaim.
    // They caused the all-night 0 MB false brake on 30 October. Only failed allocation or sustained stalls hold room.
    if (newEvent || Number(someAvg10[1]) >= PRESSURE_PERCENT) pressureUntil = at + QUIET_MS;
    const previousOomEvents = previousEvents;
    previousEvents = events;
    const underPressure = at < pressureUntil;
    return {
      identity,
      readStartedAt,
      readEndedAt: at,
      hostAvailableBytes,
      ...reading,
      ...memoryAvailability(reading, hostAvailableBytes, underPressure),
      pressureUntil,
      previousOomEvents: previousOomEvents ?? null,
      newOomEvent: !!newEvent,
      underPressure,
    };
  };
}

function readMemory(read: typeof readCgroup) {
  const memoryCurrentBytes = decimal(read('memory.current'));
  const memoryMaxBytes = read('memory.max');
  const stat = read('memory.stat');
  const memoryEvents = read('memory.events');
  const memoryPressure = read('memory.pressure');
  const activeFile = stat.match(/^active_file (\d+)$/m)?.[1];
  const raw = {
    file: field(stat, 'file'),
    active_file: activeFile === undefined ? null : decimal(activeFile),
    shmem: field(stat, 'shmem'),
    file_dirty: field(stat, 'file_dirty'),
    file_writeback: field(stat, 'file_writeback'),
    unevictable: field(stat, 'unevictable'),
  };
  return { memoryCurrentBytes, memoryMaxBytes, raw, memoryEvents, memoryPressure };
}

function memoryAvailability(
  reading: ReturnType<typeof readMemory>,
  hostAvailableBytes: number,
  underPressure: boolean,
) {
  const { memoryCurrentBytes, memoryMaxBytes, raw } = reading;
  // File includes tmpfs. Dirty, writeback and locked pages cannot be treated as immediately free.
  const retainedFileBytes = raw.shmem + raw.file_dirty + raw.file_writeback + raw.unevictable;
  const reclaimableFileBytes = Math.min(memoryCurrentBytes, Math.max(0, raw.file - retainedFileBytes));
  const heldBytes = memoryCurrentBytes - reclaimableFileBytes;
  const cap = memoryMaxBytes === 'max' ? Infinity : decimal(memoryMaxBytes);
  const availableBytes = underPressure ? 0 : Math.min(hostAvailableBytes, cap - heldBytes);
  return { reclaimableFileBytes, heldBytes, availableBytes };
}

function field(text: string, name: string) {
  const reading = text.match(new RegExp(`^${name} (\\d+)$`, 'm'));
  if (!reading) throw new Error(`Memory measurement has no ${name} reading`);
  return decimal(reading[1]);
}

export function decimal(text: string) {
  if (!/^\d+$/.test(text)) throw new Error(`Invalid memory measurement: ${text}`);
  return Number(text);
}

// Startup logs tolerate an unknown limit. Required admission and capacity reads still throw.
export function cgroup(name: string) {
  try {
    return readCgroup(name);
  } catch {
    return '';
  }
}
