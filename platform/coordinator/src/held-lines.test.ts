// node --test src/held-lines.test.ts   (the harness; Stripe is the imitation, no Print API keys)
// Held lines (held-lines.ts): a product says it holds a paid line of its own for a person, with its words; the board sees
// it in Care and releases or refuses it, or takes that back until the product has read it; the line leaves the list once
// it's in its parcel, out of it, or refunded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';
import { productHeaders } from './fixture.ts';

const manifest = (repo: string, slug: string, yaml: string) => {
  mkdirSync(`${repo}/products/${slug}`, { recursive: true });
  writeFileSync(`${repo}/products/${slug}/product.yaml`, yaml);
};
const h = await harness('held-lines', {
  env: { PUBLIC_HOST: 'hq.testco.example' },
  before: repo => {
    manifest(
      repo,
      'front',
      'name: The shop\nstatus: preview\nbasket:\n  countries: [NL, BE]\n  postage_saved: {NL: 380, BE: 635}\n',
    );
    manifest(repo, 'pebblet', 'name: Pebblet\nstatus: preview\n');
    manifest(repo, 'hello', 'name: Hello\nstatus: preview\n');
  },
});
const { db, board } = h;
const { tick } = await import('./payments.ts');
const { ORIGIN } = await import('./config.ts');

const as = await productHeaders();
const call = async (path: string, headers: Record<string, string>, body?: unknown) => {
  const r = await h.send(path, { 'content-type': 'application/json', ...headers }, body);
  return { status: r.status, body: r.json };
};
const ADDRESS = { name: 'Sanne de Vries', line1: 'Lindelaan 12', postCode: '1234 AB', city: 'Utrecht', country: 'NL' };
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 32)]);
let n = 0;
// One of Pebblet's lines, paid in the shop's basket
async function paidLine(detail = 'Pip & Grumbleguts') {
  n++;
  const l = await call('/api/pay/line', as('pebblet'), {
    reference: `peb-${n}`,
    amount: 3995,
    description: 'Pebble, painted',
    detail,
    order_url: `https://pebblet.preview.testco.example/order/${n}`,
  });
  assert.equal(l.status, 200, JSON.stringify(l.body));
  const basket = (await call('/api/pay/basket/add', as('front'), { line: l.body.line, claim: l.body.claim })).body
    .basket;
  const c = await call('/api/pay/basket/checkout', as('front'), {
    basket,
    deliver_to: ADDRESS,
    email: 'sanne@example.com',
    locale: 'nl',
    success_url: 'https://front.preview.testco.example/order-done/?session={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://front.preview.testco.example/checkout/',
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal((await call(`${new URL(c.body.url).pathname}/pay`, { origin: ORIGIN }, '')).status, 303);
  return { id: l.body.line as string, reference: `peb-${n}` };
}
const held = async () => (await board('/api/care')).body.held as any[];
const report = (id: string, detail?: string, slug = 'pebblet', why = 'its words hit the word check', words?: string) =>
  call('/api/pay/line/held', as(slug), { id, detail, why, words });
// the board's tap, for the words Care shows it now
const tap = async (line: string, answer: string | null) =>
  board('/api/care/held', { line, answer, revision: (await held()).find(x => x.line === line)?.revision });

test('a held line shows in Care with its words as the product sends them, counted until the board answers', async () => {
  const l = await paidLine();
  assert.deepEqual(await held(), [], 'nothing shows until the product says it holds the line');
  assert.deepEqual((await report(l.id, 'Pip   &  Grumblegutz')).body, { answer: null });
  const [w] = await held();
  assert.deepEqual(
    [w.line, w.app, w.appName, w.mode, w.order, w.description, w.words, w.why, w.answer, w.taken, w.quiet],
    [
      l.id,
      'pebblet',
      'Pebblet',
      'test',
      l.reference,
      'Pebble, painted',
      'Pip & Grumblegutz',
      'its words hit the word check',
      null,
      false,
      false,
    ],
  );
  assert.equal((await board('/api/care/count')).body.held, 1);
  assert.equal((await board('/api/care')).body.counts.held, 1);
  // its words with it: the line's detail is the held words now
  assert.equal((await call(`/api/pay/line?id=${l.id}`, as('pebblet'))).body.detail, 'Pip & Grumblegutz');
  // a report without words keeps the ones it has
  await report(l.id);
  assert.equal((await held()).find(x => x.line === l.id).words, 'Pip & Grumblegutz');
  assert.equal((await tap(l.id, 'release')).status, 200);
  assert.equal((await board('/api/care/count')).body.held, 0, 'answered: nothing waits on the board');
  // (the product reads it and hands it over, leaving the list)
  assert.deepEqual((await report(l.id)).body, { answer: 'release' });
  assert.equal(
    (
      await call('/api/pay/parcel/items', as('pebblet'), {
        line: l.id,
        items: [{ productId: 'pebblet_pebble', quantity: 1 }],
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/api/pay/parcel/file?line=${l.id}&item=0&file=content`,
        { ...as('pebblet'), 'content-type': 'application/pdf' },
        PDF,
      )
    ).status,
    200,
  );
  assert.equal(
    (await held()).some(x => x.line === l.id),
    false,
  );
  assert.equal((await report(l.id)).status, 409, 'in its parcel: nothing to hold');
});

test('the product reports only its own paid lines, with a detail of 1 to 120 characters', async () => {
  const l = await paidLine();
  assert.equal((await report(l.id, undefined, 'hello')).status, 404, "another product's line");
  assert.equal((await report('ln_' + '0'.repeat(24))).status, 404);
  assert.equal((await report(l.id, 'x'.repeat(121))).status, 400);
  assert.equal((await report(l.id, '   ')).status, 400);
  assert.equal((await report(l.id, undefined, 'pebblet', 'y'.repeat(201))).status, 400);
  const open = await call('/api/pay/line', as('pebblet'), {
    reference: `peb-open-${n}`,
    amount: 3995,
    description: 'Pebble, painted',
    order_url: `https://pebblet.preview.testco.example/order/open-${n}`,
  });
  assert.equal((await report(open.body.line)).status, 409, 'not paid');
  assert.equal(
    (await call('/api/pay/line/held', { ...as('pebblet'), authorization: `Bearer ${'0'.repeat(64)}` }, { id: l.id }))
      .status,
    401,
  );
  assert.equal(
    (await held()).some(x => x.line === l.id),
    false,
  );
});

test('an answer can be taken back until the product has read it, never after', async () => {
  const l = await paidLine();
  await report(l.id);
  assert.equal((await tap(l.id, 'print it')).status, 400);
  assert.equal((await tap(l.id, 'refuse')).status, 200);
  assert.equal((await held()).find(x => x.line === l.id).answer, 'refuse');
  assert.equal((await tap(l.id, null)).status, 200);
  assert.deepEqual((await report(l.id)).body, { answer: null }, 'taken back before the product asked');
  assert.equal((await tap(l.id, 'refuse')).status, 200);
  assert.deepEqual((await report(l.id)).body, { answer: 'refuse' });
  const [w] = (await held()).filter(x => x.line === l.id);
  assert.deepEqual([w.answer, w.taken], ['refuse', true]);
  const late = await tap(l.id, 'release');
  assert.deepEqual([late.status, late.body.error], [409, 'It’s being refunded already.']);
  // (the product takes it out of its parcel and refunds it, leaving the list)
  assert.equal((await call('/api/pay/parcel/cancel', as('pebblet'), { line: l.id })).status, 200);
  assert.equal((await call('/api/pay/line/refund', as('pebblet'), { id: l.id })).body.refunded, true);
  assert.equal(
    (await held()).some(x => x.line === l.id),
    false,
  );
  assert.equal((await tap(l.id, 'release')).status, 404);
});

test('a product quiet for over 10 minutes is shown as quiet: its answer waits for it', async () => {
  const l = await paidLine();
  await report(l.id);
  // (11 minutes on: no route moves the clock)
  db.prepare('update pay_lines set held_seen = ? where id = ?').run(
    new Date(Date.now() - 11 * 60_000).toISOString(),
    l.id,
  );
  assert.equal((await held()).find(x => x.line === l.id).quiet, true);
  await report(l.id);
  assert.equal((await held()).find(x => x.line === l.id).quiet, false);
});

test('the board sees everything the word check read, only while the line waits; an answer holds for those words', async () => {
  const l = await paidLine();
  await report(l.id, 'Sanne & Pim', 'pebblet', undefined, 'Sanne & Pim · Lindelaan 12 · Utrecht');
  let w = (await held()).find(x => x.line === l.id);
  assert.equal(w.words, 'Sanne & Pim · Lindelaan 12 · Utrecht', 'the words its word check read');
  assert.equal((await call(`/api/pay/line?id=${l.id}`, as('pebblet'))).body.detail, 'Sanne & Pim', 'not on the line');
  assert.equal((await report(l.id, undefined, 'pebblet', undefined, 'w'.repeat(50_001))).status, 400, 'never cut');
  const long = 'w '.repeat(12_500).trim();
  assert.equal((await report(l.id, undefined, 'pebblet', undefined, long)).status, 200, 'a body over 8 KB');
  assert.equal((await held()).find(x => x.line === l.id).words, long);
  await report(l.id, 'Sanne & Pim', 'pebblet', undefined, 'Sanne & Pim · Lindelaan 12 · Utrecht');
  // a tap from a screen older than the words is turned back
  const stale = await board('/api/care/held', { line: l.id, answer: 'release', revision: 'older' });
  assert.equal(stale.status, 409);
  assert.equal((await held()).find(x => x.line === l.id).answer, null);
  // released, then the words change before the product reads it: asked again
  assert.equal((await tap(l.id, 'release')).status, 200);
  assert.deepEqual(
    (await report(l.id, 'Sanne & Pim', 'pebblet', undefined, 'Sanne & Pim · Lindelaan 13 · Utrecht')).body,
    { answer: null },
  );
  w = (await held()).find(x => x.line === l.id);
  assert.deepEqual([w.words, w.answer, w.taken], ['Sanne & Pim · Lindelaan 13 · Utrecht', null, false]);
  // and so does another reason
  assert.equal((await tap(l.id, 'release')).status, 200);
  assert.deepEqual((await report(l.id, undefined, 'pebblet', 'its run was stopped')).body, { answer: null });
  assert.equal((await held()).find(x => x.line === l.id).why, 'its run was stopped');
  // a refusal the product has read stays, whatever changes
  assert.equal((await tap(l.id, 'refuse')).status, 200);
  assert.deepEqual((await report(l.id, undefined, 'pebblet', 'its run was stopped')).body, { answer: 'refuse' });
  assert.deepEqual((await report(l.id, undefined, 'pebblet', 'its words hit the word check')).body, {
    answer: 'refuse',
  });
  // the words go from the table they're kept in as the line is refunded, before anyone opens Care
  assert.equal((await call('/api/pay/parcel/cancel', as('pebblet'), { line: l.id })).status, 200);
  assert.equal((await call('/api/pay/line/refund', as('pebblet'), { id: l.id })).body.refunded, true);
  assert.equal(
    (db.prepare('select held_words from pay_lines where id = ?').get(l.id) as { held_words: string | null }).held_words,
    null,
  );
});

test("the 90 days' sweep forgets a held line's words with its detail, waiting or not", async () => {
  const l = await paidLine();
  await report(l.id, undefined, 'pebblet', undefined, 'Sanne & Pim · Lindelaan 12 · Utrecht');
  // (91 days on: no route moves the clock); the table is where the words would stay
  db.prepare('update pay_lines set paid_at = ? where id = ?').run(
    new Date(Date.now() - 91 * 864e5).toISOString(),
    l.id,
  );
  await tick();
  const row = db.prepare('select detail, held_words from pay_lines where id = ?').get(l.id) as Record<string, unknown>;
  assert.deepEqual([row.detail, row.held_words], [null, null]);
});
