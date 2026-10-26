// Worker memory admission with each modeled run's demand returned when it leaves.
import type { Memory, QueuedJob, Snapshot } from './eta.ts';
const budgets = new WeakMap<Snapshot, { recoverableMb: number; externalSlots: number }>();

export function canStart(snapshot: Snapshot, running: QueuedJob[], candidate: QueuedJob, now: number) {
  const memory = snapshot.memory;
  if (!memory) return running.length < (snapshot.room ?? Infinity);
  return (
    running.length < memory.totalSlots - memory.heldSlots - budget(snapshot).externalSlots &&
    free(snapshot, running, now) >= demand(memory, candidate)
  );
}

export function full(snapshot: Snapshot, running: QueuedJob[], now: number) {
  const memory = snapshot.memory;
  if (!memory) return running.length >= (snapshot.room ?? Infinity);
  return (
    running.length >= memory.totalSlots - memory.heldSlots - budget(snapshot).externalSlots ||
    free(snapshot, running, now) <= 0
  );
}

export function nextEvent(snapshot: Snapshot, now: number): number | null {
  const deadlines = snapshot.memory?.starting.map(reservation => reservation.until).filter(until => until > now) ?? [];
  return deadlines.length ? Math.min(...deadlines) : null;
}

export function assumptions(snapshot: Snapshot) {
  if (!snapshot.memory) return ['Worker memory release is unmeasured in this snapshot'];
  const memory = snapshot.memory;
  const unknown = snapshot.jobs.filter(row => row.memoryMb == null && !(memory.runningMb[row.id] != null));
  return [
    ...(unknown.length ? ['Unmeasured run memory uses the worker startup allowance'] : []),
    ...(budget(snapshot).externalSlots
      ? ['Occupants outside the modeled running queue retain their memory and slots']
      : []),
    'External memory and meeting reservations stay at their observed levels',
  ];
}

function free(snapshot: Snapshot, running: QueuedJob[], now: number) {
  const memory = snapshot.memory!;
  const occupiedMb = running.reduce((sum, row) => sum + demand(memory, row), 0);
  const startingMb = memory.starting.reduce(
    (sum, reservation) => sum + (reservation.until > now ? reservation.mb : 0),
    0,
  );
  return (
    memory.availableMb - memory.freeReserveMb - memory.heldMb + budget(snapshot).recoverableMb - occupiedMb - startingMb
  );
}

function budget(snapshot: Snapshot) {
  let measured = budgets.get(snapshot);
  if (measured) return measured;
  const memory = snapshot.memory!;
  const observed = snapshot.jobs.filter(row => row.id in memory.runningMb);
  const ids = new Set(observed.map(row => String(row.id)));
  measured = {
    recoverableMb: observed.reduce((sum, row) => sum + demand(memory, row), 0),
    externalSlots: Object.keys(memory.runningMb).filter(id => !ids.has(id)).length,
  };
  budgets.set(snapshot, measured);
  return measured;
}

const demand = (memory: Memory, row: QueuedJob) => memory.runningMb[row.id] ?? row.memoryMb ?? memory.defaultRunMb;
