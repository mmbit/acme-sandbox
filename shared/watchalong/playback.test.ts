// node --test shared/watchalong/playback.test.ts   (a throwaway database and folder)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import * as store from './store.ts';
import * as playback from './playback.ts';
import { upTo } from './shown.ts';

const dir = mkdtempSync(`${tmpdir()}/playback-`);
const kept = store.open(new DatabaseSync(':memory:'), `${dir}/kept`);
const batch = (...events: unknown[]) => Buffer.from(JSON.stringify({ events }));
const T0 = Date.now() - 60_000;
const page = [
  { type: 4, timestamp: T0, data: { href: 'https://hq.test/', width: 400, height: 300 } },
  { type: 2, timestamp: T0, data: { node: { id: 1, type: 0, childNodes: [] } } },
];
const tap = (at: number) => ({ type: 5, timestamp: at, data: { tag: 'tap', payload: { x: 10, y: 20, label: 'Pay' } } });
// a canvas picture as canvas.js sends it: the whole canvas wiped first
const frame = (at: number) => ({
  type: 3,
  timestamp: at,
  data: {
    source: 9,
    id: 6,
    type: 0,
    commands: [
      { property: 'clearRect', args: [0, 0, 400, 300] },
      { property: 'drawImage', args: [] },
    ],
  },
});
function recorded(...batches: unknown[][]) {
  const { id, key } = store.start(kept, 'call', String(id0++), 'shown');
  for (const events of batches) assert.equal(store.add(kept, id, key, batch(...events)), 200);
  return { id, key };
}
let id0 = 1;
const sessionsOf = (...ids: number[]) => ids.map(id => store.find(kept, id)!);

test("a recording's moments and times, every event and a past moment's events, read on the thread as the store reads them", async () => {
  const first = recorded([...page, tap(T0 + 1000)], [frame(T0 + 2000)]);
  const again = page.map(event => ({ ...event, timestamp: T0 + 5000 }));
  const sent = Date.now();
  const second = recorded([...again, tap(T0 + 6000)]);
  const arrived = Date.now();
  const sessions = sessionsOf(first.id, second.id);
  const events = [...page, tap(T0 + 1000), frame(T0 + 2000), ...again, tap(T0 + 6000)];
  const { clockMs, ...played } = (await playback.played(kept.dir, sessions))!;
  assert.deepEqual(played, {
    first: T0,
    last: T0 + 6000,
    moments: [
      { n: 1, at: T0 + 1000, kind: 'tap', words: 'tapped "Pay"', x: 10, y: 20 },
      { n: 2, at: T0 + 6000, kind: 'tap', words: 'tapped "Pay"', x: 10, y: 20 },
    ],
  });
  assert.ok(
    clockMs >= sent - (T0 + 6000) && clockMs <= arrived - (T0 + 6000),
    "the page's clock behind the server's by its smallest gap: the second session's last batch",
  );
  const every = await playback.every(kept.dir, sessions);
  assert.ok(Buffer.isBuffer(every));
  assert.deepEqual(
    every
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line)),
    events,
  );
  const replay = await playback.at(kept.dir, sessions, T0 + 5500);
  assert.deepEqual(upTo(replay, T0 + 5500), again, 'from the full snapshot then');
  assert.deepEqual(
    replay,
    [page[0], tap(T0 + 1000), tap(T0 + 6000), ...again],
    "the recording's pages and moments too",
  );
  assert.equal(await playback.played(kept.dir, sessionsOf(recorded().id)), undefined, 'nothing recorded');
});

test("a past moment's replay takes each canvas's latest picture by then, not every one before it", async () => {
  const { id } = recorded([...page, frame(T0 + 1000), tap(T0 + 1500)], [frame(T0 + 2000), frame(T0 + 3000)]);
  assert.deepEqual(await playback.at(kept.dir, sessionsOf(id), T0 + 2500), [...page, tap(T0 + 1500), frame(T0 + 2000)]);
});

test('the thread keeps the recording it read for the next ask, and reads a session again once it grew', async () => {
  const { id, key } = recorded([...page, tap(T0 + 1000)]);
  const before = sessionsOf(id);
  const { moments } = (await playback.played(kept.dir, before))!;
  const file = `${kept.dir}/${id}.ndjson.gz`;
  renameSync(file, `${file}.away`);
  assert.deepEqual((await playback.played(kept.dir, before))!.moments, moments, 'kept: not read again');
  renameSync(`${file}.away`, file);
  assert.equal(store.add(kept, id, key, batch(tap(T0 + 9000))), 200);
  assert.equal(
    (await playback.played(kept.dir, sessionsOf(id)))!.moments.length,
    moments.length + 1,
    'grown: read again',
  );
});

test("a recording that can't be read fails its ask, and the thread goes on to the next", async () => {
  const { id } = recorded([...page]);
  const file = `${kept.dir}/${id}.ndjson.gz`;
  renameSync(file, `${file}.away`);
  await assert.rejects(playback.played(kept.dir, sessionsOf(id)), /The recording couldn't be read: ENOENT/);
  renameSync(`${file}.away`, file);
  assert.equal((await playback.played(kept.dir, sessionsOf(id)))!.last, T0);
});
