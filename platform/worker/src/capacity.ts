// Content-free worker measurements, using the same process look as the share protections.
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import type { JobUse } from './shares.ts';
import type { SeatState } from './worker.ts';
import { decimal, readCgroup, workerMemory } from './memory.ts';

type Occupant = { job: number; slot: string; uid: number; seat: string; engine: string; kind: string; cliPid?: number };
type Look = {
  at: number;
  intervalMs: number;
  occupants: Occupant[];
  uses: Map<number, JobUse>;
  seats: {
    id: string;
    engine: string;
    occupiedOrHeld: number;
    limit: number | null;
    state: SeatState;
    windowUsed: number | null;
    eligible: boolean;
  }[];
  starting: number;
  held: number;
  reservationMb: number;
  host: { availableBytes: number; swapInPages: number; swapOutPages: number };
};

export function capacitySample(look: Look, read = readCgroup, measure = workerMemory) {
  return {
    at: look.at,
    intervalMs: look.intervalMs,
    host: look.host,
    ...measure(look.host.availableBytes),
    swapCurrentBytes: decimal(read('memory.swap.current')),
    swapMaxBytes: read('memory.swap.max'),
    swapEvents: read('memory.swap.events'),
    cpuMax: read('cpu.max'),
    cpuset: read('cpuset.cpus.effective'),
    cpuStat: read('cpu.stat'),
    cpuPressure: read('cpu.pressure'),
    ioPressure: read('io.pressure'),
    starting: look.starting,
    held: look.held,
    reservationMb: look.reservationMb,
    seats: look.seats,
    jobs: look.occupants.map(occupant => occupancy(occupant, look.uses.get(occupant.uid))),
  };
}

// The requested number bounds attempts too: a failed measurement consumes its place in the trial.
export function capacityCapture(samples: number, log: (line: string) => void, folder: string) {
  if (!Number.isSafeInteger(samples) || samples < 0)
    throw new Error('Capacity sample count must be a nonnegative safe integer');
  let remaining = samples,
    written = 0;
  let files = samples ? captureFiles(folder) : undefined;
  const note = (line: string) => {
    try {
      files?.note(line);
    } catch (error) {
      log(`Capacity log failed: ${error}`);
    }
  };
  const report = (line: string) => {
    note(line);
    log(line);
  };
  const end = (reason = 'attempt budget exhausted') => {
    if (!files) return;
    report(`Capacity trial ended: ${written}/${samples} samples, ${samples - remaining} attempts, ${reason}`);
    remaining = 0;
    files = undefined;
  };
  if (files)
    report(`Capacity trial: capturing ${samples} attempts in ${folder}/samples.jsonl, code ${process.argv[1]}`);
  return {
    note,
    end,
    record(measure: () => ReturnType<typeof capacitySample>) {
      if (!remaining) return;
      remaining--;
      try {
        files!.sample(measure());
        written++;
      } catch (error) {
        note(`Capacity sample failed: ${error}`);
        throw error;
      } finally {
        if (!remaining) end();
      }
    },
  };
}

// A code reload appends a separately identified run instead of erasing an interrupted capture.
function captureFiles(folder: string) {
  mkdirSync(folder, { recursive: true, mode: 0o755 });
  chmodSync(folder, 0o755);
  const samples = join(folder, 'samples.jsonl'),
    journal = join(folder, 'capture.log');
  for (const path of [samples, journal]) {
    closeSync(openSync(path, 'a', 0o644));
    chmodSync(path, 0o644);
  }
  return {
    sample: (sample: ReturnType<typeof capacitySample>) =>
      appendFileSync(samples, JSON.stringify({ ...sample, workerPid: process.pid }) + '\n'),
    note: (line: string) => appendFileSync(journal, `${new Date().toISOString()} worker ${process.pid}: ${line}\n`),
  };
}

function occupancy(occupant: Occupant, use: JobUse | undefined) {
  const processes = use?.processes ?? [];
  const pss = processes.filter(p => p.memoryMeasure === 'pss');
  const largest = processes.reduce<(typeof processes)[number] | undefined>(
    (top, p) => (!top || p.memoryMb > top.memoryMb ? p : top),
    undefined,
  );
  return {
    job: occupant.job,
    slot: occupant.slot,
    uid: occupant.uid,
    seat: occupant.seat,
    engine: occupant.engine,
    kind: occupant.kind,
    cliPid: occupant.cliPid,
    cliPresent: processes.some(p => p.pid === occupant.cliPid),
    processes: processes.length,
    pssProcesses: pss.length,
    pssMb: pss.length ? pss.reduce((sum, p) => sum + p.memoryMb, 0) : null,
    rssMb:
      processes.length && processes.every(p => p.rssMb !== undefined)
        ? processes.reduce((sum, p) => sum + p.rssMb!, 0)
        : null,
    accountedMb: use?.memoryMb ?? null,
    cores: use?.cores ?? null,
    largest: largest
      ? {
          pid: largest.pid,
          name: largest.comm,
          mb: largest.memoryMb,
          measure: largest.memoryMeasure,
          rssMb: largest.rssMb ?? null,
        }
      : null,
  };
}
