// node --test src/archive.test.ts   (the desk phone's answered cards: the test company, HQ's real server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('archive');
const { board, jobs } = h;
const { ORIGIN } = await import('./config.ts');
const kit = await h.start({ agent: 'kit' });
const ask = (card: Record<string, unknown>) => h.ask(kit, card);
const answer = async (id: number, text: string, more = {}) => assert.equal((await h.answer(id, text, more)).status, 200);
// convert -size 48x32 gradient:red-blue -strip -quality 60 base.jpg
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAgADADASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAQDBv/EABUQAQEAAAAAAAAAAAAAAAAAAAAS/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYB/8QAFhEBAQEAAAAAAAAAAAAAAAAAABRh/9oADAMBAAIRAxEAPwDnLLT2WyHFpYostPZZDhYostPZZDhYwstPZayhxKWKLLT2WQ4WKLLT2WQ4WP/Z', 'base64');
// the board adds a picture to an open card on the desk phone
const upload = async (id: number) => assert.equal((await fetch(`${h.base}/api/requests/photo?id=${id}&field=0`, { method: 'POST', body: JPEG,
  headers: { cookie: h.boardCookie, origin: ORIGIN, 'content-type': 'image/jpeg' } })).status, 200);
const page = async (before?: number) => (await board(`/api/requests/archive${before ? `?before=${before}` : ''}`)).body as { cards: any[]; more: boolean; total: number };
// every card, page by page, as desk.js's Older cards loads them
async function archive() {
  const all: any[] = [];
  for (let p = await page(); ; p = await page(all.at(-1).id)) { all.push(...p.cards); if (!p.more) return all; }
}

test('answered and closed cards, newest first, with what the board answered; open cards and sign-ins stay out', async () => {
  const deck = await ask({ title: 'Poppy: the pitch', body: 'The pitch: https://cycles.preview.testco.example/support-chat-pitch/presentation/\n\nChoose:\n- A: one\n- B: two' });
  const shut = await ask({ title: 'Moot now' });
  const open = await ask({ title: 'Still open' });
  const login = (h.jobs.createRequest({ kind: 'login', seat: 'claude-9', title: 'Sign in', body: 'Sign in' }) as { id: number }).id;
  await answer(deck, 'A\n\nLove it.');
  assert.equal((await h.agent('request-close', kit.token, { id: shut })).status, 200);
  await answer(login, 'code');
  const list = await archive(), ids = list.map(r => r.id);
  assert.deepEqual(ids.slice(0, 2), [shut, deck]);
  assert.ok(!ids.includes(open) && !ids.includes(login));
  const card = list.find(r => r.id === deck);
  assert.deepEqual([card.answer, card.status], ['A\n\nLove it.', 'answered']);
  assert.match(card.body, /support-chat-pitch\/presentation/);
  assert.ok(Date.now() - Date.parse(card.answered) < 60_000);
  assert.equal(list.find(r => r.id === shut).status, 'done');
  assert.ok(list.find(r => r.id === shut).answered);
  assert.equal((await fetch(`${h.base}/api/requests/archive`)).status, 401, "the board's session only");
});

test("every card comes whole, a customer card and its photos too; a key's value never", async () => {
  // a customer card is a gated tool's (Care's), written about one customer
  const customer = (jobs.createRequest({ kind: 'decision', agent: 'kit', title: 'A refund', body: 'Jane Doe, order 1234', customers: true, photos: ['The parcel'] } as any) as { id: number }).id;
  const keys = await ask({ kind: 'credential', title: 'Stripe keys', body: 'Paste them', secrets: 'STRIPE_TEST_KEY' });
  const plain = await ask({ title: 'Test print', body: 'Two posters', photos: ['Ava'] });
  for (const id of [customer, plain]) await upload(id);
  await answer(customer, 'Refund it'); await answer(plain, 'Good');
  await answer(keys, '', { secrets: { STRIPE_TEST_KEY: 'sk_test_123' } });
  const list = await archive(), card = (id: number) => list.find(x => x.id === id);
  const c = card(customer);
  assert.deepEqual([c.title, c.body, c.photos], ['A refund', 'Jane Doe, order 1234', [{ label: 'The parcel', optional: false, saved: true }]]);
  assert.match(c.answer, /^Refund it/);
  assert.equal(card(keys).body, 'Paste them');
  assert.match(card(keys).answer, /STRIPE_TEST_KEY/);
  assert.ok(!JSON.stringify(list).includes('sk_test'));
  assert.deepEqual(card(plain).photos, [{ label: 'Ava', optional: false, saved: true }]);
  const shot = await fetch(`${h.base}/api/requests/photo?id=${plain}&field=0`, { headers: { cookie: h.boardCookie } });
  assert.equal(shot.status, 200); assert.equal(shot.headers.get('cache-control'), 'private, no-store');
  const photo = (id: number, field = 0, cookie = h.boardCookie) => fetch(`${h.base}/api/requests/photo?id=${id}&field=${field}`, { headers: { cookie } }).then(r => r.status);
  assert.equal(await photo(customer), 200);
  assert.equal(await photo(plain, 1), 404);
  assert.equal(await photo(plain, 0, ''), 401);
  const still = await ask({ title: 'Open', photos: ['X'] });
  await upload(still);
  assert.equal(await photo(still), 404, "an open card's photos aren't served here (the desk phone shows its own)");
});

test('more than a page of cards: every one is reached, once, in order, a page at a time', async () => {
  const at = Date.parse('2026-09-01T00:00:00Z');
  const ids: number[] = [];
  for (let i = 0; i < 120; i++) { ids.push(await ask({ title: `Card ${i}` })); await answer(ids[i], 'ok'); }
  // Answered long ago, some at the same moment (the id breaks the tie): an answer's time is the clock's, no route sets it
  // in one transaction: a commit per card takes seconds, past the server's keep-alive, and the next fetch's socket is reset
  h.db.exec('begin');
  ids.forEach((id, i) => h.db.prepare('update requests set answered = ? where id = ?').run(new Date(at + Math.floor(i / 3) * 60_000).toISOString(), id));
  h.db.exec('commit');
  const first = await page();
  assert.equal(first.cards.length, 50); assert.ok(first.more);
  const all = await archive(), got = all.map(r => r.id);
  assert.equal(all.length, first.total); assert.equal(new Set(got).size, got.length);
  assert.deepEqual(got.slice(-120), [...ids].reverse());
  const key = (r: any) => `${r.answered ?? r.created}|${String(r.id).padStart(9, '0')}`;
  assert.deepEqual(all.map(key), all.map(key).sort().reverse());
  assert.deepEqual(await page(ids.at(-1)! + 10_000), { cards: [], more: false, total: 0 }, "a card that isn't in the archive is no place to start from");
});
