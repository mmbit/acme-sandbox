// node --test src/upgrades.test.ts (throwaway DATA_DIR and the test company): HQ takes one upgrade, review mode's
// dictation; any other request carrying Upgrade headers is answered as it is without them. Caddy's forward_auth asks
// /api/me before each call with the call's own WebSocket headers, and a 404 there dropped every call (25 October).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { harness } from './harness.ts';

const h = await harness('upgrades');

// The status of a request with a WebSocket's headers (101 if it was upgraded)
const asUpgrade = (path: string, cookie?: string) =>
  new Promise<number>((resolve, reject) => {
    const q = request(`${h.base}${path}`, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...(cookie ? { cookie } : {}),
      },
    });
    q.on('upgrade', (answer, socket) => {
      socket.destroy();
      resolve(101);
    });
    q.on('response', answer => {
      answer.resume();
      resolve(answer.statusCode!);
    });
    q.on('error', reject);
    q.end();
  });

// (dictation's own upgrade: dictation.test.ts)
test("the login check answers a call's upgrade headers as it answers without them", async () => {
  assert.equal(await asUpgrade('/api/me', h.boardCookie), (await h.board('/api/me')).status, "the board's session");
  assert.equal(await asUpgrade('/api/me'), 401, 'no session');
});
