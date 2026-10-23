// node --test src/tester.test.ts   (a throwaway DATA_DIR; no Stripe key, a local server plays both of Print API's
// environments)
// A tester invite: the board's third Share choice on the shop's preview. Each
// person gets a voucher that pays one basket there up to the invite's amount, once; the order is made for real: its parcel goes to Print API's
// live environment, never its test one, and nothing goes to Stripe.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { fakeLettermint, fixtureRepo, productHeaders } from './fixture.ts';

const repo = fixtureRepo();
const DATA = mkdtempSync(`${tmpdir()}/tester-test-`);
Object.assign(process.env, { DATA_DIR: DATA, SECRETS_DIR: `${DATA}/secrets`, PUBLIC_HOST: 'hq.company.test' });
const manifest = (slug: string, yaml: string) => {
  mkdirSync(`${repo}/products/${slug}`, { recursive: true });
  writeFileSync(`${repo}/products/${slug}/product.yaml`, yaml);
};
manifest(
  'front',
  'name: The shop\nstatus: live\nowner: bolt\nbasket:\n  countries: [NL, BE]\n  postage_saved: {NL: 400, BE: 400}\n',
);
manifest('pebblet', 'name: Pebblet\nstatus: preview\nowner: bolt\n');
mkdirSync(`${DATA}/secrets`, { recursive: true });
for (const mode of ['TEST', 'LIVE'])
  for (const k of ['CLIENT_ID', 'CLIENT_SECRET'])
    writeFileSync(`${DATA}/secrets/PRINTAPI_${mode}_${k}`, `${mode}-${k}`);

// Print API: both environments, every request kept with the one it reached; an order keeps our ids and wants its files
const printed: { env: string; method: string; path: string; body: any }[] = [];
const orders = new Map<string, any>();
const printapi = createServer(async (q, s) => {
  const chunks: Buffer[] = [];
  for await (const c of q) chunks.push(c);
  const [, env, ...rest] = q.url!.split('/'),
    path = `/${rest.join('/')}`;
  const text = Buffer.concat(chunks).toString();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* a file, or a form */
  }
  printed.push({ env, method: q.method!, path, body });
  if (path === '/oauth') return s.end(JSON.stringify({ access_token: `tok-${env}`, expires_in: 14400 }));
  const order = /^\/orders\/([^/]+)$/.exec(path),
    file = /^\/files\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
  if (q.method === 'POST' && path === '/orders') {
    const o = {
      id: body.id,
      status: 'Created',
      metadata: body.metadata,
      shipping: { address: body.shipping?.address },
      items: body.items.map((i: any) => ({
        ...i,
        files: { content: { status: 'AwaitingUpload', uploadUrl: `${base(env)}/files/${body.id}/${i.id}/content` } },
      })),
    };
    orders.set(`${env}:${body.id}`, o);
    return s.end(JSON.stringify(o));
  }
  if (q.method === 'GET' && order) {
    const o = orders.get(`${env}:${decodeURIComponent(order[1])}`);
    s.writeHead(o ? 200 : 404);
    return s.end(JSON.stringify(o ?? {}));
  }
  if (q.method === 'POST' && file) {
    const item = orders.get(`${env}:${file[1]}`)?.items.find((i: any) => i.id === file[2]);
    if (item) item.files.content = { status: 'Accepted' };
    return s.end('{}');
  }
  if (q.method === 'GET' && path.startsWith('/products/'))
    return s.end(JSON.stringify({ productionTimes: [{ speed: 'Standard', days: 2, limitHour: 12 }] }));
  s.writeHead(404);
  s.end('{}');
});
await new Promise<void>(r => printapi.listen(0, r));
const base = (env: string) => `https://printapi.test/${env}`;
process.env.PRINTAPI_TEST_API = base('test');
process.env.PRINTAPI_LIVE_API = base('live');
const paPort = (printapi.address() as any).port;
const realFetch = globalThis.fetch;
globalThis.fetch = ((u: any, o: any) =>
  realFetch(String(u).replace(/^https:\/\/printapi\.test\//, `http://localhost:${paPort}/`), o)) as typeof fetch;
// The email service: a stand-in for Lettermint that keeps what it took, and the shop's confirmation words (nl)
const lettermint = await fakeLettermint(),
  mails = lettermint.taken;
lettermint.on();
mkdirSync(`${repo}/products/front/care`, { recursive: true });
writeFileSync(
  `${repo}/products/front/care/basket-email.yaml`,
  `nl:
  subject: "Je bestelling"
  body: |
    {items}
    Totaal: {total}
  voucher: "{amount} betaald met je tegoedbon"
  saved: "{amount} minder"
  delivery: {NL: meestal 1–2 werkdagen}
`,
);
// Stripe: never asked for a tester's order. While stripeLive is set it plays a live account whose sessions are the
// imitation's (payments.ts), for the live order that uses a tester's code.
const striped: string[] = [];
let stripeLive = false;
const stripe = createServer(async (q, s) => {
  let body = '';
  for await (const c of q) body += c;
  striped.push(`${q.method} ${q.url}`);
  if (!stripeLive || q.headers.authorization !== 'Bearer rk_live_tester1') {
    s.writeHead(500);
    return s.end('{}');
  }
  if (q.url === '/v1/account') return s.end(JSON.stringify({ charges_enabled: true }));
  try {
    const out = payments.imitation(
      q.method!,
      q.url!,
      new URLSearchParams(body),
      q.headers['idempotency-key'] as string,
    );
    s.end(JSON.stringify(out.object === 'checkout.session' ? { ...out, livemode: true } : out));
  } catch (e: any) {
    s.writeHead(e.status ?? 500);
    s.end(JSON.stringify({ error: { message: e.message.replace(/^Stripe: /, '') } }));
  }
});
await new Promise<void>(r => stripe.listen(0, r));
process.env.STRIPE_API = `http://localhost:${(stripe.address() as any).port}`;

const { db } = await import('./db.ts');
const payments = await import('./payments.ts');
await import('./basketmail.ts');
const codes = await import('./codes.ts');
const parcels = await import('./parcels.ts');
const shares = await import('./shares.ts');
const feedback = await import('./feedback.ts');
const printapiTool = await import('./printapi.ts');
const guests = await import('./guests.ts');
const approvals = await import('./approvals.ts');
const preview = await import('./preview.ts');
for (const slug of ['front', 'pebblet']) approvals.record(`live:${slug}`, 1); // (a live basket, to try the voucher in)

const srv = createServer((q, s) => {
  if (q.url!.startsWith('/api/pay/basket/code')) return codes.handle(q, s);
  if (q.url!.startsWith('/api/pay/parcel/')) return parcels.handle(q, s);
  if (q.url!.startsWith('/__review/')) return feedback.product(q, s);
  if (q.url!.startsWith('/api/preview/check')) return preview.check(q, s);
  if (q.url!.startsWith('/pay/imitation/')) return payments.imitationPage(q, s);
  return payments.handle(q, s);
});
await new Promise<void>(r => srv.listen(0, r));
const hq = `http://localhost:${(srv.address() as any).port}`;
after(() => {
  srv.close();
  printapi.close();
  stripe.close();
  globalThis.fetch = realFetch;
});

const as = await productHeaders();
const call = (path: string, headers: Record<string, string>, body?: unknown) =>
  new Promise<{ status: number; json: any; text: string }>((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const q = request(hq + path, { method: data === undefined ? 'GET' : 'POST', headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => (text += c));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode!, json, text });
      });
    });
    q.on('error', reject);
    q.end(data);
  });
let n = 0;
async function basket(mode = 'test', amount = 3995) {
  const reference = `pebblet-${++n}`;
  const l = await call('/api/pay/line', as('pebblet', mode), {
    reference,
    amount,
    description: 'Pebblet poster',
    order_url: `https://front.preview.company.test/pebblet/order/${reference}`,
  });
  assert.equal(l.status, 200, l.text);
  const added = await call('/api/pay/basket/add', as('front', mode), { line: l.json.line, claim: l.json.claim });
  assert.equal(added.status, 200, added.text);
  return { id: added.json.basket as string, line: l.json.line as string };
}
const enter = (b: string, code: string, mode = 'test') =>
  call('/api/pay/basket/code', as('front', mode), { basket: b, code, country: 'NL' });
const checkout = (b: string, mode = 'test', over: Record<string, unknown> = {}) =>
  call('/api/pay/basket/checkout', as('front', mode), {
    basket: b,
    deliver_to: { name: 'Tess Ter', line1: 'Proefstraat 1', postCode: '1234 AB', city: 'Utrecht', country: 'NL' },
    email: 'tess@example.com',
    locale: 'nl',
    success_url: 'https://front.preview.company.test/nl/klaar/?session={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://front.preview.company.test/nl/afrekenen/',
    ...over,
  });
const shown = (code: string) => `TESTER-${code.slice(6).match(/.{4}/g)!.join('-')}`;

test('a tester invite is for the shop’s preview only, and gives each person a voucher of their own', () => {
  const elsewhere = feedback.inviteToShare({
    page: 'https://hello.preview.company.test/',
    name: 'Tess',
    email: 'tess@example.com',
    days: 3,
    tester: true,
  });
  assert.equal((elsewhere as any)[0], 400, 'nothing to order on a product’s own preview');
  const made = feedback.inviteToShare({
    page: 'https://front.preview.company.test/pebblet/',
    name: 'Tess',
    email: 'tess@example.com',
    days: 3,
    tester: true,
  }) as any;
  assert.equal(made.tester, true);
  assert.equal(made.view, false, 'notes on: a tester is a reviewer too');
  const notes = feedback.inviteToShare({
    page: 'https://front.preview.company.test/',
    name: 'Tess',
    email: 'tess@example.com',
    days: 3,
  }) as any;
  assert.notEqual(notes.id, made.id, 'a share for notes is another share');
  assert.equal(notes.tester, false);
  const again = feedback.inviteToShare({ id: made.id, name: 'Ruud', email: 'ruud@example.com' }) as any;
  assert.equal(again.id, made.id);
  const people = shares.people(made.id);
  assert.equal(people.length, 2);
  for (const p of people) assert.match(p.voucher!, /^TESTER[A-HJ-NP-Z2-9]{12}$/);
  assert.notEqual(people[0].voucher, people[1].voucher);
  assert.equal(shares.people(notes.id)[0].voucher, null, 'no voucher on a share for notes');
});

test('the voucher pays one basket up to its invite’s amount on the preview, once, and its parcel goes to Print API live', async () => {
  const share = shares.list().find(s => s.tester)!;
  const tess = shares.people(share.id).find(p => p.guest === 'Tess')!;
  // never in a live basket: the public shop doesn't know it
  const live = await basket('live');
  assert.equal((await enter(live.id, shown(tess.voucher!), 'live')).json?.why, 'code_unknown');

  const b = await basket();
  const marked = await enter(b.id, shown(tess.voucher!).toLowerCase());
  assert.equal(marked.status, 200, marked.text);
  assert.equal(marked.json.tester, true);
  assert.equal(marked.json.test, false);
  assert.equal(marked.json.code, null);
  assert.equal(marked.json.total, 0, 'the card pays nothing: delivery is in the price');
  assert.equal(marked.json.lines[0].amount, 3995, 'what it would have cost, for the page');

  const paid = await checkout(b.id, 'test', { revision: marked.json.revision });
  assert.equal(paid.status, 200, paid.text);
  assert.match(paid.json.id, /^cs_test_tester_[a-f0-9]{24}$/);
  assert.equal(paid.json.url, `https://front.preview.company.test/nl/klaar/?session=${paid.json.id}`);
  const order = await call(`/api/pay/basket/order?id=${paid.json.id}`, as('front', 'test'));
  assert.deepEqual([order.json.paid, order.json.tester, order.json.test, order.json.total], [true, true, false, 0]);
  const line = await call(`/api/pay/line?id=${b.line}`, as('pebblet', 'test'));
  assert.equal(line.json.status, 'paid', 'its stall makes it, as any paid order');
  assert.equal(shares.people(share.id).find(p => p.guest === 'Tess')!.ordered, paid.json.id);
  assert.deepEqual(shares.orderedFrom(shares.people(share.id).find(p => p.guest === 'Tess')!), ['Pebblet']);
  // the confirmation says what paid each line, beside its total of nothing
  for (let i = 0; i < 50 && !mails.length; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(mails.length, 1);
  assert.match(mails[0].text, /^- Pebblet: Pebblet poster, € 39,95 \(€ 39,95 betaald met je tegoedbon\)$/m);
  assert.match(mails[0].text, /^Totaal: € 0,00$/m);

  // spent: a second basket can't have it
  const second = await basket();
  assert.equal((await enter(second.id, shown(tess.voucher!))).json?.why, 'code_used');

  // the stall hands its print file over; the parcel is placed in Print API's live environment
  const items = await call('/api/pay/parcel/items', as('pebblet', 'test'), {
    line: b.line,
    items: [{ productId: 'pebblet_poster', quantity: 1 }],
  });
  assert.equal(items.status, 200, items.text);
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 32)]);
  const sent = await call(
    `/api/pay/parcel/file?line=${b.line}&item=0&file=content`,
    { ...as('pebblet', 'test'), 'content-type': 'application/pdf' },
    pdf,
  );
  assert.equal(sent.status, 200, sent.text);
  await parcels.tick();
  const placed = printed.filter(p => p.method === 'POST' && p.path === '/orders');
  assert.equal(placed.length, 1, 'placed once');
  assert.equal(placed[0].env, 'live', 'printed for real');
  assert.equal(JSON.parse(placed[0].body.metadata).tester, true);
  assert.equal(placed[0].body.shipping.address.city, 'Utrecht');
  assert.ok(!printed.some(p => p.env === 'test' && p.path === '/orders'), 'nothing to the test environment');
  assert.deepEqual(striped, [], 'Stripe never heard of it');
  assert.equal(printapiTool.ownOrder(placed[0].body.id)?.ours.from, 'tester parcel', 'hq orders says whose it is');

  // apart from the customers' numbers
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(Date.now());
  assert.equal(payments.testerOrders(today, today), 1);
  assert.deepEqual(payments.basketsByDay('live', today, today), []);
});

test('a removed tester’s voucher pays nothing', async () => {
  const share = shares.list().find(s => s.tester)!;
  const ruud = shares.people(share.id).find(p => p.guest === 'Ruud')!;
  const b = await basket();
  assert.equal((await enter(b.id, shown(ruud.voucher!))).status, 200);
  feedback.removeFromShare({ id: share.id, name: 'Ruud' });
  const refused = await checkout(b.id);
  assert.equal(refused.json?.why, 'code_expired', 'the basket still held it: its checkout refuses');
  assert.equal(shares.people(share.id).find(p => p.guest === 'Ruud')!.ordered, null);
  // removing the mark makes it an ordinary basket again
  const off = await call('/api/pay/basket/code/remove', as('front', 'test'), { basket: b.id, country: 'NL' });
  assert.equal(off.json.tester, false);
  assert.equal(off.json.total, 3995);
});

// A tester's Send my notes, as review mode sends it from the shop's preview: a session of theirs on its host
const PREVIEW_HOST = 'front.preview.company.test';
function sessionFor(share: number, guest: string) {
  const session = `session-${guest}`;
  db.prepare('insert into review_share_sessions (hash, share, guest, seal, host) values (?, ?, ?, ?, ?)').run(
    createHash('sha256').update(session).digest('hex'),
    share,
    guest,
    guests.seal(guest),
    PREVIEW_HOST,
  );
  return session;
}
const sendNotes = (session: string) =>
  call(
    '/__review/submit',
    {
      host: PREVIEW_HOST,
      origin: `https://${PREVIEW_HOST}`,
      cookie: `ps=${session}`,
      'content-type': 'application/json',
    },
    {},
  );
const testerInvite = (name: string) =>
  feedback.inviteToShare({
    page: `https://${PREVIEW_HOST}/`,
    name,
    email: `${name.toLowerCase()}@example.com`,
    days: 3,
    tester: true,
  }) as any;

test('a tester who sends their notes before ordering keeps their voucher, and the invite ends once they’ve ordered', async () => {
  for (const s of shares.list()) if (!s.ended) feedback.endShare({ id: s.id });
  const share = testerInvite('Mia');
  const sent = await sendNotes(sessionFor(share.id, 'Mia'));
  assert.equal(sent.status, 200, sent.text);
  assert.equal(shares.byId(share.id)!.ended, null, 'still open: Mia hasn’t ordered');
  feedback.gather();
  assert.equal(shares.byId(share.id)!.ended, null);

  const mia = shares.people(share.id)[0];
  const b = await basket();
  assert.equal((await enter(b.id, shown(mia.voucher!))).status, 200);
  const paid = await checkout(b.id, 'test', { email: 'mia@example.com' });
  assert.equal(paid.status, 200, paid.text);
  assert.equal(shares.people(share.id)[0].ordered, paid.json.id);
  feedback.gather();
  assert.ok(shares.byId(share.id)!.ended, 'everyone has sent their notes and ordered');
});

// The chat's route on the preview (Caddy asks with ?board=1): a tester uses the support chat there as a customer would; an
// outside reviewer's share for notes still doesn't
test('a tester gets the preview’s chat, a share for notes doesn’t', async () => {
  for (const s of shares.list()) if (!s.ended) feedback.endShare({ id: s.id });
  const check = (session: string, uri: string) =>
    call('/api/preview/check?board=1', {
      cookie: `ps=${session}`,
      'x-forwarded-host': PREVIEW_HOST,
      'x-forwarded-uri': uri,
    }).then(r => r.status);
  const tester = sessionFor(testerInvite('Ivo').id, 'Ivo');
  assert.equal(await check(tester, '/__care/widget.js'), 200);
  assert.equal(await check(tester, '/pebblet/__care/api/hello'), 200, 'on a stall’s shelf too');
  const notes = feedback.inviteToShare({
    page: `https://${PREVIEW_HOST}/`,
    name: 'Noor',
    email: 'noor@example.com',
    days: 3,
  }) as any;
  assert.equal(await check(sessionFor(notes.id, 'Noor'), '/__care/widget.js'), 403);
});

test('a voucher whose invite ended pays nothing', async () => {
  const share = testerInvite('Noor');
  const noor = shares.people(share.id)[0];
  const b = await basket();
  assert.equal((await enter(b.id, shown(noor.voucher!))).status, 200);
  feedback.endShare({ id: share.id });
  assert.equal((await checkout(b.id)).json?.why, 'code_expired');
  assert.equal(shares.people(share.id)[0].ordered, null);
});

// The board's amount on the invite: a voucher pays a basket up to it, delivery
// included (a line's amount carries its delivery), and refuses one over it at the checkout, whatever the page showed
test('a voucher pays a basket up to its invite’s amount: under, exactly at and over, and a new amount reaches vouchers already sent', async () => {
  for (const s of shares.list()) if (!s.ended) feedback.endShare({ id: s.id });
  const invite = (name: string, extra = {}) =>
    feedback.inviteToShare({
      page: `https://${PREVIEW_HOST}/`,
      name,
      email: `${name.toLowerCase()}@example.com`,
      days: 3,
      tester: true,
      ...extra,
    }) as any;
  assert.equal(invite('Lou', { cap: 0 })[0], 400, 'whole euros, 1 or more');
  const made = invite('Lou', { cap: 30 });
  assert.equal(made.cap, 30);
  assert.equal(invite('Kai', { cap: 99 }).cap, 30, 'an invite to the open share keeps its amount');
  const [lou, kai] = shares.people(made.id);

  // over: the basket says so, and its checkout is refused, the voucher kept
  const over = await basket('test', 3001);
  const marked = await enter(over.id, shown(lou.voucher!));
  assert.equal(marked.status, 200, marked.text);
  assert.deepEqual(marked.json.tester_cap, { cap: 3000, over: true });
  const refused = await checkout(over.id, 'test', { revision: marked.json.revision });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.why, 'tester_cap');
  assert.equal(refused.json.cap, 3000);
  assert.equal(shares.people(made.id)[0].ordered, null, 'nothing spent');

  // the board raises it after the invites went out: the same voucher, the same basket, now under
  assert.equal((feedback.setShareCap({ id: made.id, cap: 2.5 }) as any)[0], 400);
  assert.equal((feedback.setShareCap({ id: made.id, cap: 501 }) as any)[0], 400);
  assert.equal((feedback.setShareCap({ id: made.id, cap: 40 }) as any).cap, 40);
  const shownNow = await call(`/api/pay/basket?id=${over.id}`, as('front', 'test'));
  assert.deepEqual(shownNow.json.tester_cap, { cap: 4000, over: false });
  const paid = await checkout(over.id, 'test', { revision: shownNow.json.revision });
  assert.equal(paid.status, 200, paid.text);
  assert.equal(shares.people(made.id)[0].ordered, paid.json.id);
  assert.equal(
    (await call(`/api/pay/basket?id=${over.id}`, as('front', 'test'))).json.tester_cap,
    undefined,
    'paid: no amount to say',
  );

  // exactly at it goes through
  const at = await basket('test', 4000);
  assert.deepEqual((await enter(at.id, shown(kai.voucher!))).json.tester_cap, { cap: 4000, over: false });
  assert.equal((await checkout(at.id, 'test', { email: 'kai@example.com' })).status, 200);

  // lowered under a basket already marked: refused at its checkout, the page's check aside
  const late = invite('Ivo');
  const ivo = shares.people(made.id).find(p => p.guest === 'Ivo')!;
  const b = await basket('test', 2500);
  assert.equal((await enter(b.id, shown(ivo.voucher!))).json.tester_cap.over, false);
  feedback.setShareCap({ id: late.id, cap: 20 });
  assert.equal((await checkout(b.id)).json?.why, 'tester_cap');
  assert.equal(
    feedback.setShareCap({ id: (feedback.listShares().find(s => !s.tester) ?? { id: 0 }).id, cap: 10 }),
    404,
    'a notes share has none',
  );
});

test('a tester invite made without an amount pays up to €50', () => {
  for (const s of shares.list()) if (!s.ended) feedback.endShare({ id: s.id });
  const made = testerInvite('Ada');
  assert.equal(made.cap, 50);
  assert.equal(payments.testerVoucher.cap!(shares.people(made.id)[0].voucher!), 5000);
});

// The parcel's code card: a tester judges the whole parcel, so their order gets a code of its own that the live shop
// takes, as a customer's would (codes.ts), kept out of the live numbers. And a parcel Print API cancels is read calmly:
// nothing refunded, mailed or asked of a person, and the voucher pays the order that replaces it, which is the one
// counted.
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(Date.now());
const buyerCount = () => (db.prepare('select count(*) n from code_buyers').get() as { n: number }).n;
// A tester's paid order, on a shop whose parcels carry a code card: its invite, voucher, session and line
async function testerOrder(name: string) {
  for (const s of shares.list()) if (!s.ended) feedback.endShare({ id: s.id });
  const words = Array.from(
    { length: 120 },
    (_, i) => `W${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`,
  );
  writeFileSync(`${repo}/products/front/code-words.txt`, words.join('\n'));
  manifest(
    'front',
    'name: The shop\nstatus: live\nowner: bolt\nbasket:\n  countries: [NL, BE]\n  postage_saved: {NL: 400, BE: 400}\n' +
      'codes: {months: 3, words: code-words.txt, card: true, order: {off: 500, minimum: 3000}, thanks: {percent: 10}}\n',
  );
  const share = testerInvite(name);
  const voucher = shares.people(share.id)[0].voucher!;
  const b = await basket();
  assert.equal((await enter(b.id, shown(voucher))).status, 200);
  const paid = await checkout(b.id);
  assert.equal(paid.status, 200, paid.text);
  return { share, voucher, session: paid.json.id as string, line: b.line };
}
// Its parcel, placed at Print API: the order Print API has
async function placeParcel(order: { session: string; line: string }) {
  await call('/api/pay/parcel/items', as('pebblet', 'test'), {
    line: order.line,
    items: [{ productId: 'pebblet_poster', quantity: 1 }],
  });
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 32)]);
  const sent = await call(
    `/api/pay/parcel/file?line=${order.line}&item=0&file=content`,
    { ...as('pebblet', 'test'), 'content-type': 'application/pdf' },
    pdf,
  );
  assert.equal(sent.status, 200, sent.text);
  await parcels.tick();
  const parcel = (db.prepare('select id from parcels where session = ?').get(order.session) as { id: string }).id;
  return {
    parcel,
    placed: printed.find(p => p.method === 'POST' && p.path === '/orders' && p.body.id === `${parcel}-1`)!,
  };
}
// ...which Print API then cancels, before anything was sent
async function cancelAtPrintApi(id: string) {
  orders.get(`live:${id}`).status = 'Cancelled';
  await parcels.tick(Date.now() + 11 * 60_000);
}

test('a tester’s order gets a code of its own for its card, one the live shop takes, with nothing kept of them as a buyer', async () => {
  const buyers = buyerCount();
  const { session } = await testerOrder('Elin');
  const own = codes.codeOf(session, 'order')!;
  assert.ok(own, 'the order has a code of its own');
  assert.equal(own.mode, 'live', 'one the live shop knows, though the order is a test-mode one');
  assert.deepEqual(
    [own.off, own.minimum, own.lang],
    [500, 3000, 'nl'],
    'made as a customer’s: the shop’s size, the order’s language',
  );
  assert.deepEqual(
    { ...(db.prepare('select buyer, newcomer from code_orders where session = ?').get(session) as object) },
    { buyer: null, newcomer: null },
    'nothing kept of the tester as a buyer',
  );
  assert.equal(buyerCount(), buyers);
  const live = await basket('live');
  const entered = await enter(live.id, own.code, 'live');
  assert.equal(entered.status, 200, entered.text);
  assert.deepEqual([entered.json.code.code, entered.json.code.saved], [own.code, 500]);
});

test('a live order on a tester’s code counts in no live number and earns the tester no thank-you', async t => {
  // Stripe live: the imitation's sessions, as live ones, on an account that takes charges
  stripeLive = true;
  writeFileSync(`${DATA}/secrets/STRIPE_LIVE_RESTRICTED_KEY`, 'rk_live_tester1');
  t.after(() => {
    stripeLive = false;
    rmSync(`${DATA}/secrets/STRIPE_LIVE_RESTRICTED_KEY`, { force: true });
  });
  const { session } = await testerOrder('Jens');
  const own = codes.codeOf(session, 'order')!;
  const live = await basket('live');
  assert.equal((await enter(live.id, own.code, 'live')).status, 200);
  const opened = await checkout(live.id, 'live', {
    email: 'nieuw@example.com',
    success_url: 'https://front.company.test/nl/klaar/?session={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://front.company.test/nl/afrekenen/',
  });
  assert.equal(opened.status, 200, opened.text);
  await call(`${new URL(opened.json.url).pathname}/pay`, { origin: 'https://hq.company.test' }, '');
  const view = await call(`/api/pay/basket?id=${live.id}&country=NL`, as('front', 'live'));
  assert.equal(view.json.status, 'paid', view.text);
  assert.equal(codes.codeOf(session, 'order')!.status, 'used', 'the live order used it');
  assert.equal(codes.codeOf(session, 'thanks'), null, 'no thank-you for the tester');
  assert.deepEqual(codes.usedByDay('live', today(), today()), [], 'and no live number counts it');
});

test('a tester’s parcel Print API cancelled before anything was sent is read calmly: nothing refunded, mailed or asked of a person', async () => {
  const order = await testerOrder('Mila');
  const { parcel, placed } = await placeParcel(order);
  assert.equal(placed.env, 'live');
  const mailed = mails.length,
    asked = striped.length;
  await cancelAtPrintApi(placed.body.id);

  const line = await call(`/api/pay/line?id=${order.line}`, as('pebblet', 'test'));
  assert.equal(line.json.parcel.status, 'cancelled');
  const closed = await call('/api/pay/line/refund', as('pebblet', 'test'), { id: order.line });
  assert.equal(closed.status, 200, closed.text);
  assert.equal(closed.json.refund_status, 'succeeded', 'closed: the card paid nothing');
  assert.equal(striped.length, asked, 'Stripe never heard of it');
  assert.equal(mails.length, mailed, 'no email to the tester');
  const said = (db.prepare('select text from events where text like ?').all(`%${parcel}%`) as { text: string }[]).map(
    e => e.text,
  );
  assert.ok(!said.some(t => t.includes('NEEDS A PERSON')), said.join('\n'));
  assert.equal(printapiTool.ownOrder(placed.body.id)?.ours.status, 'cancelled', 'hq orders shows it cancelled');
});

test('a tester whose parcel Print API cancelled orders again on their voucher, counted once', async () => {
  const counted = payments.testerOrders(today(), today());
  const order = await testerOrder('Noor');
  const { placed } = await placeParcel(order);
  assert.equal(payments.testerOrders(today(), today()), counted + 1);
  await cancelAtPrintApi(placed.body.id);

  const tester = shares.people(order.share.id)[0];
  assert.equal(shares.orderOf(tester), null);
  assert.deepEqual(shares.orderedFrom(tester), []);
  assert.equal(payments.testerOrders(today(), today()), counted);
  const again = await basket();
  assert.equal((await enter(again.id, shown(order.voucher))).status, 200, 'it pays a basket again');
  const second = await checkout(again.id);
  assert.equal(second.status, 200, second.text);
  assert.equal(shares.orderOf(shares.people(order.share.id)[0]), second.json.id);
  assert.equal(payments.testerOrders(today(), today()), counted + 1, 'one tester order, not two');
  assert.equal(codes.codeOf(second.json.id, 'order')?.mode, 'live', 'its card has a code of its own too');
  const third = await basket();
  assert.equal((await enter(third.id, shown(order.voucher))).json?.why, 'code_used', 'and then it’s spent');
});

test('a tester’s parcel Print API cancelled, placed again by hand, counts again and spends its voucher', async () => {
  for (const s of shares.list()) if (!s.ended) feedback.endShare({ id: s.id });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(Date.now());
  const counted = payments.testerOrders(today, today);
  const share = testerInvite('Noor');
  const voucher = shares.people(share.id)[0].voucher!;
  const b = await basket();
  assert.equal((await enter(b.id, shown(voucher))).status, 200);
  const paid = await checkout(b.id, 'test', { email: 'noor@example.com' });
  assert.equal(paid.status, 200, paid.text);
  const session = paid.json.id as string;
  await call('/api/pay/parcel/items', as('pebblet', 'test'), {
    line: b.line,
    items: [{ productId: 'pebblet_poster', quantity: 1 }],
  });
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 32)]);
  await call(
    `/api/pay/parcel/file?line=${b.line}&item=0&file=content`,
    { ...as('pebblet', 'test'), 'content-type': 'application/pdf' },
    pdf,
  );
  await parcels.tick();
  const parcel = (db.prepare('select id from parcels where session = ?').get(session) as { id: string }).id;
  orders.get(`live:${parcel}-1`).status = 'Cancelled';
  await parcels.tick(Date.now() + 11 * 60_000);
  assert.equal(payments.testerOrders(today, today), counted, 'cancelled: not counted, its voucher free');
  const placed = await parcels.again(parcel, { '1-0': { bytes: pdf, type: 'application/pdf' } });
  assert.equal(Array.isArray(placed), false, JSON.stringify(placed));
  await parcels.tick();
  const second = printed.find(p => p.method === 'POST' && p.path === '/orders' && p.body.id === `${parcel}-2`)!;
  assert.equal(second.env, 'live', 'placed again in Print API’s live environment');
  assert.equal(JSON.parse(second.body.metadata).tester, true);
  assert.equal(payments.testerOrders(today, today), counted + 1, 'it counts again');
  const another = await basket();
  assert.equal((await enter(another.id, shown(voucher))).json?.why, 'code_used', 'its voucher is spent again');
});

test('a tester’s cancelled parcel isn’t placed again by hand once its voucher has paid another order; with that one cancelled too, it is', async () => {
  for (const s of shares.list()) if (!s.ended) feedback.endShare({ id: s.id });
  const share = testerInvite('Sanne');
  const voucher = shares.people(share.id)[0].voucher!;
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 32)]);
  const b = await basket();
  assert.equal((await enter(b.id, shown(voucher))).status, 200);
  const paid = await checkout(b.id, 'test', { email: 'sanne@example.com' });
  assert.equal(paid.status, 200, paid.text);
  await call('/api/pay/parcel/items', as('pebblet', 'test'), {
    line: b.line,
    items: [{ productId: 'pebblet_poster', quantity: 1 }],
  });
  await call(
    `/api/pay/parcel/file?line=${b.line}&item=0&file=content`,
    { ...as('pebblet', 'test'), 'content-type': 'application/pdf' },
    pdf,
  );
  await parcels.tick();
  const first = (db.prepare('select id from parcels where session = ?').get(paid.json.id) as { id: string }).id;
  orders.get(`live:${first}-1`).status = 'Cancelled';
  await parcels.tick(Date.now() + 11 * 60_000);

  // the freed voucher pays another basket: the cancelled parcel no longer goes again
  const other = await basket();
  assert.equal((await enter(other.id, shown(voucher))).status, 200);
  const paidAgain = await checkout(other.id, 'test', { email: 'sanne@example.com' });
  assert.equal(paidAgain.status, 200, paidAgain.text);
  const placedOrders = () => printed.filter(p => p.method === 'POST' && p.path === '/orders').length;
  const before = placedOrders();
  const refused = (await parcels.again(first, { '1-0': { bytes: pdf, type: 'application/pdf' } })) as [number, string];
  assert.equal(refused[0], 409);
  assert.match(refused[1], new RegExp(`voucher has paid another order since \\(${paidAgain.json.id}\\)`));
  await parcels.tick();
  assert.equal(placedOrders(), before, 'nothing placed');
  assert.equal(shares.orderOf(shares.people(share.id)[0]), paidAgain.json.id, 'the voucher stays the other order’s');
  assert.equal(
    (db.prepare('select status from parcels where id = ?').get(first) as { status: string }).status,
    'cancelled',
  );

  // that other order's parcel cancelled too: the first goes again, and its voucher is spent on it
  db.prepare("update parcels set status = 'cancelled' where session = ?").run(paidAgain.json.id);
  const placed = await parcels.again(first, { '1-0': { bytes: pdf, type: 'application/pdf' } });
  assert.equal(Array.isArray(placed), false, JSON.stringify(placed));
  assert.equal(shares.orderOf(shares.people(share.id)[0]), paid.json.id);
  const another = await basket();
  assert.equal((await enter(another.id, shown(voucher))).json?.why, 'code_used', 'its voucher is spent on it');
});
