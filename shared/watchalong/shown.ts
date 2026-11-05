// The events a replay takes: up to a moment, and what a live screen still shows; and what they tell the mirror besides.
import type { RecordedEvent } from './store.ts';

// The events a replay to this time needs: from the full snapshot last taken by then (and the page's size before it)
export function upTo(events: RecordedEvent[], time: number) {
  const before = events.filter(event => event.timestamp <= time);
  const full = before.findLastIndex(event => event.type === FULL_SNAPSHOT);
  const meta = before.findLastIndex((event, i) => event.type === META && i <= full);
  return before.slice(Math.max(0, meta));
}
const FULL_SNAPSHOT = 2,
  META = 4,
  CUSTOM = 5;

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

// The events a past moment's mirror needs: what the screen shows at this time (shown, up to it), and before them the
// recording's other metas and custom events, as the mirror takes its pages and pictures from the whole recording
// (addPagesAndPictures). Every other event before the time is left out: the replay starts at the full snapshot (upTo).
export function replayAt(events: RecordedEvent[], time: number) {
  const replay = shown(upTo(events, time)),
    inReplay = new Set(replay);
  const told = events.filter(event => (event.type === META || event.type === CUSTOM) && !inReplay.has(event));
  return [...told, ...replay];
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

// The origins of the pages these events were on: the recorded page's addresses, and the page moments its frames sent up
function* originsIn(events: RecordedEvent[]) {
  for (const event of events) {
    const data = event.data as { href?: unknown; tag?: unknown; payload?: { address?: unknown } };
    const address =
      event.type === META ? data.href : event.type === CUSTOM && data.tag === 'page' && data.payload?.address;
    if (typeof address === 'string' && URL.canParse(address)) yield new URL(address).origin;
  }
}

// Adds to a mirror what these events tell it: the origins of the pages they were on that it may show, and the pictures
// they carry by their address
export function addPagesAndPictures(
  mirror: {
    pages: Set<string>;
    pictures: Map<string, { type: string; body: Buffer }>;
    shows: (origin: string) => boolean;
  },
  events: RecordedEvent[],
) {
  for (const origin of originsIn(events)) if (mirror.shows(origin)) mirror.pages.add(origin);
  for (const [address, carried] of picturesIn(events)) mirror.pictures.set(address, carried);
}

// The pictures these events carry (routepictures.js: those of the page's own the replay can't load by their address), each
// with its address.
const PICTURE_TYPES = ['image/webp', 'image/jpeg', 'image/png'];
function* picturesIn(events: RecordedEvent[]) {
  for (const event of events) {
    const data = event.data as { tag?: unknown; payload?: { address?: unknown; type?: unknown; base64?: unknown } };
    if (event.type !== CUSTOM || data.tag !== 'picture') continue;
    const { address, type, base64 } = data.payload ?? {};
    if (typeof address !== 'string' || typeof base64 !== 'string' || !PICTURE_TYPES.includes(String(type))) continue;
    yield [address, { type: String(type), body: Buffer.from(base64, 'base64') }] as const;
  }
}
