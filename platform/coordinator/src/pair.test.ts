// node --test src/pair.test.ts (uses a throwaway DATA_DIR).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('notebook-pair', { env: { CADDY_HOST: '127.0.0.1' } });
const { ORIGIN } = await import('./config.ts');
const join = (code: string, origin = ORIGIN) => h.send('/api/notebooks/pair/join', { origin }, { code });

test('a device code is board-only to create, works once, and signs the second device into HQ', async () => {
  const denied = await h.send('/api/notebooks/pair', { origin: ORIGIN }, {});
  assert.equal(denied.status, 401);
  const made = await h.board('/api/notebooks/pair', {});
  assert.equal(made.status, 200);
  assert.match(made.body.code, /^\d{6}$/);
  assert.ok(made.body.expires > Date.now());
  assert.equal((await join(made.body.code, 'https://outside.example')).status, 403);
  const signedIn = await join(made.body.code);
  assert.equal(signedIn.status, 200);
  const cookie = String(signedIn.headers['set-cookie']).split(';')[0];
  assert.equal((await h.send('/api/notebooks', { cookie })).status, 200);
  assert.equal((await join(made.body.code)).status, 403);
});

test('renewed and expired device codes cannot create a session', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 120_000 });
  const older = await h.board('/api/notebooks/pair', {});
  const newer = await h.board('/api/notebooks/pair', {});
  assert.equal((await join(older.body.code)).status, 403);
  assert.equal((await join(newer.body.code)).status, 200);
  const expired = await h.board('/api/notebooks/pair', {});
  t.mock.timers.tick(60_001);
  const refused = await join(expired.body.code);
  assert.equal(refused.status, 403);
  assert.equal(refused.headers['set-cookie'], undefined);
});

test('repeated device-code guesses stop at the authentication boundary', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 360_000 });
  const made = await h.board('/api/notebooks/pair', {});
  const wrong = made.body.code === '000000' ? '999999' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await join(wrong)).status, 403);
  assert.equal((await join(made.body.code)).status, 429);
  t.mock.timers.tick(60_001);
  const fresh = await h.board('/api/notebooks/pair', {});
  assert.equal((await join(fresh.body.code)).status, 200);
});

test('wrong guesses across clients invalidate every live code and a new code can sign in', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 600_000 });
  const bootstrap = await h.board('/api/notebooks/pair', {});
  const signedIn = await join(bootstrap.body.code);
  assert.equal(signedIn.status, 200);
  const cookie = String(signedIn.headers['set-cookie']).split(';')[0];
  const made = await h.board('/api/notebooks/pair', {});
  const other = await h.send('/api/notebooks/pair', { origin: ORIGIN, cookie }, {});
  assert.equal(other.status, 200);
  const wrong = ['000000', '000001', '000002'].find(code => ![made.body.code, other.json.code].includes(code));
  for (let i = 1; i <= 10; i++) {
    const refused = await h.send(
      '/api/notebooks/pair/join',
      { origin: ORIGIN, 'x-forwarded-for': `192.0.2.${i}` },
      { code: wrong },
    );
    assert.equal(refused.status, 403);
    assert.equal(refused.headers['set-cookie'], undefined);
  }
  for (const code of [made.body.code, other.json.code]) {
    const refused = await join(code);
    assert.equal(refused.status, 403);
    assert.equal(refused.headers['set-cookie'], undefined);
  }
  const fresh = await h.board('/api/notebooks/pair', {});
  assert.equal((await join(fresh.body.code)).status, 200);
});

test('a device can still sign in after nine wrong guesses across clients', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 720_000 });
  const made = await h.board('/api/notebooks/pair', {});
  const wrong = made.body.code === '000000' ? '999999' : '000000';
  for (let i = 1; i <= 9; i++) {
    const refused = await h.send(
      '/api/notebooks/pair/join',
      { origin: ORIGIN, 'x-forwarded-for': `192.0.2.${i}` },
      { code: wrong },
    );
    assert.equal(refused.status, 403);
  }
  assert.equal((await join(made.body.code)).status, 200);
});
