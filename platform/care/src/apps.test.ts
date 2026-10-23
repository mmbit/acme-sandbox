// node --test src/apps.test.ts   (a local server playing an app's order endpoint, restarting or down)
// An app away for a moment (a deploy) isn't logged; one away call after call for over ten minutes is, and any other answer
// is logged as before.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let answer: 'ok' | 'gateway' | 'broken' | 'silent' = 'ok';
const app = createServer((req, res) => {
  req.resume().on('end', () => {
    if (answer === 'silent') return; // a call Caddy holds while the app restarts: no answer within care's wait
    if (answer === 'gateway') return res.writeHead(503).end();
    if (answer === 'broken') return res.writeHead(500).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"orders":[]}');
  });
});
await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${(app.address() as any).port}`;
const gone = createServer(); // a port nothing listens on any more: no connection
await new Promise<void>(r => gone.listen(0, '127.0.0.1', r));
const closed = `http://127.0.0.1:${(gone.address() as any).port}`;
await new Promise(r => gone.close(r));
process.env.CARE_APPS = JSON.stringify({ shop: url, other: url, closed });
process.env.CARE_TOKENS = JSON.stringify({ shop: 'token', other: 'token', closed: 'token' });
const apps = await import('./apps.ts');
test.after(() => {
  app.closeAllConnections();
  app.close();
});

const MIN = 60_000;
let clock = Date.parse('2026-10-18T20:02:00Z');
mock.method(Date, 'now', () => clock);
const lines = mock.method(console, 'error', () => {});
// what the call logged
const logged = async (app: string, minutes = 0) => {
  clock += minutes * MIN;
  lines.mock.resetCalls();
  assert.equal(await apps.call(app, 'orders', { email: 'a@example.com' }), null);
  return lines.mock.calls.map(c => String(c.arguments[0]));
};

test('a deploy: the gateway, then no answer within the wait, then the app again: no line', async () => {
  answer = 'gateway';
  assert.deepEqual(await logged('shop'), []);
  answer = 'silent';
  assert.deepEqual(await logged('shop', 1), []);
  answer = 'ok';
  assert.deepEqual(await apps.call('shop', 'orders', {}), { orders: [] });
});

test('away call after call for over ten minutes: logged, with how long', async () => {
  answer = 'gateway';
  assert.deepEqual(await logged('other', 1), []);
  assert.deepEqual(await logged('other', 6), []);
  assert.deepEqual(await logged('other', 5), ['apps: other orders answered 503, away for 11 min']);
  answer = 'ok';
  await apps.call('other', 'orders', {});
  answer = 'gateway';
  assert.deepEqual(await logged('other', 1), [], 'an answer in between starts it afresh');
  assert.deepEqual(await logged('other', 11), [], 'and so does a gap longer than the wait: two deploys apart');
});

test('no connection counts as away; any other failure is logged at once', async () => {
  assert.deepEqual(await logged('closed'), []);
  assert.deepEqual(await logged('closed', 10), ['apps: closed orders failed (TypeError), away for 10 min']);
  answer = 'broken';
  assert.deepEqual(await logged('shop', 1), ['apps: shop orders answered 500']);
});
