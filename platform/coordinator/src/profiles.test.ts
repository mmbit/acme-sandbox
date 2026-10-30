// node --test src/profiles.test.ts   (uses a throwaway DATA_DIR; products/hello from the repo is the product)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, request } from 'node:http';
import { fixtureRepo } from './fixture.ts';

fixtureRepo();
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/profiles-test-`);
process.env.PUBLIC_HOST = 'hq.company.test';
const feedback = await import('./feedback.ts');
const profiles = await import('./profiles.ts');
const { db } = await import('./db.ts');

const HOST = 'hello.preview.company.test',
  ORIGIN = `https://${HOST}`,
  KEY = 'board-key';
db.prepare('insert into preview_keys (key, expires) values (?, ?)').run(KEY, Date.now() + 864e5);
const srv = createServer((q, s) => feedback.product(q, s));
await new Promise<void>(r => srv.listen(0, r));
after(() => srv.close());
const base = `http://localhost:${(srv.address() as any).port}`;
// node:http rather than fetch, which won't let us set Host
const call = (path: string, { key = KEY as string | null, origin = ORIGIN, body = undefined as unknown } = {}) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers = {
      host: HOST,
      origin,
      ...(key ? { cookie: `pv=${key}` } : {}),
      ...(data ? { 'content-type': 'application/json' } : {}),
    };
    const q = request(base + path, { method: data ? 'POST' : 'GET', headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => (text += c));
      res.on('end', () => resolve({ status: res.statusCode!, text }));
    });
    q.on('error', reject);
    q.end(data);
  });
const PROFILER = readFileSync(new URL('../../../shared/profile/profile.js', import.meta.url), 'utf8');
const session = '0b6f1c1e-7d1a-4c3e-9a51-6f1e2d3c4b5a';
const sample = (minute: number, nodes: number, book: number, extra = {}) => ({
  at: Date.UTC(2026, 9, 29, 18, minute),
  nodes,
  regions: { '#book': book, '#world': 1 },
  heap: null,
  canvases: 3,
  listeners: { resize: 2 + minute },
  frames: { shown: 100, slow: minute > 30 ? 20 : 1, worst: 80 },
  longTasks: { count: 0, ms: 0, worst: 0 },
  state: 'brownstone book=open',
  ...extra,
});
const posted = {
  session,
  page: '/',
  device: { agent: 'iPad', screen: '744x1133@2', previous: null },
  samples: [sample(0, 1000, 200)],
};

test('off, review.js carries no profiler and the page posts nothing', async () => {
  assert.ok(!(await call('/__review/review.js')).text.includes('window.__profiling'));
  assert.equal((await call('/__review/profile', { body: posted })).status, 404);
});

test("on for a host, the board's review.js there ends in the profiler, and its samples are kept", async () => {
  profiles.switchOn('hello', 1);
  assert.ok((await call('/__review/review.js')).text.endsWith(PROFILER));
  assert.ok(
    !(await call('/__review/review.js', { key: null })).text.includes('window.__profiling'),
    'nobody else runs it',
  );
  assert.equal((await call('/__review/profile', { body: posted, key: null })).status, 404, 'nobody else posts');
  assert.equal((await call('/__review/profile', { body: posted, origin: 'https://evil.test' })).status, 403);
  for (const off of [
    { session: 'x' },
    { samples: [] },
    { samples: [null] },
    { samples: [{ at: 'not-a-time' }] },
    { samples: [{ at: 0, pad: 'x'.repeat(4000) }] },
    { device: { agent: 'x'.repeat(2000) } },
  ])
    assert.equal(
      (await call('/__review/profile', { body: { ...posted, ...off } })).status,
      400,
      JSON.stringify(off).slice(0, 40),
    );
  assert.equal(profiles.listSessions('hello', 0).length, 0, 'an off-shape post keeps nothing, not part of it');
  assert.equal((await call('/__review/profile', { body: posted })).status, 200);
  const later = [sample(20, 1400, 600), sample(40, 1800, 1000), sample(60, 2200, 1400)];
  assert.equal((await call('/__review/profile', { body: { ...posted, samples: later } })).status, 200);
  assert.equal(profiles.samplesOf(session).length, 4);
});

test("a session reads as each count's change per hour, what grew most and lag that built up", () => {
  const [read] = profiles.listSessions('hello', 0);
  assert.equal(read.minutes, 60);
  assert.deepEqual(read.counts.nodes, { first: 1000, last: 2200, most: 2200, perHour: 1200 });
  assert.deepEqual(read.counts.listeners, { first: 2, last: 62, most: 62, perHour: 60 });
  assert.deepEqual(read.grewMost.regions, [{ name: '#book', from: 200, to: 1400, change: 1200 }]);
  assert.deepEqual(read.slowFrames, { first: 1, last: 20 });
  assert.deepEqual(read.states, ['brownstone book=open']);
});

test('a session that came after a page killed without a pagehide says so, and so does that page', async () => {
  const next = {
    ...posted,
    session: session.replace('0b', '1c'),
    device: { ...posted.device, previous: { session, clean: false, hidden: true } },
  };
  assert.equal((await call('/__review/profile', { body: next })).status, 200);
  const [newest, first] = profiles.listSessions('hello', 0);
  assert.deepEqual([newest.after, first.ended], [next.device.previous, next.device.previous]);
});

test('off again, the page hears no and HQ keeps nothing more', async () => {
  profiles.switchOff(null);
  assert.equal((await call('/__review/profile', { body: posted })).status, 404);
  assert.deepEqual(profiles.switchedOn(), []);
  assert.equal(typeof profiles.switchOn('hello', 24 * 8), 'string', 'a week at most');
});
