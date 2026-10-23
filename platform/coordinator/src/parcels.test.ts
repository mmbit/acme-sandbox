// node --test src/parcels.test.ts
// The shop's one parcel per basket at Print API. Stripe is the imitation, a local server plays Print API's test environment.
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { harness } from './harness.ts';
import { productHeaders } from './fixture.ts';
import type { AgainView } from './parcels.ts';

// Print API's test environment as the spec and our test orders show it: our own order and item ids kept, files by upload
// (an uploadUrl per file still awaited), a Created order cancelled at once, and anything later only asked for.
type PaOrder = { id: string; status: string; metadata: string; items: any[]; shipping: any; trackingUrl?: string; cancellation?: string };
const pa = new Map<string, PaOrder>(), placed: any[] = [], uploads: { order: string; item: string; type: string; size: number }[] = [];
let fileStatus = 'Accepted';   // what an uploaded file becomes: 'Processing' while Print API is still checking it
let extraFile: 400 | string | null = null;   // what becomes of a company's own item's file
const refusedExtra = 'x-card';                // which one
let cancelAnswer = true;       // false: a cancellation is made, but its answer is lost
let cancelRefused = false;     // true: Print API answers a cancellation 500, and makes none
let readsFailing = 0;          // how many reads of an order Print API answers 503 next
let beforeCancel: ((o: PaOrder) => void) | null = null;   // what happens to the order just before a cancellation reaches it
let cancelStatus = 200;        // what a cancellation that's made answers: 500 when Print API errs after taking it
let placeStatus = 200;         // what placing an order answers: 503 while Print API is down (nothing is made)
const printapi = createServer(async (q, s) => {
  const chunks: Buffer[] = []; for await (const c of q) chunks.push(c);
  const path = q.url!.replace(/^\/test/, '');
  if (path === '/oauth') return s.end(JSON.stringify({ access_token: 'tok-test', expires_in: 14400 }));
  if (q.headers.authorization !== 'Bearer tok-test') { s.writeHead(401); return s.end('{}'); }
  const order = path.match(/^\/orders\/([^/]+)$/), cancel = path.match(/^\/orders\/([^/]+)\/cancellation$/), file = path.match(/^\/files\/([^/]+)\/([^/]+)\/([^/]+)$/);
  const o = (order ?? cancel) ? pa.get(decodeURIComponent((order ?? cancel)![1])) : undefined;
  if (q.method === 'GET' && order && readsFailing > 0) { readsFailing--; s.writeHead(503); return s.end('{}'); }
  if (q.method === 'GET' && order) { s.writeHead(o ? 200 : 404); return s.end(JSON.stringify(o ?? { message: 'Not found' })); }
  if (q.method === 'POST' && path === '/orders') {
    if (placeStatus !== 200) { s.writeHead(placeStatus); return s.end('{}'); }
    const b = JSON.parse(Buffer.concat(chunks).toString()); placed.push(b);
    if (pa.has(b.id)) { s.writeHead(400); return s.end(JSON.stringify({ fields: [{ key: 'order.Id' }] })); }
    // a product Print API doesn't take
    if (b.items.some((i: any) => i.productId === 'refused')) { s.writeHead(400); return s.end(JSON.stringify({ fields: [{ key: 'items[0].productId' }] })); }
    pa.set(b.id, { id: b.id, status: 'Created', metadata: b.metadata, shipping: { address: b.shipping.address },
      items: b.items.map((i: any) => ({ ...i, files: { content: { status: 'AwaitingUpload', uploadUrl: `https://printapi.test/test/files/${b.id}/${i.id}/content` } } })) });
    return s.end(JSON.stringify(pa.get(b.id)));
  }
  if (q.method === 'POST' && file) {
    const target = pa.get(file[1])?.items.find(i => i.id === file[2]);
    if (!target) { s.writeHead(404); return s.end('{}'); }
    // a company's own item's file Print API won't take: refused at upload, or taken and then failed
    if (file[2] === refusedExtra && extraFile === 400) { s.writeHead(400); return s.end('{}'); }
    target.files[file[3]] = { status: file[2] === refusedExtra && extraFile ? extraFile : fileStatus };
    uploads.push({ order: file[1], item: file[2], type: String(q.headers['content-type']), size: Buffer.concat(chunks).length });
    return s.end('{}');
  }
  if (cancel && o && q.method === 'POST') {
    if (cancelRefused) { s.writeHead(500); return s.end('{}'); }
    beforeCancel?.(o);
    if (o.status === 'Shipped') { s.writeHead(409); return s.end('{}'); }
    o.cancellation = o.status === 'Created' ? 'Accepted' : 'Requested';
    if (o.status === 'Created') o.status = 'Cancelled';
    if (!cancelAnswer) return s.destroy();
    s.writeHead(cancelStatus);
    return s.end(JSON.stringify({ status: o.cancellation }));
  }
  if (cancel && o) return s.end(JSON.stringify({ status: o.cancellation ?? 'None', reason: null }));
  // a product: two days to make at standard speed (cut-off noon), one at express (cut-off 16:00), €10; a book from 24
  // pages, €0.25 a page more; a spiral book at standard speed only; a product whose cost isn't given
  if (q.method === 'GET' && path.startsWith('/products/')) {
    const id = path.slice('/products/'.length), standard = { speed: 'Standard', days: 2, limitHour: 12 };
    const productionTimes = id.includes('spiral') ? [standard] : [standard, { speed: 'Express', days: 1, limitHour: 16 }];
    // a slow print: three days at either speed
    if (id.includes('slowprint')) productionTimes.splice(0, 2, { speed: 'Standard', days: 3, limitHour: 11 }, { speed: 'Express', days: 3, limitHour: 12 });
    const cost = id.includes('nocost') ? undefined : id.includes('book') ? { base: 10, perExtraPage: 0.25 } : { base: 10, perExtraPage: 0 };
    return s.end(JSON.stringify({ cost, productionTimes, minPageCount: id.includes('book') ? 24 : 0 }));
  }
  s.writeHead(404); s.end('{}');
});
await new Promise<void>(r => printapi.listen(0, r));
const paBase = `http://localhost:${(printapi.address() as any).port}`;
// (Print API's upload links are https only: its host played here)
const realFetch = globalThis.fetch;
globalThis.fetch = ((u: any, o: any) => realFetch(String(u).replace(/^https:\/\/printapi\.test\//, `${paBase}/`), o)) as typeof fetch;
after(() => { printapi.close(); globalThis.fetch = realFetch; });
const h = await harness('parcels', {
  env: { PUBLIC_HOST: 'hq.company.test', PRINTAPI_TEST_API: 'https://printapi.test/test' },
  before: repo => {
    const manifest = (slug: string, yaml: string) => { mkdirSync(`${repo}/products/${slug}`, { recursive: true }); writeFileSync(`${repo}/products/${slug}/product.yaml`, yaml); };
    manifest('front', 'name: The shop\nstatus: preview\nbasket:\n  countries: [NL, BE]\n  postage_saved: {NL: 380, BE: 635}\n');
    manifest('pebblet', 'name: Pebblet\nstatus: preview\n');
    manifest('hello', 'name: Hello\nstatus: preview\n');
    mkdirSync(process.env.SECRETS_DIR!, { recursive: true });
    for (const k of ['CLIENT_ID', 'CLIENT_SECRET']) writeFileSync(`${process.env.SECRETS_DIR}/PRINTAPI_TEST_${k}`, `TEST-${k}`);
  },
});
const { db, dataDir: DATA } = h;
const payments = await import('./payments.ts');
const parcels = await import('./parcels.ts');

const as = await productHeaders();
const call = h.send;
const ADDRESS = { name: 'Sanne de Vries', line1: 'Lindelaan 12', postCode: '1234 AB', city: 'Utrecht', country: 'NL' };
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 32)]), JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);
let n = 0;
// A basket of one line from each product, paid: the lines as their products know them (shipsIn: a product's making time)
// opened: when its checkout opened, if long before now
async function paidBasket(shipsIn: Record<string, number> = {}, voucher: Record<string, number> = {}, opened?: number) {
  n++;
  if (opened) mock.timers.enable({ apis: ['Date'], now: opened });
  const lines = [];
  let basket: string | undefined;
  for (const slug of ['pebblet', 'hello']) {
    const l = await call('/api/pay/line', as(slug), { reference: `${slug}-${n}`, amount: 3995, description: `${slug} poster`, order_url: `https://${slug}.preview.company.test/order/${n}`, ships_in: shipsIn[slug], voucher: voucher[slug] });
    basket = (await call('/api/pay/basket/add', as('front'), { basket, line: l.json.line, claim: l.json.claim })).json.basket;
    lines.push({ slug, id: l.json.line as string, reference: `${slug}-${n}` });
  }
  const c = await call('/api/pay/basket/checkout', as('front'), { basket, deliver_to: ADDRESS, email: 'sanne@example.com', locale: 'nl',
    success_url: 'https://front.preview.company.test/order-done/?session={CHECKOUT_SESSION_ID}', cancel_url: 'https://front.preview.company.test/checkout/' });
  assert.equal(c.status, 200, c.text);
  if (opened) mock.timers.reset();
  assert.equal((await call(`${new URL(c.json.url).pathname}/pay`, { origin: 'https://hq.company.test' }, '')).status, 303);
  return lines;
}
// the parcel a line is in, by the id the kits get it by
const parcelOf = (l: { id: string }) => (db.prepare('select parcel from parcel_lines where line = ?').get(l.id) as any).parcel as string;
const lineOf = async (l: { slug: string; id: string }) => (await call(`/api/pay/line?id=${l.id}`, as(l.slug))).json;
async function hand(l: { slug: string; id: string }, file = PDF, type = 'application/pdf', item: object = { productId: `${l.slug}_poster`, quantity: 1 }) {
  const items = await call('/api/pay/parcel/items', as(l.slug), { line: l.id, items: [item] });
  assert.equal(items.status, 200, items.text);
  const sent = await call(`/api/pay/parcel/file?line=${l.id}&item=0&file=content`, { ...as(l.slug), 'content-type': type }, file);
  assert.equal(sent.status, 200, sent.text);
  await parcels.tick();   // the placing a handing starts, done
  return sent.json;
}
const ordersOf = (lines: { id: string }[]) => {
  const parcel = parcelOf(lines[0]);
  return placed.filter(b => JSON.parse(b.metadata).parcel === parcel);
};

test("a basket's lines from two products go to Print API as one order, once both are handed over, to the checkout's address", async () => {
  const [a, b] = await paidBasket();
  assert.deepEqual((await lineOf(a)).parcel, { status: 'waiting', handed: false, removed: null, express: false, shipped_at: null, tracking: null, error: null,
    with: [{ shop: 'Hello', reference: b.reference }] });
  await hand(a);
  assert.equal(ordersOf([a]).length, 0, 'nothing is placed while a line is still to come');
  assert.equal((await lineOf(a)).parcel.handed, true);
  await hand(b, JPEG, 'image/jpeg');
  const [order] = ordersOf([a]);
  assert.equal(ordersOf([a]).length, 1);
  assert.deepEqual(order.items.map((i: any) => [i.id, i.productId]), [['1-0', 'pebblet_poster'], ['2-0', 'hello_poster']]);
  assert.deepEqual(order.shipping.address, ADDRESS);
  assert.deepEqual(uploads.filter(u => u.order === order.id).map(u => [u.item, u.type]), [['1-0', 'application/pdf'], ['2-0', 'image/jpeg']]);
  assert.equal((await lineOf(b)).parcel.status, 'placed');
  // a product sending its file again after a lost answer changes nothing
  assert.equal((await call(`/api/pay/parcel/file?line=${a.id}&item=0&file=content`, { ...as('pebblet'), 'content-type': 'application/pdf' }, PDF)).status, 200);
  await parcels.tick();
  assert.equal(ordersOf([a]).length, 1);
});

test('one item cancelled before printing: the parcel is cancelled and placed again without it, and only then refunded', async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const first = ordersOf([a])[0].id;
  const early = await call('/api/pay/line/refund', as('hello'), { id: b.id });
  assert.equal(early.status, 409, 'no money back for something still going to print');
  const out = await call('/api/pay/parcel/cancel', as('hello'), { line: b.id });
  assert.equal(out.status, 200, out.text);
  await parcels.tick();
  assert.equal(pa.get(first)!.status, 'Cancelled');
  const again = ordersOf([a]);
  assert.equal(again.length, 2);
  assert.equal(again[1].id, first.replace(/-1$/, '-2'));
  assert.deepEqual(again[1].items.map((i: any) => i.id), ['1-0']);
  assert.equal((await lineOf(a)).parcel.status, 'placed');
  assert.deepEqual((await lineOf(b)).parcel.removed, 'done');
  assert.equal((await call('/api/pay/line/refund', as('hello'), { id: b.id })).json.refunded, true);
  const parcel = parcelOf(a);
  assert.equal(readdirSync(`${DATA}/parcels/${parcel}`).filter(f => f.startsWith(b.id)).length, 1, "the cancelled line's file stays: a cancel changes no clock");
  await parcels.tick(Date.now() + 11 * 60_000);
  assert.equal((await lineOf(a)).parcel.status, 'placed');
});

test('a line its voucher paid in full is closed only once it is out of its parcel, like a card refund', async () => {
  let spent = true;
  // (first: the vouchers kit's own hook knows no V21)
  payments.lineVoucher.unshift((_, reference) => (reference === `pebblet-${n}` ? (spent ? 3995 : 'this voucher is no longer spent on this order') : undefined));
  try {
    const [a, b] = await paidBasket({}, { pebblet: 21 });
    assert.equal((await lineOf(a)).card, 0);
    await hand(a); await hand(b);
    spent = false;   // the product released it
    const early = await call('/api/pay/line/refund', as('pebblet'), { id: a.id });
    assert.equal(early.status, 409, 'still in its parcel');
    assert.match(early.json.error, /still in its parcel/);
    assert.equal((await call('/api/pay/parcel/cancel', as('pebblet'), { line: a.id })).status, 200);
    await parcels.tick();
    assert.equal((await lineOf(a)).parcel.removed, 'done');
    const closed = await call('/api/pay/line/refund', as('pebblet'), { id: a.id });
    assert.deepEqual([closed.status, closed.json.refunded, closed.json.description], [200, true, 'pebblet poster'], closed.text);
  } finally { payments.lineVoucher.shift(); }
});

test('once printing started, an item can no longer be cancelled, and the parcel order is left alone', async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const order = pa.get(ordersOf([a])[0].id)!;
  order.status = 'Processing';
  const r = await call('/api/pay/parcel/cancel', as('pebblet'), { line: a.id });
  assert.equal(r.status, 409);
  assert.equal(order.cancellation, undefined, 'no cancellation was asked of Print API');
  assert.equal((await lineOf(b)).parcel.status, 'printing');
});

const extraIn = (l: { id: string }) => parcels.extrasIn(parcelOf(l));
const own = (name: string, productId = 'kaart_dubbel_10x10', bytes: Buffer = PDF) =>
  ({ name, productId, quantity: 1, files: { content: { bytes, type: 'application/pdf' } } });

test("a company's own item goes in the parcel's order with its file, and is decided again when the parcel is placed again", async () => {
  const asked: any[] = [];
  let card = true;
  parcels.extras.push(async order => {
    asked.push({ parcel: order.parcel.id, round: order.parcel.round, items: order.items.map(i => i.productId), lines: order.lines.map(l => l.position) });
    return card ? own('card') : null;
  });
  try {
    const [a, b] = await paidBasket();
    await hand(a); await hand(b);
    const [first] = ordersOf([a]);
    assert.deepEqual(first.items.map((i: any) => [i.id, i.productId]), [['1-0', 'pebblet_poster'], ['2-0', 'hello_poster'], ['x-card', 'kaart_dubbel_10x10']]);
    assert.deepEqual(uploads.filter(u => u.order === first.id).map(u => [u.item, u.type]), [['1-0', 'application/pdf'], ['2-0', 'application/pdf'], ['x-card', 'application/pdf']]);
    const parcel = parcelOf(a);
    assert.deepEqual(extraIn(a), ['card']);
    assert.deepEqual(asked, [{ parcel, round: 1, items: ['pebblet_poster', 'hello_poster'], lines: [1, 2] }], 'asked once, with the lines it goes with');
    // a line taken out: placed again as the next round, and the item is decided again for what's left
    card = false;
    assert.equal((await call('/api/pay/parcel/cancel', as('hello'), { line: b.id })).status, 200);
    await parcels.tick();
    const again = ordersOf([a])[1];
    assert.deepEqual(again.items.map((i: any) => i.id), ['1-0']);
    assert.deepEqual(asked[1], { parcel, round: 2, items: ['pebblet_poster'], lines: [1] });
    assert.deepEqual(extraIn(a), [], 'the parcel says it went without one');
    assert.equal((await lineOf(a)).parcel.status, 'placed');
  } finally { parcels.extras.length = 0; }
});

test("several kits' own items: each in the order, each kit seeing what the ones before it chose", async () => {
  const seen: string[][] = [];
  parcels.extras.push(async () => own('card'));
  parcels.extras.push(async order => { seen.push(order.chosen.map(x => x.name)); return [own('gift', 'tegeltje_5x5'), own('gift2', 'tegeltje_5x5')]; });
  try {
    const [a, b] = await paidBasket();
    await hand(a); await hand(b);
    const [first] = ordersOf([a]);
    assert.deepEqual(first.items.map((i: any) => i.id), ['1-0', '2-0', 'x-card', 'x-gift', 'x-gift2']);
    assert.deepEqual(seen, [['card']]);
    assert.deepEqual(extraIn(a).sort(), ['card', 'gift', 'gift2']);
  } finally { parcels.extras.length = 0; }
});

test("a company's own item whose file Print API won't take: its order is cancelled and placed again without it", async () => {
  parcels.extras.push(async () => own('card'));
  parcels.extras.push(async () => own('gift', 'tegeltje_5x5'));
  try {
    for (const answer of [400, 'DownloadFailed'] as const) {
      extraFile = answer;
      const [a, b] = await paidBasket();
      await hand(a); await hand(b);
      await parcels.tick();
      const orders = ordersOf([a]);
      assert.deepEqual(orders.map(o => o.items.map((i: any) => i.id)), [['1-0', '2-0', 'x-card', 'x-gift'], ['1-0', '2-0', 'x-gift']], String(answer));
      assert.equal(pa.get(orders[0].id)!.status, 'Cancelled');
      assert.deepEqual(uploads.filter(u => u.order === orders[1].id).map(u => u.item), ['1-0', '2-0', 'x-gift'], "the others' files go up again");
      assert.equal((await lineOf(a)).parcel.status, 'placed');
      assert.deepEqual(extraIn(a), ['gift'], 'the other one stays in');
      const parcel = parcelOf(a);
      assert.ok((db.prepare("select dropped from parcel_extras where parcel = ? and name = 'card'").get(parcel) as any).dropped, 'it goes without that one from now on');
    }
  } finally { parcels.extras.length = 0; extraFile = null; }
});

test("a company's own item never holds the parcel back: a failing kit, a file Print API won't take, or a refused order go without it", async () => {
  const cases = [
    async () => { throw new Error('no browser'); },
    async () => own('card', 'kaart_dubbel_10x10', Buffer.from('not a pdf, not at all, but long enough to be looked at as one'.repeat(3))),
    async () => own('card', 'refused'),
    async () => [own('card'), own('card')],   // one name twice: the second goes without
  ];
  try {
    for (const [i, extra] of cases.entries()) {
      parcels.extras.length = 0;
      parcels.extras.push(extra);
      const [a, b] = await paidBasket();
      await hand(a); await hand(b);
      const orders = ordersOf([a]), last = orders[orders.length - 1];
      assert.deepEqual(last.items.map((i: any) => i.id), i === 3 ? ['1-0', '2-0', 'x-card'] : ['1-0', '2-0'], String(i));
      assert.equal((await lineOf(a)).parcel.status, 'placed');
      assert.deepEqual(extraIn(a), i === 3 ? ['card'] : []);
    }
  } finally { parcels.extras.length = 0; }
});

const sheet = (name = 'sheet', productId = 'slowprint_10x15') => ({ ...own(name, productId), pageCount: 1 });
const waitingWhy = (l: { id: string }) => (db.prepare('select status, error from parcels where id = ?').get(parcelOf(l)) as any);

test("a company's document goes in every parcel after the kits' own items, made for the ones it goes with, with its pages", async () => {
  const seen: string[][] = [];
  parcels.extras.push(async () => own('card'));
  parcels.documents.push(async order => { seen.push(order.chosen.map(x => x.name)); return sheet(); });
  try {
    const [a, b] = await paidBasket();
    await hand(a); await hand(b);
    const [first] = ordersOf([a]);
    assert.deepEqual(first.items.map((i: any) => [i.id, i.pageCount ?? null]), [['1-0', null], ['2-0', null], ['x-card', null], ['x-sheet', 1]]);
    assert.deepEqual(seen, [['card']]);
    assert.deepEqual(parcels.documentsIn({ id: parcelOf(a), round: 1 }), ['sheet']);
    assert.deepEqual(uploads.filter(u => u.order === first.id).map(u => u.item), ['1-0', '2-0', 'x-card', 'x-sheet']);
    assert.equal((await lineOf(a)).parcel.status, 'placed');
  } finally { parcels.extras.length = 0; parcels.documents.length = 0; }
});

test("a document is made again for what's left when Print API refuses the order with the kits' own items", async () => {
  const seen: string[][] = [];
  parcels.extras.push(async () => own('card', 'refused'));
  parcels.documents.push(async order => { seen.push(order.chosen.map(x => x.name)); return sheet(); });
  try {
    const [a, b] = await paidBasket();
    await hand(a); await hand(b);
    const orders = ordersOf([a]);
    assert.deepEqual(orders.map(o => o.items.map((i: any) => i.id)), [['1-0', '2-0', 'x-card', 'x-sheet'], ['1-0', '2-0', 'x-sheet']]);
    assert.deepEqual(seen, [['card'], []], 'the second one made without the card');
    assert.equal((await lineOf(a)).parcel.status, 'placed');
  } finally { parcels.extras.length = 0; parcels.documents.length = 0; }
});

test('a parcel never goes without its document: a failing kit, an item or order Print API refuses, or a file it won\'t take hold it with why', async () => {
  let fits = false;
  const cases: [() => Promise<any>, RegExp][] = [
    [async () => { if (!fits) throw new Error("NEEDS A PERSON: its sheet doesn't fit"); return sheet(); }, /^NEEDS A PERSON: its sheet doesn't fit$/],
    [async () => sheet('sheet', 'refused'), /^NEEDS A PERSON: Print API refused its order with its sheet, which it never goes without$/],
    [async () => ({ ...sheet(), files: { content: { bytes: Buffer.from('not a pdf, not at all, but long enough'.repeat(4)), type: 'application/pdf' } } }),
      /^NEEDS A PERSON: its sheet isn't an item Print API takes/],
    [async () => sheet('card'), /^NEEDS A PERSON: its card can't go \(Print API has its file as DownloadFailed\), and it never goes without$/],
  ];
  const held: string[] = [];
  try {
    for (const [i, [doc, why]] of cases.entries()) {
      parcels.documents.length = 0;
      parcels.documents.push(doc);
      if (i === 3) extraFile = 'DownloadFailed';
      const [a, b] = await paidBasket();
      await hand(a); await hand(b);
      held.push(parcelOf(a));
      await parcels.tick();
      assert.equal(waitingWhy(a).status, 'waiting', String(i));
      assert.match(waitingWhy(a).error, why);
      const orders = ordersOf([a]);
      if (i === 3) {
        // its order stays as it is at Print API, Created and not cancelled: a person places it again by hand
        assert.equal(orders.length, 1);
        assert.equal(pa.get(orders[0].id)!.status, 'Created');
        assert.equal((db.prepare("select dropped from parcel_extras where parcel = ? and name = 'card'").get(parcelOf(a)) as any).dropped, null);
      } else assert.deepEqual(orders.filter(o => pa.has(o.id)), [], 'nothing placed at Print API');
      if (i === 0) {
        // once it fits, the next round places it
        fits = true;
        await parcels.tick();
        assert.deepEqual(ordersOf([a]).at(-1).items.map((i: any) => i.id), ['1-0', '2-0', 'x-sheet']);
        assert.equal(waitingWhy(a).error, null);
      }
    }
  } finally {
    parcels.documents.length = 0; extraFile = null;
    // out of the later tests' rounds
    for (const id of held) db.prepare("update parcels set status = 'cancelled' where id = ?").run(id);
  }
});

test("a company's own item may hold its file: the order goes at once, the parcel waits for the file its kit sends, as stored after its hold", async () => {
  const later = () => new Date(Date.now() + 10 * 60_000).toISOString();
  const NEW_PDF = Buffer.concat([PDF, Buffer.from('the pick')]);
  parcels.extras.push(async () => ({ ...own('card'), holdUntil: later() }));
  parcels.extras.push(async () => own('gift', 'tegeltje_5x5'));
  const cardFile = (order: { id: string }) => pa.get(order.id)!.items.find((i: any) => i.id === 'x-card').files.content;
  // (a hold running out: time moving on, which no route makes)
  const holdEnded = (l: { id: string }, minutesAgo: number) => db.prepare("update parcel_extras set held_until = ? where parcel = ? and name = 'card'")
    .run(new Date(Date.now() - minutesAgo * 60_000).toISOString(), parcelOf(l));
  try {
    // held, then sent with the kit's new bytes
    let [a, b] = await paidBasket();
    await hand(a); await hand(b);
    let [order] = ordersOf([a]);
    assert.deepEqual(uploads.filter(u => u.order === order.id).map(u => u.item), ['1-0', '2-0', 'x-gift'], 'all but the held file');
    assert.equal((await lineOf(a)).parcel.status, 'waiting', 'its order is at Print API, its card still to come');
    assert.equal(cardFile(order).status, 'AwaitingUpload');
    assert.equal(await parcels.release(parcelOf(a), 'gift'), 'none', 'nothing of the gift is held');
    assert.equal(await parcels.release(parcelOf(a), 'card', { content: { bytes: NEW_PDF, type: 'application/pdf' } }), 'released');
    await parcels.tick();
    assert.deepEqual(uploads.filter(u => u.order === order.id && u.item === 'x-card').map(u => u.size), [NEW_PDF.length]);
    assert.equal(cardFile(order).status, 'Accepted');
    assert.equal((await lineOf(a)).parcel.status, 'placed');
    assert.equal(await parcels.release(parcelOf(a), 'card'), 'none', 'sent once');

    // the kit never sends it: two minutes after its hold, the next round sends the stored file
    [a, b] = await paidBasket();
    await hand(a); await hand(b);
    [order] = ordersOf([a]);
    holdEnded(a, 1);
    await parcels.tick();
    assert.equal(cardFile(order).status, 'AwaitingUpload', 'its kit still has time');
    assert.deepEqual(parcels.holding('card').map(p => p.id), [parcelOf(a)]);
    holdEnded(a, 3);
    assert.deepEqual(parcels.holding('card'), [], 'its kit has nothing left to send');
    assert.equal(await parcels.release(parcelOf(a), 'card', { content: { bytes: NEW_PDF, type: 'application/pdf' } }), 'none');
    await parcels.tick();
    assert.deepEqual(uploads.filter(u => u.order === order.id && u.item === 'x-card').map(u => u.size), [PDF.length]);
    assert.equal((await lineOf(a)).parcel.status, 'placed');

    // Print API reads back as the placing's files do: a file still being checked, then failed; a read that fails
    for (const trouble of ['failed later', 'read fails'] as const) {
      [a, b] = await paidBasket();
      await hand(a); await hand(b);
      [order] = ordersOf([a]);
      if (trouble === 'failed later') extraFile = 'UploadInProgress';
      else readsFailing = 2;
      await parcels.release(parcelOf(a), 'card');
      await parcels.tick();
      assert.equal((await lineOf(a)).parcel.status, 'waiting', trouble);
      if (trouble === 'failed later') cardFile(order).status = 'Failed';
      await parcels.tick();
      await parcels.tick();
      const items = ordersOf([a]).map(o => o.items.map((i: any) => i.id));
      assert.deepEqual(items.at(-1), trouble === 'failed later' ? ['1-0', '2-0', 'x-gift'] : ['1-0', '2-0', 'x-card', 'x-gift'], trouble);
      assert.equal((await lineOf(a)).parcel.status, 'placed', trouble);
      extraFile = null;
    }

    // a held file Print API won't take, and its order not cancelled at first: the parcel waits, then goes without it
    extraFile = 400;
    cancelRefused = true;
    [a, b] = await paidBasket();
    await hand(a); await hand(b);
    [order] = ordersOf([a]);
    assert.equal(await parcels.release(parcelOf(a), 'card'), 'released');
    await parcels.tick();
    assert.equal((await lineOf(a)).parcel.status, 'waiting');
    assert.match((await lineOf(a)).parcel.error, /card can't go/);
    assert.equal(pa.get(order.id)!.status, 'Created');
    cancelRefused = false;
    await parcels.tick();
    await parcels.tick();
    const orders = ordersOf([a]);
    assert.deepEqual(orders.map(o => o.items.map((i: any) => i.id)), [['1-0', '2-0', 'x-card', 'x-gift'], ['1-0', '2-0', 'x-gift']]);
    assert.equal(pa.get(orders[0].id)!.status, 'Cancelled');
    assert.equal((await lineOf(a)).parcel.status, 'placed');
    assert.deepEqual(extraIn(a), ['gift']);
  } finally { parcels.extras.length = 0; extraFile = null; cancelRefused = false; readsFailing = 0; }
});

test("a line's spare files: handed over only once they're in, there for the kits, and kept with the line's", async () => {
  const got: any[] = [];
  parcels.extras.push(async order => {
    for (const l of order.lines) got.push({ position: l.position, spares: l.spares, file: parcels.spare(order.parcel.id, l.line, 'magnet') });
    return null;
  });
  try {
    const [a, b] = await paidBasket();
    const items = await call('/api/pay/parcel/items', as('pebblet'), { line: a.id, items: [{ productId: 'pebblet_poster', quantity: 1 }], spares: ['magnet'] });
    assert.equal(items.status, 200, items.text);
    assert.equal((await call('/api/pay/parcel/items', as('pebblet'), { line: a.id, items: [{ productId: 'pebblet_poster', quantity: 1 }], spares: ['Bad name'] })).status, 400);
    assert.equal((await call(`/api/pay/parcel/file?line=${a.id}&spare=other`, { ...as('pebblet'), 'content-type': 'image/jpeg' }, JPEG)).status, 400, 'a spare it never named');
    const content = await call(`/api/pay/parcel/file?line=${a.id}&item=0&file=content`, { ...as('pebblet'), 'content-type': 'application/pdf' }, PDF);
    assert.equal(content.json.parcel.handed, false, 'not handed over without its spare');
    const spare = await call(`/api/pay/parcel/file?line=${a.id}&spare=magnet`, { ...as('pebblet'), 'content-type': 'image/jpeg' }, JPEG);
    assert.equal(spare.status, 200, spare.text);
    assert.equal(spare.json.parcel.handed, true);
    assert.equal(ordersOf([a]).length, 0, 'the other line is still to come');
    await hand(b);
    const [order] = ordersOf([a]);
    assert.deepEqual(order.items.map((i: any) => i.id), ['1-0', '2-0'], 'a spare is never printed as it is');
    assert.deepEqual(got.map(g => [g.position, g.spares, g.file?.type ?? null]), [[1, ['magnet'], 'image/jpeg'], [2, [], null]]);
    assert.ok(Buffer.from(got[0].file.bytes).equals(JPEG));
    const parcel = parcelOf(a);
    assert.equal(parcels.spare(parcel, a.id, '../x'), null);
    // taken out: its spare stays with its files, as a cancel keeps them
    assert.equal((await call('/api/pay/parcel/cancel', as('pebblet'), { line: a.id })).status, 200);
    await parcels.tick();
    assert.equal(parcels.spare(parcel, a.id, 'magnet')?.type, 'image/jpeg');
  } finally { parcels.extras.length = 0; }
});

test("a line its customer asked us to delete: its files go once its parcel can't be placed with it, the other line's stay", async () => {
  const [a, b] = await paidBasket();
  parcels.extras.push(async () => own('card'));
  try {
    await hand(a); await hand(b);
    const parcel = parcelOf(a);
    const filesOf = (l: { id: string }) => readdirSync(`${DATA}/parcels/${parcel}`).filter(f => f.startsWith(`${l.id}-`));
    const extras = () => readdirSync(`${DATA}/parcels/${parcel}`).filter(f => f.startsWith('extra-'));
    assert.equal(extras().length, 1);
    assert.equal((await call('/api/pay/parcel/cancel', as('hello'), { line: b.id })).status, 200);
    await parcels.tick();
    assert.equal((await call('/api/pay/line/forget', as('hello'), { id: b.id })).status, 200);
    assert.deepEqual(filesOf(b), [], 'taken out: gone at once');
    assert.equal((await call('/api/pay/line/forget', as('pebblet'), { id: a.id })).status, 200);
    assert.equal(filesOf(a).length, 1, 'kept while its parcel may still be placed (again) with it');
    pa.get(ordersOf([a]).at(-1)!.id)!.status = 'Cancelled';
    await parcels.tick(Date.now() + 11 * 60_000);
    assert.equal((await lineOf(a)).parcel.status, 'cancelled');
    assert.deepEqual(filesOf(a), [], 'its parcel cancelled: gone, without waiting the 90 days');
    assert.deepEqual(extras(), [], "and the kit's own items, which may copy a design");
  } finally { parcels.extras.length = 0; }
});

test('a line taken out while its parcel waits: the rest is placed without it', async () => {
  const [a, b] = await paidBasket();
  await hand(a);
  assert.equal((await call('/api/pay/parcel/cancel', as('pebblet'), { line: a.id })).status, 200);
  await hand(b);
  const orders = ordersOf([a]);
  assert.deepEqual(orders.map(o => o.items.map((i: any) => i.id)), [['2-0']]);
});

test('status and tracking come back to every line; a shipped parcel keeps no files, and its lines can be refunded', async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const order = pa.get(ordersOf([a])[0].id)!, parcel = JSON.parse(order.metadata).parcel;
  Object.assign(order, { status: 'Shipped', trackingUrl: 'https://jouw.postnl.nl/track-and-trace/3SABCD' });
  await parcels.tick(Date.now() + 11 * 60_000);
  for (const l of [a, b]) {
    const v = (await lineOf(l)).parcel;
    assert.deepEqual([v.status, v.tracking], ['shipped', 'https://jouw.postnl.nl/track-and-trace/3SABCD']);
    assert.ok(v.shipped_at);
  }
  assert.equal(existsSync(`${DATA}/parcels/${parcel}`), false);
  assert.equal((await call('/api/pay/line/refund', as('pebblet'), { id: a.id })).status, 200, 'a remedy may refund a shipped line');
});

test("the delivery address outlives the usual 14 days while the parcel waits, and goes once it's placed", async () => {
  const [a, b] = await paidBasket();
  await hand(a);
  const address = async () => (await lineOf(a)).deliver_to;
  await payments.tick(Date.now() + 15 * 86_400_000);
  assert.ok(await address(), 'kept: the parcel still needs it');
  await hand(b);
  await payments.tick(Date.now() + 15 * 86_400_000);
  assert.ok(await address(), 'kept while the placed order may still be placed again');
  pa.get(ordersOf([a])[0].id)!.status = 'Processing';
  await parcels.tick(Date.now() + 11 * 60_000);
  await payments.tick(Date.now() + 15 * 86_400_000);
  assert.equal(await address(), null);
});

test('a product hands over only its own paid lines, and only real print files', async () => {
  const [a] = await paidBasket();
  assert.equal((await call('/api/pay/parcel/items', as('hello'), { line: a.id, items: [{ productId: 'x', quantity: 1 }] })).status, 404);
  assert.equal((await call('/api/pay/parcel/items', as('pebblet'), { line: a.id, items: [{ productId: 'x y', quantity: 1 }] })).status, 400);
  assert.equal((await call(`/api/pay/parcel/file?line=${a.id}&item=0&file=content`, { ...as('pebblet'), 'content-type': 'application/pdf' }, PDF)).status, 409, 'its items first');
  await call('/api/pay/parcel/items', as('pebblet'), { line: a.id, items: [{ productId: 'pebblet_poster', quantity: 1 }] });
  assert.equal((await call(`/api/pay/parcel/file?line=${a.id}&item=0&file=content`, { ...as('pebblet'), 'content-type': 'application/pdf' }, JPEG)).status, 400);
  assert.equal((await call(`/api/pay/parcel/file?line=${a.id}&item=1&file=content`, { ...as('pebblet'), 'content-type': 'application/pdf' }, PDF)).status, 400);
});

test("a line taken out of a parcel whose placing failed half-way: its order at Print API is cancelled, the rest placed again without it", async () => {
  const [a, b] = await paidBasket();
  fileStatus = 'Processing';
  await hand(a); await hand(b);
  const [first] = ordersOf([a]);
  assert.equal((await lineOf(a)).parcel.status, 'waiting', "the files aren't accepted yet");
  assert.equal(pa.get(first.id)!.status, 'Created');
  fileStatus = 'Accepted';
  const out = await call('/api/pay/parcel/cancel', as('hello'), { line: b.id });
  assert.equal(out.status, 200, out.text);
  await parcels.tick();
  assert.equal(pa.get(first.id)!.status, 'Cancelled', 'the order with the line in it prints nothing');
  const again = ordersOf([a]);
  assert.deepEqual(again.map(o => o.id), [first.id, first.id.replace(/-1$/, '-2')]);
  assert.deepEqual(again[1].items.map((i: any) => i.id), ['1-0']);
  assert.equal((await lineOf(a)).parcel.status, 'placed');
  assert.equal((await call('/api/pay/line/refund', as('hello'), { id: b.id })).json.refunded, true);
});

test('every line taken out of a parcel whose placing failed: nothing is left to print at Print API', async () => {
  const [a, b] = await paidBasket();
  fileStatus = 'Processing';
  await hand(a); await hand(b);
  for (const l of [b, a]) {
    assert.equal((await call('/api/pay/parcel/cancel', as(l.slug), { line: l.id })).status, 200);
    await parcels.tick();
  }
  fileStatus = 'Accepted';
  const orders = ordersOf([a]);
  assert.deepEqual(orders.map(o => o.items.map((i: any) => i.id)), [['1-0', '2-0'], ['1-0']]);
  assert.deepEqual(orders.map(o => pa.get(o.id)!.status), ['Cancelled', 'Cancelled']);
  assert.equal((await lineOf(a)).parcel.status, 'cancelled');
  // a cancelled parcel's files go 90 days after the payment, quietly
  const dir = `${DATA}/parcels/${JSON.parse(orders[0].metadata).parcel}`;
  await parcels.tick(Date.now() + 89 * 86_400_000);
  assert.equal(existsSync(dir), true, 'kept as any cancel');
  const asks = () => (db.prepare("select count(*) n from events where type = 'log' and text like '%NEEDS A PERSON%parcel%'").get() as any).n;
  const before = asks();
  await parcels.tick(Date.now() + 91 * 86_400_000);
  assert.equal(existsSync(dir), false, '90 days after the payment');
  assert.equal(asks(), before, 'nothing for a person to look at');
});

test("a cancellation Print API made but whose answer was lost: the line still comes out, and the rest is placed again", async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const [first] = ordersOf([a]);
  cancelAnswer = false;
  const out = await call('/api/pay/parcel/cancel', as('hello'), { line: b.id });
  cancelAnswer = true;
  assert.equal(out.status, 502);
  assert.equal((await lineOf(b)).parcel.removed, 'asked');
  await parcels.tick(Date.now() + 11 * 60_000);   // the status read finds the order cancelled
  assert.equal((await lineOf(b)).parcel.removed, 'done');
  await parcels.tick();
  assert.deepEqual(ordersOf([a]).map(o => o.items.map((i: any) => i.id)), [['1-0', '2-0'], ['1-0']]);
  assert.equal((await lineOf(a)).parcel.status, 'placed', 'the other line is placed again, not cancelled');
  assert.equal(pa.get(first.id)!.status, 'Cancelled');
});

test("a parcel still waiting when its delivery address goes is cancelled, its files kept 90 days, and each line can be refunded", async () => {
  const [a, b] = await paidBasket();
  await hand(a);   // b's items are named, its files never come
  assert.equal((await call('/api/pay/parcel/items', as('hello'), { line: b.id, items: [{ productId: 'hello_poster', quantity: 1 }] })).status, 200);
  const parcel = parcelOf(a);
  assert.ok(readdirSync(`${DATA}/parcels/${parcel}`).length);
  await payments.tick(Date.now() + 29 * 86_400_000);
  await parcels.tick(Date.now() + 29 * 86_400_000);
  assert.equal((await lineOf(a)).parcel.status, 'waiting', 'kept within the 30 days');
  await payments.tick(Date.now() + 31 * 86_400_000);
  await parcels.tick(Date.now() + 31 * 86_400_000);
  assert.equal((await lineOf(a)).parcel.status, 'cancelled');
  assert.equal(existsSync(`${DATA}/parcels/${parcel}`), true, 'its files kept as any cancel');
  assert.equal(ordersOf([a]).length, 0);
  for (const l of [a, b]) assert.equal((await call('/api/pay/line/refund', as(l.slug), { id: l.id })).json.refunded, true);
  // a product handing over late finds the parcel closed, and nothing of it is kept
  const late = await call(`/api/pay/parcel/file?line=${b.id}&item=0&file=content`, { ...as('hello'), 'content-type': 'application/pdf' }, PDF);
  assert.equal(late.status, 409, late.text);
  assert.equal((await call('/api/pay/parcel/items', as('hello'), { line: b.id, items: [{ productId: 'hello_poster', quantity: 2 }] })).status, 409);
  assert.deepEqual(readdirSync(`${DATA}/parcels/${parcel}`).filter(f => f.startsWith(b.id)), [], 'nothing of the late hand-over is kept');
  assert.equal((await lineOf(b)).parcel.handed, false);
  await parcels.tick(Date.now() + 91 * 86_400_000);
  assert.equal(existsSync(`${DATA}/parcels/${parcel}`), false, '90 days after the payment');
});

test("a cancellation asked just as printing starts: the files wait for Print API's answer, and an accepted one places the rest again", async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const [first] = ordersOf([a]), parcel = JSON.parse(first.metadata).parcel;
  beforeCancel = o => { o.status = 'Processing'; };   // read Created, printing by the time the cancellation comes
  const out = await call('/api/pay/parcel/cancel', as('hello'), { line: b.id });
  beforeCancel = null;
  assert.equal(out.status, 200, out.text);
  assert.equal(pa.get(first.id)!.cancellation, 'Requested');
  await parcels.tick(Date.now() + 11 * 60_000);
  assert.equal((await lineOf(a)).parcel.status, 'printing');
  assert.ok(readdirSync(`${DATA}/parcels/${parcel}`).some(f => f.startsWith(a.id)), 'kept while the cancellation is unanswered');
  Object.assign(pa.get(first.id)!, { cancellation: 'Accepted', status: 'Cancelled' });
  await parcels.tick(Date.now() + 22 * 60_000);
  await parcels.tick();
  assert.equal((await lineOf(b)).parcel.removed, 'done');
  const again = ordersOf([a]);
  assert.deepEqual(again.map(o => o.items.map((i: any) => i.id)), [['1-0', '2-0'], ['1-0']]);
  assert.deepEqual(uploads.filter(u => u.order === again[1].id).map(u => u.item), ['1-0']);
  assert.equal((await lineOf(a)).parcel.status, 'placed');
});

test('a cancellation never answered before the parcel shipped: the line stays in, and the files go', async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const [first] = ordersOf([a]), parcel = JSON.parse(first.metadata).parcel;
  beforeCancel = o => { o.status = 'Processing'; };
  assert.equal((await call('/api/pay/parcel/cancel', as('hello'), { line: b.id })).status, 200);
  beforeCancel = null;
  pa.get(first.id)!.status = 'Shipped';
  await parcels.tick(Date.now() + 11 * 60_000);
  const v = (await lineOf(b)).parcel;
  assert.deepEqual([v.status, v.removed], ['shipped', null]);
  assert.equal(existsSync(`${DATA}/parcels/${parcel}`), false);
});

test("a line in a parcel ships with the parcel's slowest line; one taken out has its own date again", async () => {
  const [a, b] = await paidBasket({ hello: 10 });
  const [fast, slow] = [await lineOf(a), await lineOf(b)];
  assert.equal(fast.ship_by, slow.ship_by);
  assert.equal((await call('/api/pay/parcel/cancel', as('hello'), { line: b.id })).status, 200);
  assert.ok((await lineOf(a)).ship_by < slow.ship_by);
  assert.equal((await lineOf(b)).ship_by, slow.ship_by);
});

test('a basket paid before parcels came in has none: its products placed their own orders', async () => {
  // paid the day before HQ's parcels started (this file's start)
  mock.timers.enable({ apis: ['Date'], now: Date.now() - 86_400_000 });
  let a, b;
  try {
    [a, b] = await paidBasket();
    await lineOf(a);   // read: the payment is settled
  } finally { mock.timers.reset(); }
  await parcels.tick();
  assert.equal((await lineOf(a)).parcel, undefined);
  assert.equal((await call('/api/pay/line/refund', as('hello'), { id: b.id })).json.refunded, true);
});

test('a basket whose checkout was opened before parcels came in, and paid after, has one', async () => {
  const [a, b] = await paidBasket({}, {}, Date.now() - 10 * 60_000);   // opened before HQ's parcels started (this file's start)
  await lineOf(a);   // read: the payment is settled
  await parcels.tick();
  assert.equal((await lineOf(a)).parcel.status, 'waiting');
  await hand(a); await hand(b);
  assert.equal((await lineOf(a)).parcel.status, 'placed');
});

test('a cancellation Print API never answers: two months after the payment the files go all the same, and the lines stay in', async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const [first] = ordersOf([a]), parcel = JSON.parse(first.metadata).parcel;
  beforeCancel = o => { o.status = 'Processing'; };
  assert.equal((await call('/api/pay/parcel/cancel', as('hello'), { line: b.id })).status, 200);
  beforeCancel = null;
  await parcels.tick(Date.now() + 59 * 86_400_000);
  assert.ok(existsSync(`${DATA}/parcels/${parcel}`), 'kept while the cancellation may still be accepted');
  await parcels.tick(Date.now() + 61 * 86_400_000);
  assert.equal(existsSync(`${DATA}/parcels/${parcel}`), false);
  const v = (await lineOf(b)).parcel;
  assert.deepEqual([v.status, v.removed], ['printing', null]);
});

test("once a placed parcel's delivery address is gone, no line is taken out of it: the others aren't cancelled with it", async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const [first] = ordersOf([a]);
  await payments.tick(Date.now() + 31 * 86_400_000);
  const out = await call('/api/pay/parcel/cancel', as('hello'), { line: b.id });
  assert.equal(out.status, 409, out.text);
  assert.match(out.json.error, /address/);
  assert.equal(pa.get(first.id)!.cancellation, undefined, 'no cancellation was asked of Print API');
  assert.equal((await lineOf(a)).parcel.status, 'placed');
  assert.equal((await lineOf(b)).parcel.removed, null);
});

test('a printing parcel keeps its delivery address while a cancellation is unanswered', async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const address = async () => (await lineOf(a)).deliver_to;
  beforeCancel = o => { o.status = 'Processing'; };
  assert.equal((await call('/api/pay/parcel/cancel', as('hello'), { line: b.id })).status, 200);
  beforeCancel = null;
  await parcels.tick(Date.now() + 11 * 60_000);
  assert.equal((await lineOf(a)).parcel.status, 'printing');
  await payments.tick(Date.now() + 15 * 86_400_000);
  assert.ok(await address(), 'kept: an accepted cancellation places the rest again');
  await payments.tick(Date.now() + 31 * 86_400_000);
  assert.equal(await address(), null);
});

test('an order Print API leaves Created for two months: its files go and a person looks', async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const parcel = parcelOf(a);
  await parcels.tick(Date.now() + 59 * 86_400_000);
  assert.ok(existsSync(`${DATA}/parcels/${parcel}`));
  await parcels.tick(Date.now() + 61 * 86_400_000);
  assert.equal((await lineOf(a)).parcel.status, 'placed');
  assert.equal(existsSync(`${DATA}/parcels/${parcel}`), false);
  assert.equal((await call('/api/pay/parcel/cancel', as('hello'), { line: b.id })).status, 409);
});

// ---- hurrying a parcel
const MONDAY_10 = Date.parse('2026-10-12T08:00:00Z'), MONDAY_17 = Date.parse('2026-10-12T15:00:00Z');   // Dutch summer time

test('a placed parcel hurried before printing: its order is cancelled and placed again at express speed, and stays express', async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const quote = await parcels.hurryQuote(a.id, MONDAY_10);
  assert.deepEqual({ ...quote, ship_by: undefined }, { hurry: 'possible', why: null, country: 'NL', ship_by: undefined, ship_by_express: '2026-10-13', extra: 140 });
  assert.equal(quote.ship_by, (await lineOf(a)).ship_by, "as it is: the day the customer was told");
  assert.equal((await parcels.hurryQuote(a.id, MONDAY_17)).ship_by_express, '2026-10-14', "past express's cut-off: from the next working day");
  assert.equal(await parcels.hurry(b.id), 'express');
  await parcels.tick();
  const [first, second] = ordersOf([a]);
  assert.equal(pa.get(first.id)!.status, 'Cancelled');
  assert.equal(first.productionSpeed, undefined);
  assert.equal(second.id, first.id.replace(/-1$/, '-2'));
  assert.equal(second.productionSpeed, 'Express');
  assert.deepEqual(second.items.map((i: any) => i.id), ['1-0', '2-0'], 'every line in it');
  await parcels.tick();
  assert.equal((await lineOf(a)).parcel.status, 'placed');
  assert.equal((await lineOf(a)).parcel.express, true);
  assert.equal((await parcels.hurryQuote(b.id)).hurry, 'already');
  assert.equal(await parcels.hurry(a.id), 'express', 'asked again: how it stands, nothing placed');
  assert.equal(ordersOf([a]).length, 2);
  assert.equal((await call('/api/pay/parcel/cancel', as('hello'), { line: b.id })).status, 200);
  await parcels.tick();
  assert.equal(ordersOf([a])[2].productionSpeed, 'Express', 'placed again without a line: still express');
});

test('what every parcel holds besides (a document) ships it no sooner: its lines\' day, and its day at express speed', async () => {
  const [a, b] = await paidBasket();
  const own = (await lineOf(a)).ship_by;
  payments.everyParcel.push({ days: 5, cutoff: 11 });
  parcels.documents.push(async () => sheet());
  try {
    const paid = Date.parse((db.prepare('select paid_at from pay_lines where id = ?').get(a.id) as any).paid_at);
    assert.equal((await lineOf(a)).ship_by, payments.shipDay(paid, 5, 11));
    assert.ok((await lineOf(a)).ship_by > own);
    await hand(a); await hand(b);
    // the photo print takes three days at express speed too, where the posters take one
    assert.equal((await parcels.hurryQuote(a.id, MONDAY_10)).ship_by_express, '2026-10-15');
  } finally { payments.everyParcel.length = 0; parcels.documents.length = 0; }
});

test("a parcel whose document isn't made yet (its maker holds it): its express day counts what every parcel holds", async () => {
  const [a, b] = await paidBasket();
  payments.everyParcel.push({ days: 5, cutoff: 11 });
  parcels.documents.push(async () => { throw new Error('its words are not in yet'); });
  try {
    await hand(a); await hand(b);
    assert.equal(ordersOf([a]).length, 0, 'not placed without its document');
    assert.equal((await parcels.hurryQuote(a.id, MONDAY_10)).ship_by_express, payments.shipDay(MONDAY_10, 5, 11));
  } finally { payments.everyParcel.length = 0; parcels.documents.length = 0; }
});

test("a parcel isn't hurried before every line is handed over; once it is, with no order at Print API yet, it goes express from the start", async () => {
  const [a, b] = await paidBasket();
  await hand(a);
  // b's items, and whether Print API makes them at express speed, aren't known yet
  assert.deepEqual(await parcels.hurryQuote(b.id), { hurry: 'too_late', why: 'not_ready', country: 'NL', ship_by: null, ship_by_express: null, extra: null });
  assert.equal(await parcels.hurry(a.id), 'too_late');
  placeStatus = 503;
  try {
    await hand(b);
    assert.equal(ordersOf([a]).length, 0, 'not placed: Print API is down');
    assert.equal((await parcels.hurryQuote(b.id)).hurry, 'possible');
    assert.equal(await parcels.hurry(a.id), 'express');
  } finally { placeStatus = 200; }
  await parcels.tick();
  const orders = ordersOf([a]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].productionSpeed, 'Express');
});

test("a hurry whose order Print API refuses until express no longer ships by its day: placed at standard speed, nothing spent", async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const [first] = ordersOf([a]);
  const by = (await parcels.hurryQuote(a.id)).ship_by_express!;
  placeStatus = 503;
  try {
    assert.equal(await parcels.hurry(a.id, by), 'express', 'cancellation accepted: to be placed again at express speed');
    await parcels.tick();
    assert.equal(ordersOf([a]).length, 1, 'not placed again: Print API is down');
    assert.equal(pa.get(first.id)!.status, 'Cancelled');
  } finally { placeStatus = 200; }
  // Print API is back a week later
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 7 * 86_400_000 });
  try { await parcels.tick(); } finally { mock.timers.reset(); }
  const [, second] = ordersOf([a]);
  assert.equal(second.id, first.id.replace(/-1$/, '-2'));
  assert.equal(second.productionSpeed, undefined, 'placed again at standard speed');
  assert.equal((await lineOf(a)).parcel.express, false);
});

test("a hurry whose cancellation Print API accepts only after express could ship by its day: placed again as it was, nothing spent", async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const [first] = ordersOf([a]);
  const by = (await parcels.hurryQuote(a.id)).ship_by_express!;
  assert.equal(await parcels.hurry(a.id, '2026-01-01'), 'misses_date', 'express ships after the day allows: nothing asked');
  assert.equal(pa.get(first.id)!.cancellation, undefined);
  beforeCancel = o => { o.status = 'Processing'; };
  try { assert.equal(await parcels.hurry(a.id, by), 'asked'); } finally { beforeCancel = null; }
  Object.assign(pa.get(first.id)!, { status: 'Cancelled', cancellation: 'Accepted' });
  // Print API accepts it a week later
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 7 * 86_400_000 });
  try {
    await parcels.tick(Date.now() + 11 * 60_000);
    assert.equal(await parcels.hurry(a.id, by), 'misses_date', 'asked again: how it stands');
  } finally { mock.timers.reset(); }
  await parcels.tick();
  const [, second] = ordersOf([a]);
  assert.equal(second.id, first.id.replace(/-1$/, '-2'));
  assert.equal(second.productionSpeed, undefined, 'placed again at standard speed');
  assert.equal((await lineOf(a)).parcel.express, false);
});

test("an order whose ship day has passed (Print API left it Created) isn't on time as it is: it ships no sooner than a standard run started now", async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const told = (await lineOf(a)).ship_by, later = Date.now() + 60 * 86_400_000;
  const quote = await parcels.hurryQuote(a.id, later);
  assert.equal(quote.ship_by, payments.shipDay(later, 3, 12), "the products' usual three working days, from then");
  assert.ok(quote.ship_by! > told);
});

test('once printing started a parcel is no longer hurried, and its order is left alone', async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const [first] = ordersOf([a]);
  pa.get(first.id)!.status = 'Processing';
  assert.deepEqual(await parcels.hurryQuote(a.id), { hurry: 'too_late', why: 'printing', country: 'NL', ship_by: null, ship_by_express: null, extra: null });
  assert.equal(await parcels.hurry(a.id), 'too_late');
  assert.equal(pa.get(first.id)!.cancellation, undefined);
  assert.equal(ordersOf([a]).length, 1);
  assert.equal((await lineOf(a)).parcel.status, 'printing');
  assert.equal((await lineOf(a)).parcel.express, false);
});

test("a hurry asked just as printing starts: it waits for Print API's answer, and a turned-down one prints as it was", async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const [first] = ordersOf([a]);
  beforeCancel = o => { o.status = 'Processing'; };
  try { assert.equal(await parcels.hurry(a.id), 'asked'); } finally { beforeCancel = null; }
  assert.equal(await parcels.hurry(a.id), 'asked', 'still unanswered');
  pa.get(first.id)!.cancellation = 'Failed';
  await parcels.tick(Date.now() + 11 * 60_000);
  assert.equal(await parcels.hurry(a.id), 'too_late');
  assert.equal(ordersOf([a]).length, 1);
  assert.equal((await lineOf(b)).parcel.express, false);
  assert.equal((await lineOf(b)).parcel.status, 'printing');
});

test("a hurry whose cancellation Print API made but whose answer was lost: asked again, it goes express", async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  cancelAnswer = false;
  try { assert.equal(await parcels.hurry(a.id), 'try_again'); } finally { cancelAnswer = true; }
  assert.equal(await parcels.hurry(a.id), 'express');
  await parcels.tick();
  assert.deepEqual(ordersOf([a]).map(o => o.productionSpeed), [undefined, 'Express']);
});

test("a parcel holding a product Print API makes at standard speed only can't be hurried: nothing is cancelled", async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b, PDF, 'application/pdf', { productId: 'hello_spiral_book', quantity: 1, pageCount: 24 });
  assert.deepEqual(await parcels.hurryQuote(a.id), { hurry: 'too_late', why: 'no_express', country: 'NL', ship_by: null, ship_by_express: null, extra: null });
  const [first] = ordersOf([a]);
  assert.equal(pa.get(first.id)!.status, 'Created');
});

test("a hurry's extra counts each page past a book's minimum, and is unknown (null) when a product's cost isn't given", async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b, PDF, 'application/pdf', { productId: 'hello_photo_book', quantity: 2, pageCount: 100 });
  // 7% of €10 for the poster and 2 × (€10 + 76 pages × €0.25) for the books: 7% of €68
  assert.equal((await parcels.hurryQuote(a.id)).extra, 476);
  const [c, d] = await paidBasket();
  await hand(c); await hand(d, PDF, 'application/pdf', { productId: 'hello_nocost_poster', quantity: 1 });
  const quote = await parcels.hurryQuote(c.id);
  assert.equal(quote.hurry, 'possible');
  assert.equal(quote.extra, null);
});

test('a cancellation Print API took but answered with an error: the hurry goes on, the parcel placed again at express speed', async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  cancelStatus = 500;
  try { assert.equal(await parcels.hurry(a.id), 'express'); } finally { cancelStatus = 200; }
  await parcels.tick();
  assert.deepEqual(ordersOf([a]).map(o => o.productionSpeed), [undefined, 'Express']);
  assert.equal((await lineOf(a)).parcel.status, 'placed');
});

// ---- placed again by hand
const parcelOfLine = (l: { id: string }) => (db.prepare('select parcel from parcel_lines where line = ?').get(l.id) as any).parcel as string;

test('a parcel Print API cancelled goes again by hand: the same items to the same address from its record, the files given, its kits asked again', async () => {
  let card = false;
  parcels.extras.push(async () => [own('magnet', 'magneet_5x5'), ...(card ? [own('card')] : [])]);
  try {
    const [a, b] = await paidBasket();
    await hand(a); await hand(b, PDF, 'application/pdf', { productId: 'hello_poster', quantity: 2, pageCount: 4, options: [{ id: 'finish', value: 'mat' }] });
    const parcel = parcelOfLine(a), [first] = ordersOf([a]);
    // Print API cancels it (the board, on its dashboard): its files here stay, as for any cancelled parcel, and its address goes 14 days after the payment (here at once)
    pa.get(first.id)!.status = 'Cancelled';
    await parcels.tick(Date.now() + 11 * 60_000);
    assert.equal((await lineOf(a)).parcel.status, 'cancelled');
    assert.equal(existsSync(`${DATA}/parcels/${parcel}`), true);
    db.prepare("update payments set deliver = null where id = (select session from parcels where id = ?)").run(parcel);
    const file = (n: number) => ({ bytes: Buffer.concat([PDF, Buffer.from([n])]), type: 'application/pdf' });
    // what it refuses: a line's item without a file, an item the order hasn't, a file that isn't one
    assert.match(String((await parcels.again(parcel, { '1-0': file(1) }) as any)[1]), /none for 2-0 \(hello_poster\)/);
    assert.match(String((await parcels.again(parcel, { '1-0': file(1), '2-0': file(2), '3-0': file(3) }) as any)[1]), /no item 3-0/);
    assert.equal((await parcels.again(parcel, { '1-0': file(1), '2-0': { bytes: Buffer.from('not a print file, not at all, '.repeat(5)), type: 'application/pdf' } }) as any)[0], 400);
    assert.equal(ordersOf([a]).length, 1, 'nothing placed for a refusal');
    // the board's files, a new one for the magnet among them; the card a kit adds now
    card = true;
    const view = await parcels.again(parcel, { '1-0': file(1), '2-0': file(2), 'x-magnet': file(9) }) as AgainView;
    assert.deepEqual([view.status, view.order], ['waiting', `${parcel}-2`]);
    await parcels.tick();
    const [, second] = ordersOf([a]);
    assert.equal(second.id, `${parcel}-2`);
    assert.deepEqual(second.items.map((i: any) => [i.id, i.productId, i.quantity, i.pageCount, i.options]), [
      ['1-0', 'pebblet_poster', 1, undefined, undefined], ['2-0', 'hello_poster', 2, 4, [{ id: 'finish', value: 'mat' }]],
      ['x-magnet', 'magneet_5x5', 1, undefined, undefined], ['x-card', 'kaart_dubbel_10x10', 1, undefined, undefined]]);
    assert.deepEqual(second.shipping.address, ADDRESS, "Print API's own record of the address");
    const sizes = Object.fromEntries(uploads.filter(u => u.order === second.id).map(u => [u.item, u.size]));
    assert.deepEqual(sizes, { '1-0': PDF.length + 1, '2-0': PDF.length + 1, 'x-magnet': PDF.length + 1, 'x-card': PDF.length },
      "each item's file as given, the magnet's in place of its kit's, the card its kit's");
    assert.deepEqual([(await lineOf(a)).parcel.status, (await lineOf(b)).parcel.status], ['placed', 'placed']);
    assert.deepEqual(parcels.extrasIn(parcel).sort(), ['card', 'magnet']);
    assert.match(String((await parcels.again(parcel, { '1-0': file(1) }) as any)[1]), /only with a parcel Print API cancelled/);
  } finally { parcels.extras.length = 0; }
});

test("a cancelled parcel isn't placed again from a record that isn't whole: no address, or an order Print API doesn't have as cancelled", async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const parcel = parcelOfLine(a), [first] = ordersOf([a]);
  const files = { '1-0': { bytes: PDF, type: 'application/pdf' }, '2-0': { bytes: PDF, type: 'application/pdf' } };
  Object.assign(pa.get(first.id)!, { status: 'Cancelled', shipping: { address: { ...ADDRESS, line1: undefined } } });
  await parcels.tick(Date.now() + 11 * 60_000);
  assert.match(String((await parcels.again(parcel, files) as any)[1]), /no whole delivery address/);
  pa.get(first.id)!.status = 'Shipped';
  assert.match(String((await parcels.again(parcel, files) as any)[1]), /as Shipped, not cancelled/);
  assert.equal(ordersOf([a]).length, 1);
  assert.equal((await lineOf(a)).parcel.status, 'cancelled');
});

test('a placed parcel goes again by hand while its order is still Created: cancelled and placed again, its kits asked again; once printing, never', async () => {
  let card = false;
  parcels.extras.push(async () => (card ? own('card') : null));
  try {
    const [a, b] = await paidBasket();
    await hand(a); await hand(b);
    const parcel = parcelOfLine(a), [first] = ordersOf([a]);
    assert.deepEqual(first.items.map((i: any) => i.id), ['1-0', '2-0'], 'it went without the card');
    card = true;   // the card's code came later
    const view = await parcels.again(parcel) as AgainView;
    assert.equal(view.status, 'waiting');
    await parcels.tick();
    const [, second] = ordersOf([a]);
    assert.equal(pa.get(first.id)!.status, 'Cancelled');
    assert.deepEqual(second.items.map((i: any) => i.id), ['1-0', '2-0', 'x-card']);
    assert.equal((await lineOf(a)).parcel.status, 'placed');
    pa.get(second.id)!.status = 'Processing';
    assert.deepEqual(await parcels.again(parcel), [409, 'printing has started: it can no longer be cancelled']);
    assert.equal(ordersOf([a]).length, 2);
    assert.deepEqual(await parcels.again('pc_0000000000000000'), [404, 'no parcel pc_0000000000000000']);
  } finally { parcels.extras.length = 0; }
});

test("a customer's parcel Print API cancelled, a line of it refunded: not placed again by hand", async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const parcel = parcelOfLine(a), [first] = ordersOf([a]);
  const files = { '1-0': { bytes: PDF, type: 'application/pdf' }, '2-0': { bytes: PDF, type: 'application/pdf' } };
  pa.get(first.id)!.status = 'Cancelled';
  await parcels.tick(Date.now() + 11 * 60_000);
  db.prepare("update pay_lines set refund = 're_test', refund_status = 'succeeded' where id = ?").run(a.id);
  assert.match(String((await parcels.again(parcel, files) as any)[1]), /refunded to its buyer/);
  assert.equal(ordersOf([a]).length, 1);
  assert.equal((await lineOf(a)).parcel.status, 'cancelled');
});

test("a parcel Print API cancelled whose customer asked us to delete their details: not placed again by hand", async () => {
  const [a, b] = await paidBasket();
  await hand(a); await hand(b);
  const parcel = parcelOfLine(a), [first] = ordersOf([a]);
  const files = { '1-0': { bytes: PDF, type: 'application/pdf' }, '2-0': { bytes: PDF, type: 'application/pdf' } };
  pa.get(first.id)!.status = 'Cancelled';
  await parcels.tick(Date.now() + 11 * 60_000);
  assert.equal((await call('/api/pay/line/forget', as('pebblet'), { id: a.id })).status, 200);
  assert.match(String((await parcels.again(parcel, files) as any)[1]), /delete their details/);
  assert.equal(ordersOf([a]).length, 1);
});
