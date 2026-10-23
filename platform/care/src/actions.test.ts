// node --test src/actions.test.ts   (uses a throwaway DATA_DIR)
// A tap on an action from another session, a second tap and a tap after it expired all fail.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'care-actions-'));
const actions = await import('./actions.ts');
const session = await import('./session.ts');
const { db } = await import('./db.ts');

// by shop
const conversation = () => Number((db.prepare("insert into conversations (shop, created, last) values ('shop', 0, 0) returning id").get() as any).id);
const confirm = (s: { id: string; shop: string }, ttlMs = 10 * 60_000) =>
  actions.propose({ conversation: conversation(), session: s.id, shop: s.shop, kind: 'confirm', args: { order: 'ORD-1' }, ttlMs });

test('an action runs once, only in its own session and shop', () => {
  const mine = session.create('shop').session, theirs = session.create('shop').session;
  const { id } = confirm(mine);
  assert.match(id, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(actions.take(id, theirs.id, 'shop'), null, 'another session');
  assert.equal(actions.take(id, mine.id, 'shop@preview'), null, 'another shop');
  const a = actions.take(id, mine.id, 'shop')!;
  assert.deepEqual([a.kind, a.args], ['confirm', { order: 'ORD-1' }]);
  assert.equal(actions.take(id, mine.id, 'shop'), null, 'a second tap');
  actions.done(id, { ok: true, ref: 'R-1' });
  assert.equal((db.prepare('select result from actions where id = ?').get(id) as any).result, '{"ok":true,"ref":"R-1"}');
});

test('an expired action is refused', (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const s = session.create('shop').session;
  const { id } = confirm(s, 60_000);
  mock.timers.tick(60_000);
  assert.equal(actions.take(id, s.id, 'shop'), null);
});

test('an action proposed before the session rotated is still its own after it', () => {
  const { session: s, cookie } = session.create('shop');
  const { id } = confirm(s);
  const opened = session.open({ headers: { cookie: cookie.split(';')[0] } } as any, 'shop')!;
  const r = session.rotate(opened)!;
  assert.equal(actions.take(id, s.id, 'shop'), null, 'the old id holds nothing');
  assert.ok(actions.take(id, r.session.id, 'shop'));
});
