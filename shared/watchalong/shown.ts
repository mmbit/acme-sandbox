// The events a replay takes: up to a moment, and what a live screen still shows.
import type { RecordedEvent } from './store.ts';

// The events a replay to this time needs: from the full snapshot last taken by then (and the page's size before it)
export function upTo(events: RecordedEvent[], time: number) {
  const before = events.filter(event => event.timestamp <= time);
  const full = before.findLastIndex(event => event.type === FULL_SNAPSHOT);
  const meta = before.findLastIndex((event, i) => event.type === META && i <= full);
  return before.slice(Math.max(0, meta));
}
const FULL_SNAPSHOT = 2,
  META = 4;

// The events a live mirror opens with: what the screen still shows, from the full snapshot last taken (upTo), each
// canvas's pictures but its latest. A picture that starts by wiping its canvas leaves nothing of the ones before it,
// and each costs the replay a picture to decode. canvas.js wipes with a clearRect from the corner at the canvas's
// size. That size isn't known here, so any clearRect from the corner with an area counts as a wipe.
export function shown(events: RecordedEvent[]) {
  const since = upTo(events, Infinity);
  const latest = new Map<number, number>();
  since.forEach((event, i) => {
    const wiped = wipes(event);
    if (wiped !== undefined) latest.set(wiped, i);
  });
  return since.filter((event, i) => {
    const wiped = wipes(event);
    return wiped === undefined || latest.get(wiped) === i;
  });
}
const INCREMENTAL = 3,
  CANVAS_MUTATION = 9;
// The canvas a canvas mutation wipes before it draws (its first command a clearRect from the corner), or undefined
function wipes(event: RecordedEvent) {
  const data = event.data as { source?: number; id?: number; commands?: { property?: string; args?: unknown[] }[] };
  if (event.type !== INCREMENTAL || data.source !== CANVAS_MUTATION || typeof data.id !== 'number') return undefined;
  const [wipe] = data.commands ?? [];
  const [x, y, width, height] = wipe?.args ?? [];
  const whole = wipe?.property === 'clearRect' && x === 0 && y === 0 && Number(width) > 0 && Number(height) > 0;
  return whole ? data.id : undefined;
}
