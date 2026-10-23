// The shared plan played forward on reported capacity and measured runs.
import { playPlan } from './simulation.ts';
import type { Snapshot, Size } from './playtypes.ts';
export type * from './playtypes.ts';
export const PLAY_VERSION = 3;
export function play(snapshot: Snapshot, sizes: ReadonlyMap<number, Size>, options: { pace?: 'usual' | 'slow' } = {}) {
  return playPlan(snapshot, sizes, options.pace ?? 'usual');
}
