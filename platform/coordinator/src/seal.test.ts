// node --test src/seal.test.ts   (the harness: a throwaway DATA_DIR, products calling with their own tokens)
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { harness } from './harness.ts';
import { productFolders, productHeaders } from './fixture.ts';

const h = await harness('seal', {
  before: repo => productFolders(repo, ['pebblet', 'plum']),
});
const as = await productHeaders();
const sealFor = async (payload: Buffer, slug = 'pebblet', mode = 'test') => {
  const r = await h.send('/api/pay/backup/seal', as(slug, mode), { payload: payload.toString('base64') });
  assert.equal(r.status, 200, r.text);
  return Buffer.from(r.json.sealed, 'base64');
};
const openAs = (sealed: Buffer, slug = 'pebblet', mode = 'test') =>
  h.send('/api/pay/backup/open', as(slug, mode), { sealed: sealed.toString('base64') });
const keyFiles = () => readdirSync(`${h.dataDir}/backup-keys`);

test("a product's payload comes back from its own seal, which starts with the format and the key's id", async () => {
  const payload = randomBytes(5000);
  const sealed = await sealFor(payload);
  assert.equal(sealed[0], 1);
  assert.deepEqual(keyFiles(), [`${sealed.readUInt32BE(1)}.key`]);
  assert.equal(statSync(`${h.dataDir}/backup-keys/${keyFiles()[0]}`).mode & 0o777, 0o600);
  assert.ok(!sealed.includes(payload.subarray(0, 32)), 'the payload is not in the clear');
  const r = await openAs(sealed);
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(r.json.payload, 'base64'), payload);
  const again = await sealFor(payload);
  assert.notDeepEqual(again, sealed, 'a fresh nonce each time');
});

test('a changed or cut-short file is refused as damaged', async () => {
  const sealed = await sealFor(Buffer.from('{"words":"Hier wonen Sam & Noor"}'));
  const changed = (at: number) => {
    const copy = Buffer.from(sealed);
    copy[at] ^= 1;
    return copy;
  };
  for (const [what, file] of [
    ['a changed byte in the middle', changed(sealed.length >> 1)],
    ['a changed tag', changed(sealed.length - 1)],
    ['a changed key id', changed(4)],
    ['a changed nonce', changed(16)],
    ['cut short', sealed.subarray(0, sealed.length - 5)],
    ['only its start', sealed.subarray(0, 10)],
    ['an unknown format', changed(0)],
  ] as const) {
    const r = await openAs(file);
    assert.equal(r.status, 422, what);
    assert.equal(r.json.why, 'damaged', what);
  }
  const notBase64 = await h.send('/api/pay/backup/open', as('pebblet'), { sealed: 'not base64!' });
  assert.equal(notBase64.status, 400);
});

test("another product's file, or the preview's in live, is refused as another stall's", async () => {
  const sealed = await sealFor(Buffer.from('plum things'), 'plum');
  const r = await openAs(sealed, 'pebblet');
  assert.equal(r.status, 403);
  assert.equal(r.json.why, 'other_stall');
  assert.equal((await openAs(sealed, 'plum')).status, 200);

  const job = await h.start({ agent: 'bolt' }),
    card = await h.ask(job, { kind: 'approval', approves: 'live:plum' });
  assert.equal((await h.answer(card, '', { approve: true })).status, 200);
  await h.finish(job);
  const live = await openAs(sealed, 'plum', 'live');
  assert.equal(live.status, 403, 'a preview file never opens live');
  assert.equal(live.json.why, 'other_stall');
  // the slug in the header changed to the caller's: the associated data no longer matches
  const relabelled = Buffer.from(sealed);
  relabelled.write('pebb', 6, 'latin1');
  assert.equal((await openAs(relabelled, 'pebblet')).status, 403);
});

test('a payload over 20 MB is refused, and a token that is not the product’s is turned away', async () => {
  const r = await h.send('/api/pay/backup/seal', as('pebblet'), {
    payload: Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64'),
  });
  assert.equal(r.status, 413);
  assert.equal(r.json.why, 'too_big');
  const wrong = await h.send(
    '/api/pay/backup/seal',
    { ...as('pebblet'), authorization: `Bearer ${'0'.repeat(64)}` },
    {
      payload: 'AAAA',
    },
  );
  assert.equal(wrong.status, 401);
});

test('a year on, a new key seals, and a file sealed under the old one still opens', async () => {
  const before = await sealFor(Buffer.from('sealed this year'));
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 400 * 86_400_000 });
  try {
    const after = await sealFor(Buffer.from('sealed next year'));
    assert.ok(after.readUInt32BE(1) > before.readUInt32BE(1), 'the newer key');
    assert.equal(keyFiles().length, 2);
    assert.equal(Buffer.from((await openAs(before)).json.payload, 'base64').toString(), 'sealed this year');
    assert.equal(Buffer.from((await openAs(after)).json.payload, 'base64').toString(), 'sealed next year');
  } finally {
    mock.timers.reset();
  }
});
