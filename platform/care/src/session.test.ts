// node --test src/session.test.ts   (uses a throwaway DATA_DIR)
// The cookie's flags, a new id after each grant (the old one dead), and the email grant's own expiry.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'care-session-'));
const session = await import('./session.ts');
const { db } = await import('./db.ts');

const HOUR = 3_600_000;
const req = (cookie: string) => ({ headers: { cookie } }) as any;
const value = (setCookie: string) => setCookie.split(';')[0];   // '__Host-care=…', as the browser sends it back

test('a CARE_COOKIE without __Host- stops the service at start: never a cookie a sibling host could plant', async () => {
  const { execFile } = await import('node:child_process');
  const run = (name: string) => new Promise<string>(r => execFile(process.execPath, ['-e', "import('./src/session.ts').then(() => console.log('started'), e => console.log(e.message))"],
    { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, CARE_COOKIE: name } }, (_e, out) => r(out.trim())));
  assert.match(await run('chat'), /must be a plain name starting with __Host-/);
  assert.match(await run('__Host-chat;x'), /must be a plain name/);
  assert.equal(await run('__Host-chat'), 'started');
});

test('the cookie is exactly __Host-care, Secure; HttpOnly; SameSite=Lax; Path=/ for 30 days, and only opens its own app', () => {
  const { session: s, cookie } = session.create('shop');
  // __Host-: no Domain, Path=/ and Secure, so no other host under the company's domain can plant one (Caddy keeps it from the product)
  assert.match(cookie, /^__Host-care=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
  assert.equal(session.open(req(value(cookie)), 'shop')?.id, s.id);
  assert.equal(session.open(req(value(cookie)), 'shop@preview'), null, 'the preview twin is another app');
  assert.equal(session.open(req('__Host-care=' + 'A'.repeat(43)), 'shop'), null);
  assert.equal(session.open(req(value(cookie).replace('__Host-care=', 'care=')), 'shop'), null, 'the plain name, which any host could set, opens nothing');
  assert.equal(session.refresh(req(`x=1; ${value(cookie)}`), s), cookie, 'sliding: the same id with a fresh Max-Age');
  // the table keeps only the hash: the cookie's value is nowhere in it
  const raw = value(cookie).slice('__Host-care='.length);
  assert.equal((db.prepare('select count(*) as n from sessions where id = ?').get(raw) as any).n, 0);
});

test('each grant gives the session a new id on rotation, and the old cookie is dead at once', () => {
  const first = session.create('shop');
  // (grants carry the order's app; conversations go by shop)
  const s1 = session.grantOrder(first.session, [{ app: 'shop', id: 'ORD-1' }], 'mila@example.com')!;
  assert.equal(session.level(s1), 1);
  // the grant was raised outside a response (the model's path): the next request sees it must rotate
  const opened = session.open(req(value(first.cookie)), 'shop')!;
  assert.equal(opened.rotate, true);
  const r1 = session.rotate(opened)!;
  assert.notEqual(r1.session.id, first.session.id);
  assert.equal(session.open(req(value(first.cookie)), 'shop'), null, 'old cookie dead');
  assert.equal(session.rotate(opened), null, 'a second request with the old cookie loses the race');
  const now1 = session.open(req(value(r1.cookie)), 'shop')!;
  // (grants carry the order's app; conversations go by shop)
  assert.deepEqual([now1.rotate, now1.orders, session.level(now1)], [undefined, [{ app: 'shop', id: 'ORD-1' }], 1]);

  const s2 = session.grantEmail(now1, 'mila@example.com')!;
  const r2 = session.rotate(session.open(req(value(r1.cookie)), 'shop')!)!;
  assert.equal(session.open(req(value(r1.cookie)), 'shop'), null);
  const now2 = session.open(req(value(r2.cookie)), 'shop')!;
  assert.equal(session.level(now2), 2);
  assert.deepEqual(now2.orders, [], 'the order grant under the same email is covered by the email grant');
  assert.notEqual(s2.id, now2.id);
});

test('a grant applied to a Session read before a rotation lands on the session as it is now', () => {
  const { session: s, cookie } = session.create('shop');
  // (grants carry the order's app; conversations go by shop)
  const held = session.grantOrder(s, [{ app: 'shop', id: 'ORD-1' }], 'mila@example.com')!;       // the engine holds this across a model call
  const r = session.rotate(session.open(req(value(cookie)), 'shop')!)!; // meanwhile a POST rotates it
  const after = session.grantOrder(held, [{ app: 'shop', id: 'ORD-7' }], 'mila@example.com')!;
  assert.equal(after.id, r.session.id);
  assert.deepEqual(session.open(req(value(r.cookie)), 'shop')!.orders, [{ app: 'shop', id: 'ORD-1' }, { app: 'shop', id: 'ORD-7' }]);
  // an order matched under another email starts the list again: the grants are always one email's
  // (grants carry the order's app; conversations go by shop)
  assert.deepEqual(session.grantOrder(after, [{ app: 'shop', id: 'ORD-2' }], 'sam@example.com')!.orders, [{ app: 'shop', id: 'ORD-2' }]);
  session.forget(after);
  assert.equal(session.grantEmail(held, 'mila@example.com'), null, 'a forgotten session takes no grant');
});

test('the email grant lapses at 24 h idle and at 7 days whatever, while the session stays', (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { session: s0, cookie } = session.create('shop');
  // (grants carry the order's app; conversations go by shop)
  const thread = Number((db.prepare("insert into conversations (shop, email, created, last) values ('shop', 'mila@example.com', 0, 0) returning id").get() as any).id);
  session.attach(s0, thread);
  const s = session.grantEmail(s0, 'mila@example.com')!;
  const at = s.emailAt!;
  assert.equal(session.level(s, at + 23 * HOUR), 2);
  assert.equal(session.level(s, at + 24 * HOUR), 0, '24 h idle');

  // in use every 12 hours: the idle limit slides, the 7-day limit doesn't; a money action needs a check from the last 24 h
  let c = s;
  for (let h = 12; h < 7 * 24; h += 12) {
    mock.timers.tick(12 * HOUR);
    c = session.open(req(value(cookie)), 'shop')!;
    assert.equal(session.level(c), 2, `still level 2 after ${h} h`);
    assert.equal(session.fresh(c), h < 24, `fresh after ${h} h`);
    session.touch(c);
  }
  mock.timers.tick(12 * HOUR);
  const lapsed = session.open(req(value(cookie)), 'shop');
  assert.ok(lapsed, 'the session stays');
  assert.equal(session.level(lapsed), 0);
  assert.equal(lapsed.email, null);
  assert.equal(lapsed.conversation, null, 'a device below level 2 leaves the email thread');
  session.touch(lapsed);
  assert.equal(session.level(session.open(req(value(cookie)), 'shop')!), 0, 'touching never revives a lapsed grant');
});

test('a stream in the email thread hears nothing once the grant lapsed, with no request to lapse it, and the device leaves the thread', (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { session: s0 } = session.create('shop');
  // (grants carry the order's app; conversations go by shop)
  const thread = Number((db.prepare("insert into conversations (shop, email, created, last) values ('shop', 'noor@example.com', 0, 0) returning id").get() as any).id);
  session.attach(s0, thread);
  const s = session.rotate(session.grantEmail(s0, 'noor@example.com')!)!.session; // the request that carried the grant
  assert.equal(session.hearing(s.id, thread), 'all');
  mock.timers.tick(24 * HOUR); // the tab left open, no request since
  assert.equal(session.hearing(s.id, thread), 'none');
  assert.equal(session.current(s)!.conversation, null);
  assert.equal(session.current(s)!.email, null);
});

test('a grant the model raised is held for its page: another page with the cookie can’t take it, and after a minute it ends', async (t) => {
  t.after(() => mock.timers.reset());
  const first = session.create('shop');
  // (grants carry the order's app; conversations go by shop)
  const s = session.grantOrder(first.session, [{ app: 'shop', id: 'ORD-1' }], 'mila@example.com', session.pageOf('page-a')!)!;
  const opened = session.open(req(value(first.cookie)), 'shop')!;
  assert.equal(session.mayUse(opened, 'page-b'), false, 'someone else holding the cookie');
  assert.equal(session.mayUse(opened, 'page-a'), true);
  const chat = Number((db.prepare("insert into conversations (shop, created, last) values ('shop', 0, 0) returning id").get() as any).id);
  assert.equal(session.hearing(s.id, chat), 'none', 'not in a conversation yet');
  session.attach(s, chat);
  assert.equal(session.hearing(s.id, chat), 'renew', 'a stream on the old id hears only "renew" while the grant waits');
  const r = session.rotate(opened)!;
  assert.equal(session.mayUse(session.open(req(value(r.cookie)), 'shop')!, 'page-b'), true, 'the new id is free for all its pages');
  assert.equal(session.hearing(r.session.id, chat), 'all');
  assert.equal(session.hearing(s.id, chat), 'none', 'the old id hears nothing more');
  // a page that never comes back for the new id: the session ends, and nobody else gets the grant
  const other = session.create('shop');
  // (grants carry the order's app; conversations go by shop)
  session.grantOrder(other.session, [{ app: 'shop', id: 'ORD-1' }], 'mila@example.com', session.pageOf('page-a')!);
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  mock.timers.tick(60_001);
  assert.equal(session.open(req(value(other.cookie)), 'shop'), null);
});

test('forget deletes the session and clears the cookie', () => {
  const { session: s, cookie } = session.create('shop');
  assert.equal(session.forget(s), '__Host-care=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  assert.equal(session.open(req(value(cookie)), 'shop'), null);
});

