// node --test src/diagnostics.test.ts   (the real server on a local port, a throwaway DATA_DIR, the fake model, and a local
// server playing HQ). A bug report as the customer gives it: the consent card offered once, nothing stored without its
// "Send it", the bundle checked and redacted again on the server, the case for HQ, and how long it's kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HQ's side of the line: the cards care posts, and its state (with the bugs it marked fixed)
const cards: any[] = [];
let fixedRefs: string[] = [], erasedRefs: string[] = [];
const hqServer = createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d).on('end', () => {
    if (req.headers.authorization !== 'Bearer hq-test-token') return void res.writeHead(401).end();
    if (req.url === '/api/care/cards') cards.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.url === '/api/care/cards' ? { ok: true, id: String(cards.length) }
      : { busy: 'auto', queue: { waiting: 0, oldest: null }, fixed: fixedRefs, erased: erasedRefs }));
  });
});
await new Promise<void>(r => hqServer.listen(0, '127.0.0.1', r));

const PORT = 20000 + Math.floor(Math.random() * 20000);
Object.assign(process.env, { DATA_DIR: mkdtempSync(join(tmpdir(), 'care-diagnostics-')), PORT: String(PORT), CARE_LOCAL: '1', CARE_PROVIDER: 'fake',
  CARE_APPS: JSON.stringify({ shop: 'http://127.0.0.1:9' }), CARE_TOKENS: JSON.stringify({ shop: 'unused' }), CARE_NAMES: JSON.stringify({ shop: 'Shop' }),
  CARE_COMPANY_DIR: new URL('../../../template/products/care', import.meta.url).pathname,
  CARE_HQ_URL: `http://127.0.0.1:${(hqServer.address() as any).port}`, CARE_HQ_TOKEN: 'hq-test-token' });
const fake = await import('./fake.ts');
const { t } = await import('./texts.ts');
const { db, sweep } = await import('./db.ts');
const hq = await import('./hq.ts');
await import('./server.ts');
await new Promise(r => setTimeout(r, 100));

// ---- a customer: a cookie, the stream as a list of messages, and the widget's POSTs
const BASE = `http://127.0.0.1:${PORT}`;
async function customer() {
  let cookie = '';
  const events: any[] = [], tab = crypto.randomUUID(), ip = `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const headers = () => ({ 'x-care-app': 'shop', origin: BASE, 'content-type': 'application/json', 'x-forwarded-for': ip, 'x-care-tab': tab, ...(cookie ? { cookie } : {}) });
  const raw = async (path: string, body: string) => {
    const r = await fetch(`${BASE}/__care/api/${path}`, { method: 'POST', headers: headers(), body });
    const set = r.headers.getSetCookie().filter(c => c.startsWith('__Host-care=')).at(-1);
    if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json() as any };
  };
  const post = async (path: string, body: any = {}) => (await raw(path, JSON.stringify(body))).body;
  const hello = await post('hello', { lang: 'en' });
  const ctl = new AbortController();
  const r = await fetch(`${BASE}/__care/api/stream`, { headers: headers(), signal: ctl.signal });
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    try { for await (const chunk of r.body as any) { buf += dec.decode(chunk); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); if (ev.startsWith('data: ')) events.push(JSON.parse(ev.slice(6))); } } } catch { /* closed */ }
  })();
  const replies = () => events.filter(e => e.t === 'reply');
  const until = async (f: () => any, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const x = f(); if (x) return x; await new Promise(r => setTimeout(r, 20)); } throw new Error('timed out waiting'); };
  let n = 0;
  const say = (text: string, answer?: any) => post('say', { id: `c${++n}`, text, answer });
  const conversation = () => (db.prepare('select conversation from messages where id = ?').get(Number(hello.items[0].id.slice(1))) as any).conversation as number;
  return { hello, events, replies, until, say, post, raw, conversation, close: () => ctl.abort() };
}

// the model offers the card when the customer reports a bug, and answers in words after a tool result
const seen: any[] = [];
const isResult = (m: any) => Array.isArray(m.content);
fake.script(o => { seen.push(o); return isResult(o.messages.at(-1)) ? [{ text: 'Let’s keep going.' }] : [{ text: 'Sorry, that sounds broken.' }, { tool: 'offer_snapshot', input: { problem: 'The order page shows an error for anna@example.com.' } }]; });
async function offered() {
  const c = await customer();
  await c.say('the order page shows an error');
  const r = await c.until(() => c.replies().find(x => x.widget?.type === 'consent'));
  return { c, card: r.widget, send: r.widget.options[0].action as string, no: r.widget.options[1].action as string };
}

// a real-looking bundle: a PNG's first bytes and a log, as the browser builds it
const PNG = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]).toString('base64');
const bundle = (extra: any = {}) => ({ v: 1, at: new Date().toISOString(), page: { path: '/order', w: 390, h: 844 },
  events: [{ at: Date.now(), kind: 'view', text: '/order' }, { at: Date.now(), kind: 'error', text: 'Uncaught Error: no order (order.js:3:9)' }], picture: PNG, ...extra });
// hq.sync() returns at once while a run is going (a case nudges one): call it until what HQ did shows
async function synced(f: () => any) { for (let i = 0; i < 100; i++) { await hq.sync(); const x = f(); if (x) return x; await new Promise(r => setTimeout(r, 30)); } throw new Error('HQ never synced'); }
const diagnosticsOf = (conv: number) => db.prepare('select * from diagnostics where conversation = ?').all(conv) as any[];

test('the card is offered once per conversation, from templates, with three buttons of equal weight', async () => {
  const { c, card } = await offered();
  assert.equal(card.title, t('snap_title', 'en'));
  assert.equal(card.text, t('snap_text', 'en'));
  assert.equal(card.fine, t('snap_fine', 'en'));
  assert.equal(card.see, t('snap_see', 'en'));
  assert.deepEqual(card.options.map((o: any) => o.label), [t('snap_send', 'en'), t('snap_no', 'en')]);
  assert.ok(card.options.every((o: any) => !o.primary), 'none of them primary');
  seen.length = 0;
  await c.say('it still shows the error');
  await c.until(() => c.replies().some(x => x.text === 'Let’s keep going.'));
  const result = seen.at(-1).messages.at(-1).content.find((b: any) => b.type === 'tool_result');
  assert.match(result.content, /"shown":false/, 'the second call is told it was already asked');
  assert.match(seen.at(-1).system, /already offered the snapshot card/);
  assert.equal(c.replies().filter(x => x.widget?.type === 'consent').length, 1, 'one card in the conversation');
  c.close();
});

test('nothing is stored without the card’s own Send: no action, “No thanks”, or another customer’s card', async () => {
  const a = await offered(), b = await offered();
  const conv = a.c.conversation();
  assert.equal((await a.c.raw('diagnostics', JSON.stringify({ widget: a.card.id, action: 'made-up', bundle: bundle() }))).status, 403);
  assert.equal((await a.c.raw('diagnostics', JSON.stringify({ widget: a.card.id, action: a.no, bundle: bundle() }))).status, 403);
  assert.equal((await a.c.raw('diagnostics', JSON.stringify({ widget: b.card.id, action: b.send, bundle: bundle() }))).status, 403, 'another conversation’s card');
  assert.equal(diagnosticsOf(conv).length, 0);
  // "No thanks" is a tap like any other: a fixed line, nothing sent, and the card can't send any more
  await a.c.say('No thanks', { widget: a.card.id, action: a.no });
  await a.c.until(() => a.c.replies().find(x => x.text === t('snap_declined', 'en')));
  assert.equal(diagnosticsOf(conv).length, 0);
  a.c.close(); b.c.close();
});

test('the schema: extra keys, a picture that isn’t an image, too many events and a body over 256 KB are refused, and the card still works', async () => {
  const { c, card, send } = await offered();
  const conv = c.conversation();
  const tryIt = async (b: any) => (await c.raw('diagnostics', JSON.stringify({ widget: card.id, action: send, bundle: b }))).status;
  assert.equal(await tryIt({ ...bundle(), cookie: 'x' }), 400, 'an extra key');
  assert.equal(await tryIt(bundle({ page: { path: '/order', w: 390, h: 844, html: '<b>' } })), 400, 'an extra key inside');
  assert.equal(await tryIt(bundle({ events: [{ at: 1, kind: 'error', text: 'x', stack: 'y' }] })), 400, 'an extra key in an event');
  assert.equal(await tryIt(bundle({ events: [{ at: 1, kind: 'script', text: 'x' }] })), 400, 'an unknown kind');
  assert.equal(await tryIt(bundle({ picture: 'data:image/svg+xml;base64,' + Buffer.from('<svg onload="alert(1)"/>').toString('base64') })), 400, 'an SVG');
  assert.equal(await tryIt(bundle({ picture: 'data:image/png;base64,' + Buffer.from('<html><script>alert(1)</script></html>'.repeat(4)).toString('base64') })), 400, 'HTML named a PNG');
  assert.equal(await tryIt(bundle({ picture: PNG.replace('image/png', 'image/jpeg') })), 400, 'a PNG named a JPEG');
  assert.equal(await tryIt(bundle({ events: Array.from({ length: 101 }, () => ({ at: 1, kind: 'view', text: '/' })) })), 400, '101 events');
  const big = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200_000)]).toString('base64');
  assert.equal(await tryIt(bundle({ picture: big })), 400, 'a body over 256 KB');
  const stranger = await fetch(`${BASE}/__care/api/diagnostics`, { method: 'POST', body: JSON.stringify({ bundle: bundle({ picture: big }) }),
    headers: { 'x-care-app': 'shop', origin: BASE, 'content-type': 'application/json' } });
  assert.equal(stranger.status, 401, 'no live session: refused before the 256 KB body is read');
  assert.equal((await c.raw('say', JSON.stringify({ id: 'x', text: 'a'.repeat(20_000) }))).status, 400, 'the other routes keep 16 KB');
  assert.equal(diagnosticsOf(conv).length, 0);
  const ok = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(150_000, 3)]).toString('base64');
  const r = await c.raw('diagnostics', JSON.stringify({ widget: card.id, action: send, bundle: bundle({ picture: ok }) }));
  assert.equal(r.status, 200, 'a picture of 200 KB in base64 fits, and the refusals didn’t spend the action');
  assert.equal(diagnosticsOf(conv).length, 1);
  c.close();
});

test('the log is the last ten minutes: older events are dropped; and the route is 20 tries an hour per session', async () => {
  const { c, card, send } = await offered();
  const conv = c.conversation();
  const tryIt = async (b: any) => (await c.raw('diagnostics', JSON.stringify({ widget: card.id, action: send, bundle: b }))).status;
  for (let i = 0; i < 19; i++) assert.equal(await tryIt({ ...bundle(), cookie: 'x' }), 400);
  const old = Date.now() - 11 * 60_000;
  assert.equal(await tryIt(bundle({ events: [{ at: old, kind: 'error', text: 'an hour-old error' }, { at: Date.now(), kind: 'view', text: '/order' }] })), 200);
  assert.deepEqual(JSON.parse(diagnosticsOf(conv)[0].bundle).events.map((e: any) => e.text), ['/order'], 'only the last ten minutes');
  assert.equal(await tryIt(bundle()), 429, 'the 21st in an hour');
  c.close();
});

test('a Send stores the bundle as data, redacted again on the server; a second Send is refused; HQ’s card carries it', async () => {
  const { c, card, send } = await offered();
  const conv = c.conversation();
  const forged = bundle({ page: { path: '/order/ORD-7Q4K-M2?t=s3cret-token#t=frag-token', w: 390, h: 844 }, events: [
    { at: Date.now(), kind: 'error', text: '<img src=x onerror=alert(1)> for anna@example.com, card 4242 4242 4242 4242' },
    { at: Date.now(), kind: 'request', text: 'GET https://shop.example/api/orders/ORD-7Q4K-M2?order=ORD-7Q4K-M2&t=s3cret-token#t=frag-token 500' }] });
  const r = await c.post('diagnostics', { id: 'snap1', widget: card.id, action: send, bundle: forged });
  assert.equal(r.ok, true);
  assert.match(r.ref, /^H-\d+$/);
  const row = diagnosticsOf(conv)[0];
  for (const secret of ['anna@example.com', '4242', 's3cret-token', 'frag-token', 'ORD-7Q4K-M2']) assert.ok(!row.bundle.includes(secret), `no ${secret}`);
  const kept = JSON.parse(row.bundle);
  assert.equal(kept.page.path, '/order/:id');
  assert.equal(kept.events[0].text, '<img src=x onerror=alert(1)> for [email], card [number]', 'the HTML stays text, as data');
  assert.equal(kept.events[1].text, 'GET https://shop.example/api/orders/:id 500');
  // the card answered, the tap in the transcript, and the reference said
  await c.until(() => c.events.find(e => e.t === 'close' && e.widget === card.id && e.done));
  await c.until(() => c.replies().find(x => x.text === t('snap_sent', 'en', { ref: r.ref })));
  assert.equal((await c.raw('diagnostics', JSON.stringify({ id: 'snap2', widget: card.id, action: send, bundle: bundle() }))).status, 409, 'a second Send');
  assert.equal(diagnosticsOf(conv).length, 1);
  // HQ: a `bug` card with the bundle, the helper's sentence (redacted) and no chat
  const sent = await synced(() => cards.find(x => x.case === r.ref));
  assert.equal(sent.kind, 'bug');
  assert.equal(sent.summary, 'The order page shows an error for [email].');
  // only what the consent card names: no reply address, no orders
  assert.equal(sent.to, null);
  assert.equal(sent.check, 'none');
  assert.deepEqual(sent.facts, {});
  assert.deepEqual(sent.chat, []);
  assert.equal(sent.bundle.picture, PNG);
  assert.equal(sent.bundle.events[0].text, kept.events[0].text);
  c.close();
});

// What a thrown message may carry besides a plain email and card number
test('redaction: emails in any script or with any dot, spaced or full-width card numbers, a bare query or link fragment, a long token', async () => {
  const { redact } = await import('./diagnostics.ts');
  const cases: [string, string][] = [
    ['Invalid email anna@пример.рф', 'Invalid email [email]'],
    ['Invalid email anna@example。com and anna@example．com.', 'Invalid email [email] and [email].'],
    ['card 4242  4242  4242  4242', 'card [number]'],
    ['card ４２４２４２４２４２４２４２４２', 'card [number]'],
    ['cannot read ?order=ORD-7Q4K-M2&t=s3cret-token', 'cannot read '],
    ['invalid link #poppy=eyJhIjoic2hvcCJ9.c2lnbmF0dXJl', 'invalid link '],
    ['bad token eyJhIjoic2hvcCIsImUiOiJhbm5hIn0.Zk3m9QpLr2sT8vWxYz', 'bad token [token]'],
    // what a developer needs stays
    ['Uncaught TypeError: x is undefined (order.js:3:9)', 'Uncaught TypeError: x is undefined (order.js:3:9)'],
    ['GET /api/orders/:id 404', 'GET /api/orders/:id 404'],
  ];
  for (const [input, want] of cases) assert.equal(redact(input), want, input);
});

test('kept until the bug is fixed and 90 days at most: HQ’s fixed list and the sweep delete the bug case, its one line and its bundle; deleting the conversation does too', async () => {
  const one = await offered(), two = await offered(), three = await offered();
  const [c1, c2, c3] = [one, two, three].map(x => x.c.conversation());
  const refs: string[] = [];
  for (const x of [one, two, three]) refs.push((await x.c.post('diagnostics', { widget: x.card.id, action: x.send, bundle: bundle() })).ref);
  // the one line on what went wrong is part of what the card says is sent, so it's kept no longer than the bundle
  const summary = (ref: string) => (db.prepare('select summary from cases where id = ?').get(Number(ref.slice(2)) - 1000) as any)?.summary;
  await new Promise(r => setTimeout(r, 200)); // the "Sent" line has gone out (it saves the conversation as it is in memory)
  // linked to an email, so the conversation itself is kept 12 months: what goes at 90 days is the bundle alone
  db.prepare("update conversations set email = 'gina@example.com' where id = ?").run(c2);
  fixedRefs = [refs[0]];
  await synced(() => diagnosticsOf(c1).length === 0);
  assert.equal(summary(refs[0]), undefined, 'fixed: the bug case goes, its one line with it');
  assert.equal(diagnosticsOf(c2).length, 1, 'not fixed: kept');
  assert.ok(summary(refs[1]), 'its one line too');
  assert.deepEqual(await three.c.post('delete'), { ok: true });
  assert.equal(diagnosticsOf(c3).length, 0, '"Delete this conversation" takes the bundle with it');
  assert.equal(db.prepare("select count(*) n from cases where id = ?").get(Number(refs[2].slice(2)) - 1000).n, 0, 'and care’s copy of its bug case');
  // the board deleted a case in HQ because the customer asked: care's copy goes too, its bundle with it
  erasedRefs = [refs[1]];
  await synced(() => !db.prepare('select 1 from cases where id = ?').get(Number(refs[1].slice(2)) - 1000));
  assert.equal(diagnosticsOf(c2).length, 0, 'erased: the bundle goes with its case');
  erasedRefs = [];
  const four = await offered(), c4 = four.c.conversation();
  const r4 = await four.c.post('diagnostics', { widget: four.card.id, action: four.send, bundle: bundle() });
  assert.equal(r4.ok, true);
  await new Promise(r => setTimeout(r, 200)); // as above: the "Sent" line has gone out, then the email so it's kept 12 months
  db.prepare("update conversations set email = 'gina@example.com' where id = ?").run(c4);
  sweep(Date.now() + 89 * 864e5);
  assert.equal(diagnosticsOf(c4).length, 1, 'kept at 89 days');
  assert.ok(summary(r4.ref), 'with its one line');
  sweep(Date.now() + 91 * 864e5);
  assert.equal(diagnosticsOf(c4).length, 0, 'gone after 90 days');
  assert.equal(summary(r4.ref), undefined, 'the bug case and its one line too, though cases are otherwise kept 12 months');
  assert.ok(db.prepare('select 1 from conversations where id = ?').get(c4), 'while the conversation stays');
  for (const x of [one, two, three, four]) x.c.close();
});

test('an erased reference is never reused: HQ keeps it 90 days, and the next bug filed must not be deleted by it', async () => {
  const one = await offered();
  const first = (await one.c.post('diagnostics', { widget: one.card.id, action: one.send, bundle: bundle() })).ref;
  erasedRefs = [first];
  await synced(() => !db.prepare('select 1 from cases where id = ?').get(Number(first.slice(2)) - 1000));
  const two = await offered(), c2 = two.c.conversation();
  const second = (await two.c.post('diagnostics', { widget: two.card.id, action: two.send, bundle: bundle() })).ref;
  assert.notEqual(second, first, 'a new reference, though the newest case was deleted');
  await synced(() => cards.some(x => x.case === second)); // HQ's state still lists the first: a sync or two later
  await hq.sync();
  assert.ok(db.prepare('select 1 from cases where id = ?').get(Number(second.slice(2)) - 1000), 'the new case stays');
  assert.equal(diagnosticsOf(c2).length, 1, 'and its bundle');
  erasedRefs = [];
  for (const x of [one, two]) x.c.close();
});

test('HQ’s fixed and erased lists are taken whole: references past the 500th are done too', async () => {
  const c = await offered(), conv = c.c.conversation();
  const file = (await import('./diagnostics.ts')).file;
  const mine = Array.from({ length: 4 }, () => file({ app: 'shop', conversation: conv, lang: 'en', problem: 'x', bundle: bundle() as any }));
  db.prepare('update cases set sent_hq = 1 where sent_hq is null').run(); // not this test's business: HQ has them
  const filler = Array.from({ length: 600 }, (_, i) => `H-${900000 + i}`); // references of cases long gone
  fixedRefs = [...filler, mine[0], mine[1]];
  erasedRefs = [...filler, mine[2]];
  await synced(() => !db.prepare('select 1 from cases where id = ?').get(Number(mine[2].slice(2)) - 1000));
  const bundles = (ref: string) => (db.prepare('select count(*) n from diagnostics where case_id = ?').get(Number(ref.slice(2)) - 1000) as any).n;
  assert.deepEqual(mine.map(bundles), [0, 0, 0, 1], 'fixed: the 601st and 602nd; erased: the 601st; the last one untouched');
  fixedRefs = []; erasedRefs = [];
  c.c.close();
});

test.after(() => { hqServer.close(); setTimeout(() => process.exit(0), 50); });
