// Worker memory reports for coordinator tests.
import type { Memory } from './eta.ts';

export const memoryReport = (extra: Partial<Memory> = {}): Memory => ({
  at: 0,
  availableMb: 2000,
  freeReserveMb: 1500,
  defaultRunMb: 700,
  totalSlots: 15,
  heldSlots: 0,
  heldMb: 0,
  starting: [],
  runningMb: {},
  ...extra,
});
