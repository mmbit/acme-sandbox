// node --test src/owndevice.test.ts: HQ marks the board's devices as its own on every host of the zone, so the
// products' counts skip their visits (auth.ts markOwnDevice; Caddy's own_device).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('owndevice', { env: { PUBLIC_HOST: 'hq.company.test' } });
const MARK = /^hq-own-device=1; Domain=company\.test; Path=\/; HttpOnly; SameSite=Lax; Max-Age=34560000; Secure$/;
const marks = async (cookie?: string, path = '/') => {
  const res = await fetch(`${h.base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  await res.body?.cancel();
  return res.headers.getSetCookie().filter(c => c.startsWith('hq-own-device='));
};

test('a signed-in device without the mark gets it, for the whole zone and long', async () => {
  const [mark, ...more] = await marks(h.boardCookie);
  assert.match(mark, MARK);
  assert.equal(more.length, 0);
});

test('a device that has it, or anyone not signed in, gets nothing', async () => {
  assert.deepEqual(await marks(`${h.boardCookie}; hq-own-device=1`), []);
  assert.deepEqual(await marks(), []);
  assert.deepEqual(await marks('hq-own-device=1'), []);
  assert.deepEqual(await marks('s=not-a-session'), []);
});
