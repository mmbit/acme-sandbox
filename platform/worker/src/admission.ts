// Worker admission from reclaim-aware memory and startup/meeting reservations.
import { readFileSync } from 'node:fs';
import { reservations, reservationInputs, type ReservationInputs } from './reserve.ts';
import { workerMemory } from './memory.ts';

export type AdmissionInput = {
  phase?: 'watch' | 'report' | 'selection';
  operation: string;
  young: boolean;
  measurement: ReturnType<typeof workerMemory>;
  readStartedAt: number;
  readEndedAt: number;
  reserves: ReservationInputs;
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
  const measured = (room: typeof reserve.reading) => ({
    freeMb: (young = true) => use('freeMb', young, available => room.freeMb(available, young)),
    claimMb: (young = true) => use('claimMb', young, available => room.claimMb(available, young)),
    gathering: () => use('gathering', true, available => room.gathering(available)),
    starts: (young = true) => use('starts', young, available => room.starts(available, young)),
    room: (young = true) => use('room', young, available => room.room(available, young)),
  });
  return {
    ...reserve,
    availableMb,
    inspect: inspection.inspect,
    ...measured(reserve),
    reading: measured(reserve.reading),
  };
}

export const hostAvailableBytes = (meminfo = '/proc/meminfo') =>
  Number(readFileSync(meminfo, 'utf8').match(/^MemAvailable:\s+(\d+)/m)![1]) * 1024;

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
