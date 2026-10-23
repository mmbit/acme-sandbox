// node --test shared/routes/routes.test.ts   (a real server on a free port, asked through fetch)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { routes } from './routes.ts';

const answer = (res: import('node:http').ServerResponse, body: unknown) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const api = routes({
  'GET /api/orders/:id(ord-[a-z0-9]{4})': ({ res, params }) => answer(res, { order: params.id }),
  'POST /api/orders/:id(ord-[a-z0-9]{4})/line': async ({ res, params, jsonBody }) =>
    answer(res, { order: params.id, sent: await jsonBody(100) }),
  'GET /api/names/:name': ({ res, params }) => answer(res, { name: params.name }),
  'HEAD /api/health': ({ res }) => res.writeHead(204).end(),
  '* /api/care/*': ({ req, res, params }) => answer(res, { method: req.method, rest: params[0] }),
});

let server: Server;
let base: string;
before(async () => {
  server = createServer((req, res) => api(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const ask = async (path: string, init?: RequestInit) => {
  const res = await fetch(base + path, init);
  return { status: res.status, allow: res.headers.get('allow'), body: await res.json().catch(() => null) };
};
const post = (path: string, body: string) => ask(path, { method: 'POST', body });

test('a route gets its params by name', async () => {
  assert.deepEqual(await ask('/api/orders/ord-ab12'), { status: 200, allow: null, body: { order: 'ord-ab12' } });
});

test('a percent-encoded param arrives decoded', async () => {
  assert.deepEqual((await ask('/api/names/Zo%C3%AB%20%2F%20Jo')).body, { name: 'Zoë / Jo' });
});

test('a path no pattern matches is a 404, a param of the wrong shape too', async () => {
  for (const path of ['/api/nothing', '/api/orders/ord-AB12', '/api/orders/ord-ab12/', '/api/orders/ord-ab12/x'])
    assert.deepEqual(await ask(path), { status: 404, allow: null, body: { code: 'notfound' } }, path);
});

test('a path that matches with another method is a 405 naming the methods it takes', async () => {
  assert.deepEqual(await ask('/api/orders/ord-ab12', { method: 'DELETE' }), {
    status: 405,
    allow: 'GET',
    body: { code: 'method' },
  });
  assert.equal((await ask('/api/orders/ord-ab12/line')).allow, 'POST');
});

test('a HEAD is answered by the GET route', async () => {
  assert.equal((await fetch(`${base}/api/orders/ord-ab12`, { method: 'HEAD' })).status, 200);
});

test('a HEAD route of its own on one path leaves the other paths answering HEAD by their GET', async () => {
  assert.equal((await fetch(`${base}/api/health`, { method: 'HEAD' })).status, 204);
  assert.equal((await fetch(`${base}/api/names/jo`, { method: 'HEAD' })).status, 200);
});

test('a malformed percent-encoding in a param is a 400', async () => {
  assert.deepEqual(await ask('/api/names/%E0%A4%A'), { status: 400, allow: null, body: { code: 'generic' } });
});

test('the body reads as JSON within its cap, and as null over it or when it is not JSON', async () => {
  const path = '/api/orders/ord-ab12/line';
  assert.deepEqual((await post(path, '{"tag":"zoë"}')).body.sent, { tag: 'zoë' });
  assert.equal((await post(path, JSON.stringify({ tag: 'x'.repeat(200) }))).body.sent, null);
  assert.equal((await post(path, '{"tag":')).body.sent, null);
});

test('a body over its cap sent without a length is cut off at the cap', async () => {
  const chunks = new ReadableStream({
    start(controller) {
      const text = JSON.stringify('x'.repeat(300));
      for (let i = 0; i < text.length; i += 30) controller.enqueue(new TextEncoder().encode(text.slice(i, i + 30)));
      controller.close();
    },
  });
  const res = await ask('/api/orders/ord-ab12/line', { method: 'POST', body: chunks, duplex: 'half' } as RequestInit);
  assert.equal(res.body.sent, null);
});

test('a * route takes every method and the rest of the path', async () => {
  assert.deepEqual((await ask('/api/care/orders/12', { method: 'PUT' })).body, { method: 'PUT', rest: 'orders/12' });
});

test('an empty body reads as an empty object', async () => {
  assert.deepEqual((await post('/api/orders/ord-ab12/line', '')).body.sent, {});
});

test('a * rest comes as written, a lone % too', async () => {
  assert.deepEqual((await ask('/api/care/files/100%25%.png', { method: 'GET' })).body, {
    method: 'GET',
    rest: 'files/100%25%.png',
  });
});
