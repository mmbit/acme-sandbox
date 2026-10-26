// node --test src/pair.test.ts   (two of the board's devices paired by a one-time code, and the live channel between
// them: the harness's throwaway DATA_DIR and real server, each stream read as a browser's EventSource reads it).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { request, type ClientRequest } from 'node:http';
import { harness } from './harness.ts';

const h = await harness('pair');
const { ORIGIN } = await import('./config.ts');
const pair = await import('./pair.ts');

type Fed = { id: number; tag: string; payload: any };
type Opened = {
  status: number;
  events: Fed[];
  next: (tag?: string) => Promise<Fed>;
  ended: Promise<void>;
  close: () => void;
};

const create = (body: Record<string, unknown> = {}) => h.board('/api/pair', body);
const join = (code: string) => h.board('/api/pair/join', { code });
const sendFrom = (side: { pair: string; key: string }, events: unknown[]) =>
  h.board('/api/pair/send', { pair: side.pair, key: side.key, events });
// a pairing both devices have joined
async function paired() {
  const a = (await create()).body;
  const b = (await join(a.code)).body;
  return { a, b };
}

// Every stream a test opened closes after it, failed or not, or the server's close would wait for it
const streams = new Set<Opened>();
afterEach(() => {
  for (const s of streams) s.close();
  streams.clear();
});

// A side's stream, its events as they come: next() waits for the first one not yet taken (of a tag, when given)
function listen(side: { pair: string; key: string }, lastEventId?: number) {
  const query = new URLSearchParams({ pair: side.pair, key: side.key });
  const headers: Record<string, string> = {
    cookie: h.boardCookie,
    ...(lastEventId ? { 'last-event-id': String(lastEventId) } : {}),
  };
  return new Promise<Opened>((resolve, reject) => {
    let q: ClientRequest | undefined = undefined;
    const events: Fed[] = [],
      waiting: (() => void)[] = [];
    let taken = 0,
      endedNow = () => {};
    const opened: Opened = {
      status: 0,
      events,
      next: tag =>
        new Promise((done, failed) => {
          const timer = setTimeout(() => failed(new Error(`no ${tag ?? 'event'} came`)), 2_000);
          const look = () => {
            while (taken < events.length) {
              const event = events[taken++];
              if (!tag || event.tag === tag) {
                clearTimeout(timer);
                return done(event);
              }
            }
            waiting.push(look);
          };
          look();
        }),
      ended: new Promise(r => (endedNow = r)),
      close: () => q!.destroy(),
    };
    q = request(`${h.base}/api/pair/live?${query}`, { headers }, res => {
      opened.status = res.statusCode!;
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const id = /^id: (\d+)$/m.exec(block)?.[1],
            data = /^data: (.*)$/m.exec(block)?.[1];
          if (data) events.push({ id: Number(id), ...JSON.parse(data) });
        }
        waiting.splice(0).forEach(look => look());
      });
      res.on('end', () => endedNow());
      streams.add(opened);
      resolve(opened);
    });
    q.on('error', e => (q!.destroyed ? undefined : reject(e)));
    q.end();
  });
}

test('a code pairs once, and only while it is good', async () => {
  const a = (await create()).body;
  assert.equal(a.side, 'a');
  assert.match(a.code, /^\d{6}$/);
  assert.match(a.pair, /^[\w-]{16}$/);
  assert.ok(a.expires > Date.now() && a.expires <= Date.now() + 60_000);
  const spaced = `${a.code.slice(0, 3)} - ${a.code.slice(3)}`;
  const b = await join(spaced);
  assert.equal(b.status, 200);
  assert.equal(b.body.side, 'b');
  assert.equal(b.body.pair, a.pair);
  assert.notEqual(b.body.key, a.key);
  assert.equal((await join(a.code)).status, 410, 'a code joins once');

  const stored = h.db.prepare('select * from pairs where id = ?').get(a.pair) as Record<string, unknown>;
  assert.ok(
    !JSON.stringify(stored).includes(a.code) && !JSON.stringify(stored).includes(a.key),
    'hq.db keeps only hashes',
  );

  const late = (await create()).body;
  h.db.prepare('update pairs set code_expires = ? where id = ?').run(Date.now() - 1, late.pair);
  assert.equal((await join(late.code)).status, 410, 'a code past its minute');
  const wrong = String((Number(late.code) + 1) % 1_000_000).padStart(6, '0');
  assert.equal((await join(wrong)).status, 404, 'no such code');
  assert.equal((await join('12345')).status, 404, 'not a code at all');
});

test('a fresh code for a waiting pairing kills the old one', async () => {
  const a = (await create()).body;
  const fresh = await create({ pair: a.pair, key: a.key });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.pair, a.pair);
  assert.notEqual(fresh.body.code, a.code);
  assert.equal((await join(a.code)).status, 404, 'the old code is dead');
  assert.equal((await create({ pair: a.pair, key: 'not-the-key' })).status, 403);
  const b = (await join(fresh.body.code)).body;
  assert.equal((await create({ pair: a.pair, key: b.key })).status, 403, "only side a's key asks for a code");
  assert.equal((await create({ pair: a.pair, key: a.key })).status, 409, 'none once joined');
});

test('the relay: what a side sends reaches the other verbatim, in order, and not itself', async () => {
  const a = (await create()).body;
  const streamA = await listen(a);
  assert.equal(streamA.status, 200);
  assert.deepEqual((await streamA.next()).payload, { state: 'waiting' });
  assert.equal((await sendFrom(a, [{ tag: 'mark', payload: {} }])).status, 409, 'nobody to send to before the join');

  const b = (await join(a.code)).body;
  assert.deepEqual((await streamA.next()).payload, { state: 'paired' }, 'a hears the join');
  const streamB = await listen(b);
  assert.deepEqual((await streamB.next()).payload, { state: 'paired' });

  const mark = {
    tag: 'mark:open',
    payload: { strokes: [[1, 2, 0.5]], colour: '#2b2230', nested: { a: [null, true] } },
  };
  const turn = { tag: 'page', payload: { page: 3 } };
  assert.deepEqual((await sendFrom(a, [mark, turn])).body, { ok: true });
  const got = [await streamB.next(), await streamB.next()];
  assert.deepEqual(
    got.map(({ tag, payload }) => ({ tag, payload })),
    [mark, turn],
  );
  assert.ok(got[0].id < got[1].id, 'ids rise');
  await sendFrom(b, [{ tag: 'fold', payload: { open: true } }]);
  const back = await streamA.next();
  assert.deepEqual({ tag: back.tag, payload: back.payload }, { tag: 'fold', payload: { open: true } });
  assert.ok(!streamA.events.some(e => e.tag === 'mark:open'), "a doesn't hear itself");

  for (const bad of [
    [{ tag: 'Mark', payload: {} }],
    [{ tag: 'mark', payload: [] }],
    [{ tag: 'pair', payload: { state: 'ended' } }],
    'x',
  ])
    assert.equal((await h.board('/api/pair/send', { pair: a.pair, key: a.key, events: bad })).status, 400);
  assert.equal((await sendFrom({ pair: a.pair, key: 'nope' }, [turn])).status, 403);
  const tooBig = { tag: 'mark', payload: { strokes: 'x'.repeat(pair.SEND_MAX) } };
  assert.equal((await sendFrom(a, [tooBig])).status, 413);

  // the other side's stream drops and returns
  streamB.close();
  assert.deepEqual((await streamA.next('pair')).payload, { state: 'away' });
  const streamB2 = await listen(b, got[1].id);
  assert.deepEqual((await streamA.next('pair')).payload, { state: 'back' });
  streamB2.close();
  await streamA.next('pair');

  assert.deepEqual((await h.board('/api/pair/end', { pair: b.pair, key: b.key })).body, { ok: true });
  assert.deepEqual((await streamA.next('pair')).payload, { state: 'ended' }, 'the other side hears it end');
  assert.equal((await sendFrom(a, [turn])).status, 410);
  assert.equal((await listen(a)).status, 410);
  streamA.close();
});

test('a stream that reconnects gets only what came after the last event it saw', async () => {
  const { a, b } = await paired();
  const streamB = await listen(b);
  await streamB.next('pair');
  await sendFrom(a, [{ tag: 'page', payload: { page: 1 } }]);
  const seen = await streamB.next('page');
  streamB.close();
  await sendFrom(a, [
    { tag: 'page', payload: { page: 2 } },
    { tag: 'page', payload: { page: 3 } },
  ]);
  const again = await listen(b, seen.id);
  const replayed = [await again.next(), await again.next(), await again.next()];
  assert.deepEqual(
    replayed.map(e => e.payload),
    [{ page: 2 }, { page: 3 }, { state: 'paired' }],
  );
  again.close();
  const fresh = await listen(b);
  assert.deepEqual((await fresh.next()).payload, { page: 1 }, 'a first connect gets all that was kept');
  fresh.close();
});

test("a side has one stream: a new one ends the old, and the other side doesn't hear it away", async () => {
  const { a, b } = await paired();
  const streamA = await listen(a);
  const first = await listen(b);
  await first.next('pair');
  const second = await listen(b);
  await second.next('pair');
  await first.ended;
  await sendFrom(a, [{ tag: 'page', payload: { page: 9 } }]);
  assert.deepEqual((await second.next('page')).payload, { page: 9 });
  assert.ok(!streamA.events.some(e => e.payload.state === 'away'));
  for (const s of [streamA, first, second]) s.close();
});

test('the sweep: a pairing never joined goes, one both sides left ends, an old ended one goes', async () => {
  const waiting = (await create()).body;
  const quiet = await paired();
  const now = Date.now();
  h.db.prepare('update pairs set code_expires = ? where id = ?').run(now - 2 * 60_000, waiting.pair);
  pair.sweep(now + 11 * 60_000);
  assert.equal((await create({ pair: waiting.pair, key: waiting.key })).status, 404, 'a waiting pairing goes');
  assert.equal((await sendFrom(quiet.a, [{ tag: 'page', payload: {} }])).status, 410, 'a quiet one ends');
  pair.sweep(now + 25 * 3_600_000);
  assert.equal((await sendFrom(quiet.a, [{ tag: 'page', payload: {} }])).status, 404, 'a day after, it goes');
});

test('only the board, signed in, from its own pages', async () => {
  const { a } = await paired();
  const anon = (path: string, body?: unknown) =>
    h.send(path, { origin: ORIGIN, 'content-type': 'application/json' }, body);
  for (const path of ['/api/pair', '/api/pair/join', '/api/pair/send', '/api/pair/end'])
    assert.equal((await anon(path, { pair: a.pair, key: a.key, code: '123456', events: [] })).status, 401, path);
  assert.equal((await anon(`/api/pair/live?pair=${a.pair}&key=${a.key}`)).status, 401);
  const elsewhere = await h.send('/api/pair', { cookie: h.boardCookie, origin: 'https://elsewhere.test' }, {});
  assert.equal(elsewhere.status, 403);
  assert.equal((await listen({ pair: 'unknown', key: a.key })).status, 404);
  assert.equal((await listen({ pair: a.pair, key: 'wrong' })).status, 403);
});
