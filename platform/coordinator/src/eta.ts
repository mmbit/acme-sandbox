// The shared plan played forward on reported capacity and measured runs.
import { playPlan, type PlayOrder } from './simulation.ts';
import type { Snapshot, Size } from './playtypes.ts';
export type * from './playtypes.ts';
export const PLAY_VERSION = 3;
// order: the snapshot's playOrder, played once for both paces (predictions.ts played).
export function play(
  snapshot: Snapshot,
  sizes: ReadonlyMap<number, Size>,
  options: { pace?: 'usual' | 'slow'; order?: PlayOrder } = {},
) {
  return playPlan(snapshot, sizes, options.pace ?? 'usual', options.order);
}
