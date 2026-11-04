// node --test src/pair.test.ts (uses a throwaway DATA_DIR).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';
import { cookieOf } from './testdoor.ts';
import { reviewModeOff } from './testreview.ts';

const before = (repo: string) => {
  for (const folder of ['2026-03-01-deck/presentation', '2026-03-02-other']) {
    mkdirSync(`${repo}/products/_cycles/${folder}`, { recursive: true });
    writeFileSync(`${repo}/products/_cycles/${folder}/index.html`, '<!doctype html><title>Deck</title>');
  }
};
const h = await harness('pair', { env: { CADDY_HOST: '127.0.0.1', PUBLIC_HOST: 'hq.company.test' }, before });
const { ORIGIN } = await import('./config.ts');
const { viewerId } = await import('./viewers.ts');
const HELLO = 'hello.preview.company.test',
  CYCLES = 'cycles.preview.company.test',
  PAGE = `https://${HELLO}/deck/?lang=nl#3`;
const make = (url: unknown = PAGE) => h.board('/api/pair-codes', { url });
const join = (code: string, origin = ORIGIN) => h.send('/api/pair-codes/open', { origin }, { code });
const check = (cookie: string, host: string, uri = '/', query = '') =>
  h.send(`/api/preview/check${query}`, { cookie, 'x-forwarded-host': host, 'x-forwarded-uri': uri });
// The device's side: the code typed or scanned, then the link it gets → the page it lands on and the cookie it holds
async function opened(url: string) {
  const joined = await join((await make(url)).body.code);
  assert.equal(joined.status, 200);
  assert.equal(joined.headers['set-cookie'], undefined); // no session of HQ's, nor any other cookie on HQ's host
  const link = new URL(joined.json.url);
  const landed = await h.send(link.pathname + link.search, { host: link.host });
  assert.equal(landed.status, 302);
  return { link, landed, cookie: cookieOf(landed) };
}

test('a pair code is board-only to make, only for a page a share opens, and works once', async () => {
  assert.equal((await h.send('/api/pair-codes', { origin: ORIGIN }, { url: PAGE })).status, 401);
  const notShared = [null, '', ORIGIN, `${ORIGIN}/`, 'https://evil.example/', `http://${HELLO}/`, `https://${CYCLES}/`];
  for (const url of notShared) assert.equal((await make(url)).status, 400, String(url));
  const made = await make();
  assert.equal(made.status, 200);
  assert.match(made.body.code, /^\d{6}$/);
  assert.ok(made.body.expires > Date.now());
  assert.equal((await join(made.body.code, 'https://outside.example')).status, 403);
  assert.equal((await join(made.body.code)).status, 200);
  assert.equal((await join(made.body.code)).status, 403);
});

test('a scanned code opens its page to view on the device, never as the board and never HQ', async () => {
  const { link, landed, cookie } = await opened(PAGE);
  assert.equal(link.host, HELLO);
  assert.equal(link.hash, '#3'); // (the slide it was on, kept by the redirect)
  assert.equal(landed.headers.location, '/deck/?lang=nl');
  assert.match(cookie, /^ps=/); // a share's session, no preview key of the board's
  assert.doesNotMatch(String(landed.headers['set-cookie']), /Domain=/i); // this host alone
  const looked = await check(cookie, HELLO, '/deck/');
  assert.equal(looked.status, 200);
  assert.ok(looked.headers['x-viewer']);
  assert.notEqual(looked.headers['x-viewer'], viewerId('hello', 'board'));
  assert.equal((await check(cookie, HELLO, '/', '?board=1')).status, 403); // the board's own routes (the shop chat)
  assert.equal((await check(cookie, 'other.preview.company.test')).status, 302);
  // no review mode: its script is off, and a note pinned with it is refused
  assert.ok(reviewModeOff((await h.send('/__review/review.js', { host: HELLO, cookie })).text));
  const pinned = await h.send(
    '/__review/notes',
    { host: HELLO, cookie, origin: `https://${HELLO}` },
    { note: 'Hard to find', page: `https://${HELLO}/deck/`, element: { kind: 'pin' }, viewport: { w: 390, h: 844 } },
  );
  assert.equal(pinned.status, 403);
  // whatever the device now holds, HQ answers it as a stranger: its pages send it to the passkey, its routes refuse
  for (const held of [cookie, '']) {
    for (const route of ['/api/notebooks', '/api/org', '/api/jobs', '/api/requests'])
      assert.equal((await h.send(route, { cookie: held })).status, 401, route);
    assert.equal((await h.send('/api/pair-codes', { origin: ORIGIN, cookie: held }, { url: PAGE })).status, 401);
    const handOn = await h.send(
      '/__preview/handoff',
      { host: HELLO, cookie: held, origin: `https://${HELLO}` },
      { to: '/' },
    );
    assert.equal(handOn.status, 403);
  }
  const home = await h.send('/', { cookie });
  assert.equal(home.status, 302);
  assert.match(String(home.headers.location), /\/login/);
});

test("a code for a cycle's deck opens that cycle's folder alone", async () => {
  const { cookie } = await opened(`https://${CYCLES}/2026-03-01-deck/presentation/#4`);
  assert.equal((await check(cookie, CYCLES, '/2026-03-01-deck/presentation/')).status, 200);
  assert.equal((await h.send('/2026-03-01-deck/presentation/', { host: CYCLES, cookie })).status, 200);
  assert.equal((await check(cookie, CYCLES, '/2026-03-02-other/')).status, 302);
  assert.equal((await h.send('/2026-03-02-other/index.html', { host: CYCLES, cookie })).status, 403);
});

test('renewed and expired pair codes open nothing', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 120_000 });
  const older = await make();
  const newer = await make();
  assert.equal((await join(older.body.code)).status, 403);
  assert.equal((await join(newer.body.code)).status, 200);
  const expired = await make();
  t.mock.timers.tick(60_001);
  const refused = await join(expired.body.code);
  assert.equal(refused.status, 403);
  assert.equal(refused.headers['set-cookie'], undefined);
});

test('repeated pair-code guesses stop at the authentication boundary', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 360_000 });
  const made = await make();
  const wrong = made.body.code === '000000' ? '999999' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await join(wrong)).status, 403);
  assert.equal((await join(made.body.code)).status, 429);
  t.mock.timers.tick(60_001);
  const fresh = await make();
  assert.equal((await join(fresh.body.code)).status, 200);
});

test('wrong guesses across clients invalidate every live code and a new code still opens', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 600_000 });
  const made = await make();
  // (another of the board's devices: its own code beside this one)
  const other = await h.send('/api/pair-codes', { origin: ORIGIN, cookie: `${h.boardCookie}; other=1` }, { url: PAGE });
  assert.equal(other.status, 200);
  const wrong = ['000000', '000001', '000002'].find(code => ![made.body.code, other.json.code].includes(code));
  for (let i = 1; i <= 10; i++) {
    const refused = await h.send(
      '/api/pair-codes/open',
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
  const fresh = await make();
  assert.equal((await join(fresh.body.code)).status, 200);
});

test('a device can still open a code after nine wrong guesses across clients', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 720_000 });
  const made = await make();
  const wrong = made.body.code === '000000' ? '999999' : '000000';
  for (let i = 1; i <= 9; i++) {
    const refused = await h.send(
      '/api/pair-codes/open',
      { origin: ORIGIN, 'x-forwarded-for': `192.0.2.${i}` },
      { code: wrong },
    );
    assert.equal(refused.status, 403);
  }
  assert.equal((await join(made.body.code)).status, 200);
});
