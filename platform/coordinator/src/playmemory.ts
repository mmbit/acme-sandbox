// Worker memory admission with each modeled run's demand returned when it leaves.
import type { Memory, QueuedJob, Snapshot } from './eta.ts';
const budgets = new WeakMap<Snapshot, { recoverableMb: number; externalSlots: number }>();

// The room's use at one moment of the play (simulation.ts start): its runs' slots and memory, summed once and added to
// as claims start, not summed again for every claim.
export type Room = { snapshot: Snapshot; slots: number; occupiedMb: number; startingMb: number };
export function room(snapshot: Snapshot, running: QueuedJob[], now: number): Room {
  const memory = snapshot.memory;
  return {
    snapshot,
    slots: running.length,
    occupiedMb: memory ? running.reduce((sum, row) => sum + demand(memory, row), 0) : 0,
    startingMb: memory
      ? memory.starting.reduce((sum, reservation) => sum + (reservation.until > now ? reservation.mb : 0), 0)
      : 0,
  };
}

export function join(room: Room, row: QueuedJob) {
  room.slots++;
  if (room.snapshot.memory) room.occupiedMb += demand(room.snapshot.memory, row);
}

// A start is admitted as the worker admits a claim (its reserve.ts and the claim's room, jobs.ts): its starting
// allowance above the reserve, or less for a job whose measured memory is smaller. A run then holds its measured
// memory. (admitting on the measured peak never started a job that peaks past the room the snapshot's moment left, and
// every job ordered after it waited out the 8 days.)
export function canStart(room: Room, candidate: QueuedJob) {
  const { snapshot } = room,
    memory = snapshot.memory;
  if (!memory) return room.slots < (snapshot.room ?? Infinity);
  return (
    room.slots < memory.totalSlots - memory.heldSlots - budget(snapshot).externalSlots &&
    free(room) >= Math.min(memory.defaultRunMb, demand(memory, candidate))
  );
}

export function afterPauses(room: Room, rows: QueuedJob[]): Room {
  return {
    ...room,
    slots: room.slots - rows.length,
    occupiedMb:
      room.occupiedMb -
      rows.reduce((sum, row) => sum + (room.snapshot.memory ? demand(room.snapshot.memory, row) : 0), 0),
  };
}

export function full(room: Room) {
  const { snapshot } = room,
    memory = snapshot.memory;
  if (!memory) return room.slots >= (snapshot.room ?? Infinity);
  return room.slots >= memory.totalSlots - memory.heldSlots - budget(snapshot).externalSlots || free(room) <= 0;
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

function free(room: Room) {
  const memory = room.snapshot.memory!;
  return (
    memory.availableMb -
    memory.freeReserveMb -
    memory.heldMb +
    budget(room.snapshot).recoverableMb -
    room.occupiedMb -
    room.startingMb
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
