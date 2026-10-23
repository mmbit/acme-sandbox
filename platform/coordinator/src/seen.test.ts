// node --test src/seen.test.ts: what the board has read in Mail and the Gazette is one set of marks on the server,
// whichever device marks it, and a mark only moves forward.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('seen');
const { ORIGIN } = await import('./config.ts');
// two of the board's devices, each signed in with its own session (the laptop's left by a passkey's sign-in, as the harness's is)
const phone = h.boardCookie, laptop = 's=laptop-session';
h.db.prepare('insert into sessions (token, expires) values (?, ?)').run('laptop-session', Date.now() + 60_000);
const post = (cookie: string, body: string) => fetch(`${h.base}/api/seen`, { method: 'POST', body, headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' } });
const marks = async (cookie: string) => (await fetch(`${h.base}/api/seen`, { headers: { cookie } })).json();
const mark = async (cookie: string, list: string, newest: unknown) => {
  const res = await post(cookie, JSON.stringify({ list, newest }));
  return { status: res.status, body: await res.json() };
};

test('what one device reads is read on the others', async () => {
  assert.deepEqual(await marks(laptop), {});
  assert.equal((await mark(phone, 'mail', 12)).status, 200);
  await mark(phone, 'gazette.board', '2026-10-06T09:30');
  assert.deepEqual(await marks(laptop), { mail: 12, 'gazette.board': '2026-10-06T09:30' });
});

test('a device that is behind never brings old items back', async () => {
  const { body } = await mark(laptop, 'mail', 9);
  assert.equal(body.mail, 12);
  await mark(laptop, 'gazette.board', '2026-10-05');
  await mark(laptop, 'mail', 15);
  assert.deepEqual(await marks(phone), { mail: 15, 'gazette.board': '2026-10-06T09:30' });
});

test('only the lists HQ counts, each with its own kind of mark', async () => {
  for (const [list, newest] of [['jobs', 1], ['mail', '20'], ['mail', 1.5], ['gazette.company', 3], ['intercom', '4'], ['constructor', 'x']] as const)
    assert.equal((await mark(phone, list, newest)).status, 400, `${list}: ${newest}`);
  assert.deepEqual(await marks(phone), { mail: 15, 'gazette.board': '2026-10-06T09:30' });
});

// the intercom's: the newest chat line shown, so the CEO's replies after it count
test("the intercom's mark is a chat line id", async () => {
  assert.equal((await mark(phone, 'intercom', 4)).body.intercom, 4);
  assert.equal((await mark(laptop, 'intercom', 3)).body.intercom, 4);
});

test('a body that is not an object is refused, not a crash', async () => {
  assert.equal((await post(phone, 'null')).status, 400);
});
