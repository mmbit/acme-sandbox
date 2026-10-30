// Worker admission from reclaim-aware memory and startup/meeting reservations.
import { readFileSync } from 'node:fs';
import { reservations, FREE_MB, JOB_MB, SEAT_MB } from './reserve.ts';
import { workerMemory } from './memory.ts';

export type AdmissionInput = {
  phase?: 'watch' | 'report' | 'selection';
  operation: string;
  young: boolean;
  measurement: ReturnType<typeof workerMemory>;
  readStartedAt: number;
  readEndedAt: number;
  reserves: {
    starting: { until: number; mb: number }[] | null;
    heldSlots: number;
    heldMb: number;
    freeReserveMb: number;
    defaultRunMb: number;
  };
  value: number | boolean;
};

export function admission<Seat>(now = Date.now, measure = workerMemory, meminfo = '/proc/meminfo') {
  let startingUsed: { until: number; mb: number }[] | null = null;
  const reserve = reservations<Seat>(now, starting => {
    startingUsed = starting;
  });
  const inspection = inputInspection();
  const use = <Value extends number | boolean>(
    operation: string,
    young: boolean,
    apply: (available: number) => Value,
  ) => {
    const readStartedAt = now();
    const measurement = measure(hostAvailableBytes(meminfo));
    startingUsed = null;
    const value = apply(measurement.availableBytes / 2 ** 20);
    inspection.record({
      operation,
      young,
      measurement,
      readStartedAt,
      readEndedAt: now(),
      value,
      reserves: reservationInputs(startingUsed, reserve.holding.size),
    });
    return value;
  };
  const availableMb = () => use('availableMb', false, available => available);
  return {
    ...reserve,
    availableMb,
    inspect: inspection.inspect,
    freeMb: (young = true) => use('freeMb', young, available => reserve.freeMb(available, young)),
    claimMb: (young = true) => use('claimMb', young, available => reserve.claimMb(available, young)),
    gathering: () => use('gathering', true, available => reserve.gathering(available)),
    starts: (young = true) => use('starts', young, available => reserve.starts(available, young)),
    room: (young = true) => use('room', young, available => reserve.room(available, young)),
  };
}

export const hostAvailableBytes = (meminfo = '/proc/meminfo') =>
  Number(readFileSync(meminfo, 'utf8').match(/^MemAvailable:\s+(\d+)/m)![1]) * 1024;

function reservationInputs(starting: AdmissionInput['reserves']['starting'], heldSlots: number) {
  return { starting, heldSlots, heldMb: heldSlots * SEAT_MB, freeReserveMb: FREE_MB, defaultRunMb: JOB_MB };
}

function inputInspection() {
  let inputs: AdmissionInput[] | undefined;
  return {
    record: (input: AdmissionInput) => inputs?.push(input),
    inspect<Value>(action: () => Value) {
      const previous = inputs;
      inputs = [];
      try {
        return { value: action(), inputs };
      } finally {
        inputs = previous;
      }
    },
  };
}
