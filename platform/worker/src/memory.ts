// Reclaim-aware worker memory, with a shared pressure brake for admission and diagnostics.
import { readFileSync } from 'node:fs';
import { immutable } from './immutable.ts';
import { memoryAvailability, pressureReading, cgroupField, decimal, QUIET_MS } from './availability.ts';
import { recordIdentity, type RecordIdentity } from './roomrecords.ts';

export { decimal, QUIET_MS, PRESSURE_PERCENT } from './availability.ts';

export const readCgroup = (name: string) => readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim();
export const workerMemory = memoryMeter();

export type QuietObservation = {
  identity: RecordIdentity;
  readStartedAt: number;
  readEndedAt: number;
  sequence: number;
};
export type QuietPredecessor = {
  first: QuietObservation;
  last: QuietObservation;
  observedReadCount: number;
  initialPreviousOomEvents: number[] | null;
  previousOomEvents: number[] | null;
};
export type PressureTrigger = QuietObservation & {
  pressureUntil: number;
  psiThreshold: boolean;
  someAvg10: number;
  memoryPressure: string;
  memoryEvents: string;
  newOomEvent: boolean;
  previousOomEvents: number[] | null;
  oomEvents: number[];
};
type MeterEvidence = {
  quiet: QuietPredecessor | null;
  lastPressureTrigger: PressureTrigger | null;
  sequence: number;
};

export function memoryMeter(read = readCgroup, now = Date.now) {
  let previousEvents: number[] | null = null;
  let pressureUntil = 0;
  const evidence: MeterEvidence = { quiet: null, lastPressureTrigger: null, sequence: 0 };
  return (hostAvailableBytes: number) => {
    const { identity, readStartedAt, reading, at } = readMeasurement(read, now);
    const { memoryEvents, memoryPressure } = reading;
    const pressure = pressureReading(memoryPressure, memoryEvents, previousEvents);
    // High/max events and tiny stalls can accompany successful cache reclaim.
    // They caused the all-night 0 MB false brake on 30 October. Only failed allocation or sustained stalls hold room.
    if (pressure.newOomEvent || pressure.psiThreshold) pressureUntil = at + QUIET_MS;
    const previousOomEvents = previousEvents;
    previousEvents = pressure.oomEvents;
    const underPressure = at < pressureUntil;
    const observation = { identity, readStartedAt, readEndedAt: at, sequence: ++evidence.sequence };
    const quietPredecessor = observeQuiet(evidence, observation, {
      pressureUntil,
      ...pressure,
      memoryPressure,
      memoryEvents,
      previousOomEvents,
    });
    return {
      identity,
      readStartedAt,
      readEndedAt: at,
      hostAvailableBytes,
      ...reading,
      ...memoryAvailability(reading, hostAvailableBytes, underPressure),
      pressureUntil,
      previousOomEvents,
      newOomEvent: pressure.newOomEvent,
      underPressure,
      quietPredecessor,
      lastPressureTrigger: evidence.lastPressureTrigger,
    };
  };
}

function readMeasurement(read: typeof readCgroup, now: () => number) {
  const identity = recordIdentity(),
    readStartedAt = now();
  const reading = readMemory(read);
  const at = now();
  return { identity, readStartedAt, reading, at };
}

function observeQuiet(
  evidence: MeterEvidence,
  observation: QuietObservation,
  trigger: Omit<PressureTrigger, keyof QuietObservation>,
) {
  if (trigger.psiThreshold || trigger.newOomEvent) {
    evidence.quiet = null;
    evidence.lastPressureTrigger = immutable({ ...observation, ...trigger });
    return null;
  }
  if (observation.readEndedAt < trigger.pressureUntil) return null;
  const predecessor = evidence.quiet;
  evidence.quiet = immutable({
    first: predecessor?.first ?? observation,
    last: observation,
    observedReadCount: (predecessor?.observedReadCount ?? 0) + 1,
    initialPreviousOomEvents: predecessor ? predecessor.initialPreviousOomEvents : trigger.previousOomEvents,
    previousOomEvents: trigger.previousOomEvents,
  });
  return predecessor;
}

function readMemory(read: typeof readCgroup) {
  const memoryCurrentBytes = decimal(read('memory.current'));
  const memoryMaxBytes = read('memory.max');
  if (memoryMaxBytes !== 'max') decimal(memoryMaxBytes);
  const stat = read('memory.stat');
  const memoryEvents = read('memory.events');
  const memoryPressure = read('memory.pressure');
  const activeFile = stat.match(/^active_file (\d+)$/m)?.[1];
  const raw = {
    file: cgroupField(stat, 'file'),
    active_file: activeFile === undefined ? null : decimal(activeFile),
    shmem: cgroupField(stat, 'shmem'),
    file_dirty: cgroupField(stat, 'file_dirty'),
    file_writeback: cgroupField(stat, 'file_writeback'),
    unevictable: cgroupField(stat, 'unevictable'),
  };
  return { memoryCurrentBytes, memoryMaxBytes, raw, memoryEvents, memoryPressure };
}

// Startup logs tolerate an unknown limit. Required admission and capacity reads still throw.
export function cgroup(name: string) {
  try {
    return readCgroup(name);
  } catch {
    return '';
  }
}
