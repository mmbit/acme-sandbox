// node --test shared/watchalong/store.test.ts   (a throwaway database and folder)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import * as store from './store.ts';

const dir = mkdtempSync(`${tmpdir()}/watchalong-`);
const kept = store.open(new DatabaseSync(':memory:'), `${dir}/kept`);
const batch = (...events: unknown[]) => Buffer.from(JSON.stringify({ events }));
const event = (type: number, timestamp: number, data: object = {}) => ({ type, timestamp, data });

test("a session's batches come back in order, its file only the app's, and only with its own key", () => {
  const { id, key } = store.start(kept, 'call', '7', 'hidden');
  const other = store.start(kept, 'call', '8', 'hidden');
  const now = Date.now();
  assert.equal(
    store.add(kept, id, key, batch(event(4, now - 900, { href: 'https://hq.test/' }), event(2, now - 800))),
    200,
  );
  assert.equal(store.add(kept, id, key, batch(event(3, now - 500, { source: 2 }))), 200);
  assert.equal(store.add(kept, id, other.key, batch(event(3, now))), 404);
  assert.equal(store.add(kept, id, `${key}x`, batch(event(3, now))), 404);
  assert.equal(store.add(kept, 999, key, batch(event(3, now))), 404);
  // an empty batch (a quiet page asking how its session is) is answered and keeps nothing
  const bytes = store.find(kept, id)!.bytes;
  assert.equal(store.add(kept, id, key, batch()), 200);
  assert.equal(store.find(kept, id)!.bytes, bytes);
  assert.equal(store.add(kept, id, other.key, batch()), 404);
  const recording = store.read(kept, id)!;
  assert.deepEqual(
    recording.events.map(e => e.type),
    [4, 2, 3],
  );
  assert.equal(recording.session.typed, 'hidden');
  // the page's clock is about in step with the server's here: the gap is the time a batch took to arrive
  assert.ok(recording.clockMs >= 500 && recording.clockMs < 5000, String(recording.clockMs));
  assert.equal(statSync(`${dir}/kept/${id}.ndjson.gz`).mode & 0o777, 0o600);
  assert.equal(statSync(`${dir}/kept`).mode & 0o777, 0o700);
  assert.deepEqual(store.read(kept, other.id)!.events, []);
});

test("only a batch of rrweb events is kept, within its size and the session's room", () => {
  const { id, key } = store.start(kept, 'call', '9', 'shown');
  for (const body of [
    Buffer.from('not json'),
    Buffer.from('{"events": "no"}'),
    batch({ type: 9, timestamp: 1, data: {} }),
    batch({ type: 2, timestamp: 'soon', data: {} }),
    batch({ type: 2, timestamp: 1, data: null }),
    batch(event(2, 1), 'one more'),
  ])
    assert.equal(store.add(kept, id, key, body), 400, body.toString());
  assert.equal(store.add(kept, id, key, Buffer.alloc(store.BATCH_BYTES + 1, ' ')), 413);
  assert.equal(store.find(kept, id)!.bytes, 0);
  // a session with no room left: the batch is fine, the session full
  kept.db.prepare('update watchalong_sessions set bytes = ? where id = ?').run(store.SESSION_BYTES, id);
  assert.equal(store.add(kept, id, key, batch(event(2, 1))), 507);
});

test('a session ends with its thing: its page hears 409, its recording stays until forgotten or past its days', () => {
  const first = store.start(kept, 'call', '10', 'shown');
  const second = store.start(kept, 'call', '10', 'shown');
  const later = store.start(kept, 'call', '11', 'shown');
  assert.equal(store.add(kept, first.id, first.key, batch(event(2, 1))), 200);
  store.end(kept, 'call', '10');
  assert.equal(store.add(kept, first.id, first.key, batch(event(3, 2))), 409);
  assert.equal(store.add(kept, second.id, second.key, batch(event(3, 2))), 409);
  assert.equal(store.add(kept, first.id, first.key, batch()), 409, 'a quiet page hears it too');
  assert.equal(store.add(kept, later.id, later.key, batch(event(2, 1))), 200);
  assert.deepEqual(
    store.sessionsOf(kept, 'call', '10').map(s => s.id),
    [first.id, second.id],
  );
  assert.equal(store.read(kept, first.id)!.events.length, 1);
  store.forget(kept, 'call', '10');
  assert.equal(store.find(kept, first.id), undefined);
  assert.equal(existsSync(`${dir}/kept/${first.id}.ndjson.gz`), false);
  store.sweep(kept, Date.now() + (store.KEEP_DAYS - 1) * 86_400_000);
  assert.ok(store.find(kept, later.id));
  store.sweep(kept, Date.now() + (store.KEEP_DAYS + 1) * 86_400_000);
  assert.equal(store.find(kept, later.id), undefined);
  assert.equal(existsSync(`${dir}/kept/${later.id}.ndjson.gz`), false);
});
