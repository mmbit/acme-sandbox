// node --test shared/watchalong/shown.test.ts
// What a replay takes of a recording (shown.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shown, upTo } from './shown.ts';
import type { RecordedEvent } from './store.ts';

// A page as rrweb records it: its address and the screen's size, then a full snapshot
const page = (at: number): RecordedEvent[] => [
  { type: 4, timestamp: at, data: { href: 'https://shop.test/', width: 400, height: 300 } },
  { type: 2, timestamp: at, data: { node: { id: 1, type: 0, childNodes: [] } } },
];
// A canvas mutation as rrweb's canvas sampling sends it: its first command, then a picture
const drawn = (at: number, id: number, first: { property: string; args: number[] }): RecordedEvent => ({
  type: 3,
  timestamp: at,
  data: { source: 9, id, type: 0, commands: [first, { property: 'drawImage', args: [] }] },
});
const WIPE = { property: 'clearRect', args: [0, 0, 400, 300] };
// A canvas picture as canvas.js sends it: the whole canvas wiped first
const frame = (at: number, id = 6) => drawn(at, id, WIPE);
const typed = (at: number): RecordedEvent => ({ type: 3, timestamp: at, data: { source: 5, id: 7, text: 'a' } });

test("a past moment's replay takes the events from the full snapshot last taken by then, the page's size before it", () => {
  const events = [...page(0), typed(10), ...page(20), typed(30), typed(50)];
  assert.deepEqual(upTo(events, 35), [...page(20), typed(30)]);
  assert.deepEqual(upTo(events, 15), [...page(0), typed(10)]);
  assert.deepEqual(upTo(events, 20), page(20), 'what happened at that time too');
  assert.deepEqual(upTo([typed(5), typed(6)], 10), [typed(5), typed(6)], 'no full snapshot yet: all of it');
});

test("a mirror opens with what the screen still shows: from the last full snapshot, each canvas's latest picture", () => {
  const ink = { type: 5, timestamp: 40, data: { tag: 'ink', payload: {} } };
  const stroke = drawn(45, 6, { property: 'fillRect', args: [0, 0, 10, 10] });
  const events = [...page(0), frame(10), ...page(20), frame(30), ink, stroke, frame(50, 7), frame(60)];
  assert.deepEqual(shown(events), [...page(20), ink, stroke, frame(50, 7), frame(60)]);
  // a clear off the corner, or without area, wipes nothing: the picture before it stays. Each misses the rule by one
  // condition, so the test fails if any of them changes
  const before = drawn(65, 8, WIPE);
  const partial = [
    [5, 0, 400, 300],
    [0, 5, 400, 300],
    [0, 0, 0, 300],
    [0, 0, 400, 0],
  ].map((args, i) => drawn(70 + i, 8, { property: 'clearRect', args }));
  assert.deepEqual(shown([...page(0), before, ...partial]), [...page(0), before, ...partial]);
  assert.deepEqual(shown([frame(10), frame(20)]), [frame(20)], 'no full snapshot yet: from the start');
});
