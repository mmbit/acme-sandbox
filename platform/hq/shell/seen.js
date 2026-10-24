// What the board has read in Mail and the Gazette, kept by the coordinator (seen.ts) so every device it uses shows the
// same unread counts: per list, the newest item seen. Null until the first read, so no count is drawn on a guess.
import * as world from '../world/world.js';
import { loadSeen, saveSeen } from './data.js';

export let seen = null;
// A mark only moves forward, here as on the coordinator, so an answer that arrives late can't bring back older marks.
// `unsaved`: marks the coordinator hasn't confirmed (a save that failed), sent again with the next read.
let marks = {},
  loaded = false;
const unsaved = new Map();
const later = (a, b) => (a == null || b > a ? b : a);
// Counts drawn outside the screen that marks them (the desk phone's badge) repaint when a mark moves, here or on another
// device
const watchers = [];
export const onSeen = fn => watchers.push(fn);
function take(answer) {
  marks = { ...marks };
  for (const [list, newest] of Object.entries(answer)) marks[list] = later(marks[list], newest);
  for (const [list, newest] of unsaved) if (answer[list] != null && answer[list] >= newest) unsaved.delete(list);
  seen = loaded ? marks : null;
  for (const fn of watchers) fn();
}
// read with the requests poll and when HQ comes back to the foreground; a failed read keeps the last marks
export async function refreshSeen() {
  for (const [list, newest] of unsaved) save(list, newest);
  const answer = await loadSeen(world.dev).catch(() => null);
  if (!answer) return;
  loaded = true;
  take(answer);
}
// The board has seen `list` up to `newest`: kept here at once, then on the coordinator
export function markSeen(list, newest) {
  if (marks[list] != null && newest <= marks[list]) return;
  take({ [list]: newest });
  unsaved.set(list, newest);
  save(list, newest);
}
function save(list, newest) {
  saveSeen(world.dev, list, newest).then(take, err => console.error('Could not keep what was read:', err));
}
