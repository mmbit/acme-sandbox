// node --test src/engine.test.ts   (the real server on a local port with the template's plug-in, a throwaway DATA_DIR,
// the fake model, and a local server playing an app's order endpoint). The conversation as a customer meets it: one answer to a burst, holding while
// they type, the outage card, the way to a person, the caps, and the tools' guard on what the customer typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const TOKEN = 'engine-test-token';
const VIEW = { id: 'ORD-7Q4K-M2', ref: 'R-4829', placed_at: '2026-09-24T10:00:00Z', title: '“Mila” blanket', status: 'shipped',
  shipped_at: '2026-09-28T09:00:00Z', delivered_at: null, carrier: 'UPS', tracking_url: 'https://www.ups.com/x', country: 'GB',
  total_cents: 3995, address_masked: 'Test Street 1, Leeds' };
const ORDERS = [{ view: VIEW, email: 'anna@example.com' }, { view: { ...VIEW, id: 'ORD-BOB1-X2', ref: 'R-1111' }, email: 'bob@example.com' },
  { view: { ...VIEW, id: 'ORD-CLEO-X3', ref: 'R-3333' }, email: 'cleo@example.com' }, { view: { ...VIEW, id: 'ORD-DORA-X4', ref: 'R-5555' }, email: 'dora@example.com' },
  { view: { ...VIEW, id: 'ORD-EMIL-X5', ref: 'R-7777' }, email: 'emil@example.com' }, { view: { ...VIEW, id: 'ORD-FINN-X6', ref: 'R-9999' }, email: 'finn@example.com' },
  { view: { ...VIEW, id: 'ORD-MILO-Y6', ref: 'R-1299', address_masked: 'MILO Street 1, Leeds' }, email: 'mil@example.com' },
  ...['GINA', 'HUGO', 'IVY0', 'JONA', 'KAIA', 'LINA', 'MIRA', 'NOAH', 'OLGA', 'PIET', 'QUIN', 'RUBY', 'SVEN'].map((n, i) => ({ view: { ...VIEW, id: `ORD-${n}-Y${i}`, ref: `R-12${i}`, address_masked: `${n} Street 1, Leeds` }, email: `${n.slice(0, 3).toLowerCase()}@example.com` })),
  { view: { ...VIEW, id: 'ORD-NORA-Z1', ref: 'R-2468' }, email: 'nora@example.com' }, { view: { ...VIEW, id: 'ORD-TESS-Z2', ref: 'R-2470' }, email: 'tess@example.com' },
  // an order of a basket, with the number its customer was told for the basket
  { view: { ...VIEW, id: 'ORD-UMA0-Z3', ref: 'R-2472', number: '1234566' }, email: 'uma@example.com' }];
const asked: string[] = []; // the emails the order list was asked for
const shop = createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d).on('end', () => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
    const b = JSON.parse(body);
    const json = (o: object) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    const o = ORDERS.find(x => x.view.id === b.order?.toUpperCase() && x.email === b.email?.toLowerCase());
    if (req.url === '/api/care/match') return json(o ? { match: true, order: o.view } : { match: false });
    if (req.url === '/api/care/orders') asked.push(b.email);
    if (req.url === '/api/care/orders') return json({ orders: ORDERS.filter(x => x.email === b.email).map(x => x.view) });
    res.writeHead(404).end();
  });
});
await new Promise<void>(r => shop.listen(0, '127.0.0.1', r));

// HQ's side of the line (hq.ts): the cards care posts (each try, the ones it answers 503 too), and a quiet state
const cards: any[] = [];
let hqStatus = (card: any) => 200;
const hqServer = createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d).on('end', () => {
    if (req.headers.authorization !== 'Bearer hq-test-token') return void res.writeHead(401).end();
    const card = req.url === '/api/care/cards' ? JSON.parse(body) : null;
    if (card) cards.push(card);
    const status = card ? hqStatus(card) : 200;
    if (status !== 200) return void res.writeHead(status).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.url === '/api/care/cards' ? { ok: true, id: String(cards.length) } : { busy: 'auto', queue: { waiting: 0, oldest: null } }));
  });
});
await new Promise<void>(r => hqServer.listen(0, '127.0.0.1', r));

const PORT = 20000 + Math.floor(Math.random() * 20000);
Object.assign(process.env, { DATA_DIR: mkdtempSync(join(tmpdir(), 'care-engine-')), PORT: String(PORT), CARE_LOCAL: '1', CARE_PROVIDER: 'fake',
  CARE_APPS: JSON.stringify({ shop: `http://127.0.0.1:${(shop.address() as any).port}` }), CARE_TOKENS: JSON.stringify({ shop: TOKEN }),
  CARE_NAMES: JSON.stringify({ shop: 'Shop' }), CARE_CAP_CONVERSATION: '0.05', CARE_RETRY_MS: '300', CARE_SILENT_MS: '10000', CARE_MAIL_RETRY_MS: '500', CARE_HELPED_MS: '300',
  CARE_HQ_URL: `http://127.0.0.1:${(hqServer.address() as any).port}`, CARE_HQ_TOKEN: 'hq-test-token',
  CARE_COMPANY_DIR: new URL('../../../template/products/care', import.meta.url).pathname });
const fake = await import('./fake.ts');
const { db, now } = await import('./db.ts');
const numbers = await import('./numbers.ts');
const ledger = await import('./ledger.ts');
const email = await import('./email.ts');
const engine = await import('./engine.ts');
const hq = await import('./hq.ts');
const phonecall = await import('./phonecall.ts');
await import('./server.ts');
const { t } = await import('./texts.ts'); // the template's words (its plug-in, loaded by the server)
const { TURN_ROUNDS } = await import('./model.ts');
const { settings } = await import('./company.ts');
// a test with a setting the template's plug-in leaves at the engine's default
async function withSetting<K extends keyof typeof settings>(key: K, value: (typeof settings)[K], f: () => Promise<void>) {
  const was = settings[key];
  settings[key] = value;
  try { await f(); } finally { settings[key] = was; }
}
await new Promise(r => setTimeout(r, 100));

// ---- a customer: a cookie jar, the stream as a list of messages, and the widget's POSTs
const BASE = `http://127.0.0.1:${PORT}`;
async function customer(start = '', { renews = true, lang = 'en' } = {}) {
  let cookie = start;
  const events: any[] = [];
  const ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`; // each customer their own address, like Caddy says
  const tab = crypto.randomUUID(); // the page's own id, like the widget's
  const headers = () => ({ 'x-care-app': 'shop', origin: BASE, 'content-type': 'application/json', 'x-forwarded-for': ip, 'x-care-tab': tab, ...(cookie ? { cookie } : {}) });
  let renewing: Promise<unknown> = Promise.resolve(); // a person types slower than a renew: the next POST waits for it
  const post = async (path: string, body: any = {}) => {
    if (path !== 'renew') await renewing;
    const r = await fetch(`${BASE}/__care/api/${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    const set = r.headers.getSetCookie().filter(c => c.startsWith('__Host-care=')).at(-1); // the browser keeps the last one
    if (set) cookie = set.split(';')[0];
    return r.json() as any;
  };
  const hello = await post('hello', { lang });
  const ctl = new AbortController(), shown = new Set<string>();
  const push = (m: any) => { if (m.t === 'reply') { if (shown.has(m.id)) return; shown.add(m.id); } events.push(m); if (m.t === 'renew' && renews) renewing = post('renew'); }; // like the widget
  const read = async (r: Response) => {
    const dec = new TextDecoder(); let buf = '';
    try { for await (const chunk of r.body as any) { buf += dec.decode(chunk); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); if (ev.startsWith('data: ')) push(JSON.parse(ev.slice(6))); } } } catch { /* closed */ }
  };
  const open = () => fetch(`${BASE}/__care/api/stream`, { headers: headers(), signal: ctl.signal });
  const first = await open();
  // like the widget's EventSource: when the server ends the stream (the session got a new id), it reconnects with the
  // cookie it has now, and a hello brings back what was said in between
  (async () => {
    await read(first);
    while (!ctl.signal.aborted) {
      await new Promise(r => setTimeout(r, 50));
      try {
        const r = await open();
        for (const it of (await post('hello', { lang })).items ?? []) if (it.k === 'ai') push({ t: 'reply', id: it.id, text: it.text, ...(it.w ? { widget: it.w } : {}) });
        await read(r);
      } catch { /* closed */ }
    }
  })();
  const replies = () => events.filter(e => e.t === 'reply');
  const until = async (f: () => any, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const x = f(); if (x) return x; await new Promise(r => setTimeout(r, 20)); } throw new Error('timed out waiting'); };
  let n = 0;
  const say = (text: string, answer?: any) => post('say', { id: `c${++n}`, text, answer });
  return { hello, events, replies, until, say, post, close: () => ctl.abort(), cookie: () => cookie };
}
const seen: any[] = []; // what the fake model saw on each call
test.beforeEach(() => ledger.breaker.ok()); // an outage test leaves the breaker down for the next one
const raw = (m: any) => (typeof m.content === 'string' ? m.content : m.content.map((b: any) => b.text ?? '').join(''));
const words = (m: any) => raw(m).replace(/\[#\d+\] /g, ''); // what the customer wrote, without the numbers history() gives each message

test('the greeting says it is an AI before the customer types anything', async () => {
  const c = await customer();
  assert.equal(c.hello.items[0].text, t('hi', 'en', { app: 'Shop' }));
  assert.equal(c.hello.items.at(-1).w.options.length, 3, 'with the three starting chips');
  c.close();
});

test("the chat follows the page's language: a greeting alone is said again in it, what was said stays", async () => {
  await withSetting('langs', ['en', 'nl', 'de'], () => withSetting('texts', { ...settings.texts, nl: { hi: 'Hoi, ik ben {helper}.' }, de: { hi: 'Hallo, ich bin {helper}.' } }, async () => {
    const c = await customer('', { lang: 'nl' });
    assert.equal(c.hello.lang, 'nl');
    assert.equal(c.hello.items[0].text, t('hi', 'nl'));
    const de = await c.post('hello', { lang: 'de' }); // the shop switched to German: nothing said yet, so greeted again in it
    assert.equal(de.lang, 'de');
    assert.deepEqual(de.items.filter((it: any) => it.k === 'ai').map((it: any) => it.text).slice(0, 2), [t('hi', 'de'), t('can', 'de')]);
    assert.equal(de.items.filter((it: any) => it.text === t('hi', 'de')).length, 1, 'one greeting, not two');
    fake.script(() => [{ text: 'Sie ist unterwegs.' }]);
    await c.say('wo ist mein Paket?');
    await c.until(() => c.replies().find(r => r.text === 'Sie ist unterwegs.'));
    const nl = await c.post('hello', { lang: 'nl' }); // and back: the conversation keeps what was said, in Dutch from now on
    assert.equal(nl.lang, 'nl');
    assert.deepEqual(nl.items.map((it: any) => it.text).slice(0, 1), [t('hi', 'de')]);
    assert.ok(nl.items.some((it: any) => it.text === 'wo ist mein Paket?'));
    c.close();
  }));
});

test('what the model writes is marked AI-generated in the stream and in hello’s items; the greeting and the outage card aren’t', async () => {
  fake.script(() => [{ text: 'Your parcel is on its way.' }]);
  const c = await customer();
  await c.say('where is my parcel?');
  const reply = await c.until(() => c.replies().find(r => r.text === 'Your parcel is on its way.'));
  assert.equal(reply.aiGenerated, true);
  fake.script(() => [{ fail: 529 }]);
  await c.say('and my other one?');
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'outage'), 8000);
  assert.equal(card.aiGenerated, undefined);
  const { items } = await c.post('hello', { lang: 'en' });
  const marks = items.filter((it: any) => it.k === 'ai').map((it: any) => [it.text, !!it.aiGenerated]);
  assert.deepEqual(marks, [[t('hi', 'en', { app: 'Shop' }), false], [t('can', 'en'), false], [t('what', 'en'), false],
    ['Your parcel is on its way.', true], [card.text, false]]);
  c.close();
});

test("care's own preview host: a status page with review mode's tag, under a policy that lets it load", async () => {
  const get = async () => { const r = await fetch(`${BASE}/`); return { r, html: await r.text() }; };
  const model = (html: string) => html.match(/<li class="(\w+)">(?:(?!<li).)*<b>Model<\/b>/s)?.[1];
  let { r, html } = await get();
  assert.match(r.headers.get('content-type')!, /^text\/html/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy')!, /script-src 'self';.*connect-src 'self'/);
  assert.ok(html.includes('/__review/review.js'), "review mode's script is on the page");
  assert.doesNotMatch(html, /\$\{/, 'no template left unfilled');
  assert.equal(model(html), 'ok');
  ledger.breaker.failed(); ledger.breaker.failed();
  ({ html } = await get());
  assert.equal(model(html), 'warn', 'the page shows the breaker down');
  assert.equal((await (await fetch(`${BASE}/health`)).json()).ok, true, '/health stays JSON');
});

test('a button from another conversation of the same device runs nothing here', async () => {
  const c = await customer(), d = await customer();
  const chip = c.hello.items.at(-1).w, other = d.hello.items.at(-1).w.options[0].action;
  const theirs = (db.prepare('select conversation from actions where id = ?').get(other) as any).conversation;
  // the device's own button, as if it had been proposed in a conversation it has since left
  db.prepare('update actions set conversation = ? where id = ?').run(theirs, chip.options[0].action);
  const before = (db.prepare("select count(*) as n from messages where who = 'me'").get() as any).n;
  const r = await c.say('', { widget: chip.id, action: chip.options[0].action });
  assert.deepEqual(r, { ok: true, resync: true, text: t('expired', 'en') }, 'the rejection goes back on this tap’s own response, not a broadcast');
  assert.equal((db.prepare("select count(*) as n from messages where who = 'me'").get() as any).n, before, 'no echo stored, nothing answered');
  c.close(); d.close();
});

test('two tabs that each open a brand-new chat at once: the browser’s cookie jar keeps only one, but the tapping tab still hears back', async () => {
  const ip = `10.2.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const post = async (tab: string, path: string, body: any, cookie: string) => {
    const r = await fetch(`${BASE}/__care/api/${path}`, { method: 'POST', headers: { 'x-care-app': 'shop', origin: BASE, 'content-type': 'application/json', 'x-forwarded-for': ip, 'x-care-tab': tab, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const set = r.headers.getSetCookie().filter(c => c.startsWith('__Host-care=')).at(-1);
    return { json: await r.json(), cookie: set ? set.split(';')[0] : '' };
  };
  const tabA = crypto.randomUUID(), tabB = crypto.randomUUID();
  // both cookie-free, like two tabs opening a chat for the first time together: two conversations, two cookies
  const [a, b] = await Promise.all([post(tabA, 'hello', { lang: 'en' }, ''), post(tabB, 'hello', { lang: 'en' }, '')]);
  const chipA = a.json.items.at(-1).w;
  // the jar keeps whichever Set-Cookie the browser saw last: here, tab B's, even though A is the one about to tap
  const r = await post(tabA, 'say', { id: 'race1', text: '', answer: { widget: chipA.id, action: chipA.options[0].action } }, b.cookie);
  assert.equal(r.json.resync, true, 'tab A’s tap ran on tab B’s conversation, so it’s told, not left to look like nothing happened');
  assert.equal(r.json.text, t('expired', 'en'));
});

test('a burst of three quick messages gets one answer that saw all three', async () => {
  seen.length = 0;
  fake.script(o => { seen.push(o.messages); return [{ wait: 200 }, { text: 'Got all of that.' }]; });
  const c = await customer();
  await c.say('hi'); await c.say('my parcel hasn’t come'); await c.say('it’s the Mila blanket');
  await c.until(() => c.replies().some(r => r.text === 'Got all of that.'));
  await new Promise(r => setTimeout(r, 400));
  assert.equal(c.replies().filter(r => r.text === 'Got all of that.').length, 1);
  assert.match(words(seen.at(-1).at(-1)), /hi[\s\S]*parcel[\s\S]*Mila/);
  c.close();
});

test('a reply waits while the customer types, and a follow-up discards the draft for one answer to both', async () => {
  let calls = 0;
  fake.script(o => { calls++; const last = words(o.messages.at(-1)); return [{ wait: 300 }, { text: `Answer to: ${last.replace(/\s+/g, ' ')}` }]; });
  const c = await customer();
  await c.say('first');
  await new Promise(r => setTimeout(r, 200)); // the draft has started
  await c.post('typing', { on: true });
  await new Promise(r => setTimeout(r, 600)); // the draft is ready by now, but held
  assert.equal(c.replies().filter(r => r.text.startsWith('Answer to')).length, 0, 'nothing shown while they type');
  await c.say('second'); // the follow-up: the held draft goes, a new one answers both
  const r = await c.until(() => c.replies().find(x => x.text.startsWith('Answer to')));
  assert.match(r.text, /first second/);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(c.replies().filter(x => x.text.startsWith('Answer to')).length, 1);
  assert.ok(calls >= 2);
  c.close();
});

// The API's first token can take longer than 8 s on a cold cache: slow isn't down.
test('first words after 9 s: typing, then the answer, one call, no outage card and the breaker up', async () => {
  let calls = 0;
  fake.script(() => { calls++; return [{ wait: 9000 }, { text: 'Here it is, just slower.' }]; });
  const c = await customer();
  await c.say('where is my order?');
  await c.until(() => c.replies().find(r => r.text === 'Here it is, just slower.'), 15_000);
  assert.ok(c.events.some(e => e.t === 'typing' && e.on), 'typing shows while it waits');
  assert.ok(!c.replies().some(r => r.widget?.type === 'outage'), 'no outage card');
  assert.ok(!c.events.some(e => e.t === 'status' && e.online === false), 'never offline');
  assert.equal(calls, 1, 'the call ran to its answer: no retry');
  assert.equal(ledger.breaker.state(), 'up');
  c.close();
});

test('no first words at all (CARE_SILENT_MS): the outage card without a second wait, and the answer once it’s back', async () => {
  let calls = 0;
  fake.script(() => ++calls === 1 ? [{ until: new Promise(() => {}) }] : [{ text: 'Back with your answer.' }]);
  const c = await customer();
  await c.say('where is my order?');
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'outage'), 15_000);
  assert.match(card.text, /isn’t responding/);
  assert.equal(calls, 1, 'no retry after a silent call');
  await c.until(() => c.replies().find(r => r.text === 'Back with your answer.'), 5000);
  c.close();
});

test('with the model down: one retry, then the outage card, and Email a person works from templates', async () => {
  fake.script(() => [{ fail: 529 }]);
  const c = await customer();
  await c.say('where is my order?');
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'outage'), 8000);
  assert.match(card.text, /can’t answer right now. The AI service it runs on isn’t responding/);
  assert.ok(c.events.some(e => e.t === 'status' && e.online === false));
  const person = card.widget.options.find((o: any) => o.label === 'Email a person');
  await c.say('', { widget: card.widget.id, action: person.action });
  await c.until(() => c.replies().find(r => /What email should they reply to\?/.test(r.text)));
  await c.say('anna@example.com');
  const sum = await c.until(() => c.replies().find(r => r.widget?.type === 'summary'));
  assert.deepEqual(sum.widget.options.map((o: any) => o.label), ['Email it to a person', 'Not now']);
  await c.say('', { widget: sum.widget.id, action: sum.widget.options[0].action, note: 'My parcel never came.' });
  const sent = await c.until(() => c.replies().find(r => r.text.startsWith('Sent.')));
  assert.equal(sent.text, t('sent', 'en', { to: 'a•••@example.com', ref: /H-\d+/.exec(sent.text)![0] }));
  const row = db.prepare('select * from cases order by id desc limit 1').get() as any;
  assert.equal(row.email, 'anna@example.com'); assert.equal(row.checked, 'none'); assert.equal(row.words, 'My parcel never came.');
  c.close();
});

test('with chatFirst and the model down: the outage card offers no person while what they write waits, and the ⋯ menu’s Email a person goes straight to the email card', () => withSetting('chatFirst', true, async () => {
  fake.script(() => [{ fail: 529 }]);
  const c = await customer();
  await c.say('where is my order?');
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'outage'), 8000);
  assert.match(card.text, /can’t answer right now. The AI service it runs on isn’t responding/);
  assert.deepEqual(card.widget.options, [], 'what they write waits for the helper: no person pushed');
  assert.ok(c.events.some(e => e.t === 'status' && e.online === false));
  await c.say('Email a person', { menu: 'person' });
  await c.until(() => c.replies().find(r => /What email should they reply to\?/.test(r.text)));
  assert.ok(!c.replies().some(r => r.widget?.options?.some((o: any) => o.label === 'Let’s try here')), 'no case for a helper that’s down');
  await c.say('anna@example.com');
  const sum = await c.until(() => c.replies().find(r => r.widget?.type === 'summary'));
  assert.deepEqual(sum.widget.options.map((o: any) => o.label), ['Email it to a person', 'Not now']);
  await c.say('', { widget: sum.widget.id, action: sum.widget.options[0].action, note: 'My parcel never came.' });
  const sent = await c.until(() => c.replies().find(r => r.text.startsWith('Sent.')));
  assert.equal(sent.text, t('sent', 'en', { to: 'a•••@example.com', ref: /H-\d+/.exec(sent.text)![0] }));
  const row = db.prepare('select * from cases order by id desc limit 1').get() as any;
  assert.equal(row.email, 'anna@example.com'); assert.equal(row.checked, 'none'); assert.equal(row.words, 'My parcel never came.');
  c.close();
}));

test('a stop never comes back: the header says so, not "paused", nothing is marked waiting, and Email a person promises no return', async () => {
  fake.script(() => [{ fail: 400 }]); // a request the provider refuses: no outage, this conversation stops
  const c = await customer();
  await c.say('where is my order?');
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'outage'), 8000);
  assert.equal(card.widget.cause, 'stop');
  assert.ok(c.events.some(e => e.t === 'status' && e.online === false && e.cause === 'stop'));
  await c.say('hello? is anyone there');
  const again = await c.post('hello', { lang: 'en' });
  assert.equal(again.cause, 'stop');
  assert.ok(!again.items.some((it: any) => it.waiting), 'nor after a reload');
  const person = card.widget.options.find((o: any) => o.label === 'Email a person');
  await c.say('', { widget: card.widget.id, action: person.action });
  await c.until(() => c.replies().find(r => /What email should they reply to\?/.test(r.text)));
  // a wait for the message above would have come down the stream before this reply
  assert.ok(!c.events.some(e => e.t === 'wait' && e.on), 'no message is marked waiting');
  await c.say('anna@example.com');
  const sum = await c.until(() => c.replies().find(r => r.widget?.type === 'summary'));
  await c.say('', { widget: sum.widget.id, action: sum.widget.options[0].action, note: 'My parcel never came.' });
  await c.until(() => c.replies().find(r => r.text.startsWith('Sent.')));
  const more = await c.until(() => c.replies().find(r => r.text === t('sent_more', 'en')));
  assert.ok(more, 'the helper isn’t coming back: what they add goes with the email');
  assert.ok(!c.replies().some(r => r.text === t('sent_more_down', 'en', { helper: 'Shop’s AI helper' }) || /when it’s back/.test(r.text)));
  const row = db.prepare('select words from cases order by id desc limit 1').get() as any;
  assert.match(row.words, /My parcel never came\.[\s\S]*hello\? is anyone there/, 'what they wrote after the stop goes with it');
  c.close();
});

test('back after an outage: "I’m back" and one answer, kept in the chat for a customer who left (no address asked for)', async () => {
  fake.script(() => [{ fail: 529 }]);
  const c = await customer();
  await c.say('is my parcel coming?');
  await c.until(() => c.replies().find(r => r.widget?.type === 'outage'), 8000);
  await c.say('also, do you ship to Belgium?');
  c.close(); // they leave
  await new Promise(r => setTimeout(r, 100));
  fake.script(() => [{ text: 'Yes, we ship to Belgium.' }]);
  ledger.breaker.ok();
  await c.until(() => db.prepare("select 1 from messages where who = 'ai' and text = 'Yes, we ship to Belgium.'").get(), 4000);
  const back = await c.post('hello', { lang: 'en' }); // they come back: the answer is there
  assert.deepEqual(back.items.filter((it: any) => it.k === 'ai').map((it: any) => it.text).slice(-2), [t('back', 'en'), 'Yes, we ship to Belgium.']);
  assert.ok(!back.items.some((it: any) => it.waiting), 'nothing is marked waiting any more');
  assert.equal(email.outbox.filter(m => m.kind === 'answer').length, 0, 'nothing goes by email');
});

// Newer models refuse a request whose last turn is the assistant's (a prefill) with a 400, which would take the
// conversation down: every request ends on the customer's turn, and a template line after it goes into the facts
test('a request always ends on the customer’s turn: after the outage card, and after the code box’s “that’s you”', async () => {
  const asks: { messages: any[]; system: string; cached?: string }[] = [];
  fake.script(() => [{ fail: 529 }]);
  const c = await customer();
  await c.say('is my blanket on its way?');
  await c.until(() => c.replies().find(r => r.widget?.type === 'outage'), 8000);
  fake.script(o => { asks.push(o); return [{ text: 'Let me look.' }]; });
  ledger.breaker.ok(); // the service is back: the retry answers what was waiting
  await c.until(() => c.replies().find(r => r.text === 'Let me look.'), 4000);
  assert.equal(asks.at(-1)!.messages.at(-1).role, 'user');
  assert.match(words(asks.at(-1)!.messages.at(-1)), /is my blanket on its way\?$/);
  assert.match(asks.at(-1)!.system, /The server: .*can’t answer right now/s, 'the outage card is in the facts');
  // (and the engine's own rule after the company's instructions)
  assert.match(asks.at(-1)!.cached ?? '', /never ask for it again and never send them to look for it/);
  c.close();

  const d = await checked('', 'ORD-MILO-Y6', 'mil@example.com'); // the code box: its "Thanks, that’s you." comes after the customer's turn
  fake.script(o => { asks.push(o); return [{ text: 'Here are your orders.' }]; });
  await d.until(() => d.replies().find(r => r.text === 'Here are your orders.'), 4000);
  const last = asks.at(-1)!;
  assert.equal(last.messages.at(-1).role, 'user');
  assert.match(words(last.messages.at(-1)), /^\[typed the 6-digit code from their inbox into the code box/, 'the model is told what the dots were');
  assert.match(last.system, /The server: Thanks, that’s you\./);
  d.close();
});

test('the tool log (a local run or a preview app): each call with its level, the input cut to what the eval checks, how it came out', () => withSetting('chatFirst', true, async () => {
  fake.script(o => Array.isArray(o.messages.at(-1).content) ? [{ text: 'Checked.' }]
    : [{ tool: 'check_order', input: { order: 'ORD-LINA-Y5', email: 'lin@example.com' } }, { tool: 'ask_for_person', input: { reason: 'asked', note: 'Lina, Lina Street 1' } },
      { tool: 'send_code', input: {} }, { tool: 'my_orders', input: { show: true } }]);
  await new Promise(r => setTimeout(r, 1600)); // past the gap after the last draft
  const c = await customer();
  await c.say('ORD-LINA-Y5, lin@example.com, and can I talk to someone?');
  await c.until(() => c.replies().find(r => r.widget?.type === 'code_entry'));
  const { calls } = await c.post('tools');
  assert.deepEqual(calls.map((x: any) => [x.name, x.input, x.level, x.result]), [
    ['check_order', { order: 'ORD-LINA-Y5', email: 'lin@example.com' }, 0, { match: true }],
    ['ask_for_person', { reason: 'asked' }, 0, { make_your_case: true }], // the note (customer's words) isn't kept
    ['send_code', {}, 0, { sent: true }], // the level as the call streamed in: one batch, all before the check ran
    ['my_orders', { show: true }, 0, 'not run'], // send_code ended the answer
  ]);
  const other = await customer();
  assert.deepEqual((await other.post('tools')).calls, [], 'another conversation reads only its own');
  c.close(); other.close();
}));

// A restart, as far as one conversation goes: the process forgets it (engine.forget drops its Live, timers and all);
// the database keeps everything
const restart = (text: string) => engine.forget((db.prepare('select conversation from messages where text = ?').get(text) as any).conversation);

test('a message a restart cut off mid-answer is answered when the customer comes back', async () => {
  fake.script(() => [{ wait: 3000 }, { text: 'Too late.' }]);
  const c = await customer();
  await c.say('what sizes are there?');
  await new Promise(r => setTimeout(r, 500)); // the draft is running
  restart('what sizes are there?');
  fake.script(() => [{ text: 'Small and large.' }]);
  const back = await customer(c.cookie()); // the page again
  await back.until(() => db.prepare("select 1 from messages where text = 'Small and large.'").get());
  assert.ok(!db.prepare("select 1 from messages where text = 'Too late.'").get());
  c.close(); back.close();
});

test('a tap carries only an id: a second tap, or another customer’s id, does nothing', async () => {
  fake.script(() => [{ fail: 529 }]);
  const a = await customer(), b = await customer();
  await a.say('hello?');
  const card = await a.until(() => a.replies().find(r => r.widget?.type === 'outage'), 8000);
  const id = card.widget.options.find((o: any) => o.label === 'Email a person').action;
  assert.ok((await b.say('', { widget: card.widget.id, action: id })).resync, 'rejected, on its own response');
  assert.ok(!b.replies().some(r => /A person answers by email/.test(r.text)), 'not in another session');
  await a.say('', { widget: card.widget.id, action: id });
  await a.until(() => a.replies().find(r => /A person answers by email/.test(r.text)));
  assert.ok((await a.say('', { widget: card.widget.id, action: id })).resync, 'spent, so a second tap is rejected too');
  a.close(); b.close();
});

test('asking for a person with chatFirst: one case for trying here, counted by the server, then the email card at once', () => withSetting('chatFirst', true, async () => {
  const results: string[] = [];
  fake.script(o => {
    const last = words(o.messages.at(-1));
    if (Array.isArray(o.messages.at(-1).content)) { results.push(o.messages.at(-1).content[0].content); return [{ text: 'I’m an AI, not a person. Shall we try here first?' }]; }
    return /human/.test(last) ? [{ tool: 'ask_for_person', input: { reason: 'asked', note: 'I want a person.' } }] : [{ text: 'OK.' }];
  });
  const c = await customer();
  await c.say('can I talk to a human?');
  const pitch = await c.until(() => c.replies().find(r => r.widget?.options?.some((o: any) => o.label === 'Let’s try here')));
  assert.match(JSON.parse(results[0]).how, /reply within 2 working days/, 'the plug-in’s aim (the template’s: 2), not a placeholder');
  assert.deepEqual(pitch.widget.options.map((o: any) => o.label), ['Let’s try here', 'Email a person'], 'the labels come from the server');
  await c.say('a human please');  // the model says "asked" again: the server doesn't make a second case
  await c.until(() => c.replies().find(r => /Of course\. A person answers by email/.test(r.text)));
  c.close();
}));

test('asking for a person without chatFirst (the engine’s default): the email card at the first ask, no case for trying here', async () => {
  assert.equal(settings.chatFirst, false, 'the template’s plug-in leaves it off');
  const results: string[] = [];
  fake.script(o => {
    if (Array.isArray(o.messages.at(-1).content)) { results.push(o.messages.at(-1).content[0].content); return [{ text: 'OK.' }]; }
    return /human/.test(words(o.messages.at(-1))) ? [{ tool: 'ask_for_person', input: { reason: 'asked', note: 'I want a person.' } }] : [{ text: 'OK.' }];
  });
  const c = await customer();
  await c.say('can I talk to a human?');
  await c.until(() => c.replies().find(r => /Of course\. A person answers by email/.test(r.text)));
  assert.deepEqual(results, [], 'the card ends the answer: no pitch for the model to write');
  assert.equal(c.replies().some(r => r.widget?.options?.some((o: any) => o.label === 'Let’s try here')), false, 'no "Let’s try here"');
  c.close();
});

test('with chatFirst, a complaint’s first ask gets the one case too (the default caseFor), an insist the email card at once', () => withSetting('chatFirst', true, async () => {
  const tools: any[] = [];
  fake.script(o => {
    tools.push(o.tools.find((x: any) => x.name === 'ask_for_person'));
    const m = o.messages.at(-1)!;
    if (Array.isArray(m.content)) return [{ text: 'I can look into it with you right here. Shall we try?' }];
    const last = words(m);
    return /complain/.test(last) ? [{ tool: 'ask_for_person', input: { reason: 'complaint', note: 'I want to complain.' } }]
      : /insist/.test(last) ? [{ tool: 'ask_for_person', input: { reason: 'insisted', note: 'I want a person.' } }] : [{ text: 'OK.' }];
  });
  const c = await customer();
  await c.say('I want to complain');
  await c.until(() => c.replies().find(r => r.widget?.options?.some((o: any) => o.label === 'Let’s try here')));
  assert.ok(!c.replies().some(r => /What email should they reply to\?/.test(r.text)), 'no email card at a first ask, whatever it’s about');
  c.close();
  const d = await customer();
  await d.say('I insist on a person');
  await d.until(() => d.replies().find(r => /Of course\. A person answers by email/.test(r.text)));
  assert.equal(d.replies().some(r => r.widget?.options?.some((o: any) => o.label === 'Let’s try here')), false, 'an insist gets no case');
  d.close();
  assert.ok(tools[0].input_schema.properties.reason.enum.includes('complaint'), 'a complaint asked for in words is an ask too, with its reason');
}));

test('with chatFirst and caseFor only a plain ask: a complaint and the ⋯ menu get the email card at once, a plain ask still the case', () => withSetting('chatFirst', true, () => withSetting('caseFor', ['asked'], async () => {
  fake.script(o => {
    const m = o.messages.at(-1)!;
    if (Array.isArray(m.content)) return [{ text: 'I can look into it with you right here. Shall we try?' }];
    const last = words(m);
    return /complain/.test(last) ? [{ tool: 'ask_for_person', input: { reason: 'complaint', note: 'I want to complain.' } }]
      : /human/.test(last) ? [{ tool: 'ask_for_person', input: { reason: 'asked', note: 'I want a person.' } }] : [{ text: 'OK.' }];
  });
  const c = await customer();
  await c.say('I want to complain');
  await c.until(() => c.replies().find(r => /Of course\. A person answers by email/.test(r.text)));
  assert.equal(c.replies().some(r => r.widget?.options?.some((o: any) => o.label === 'Let’s try here')), false, 'no case for a complaint');
  c.close();
  const m = await customer();
  await m.say('Email a person', { menu: 'person' });
  await m.until(() => m.replies().find(r => /Of course\. A person answers by email/.test(r.text)));
  assert.equal(m.replies().some(r => r.widget?.options?.some((o: any) => o.label === 'Let’s try here')), false, 'no case from the menu');
  m.close();
  const d = await customer();
  await d.say('can I talk to a human?');
  await d.until(() => d.replies().find(r => r.widget?.options?.some((o: any) => o.label === 'Let’s try here')));
  d.close();
})));

test('with chatFirst, the ⋯ menu’s “Email a person”: the chat says first that it can probably help here, in the app’s own words, and its button goes on to the email card', () => withSetting('chatFirst', true, () => withSetting('appWords', { shop: { en: { person_case: 'Shop’s own case for trying here.' } } }, async () => {
  fake.script(() => [{ text: 'OK.' }]);
  const c = await customer();
  await c.say('Email a person', { menu: 'person' });
  const pitch = await c.until(() => c.replies().find(r => r.text === 'Shop’s own case for trying here.'));
  assert.deepEqual(pitch.widget.options.map((o: any) => o.label), ['Let’s try here', 'Email a person']);
  assert.ok(!c.replies().some(r => /What email should they reply to\?/.test(r.text)), 'no email card yet');
  await c.say('', { widget: pitch.widget.id, action: pitch.widget.options[1].action });
  await c.until(() => c.replies().find(r => /What email should they reply to\?/.test(r.text)));
  const other = await customer();
  await other.say('Email a person', { menu: 'person' });
  const theirs = await other.until(() => other.replies().find(r => r.text === 'Shop’s own case for trying here.'));
  await other.say('', { widget: theirs.widget.id, action: theirs.widget.options[0].action });
  await other.until(() => other.replies().find(r => r.text === 'OK.')); // "Let’s try here" is a message the helper answers
  await other.say('Email a person', { menu: 'person' });
  await other.until(() => other.replies().find(r => /What email should they reply to\?/.test(r.text)));
  c.close(); other.close();
  fake.script(o => /yes, ask the team/.test(words(o.messages.at(-1)))
    ? [{ tool: 'ask_team', input: { question: 'Can the team confirm this?' } }] : [{ text: 'OK.' }]);
  for (const tryHere of [true, false]) {
    const pending = await customer();
    try {
      await pending.say('yes, ask the team');
      await pending.until(() => pending.replies().find(r => r.text === t('team_address', 'en')));
      await pending.say('Email a person', { menu: 'person' });
      const choice = await pending.until(() => pending.replies().find(r => r.text === 'Shop’s own case for trying here.'));
      assert.ok(!pending.replies().some(r => /What email should they reply to\?/.test(r.text)), 'a team question is not a prior personal handover');
      await pending.say('', { widget: choice.widget.id, action: choice.widget.options[tryHere ? 0 : 1].action });
      if (tryHere) {
        await pending.until(() => pending.replies().find(r => r.text === 'OK.'));
        await pending.say('reader@example.com');
        await pending.until(() => pending.replies().find(r => /I’ve asked the team/.test(r.text)));
        assert.ok(!pending.replies().some(r => r.widget?.kind === 'handover'), 'continuing here preserves the team question');
      } else {
        await pending.until(() => pending.replies().find(r => /What email should they reply to\?/.test(r.text)));
      }
    } finally { pending.close(); }
  }
})));

test('an app’s own words open its chat: it says it’s an AI and what this chat can do, over the company’s and the engine’s', () => withSetting('appWords', { shop: { en: { can: 'I can find your order and sort out a refund, at any hour.' } } }, async () => {
  const c = await customer();
  const said = c.hello.items.map((i: any) => i.text);
  assert.equal(said[0], t('hi', 'en', { app: 'Shop' }), 'the company’s first line, where the app has none');
  assert.equal(said[1], 'I can find your order and sort out a refund, at any hour.');
  assert.ok(!said.some((x: string) => /person|email/i.test(x)), 'no person and no email in the greeting');
  c.close();
}));

test('the order tool only takes an order number and email the customer typed', async () => {
  const results: string[] = [];
  fake.script(o => {
    const last = o.messages.at(-1);
    if (Array.isArray(last.content)) { results.push(last.content[0].content); return [{ text: 'Checked.' }]; }
    return [{ tool: 'check_order', input: { order: 'ORD-7Q4K-M2', email: 'anna@example.com' } }];
  });
  const c = await customer();
  await c.say('where is my blanket?'); // neither typed: the tool refuses, whatever the model tries
  await c.until(() => results.length === 1);
  assert.match(results[0], /"match":false/);
  await c.say('ORD-7Q4K-M2 and anna@example.com');
  await c.until(() => results.length === 2);
  const r = JSON.parse(results[1]);
  assert.equal(r.match, true);
  assert.equal('total_cents' in r.order, false, 'level 1: no price');
  assert.equal('address_masked' in r.order, false, 'level 1: no address');
  assert.equal('delivery' in r, false, 'no delivery rule in the plug-in: no state beside the order');
  c.close();
});

test('past the conversation’s cap for the day: no model call, the card says until when and leads with the person, and the next day it answers', async () => {
  let calls = 0;
  // ~20,000 tokens out: past the cap (€0.05 here), in few words, since the fake streams one a turn of the event loop
  fake.script(() => { calls++; return [{ text: `${'x'.repeat(400)} `.repeat(200) }]; });
  const c = await customer();
  await c.say('one');
  await c.until(() => c.replies().some(r => r.text.startsWith('x')), 8000);
  await new Promise(r => setTimeout(r, 300));
  const before = calls;
  await c.say('two, past the cap');
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'outage'), 8000);
  assert.equal(calls, before, 'no model call past the cap');
  assert.match(card.text, /can’t answer any more today, only again from tomorrow\. A person can/);
  assert.deepEqual(card.widget.options.map((o: any) => o.label), ['Email a person']);
  // the next day (the company's): what this conversation spent was yesterday's, and its stop is over
  const conv = (db.prepare("select conversation from messages where text = 'two, past the cap'").get() as any).conversation;
  const spent = (db.prepare('select id from ledger where conversation = ?').all(conv) as any[]).map(r => r.id);
  const shift = (ms: number) => { for (const id of spent) db.prepare('update ledger set at = at + ? where id = ?').run(ms, id); };
  shift(-864e5);
  const live = engine.live(conv)!;
  assert.equal(live.conv.state.until, ledger.dayEnd(), 'stopped until midnight');
  live.conv.state.until = Date.now() - 1;
  assert.equal((await c.post('hello', { lang: 'en' })).online, true, 'back on a reload');
  const shown = c.replies().length;
  fake.script(() => { calls++; return [{ text: 'x, and good morning.' }]; }); // short: a long stream would outlive the test
  await c.say('three, the next day');
  await c.until(() => c.replies().slice(shown).some(r => r.text.startsWith('x')), 8000);
  assert.equal(calls, before + 1, 'answered by the model');
  assert.ok(c.events.some(e => e.t === 'status' && e.online === true), 'and the header hears it');
  shift(864e5); // today's again: the tests after this one meet the app's day cap where they did
  c.close();
});

// a customer checked by code (level 2): order and email, then the code from the outbox, typed in the code box
// a customer checked by code (the outbox has it); each email may get 3 codes an hour, so tests spread over three people
async function checked(cookie = '', order = 'ORD-7Q4K-M2', mail = 'anna@example.com') {
  fake.script(o => {
    const last = o.messages.at(-1);
    if (Array.isArray(last.content)) return [{ text: 'Done.' }];
    return /ORD-/.test(words(last)) ? [{ tool: 'check_order', input: { order, email: mail } }, { tool: 'send_code', input: {} }] : [{ text: 'OK.' }];
  });
  const c = await customer(cookie);
  await c.say(`${order}, ${mail}`);
  await c.until(() => c.replies().find(r => r.widget?.type === 'code_entry'));
  const code = /\b(\d{6})\b/.exec(email.outbox.filter(m => m.kind === 'code' && m.to === mail).at(-1)!.text)![1];
  assert.equal((await c.post('code', { code })).level, 2);
  return c;
}

test("a phone fault noted under a basket's number shows beside its order: in the chat's order tools and on a person's card", async () => {
  // the caller's note, as the phone files it, under the number as they said it (a conversation of its own stands in for
  // the call)
  const line = await customer();
  phonecall.fault({ id: chatOf(line), shop: 'shop', state: { phone: {} } }, '123 4566', 'A corner is torn.', 'en');
  line.close();
  let found: any = null;
  fake.script(o => {
    const last: any = o.messages.at(-1);
    if (!Array.isArray(last.content)) return [{ tool: 'check_order', input: { order: 'ORD-UMA0-Z3', email: 'uma@example.com' } }];
    found ??= JSON.parse(last.content.at(-1).content);
    return [{ text: 'Found it.' }];
  });
  const c = await customer();
  await c.say('ORD-UMA0-Z3, uma@example.com');
  await c.until(() => c.replies().find(r => r.text === 'Found it.'));
  assert.match(found.order.reported_by_phone[0], /, by phone, not checked who called: A corner is torn\./);
  fake.script(() => [{ text: 'OK.' }]);
  await c.say('Email a person', { menu: 'person' });
  const sum = await c.until(() => c.replies().find(r => r.widget?.type === 'summary'));
  await c.say('', { widget: sum.widget.id, action: sum.widget.options[0].action, note: 'The corner, as I said on the phone.' });
  const sent = await c.until(() => c.replies().find(r => r.text.startsWith('Sent.')));
  const ref = /Reference (H-\d+)/.exec(sent.text)![1];
  const card = await c.until(() => cards.find(x => x.case === ref));
  assert.match(card.facts.reported_by_phone[0], /^1234566: \d{4}-\d{2}-\d{2}, by phone, not checked who called: A corner is torn\./);
  c.close();
});

test('a check the model ran raises the grant, and the widget is told at once to take a new session id', async () => {
  fake.script(o => Array.isArray(o.messages.at(-1).content) ? [{ text: 'Found it.' }] : [{ tool: 'check_order', input: { order: 'ORD-7Q4K-M2', email: 'anna@example.com' } }]);
  const c = await customer();
  await c.say('ORD-7Q4K-M2, anna@example.com');
  await c.until(() => c.events.find(e => e.t === 'renew'));
  c.close();
});

test('a stream opened with the cookie from before a check hears nothing after it (a planted cookie can’t listen in)', async () => {
  const planted = await customer();             // someone else's browser holding the same cookie, listening
  const c = await checked(planted.cookie());    // the customer checks their order and types the code on that cookie
  const again = await customer(c.cookie());     // the widget's stream, reconnected with the new cookie
  await c.say('show my orders');
  await again.until(() => again.replies().find(r => r.text === 'OK.'));
  assert.ok(!planted.replies().some(r => /that’s you|OK\./.test(r.text)), 'nothing from after the check');
  planted.close(); c.close(); again.close();
});

test('"Email me a copy of this chat" is limited per address, so a script can’t mail one inbox again and again', async () => {
  const c = await checked();
  const copies = () => email.outbox.filter(m => m.kind === 'copy').length, before = copies();
  for (let i = 0; i < 5; i++) await c.post('copy');
  assert.equal(copies() - before, 3);
  c.close();
});

test('a copy of the chat carries the AI mark once a message the model wrote is in it', async () => {
  const c = await checked('', 'ORD-TESS-Z2', 'tess@example.com');
  const copies = () => email.outbox.filter(m => m.kind === 'copy' && m.to === 'tess@example.com');
  await c.post('copy');
  assert.equal(copies().at(-1)!.headers, undefined, 'the greeting, the code box and the check are templates');
  await c.say('thanks!');
  await c.until(() => c.replies().find(r => r.text === 'OK.'));
  await c.post('copy');
  assert.deepEqual(copies().at(-1)!.headers, { 'AI-Disclosure': 'mode=machine-generated' });
  c.close();
});

test('the email card carries the note the helper wrote from the conversation, for the customer to edit', async () => {
  fake.script(o => {
    const last = o.messages.at(-1);
    if (Array.isArray(last.content)) return [{ text: 'Thanks.' }];
    if (/ORD-/.test(words(last))) return [{ tool: 'check_order', input: { order: 'ORD-7Q4K-M2', email: 'anna@example.com' } }];
    return [{ tool: 'ask_for_person', input: { reason: 'insisted', note: 'My Mila blanket arrived torn.' } }];
  });
  const c = await customer();
  await c.say('ORD-7Q4K-M2, anna@example.com');
  await c.until(() => c.replies().find(r => r.text === 'Thanks.'));
  await c.say('stop, I want a person');
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'summary'));
  assert.equal(card.widget.note, 'My Mila blanket arrived torn.');
  assert.equal(card.widget.noteAiGenerated, true, 'the model wrote the note');
  assert.equal(card.aiGenerated, undefined, 'the card’s own words are a template');
  const { items } = await c.post('hello', { lang: 'en' });
  assert.equal(items.find((it: any) => it.w?.type === 'summary').w.noteAiGenerated, true, 'stored with its mark');
  c.close();
});

test('after the address step the note the model wrote is still marked, and loses the mark once the customer changes it', async () => {
  fake.script(o => {
    const last = o.messages.at(-1)!;
    if (Array.isArray(last.content)) return [{ text: 'OK.' }];
    if (/@/.test(words(last))) return [{ tool: 'reply_address', input: { email: 'vera@example.com' } }];
    return [{ tool: 'ask_for_person', input: { reason: 'insisted', note: 'The blanket arrived torn.' } }];
  });
  const c = await customer();
  await c.say('I want a person');
  await c.until(() => c.replies().find(r => /What email should they reply to\?/.test(r.text)));
  await c.say('vera@example.com');
  const sum = await c.until(() => c.replies().find(r => r.widget?.type === 'summary'));
  assert.equal(sum.widget.noteAiGenerated, true);
  const edited = 'It arrived torn while I was in hospital.'; // a health detail: the health card, whose "Edit" brings the note back
  await c.say('', { widget: sum.widget.id, action: sum.widget.options[0].action, note: edited });
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'health'));
  await c.say('', { widget: card.widget.id, action: card.widget.options[0].action });
  const again = await c.until(() => c.replies().find(r => r.widget?.type === 'summary' && r.widget.id !== sum.widget.id));
  assert.equal(again.widget.note, edited);
  assert.equal(again.widget.noteAiGenerated, undefined, 'the customer’s words now');
  c.close();
});

test('after "Forget this chat", a reply held while the customer typed is dropped, not thrown (it would stop the service)', async () => {
  const thrown: string[] = [], catcher = (e: Error) => thrown.push(e.message); // outside a request, a throw stops the service
  process.on('uncaughtException', catcher);
  const c = await customer();
  await c.post('typing', { on: true });
  await c.post('code', { code: '123456' }); // no code was asked for: a template reply, held while they type
  await c.post('forget');                   // the chat nobody checked an email for is deleted
  await new Promise(r => setTimeout(r, 10_500)); // past the typing backstop, when the held reply would go out
  process.off('uncaughtException', catcher);
  assert.deepEqual(thrown, []);
  c.close();
});

test('a draft that is dropped files nothing: "ask the team", held while they type, then a follow-up, makes one case', async () => {
  const c = await checked('', 'ORD-CLEO-X3', 'cleo@example.com'); // the address is known, so ask_team files at once
  fake.script(o => {
    const last = o.messages.at(-1);
    return /ask the team/.test(words(last)) ? [{ wait: 400 }, { tool: 'ask_team', input: { question: 'Do you ship to Austria?' } }] : [{ text: 'OK.' }];
  });
  await new Promise(r => setTimeout(r, 3000)); // past the gap after the code's own answer
  const count = () => (db.prepare("select count(*) as n from cases where kind = 'question'").get() as any).n;
  const before = count();
  await c.say('please ask the team');
  await new Promise(r => setTimeout(r, 300)); // the draft is running
  await c.post('typing', { on: true });     // they type on: when it finishes (its tool run), it's held
  await new Promise(r => setTimeout(r, 600));
  await c.say('about shipping to Austria, please ask the team'); // the follow-up drops the held draft
  await c.until(() => c.replies().find(r => /Done: I’ve asked the team/.test(r.text)), 8000);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(count() - before, 1, 'one case, from the answer that was shown');
  c.close();
});

test('pass_on_feedback: a note for the team, with no reply address and none of their orders; one with an address or a number as said in it is refused', async () => {
  const c = await checked('', 'ORD-CLEO-X3', 'cleo@example.com'); // checked: the note still carries nothing of it
  fake.script(o => {
    const last = o.messages.at(-1);
    if (Array.isArray(last.content)) return [{ text: 'Thanks, passed on.' }];
    if (!/pass it on/.test(words(last))) return [{ text: 'OK.' }];
    const said = /mine/.test(words(last)) ? 'cleo@example.com finds the chat slow.' : /ring/.test(words(last)) ? 'Ring 06 12 34 56 78 about the slow chat.' : 'The chat felt a little slow to answer.';
    return [{ tool: 'pass_on_feedback', input: { feedback: said } }];
  });
  await new Promise(r => setTimeout(r, 3000)); // past the gap after the code's own answer
  const had = (db.prepare("select coalesce(max(id), 0) as n from cases").get() as any).n;
  const notes = () => db.prepare("select * from cases where kind = 'feedback' and id > ?").all(had) as any[];
  await c.say('mine: you are slow, pass it on');
  await c.until(() => c.replies().find(r => /passed on/.test(r.text)), 8000);
  assert.deepEqual(notes(), [], 'an address in it: not passed on');
  await c.say('ring me: you are slow, pass it on');
  await c.until(() => c.replies().filter(r => /passed on/.test(r.text)).length === 2, 8000);
  assert.deepEqual(notes(), [], 'a phone number as said, spaced: not passed on');
  await c.say('you are a little slow, pass it on');
  await c.until(() => notes().length, 8000);
  const [n] = notes();
  assert.deepEqual([n.words, n.email, n.checked, n.facts, n.kind], ['The chat felt a little slow to answer.', null, 'none', '{}', 'feedback']);
  c.close();
});

test('on a shared tablet, a second person’s code starts a new conversation: the first one’s chat never joins their thread', async () => {
  const anna = await checked();
  const annaConv = (db.prepare("select id from conversations where email = 'anna@example.com' order by id desc limit 1").get() as any).id;
  fake.script(o => {
    const last = o.messages.at(-1);
    if (Array.isArray(last.content)) return [{ text: 'Done.' }];
    return /BOB1/.test(words(last)) ? [{ tool: 'check_order', input: { order: 'ORD-BOB1-X2', email: 'bob@example.com' } }, { tool: 'send_code', input: {} }] : [{ text: 'OK.' }];
  });
  await anna.say('ORD-BOB1-X2, bob@example.com'); // Bob, on Anna's tablet, in her open chat
  await anna.until(() => email.outbox.find(m => m.kind === 'code' && m.to === 'bob@example.com'));
  const code = /\b(\d{6})\b/.exec(email.outbox.filter(m => m.to === 'bob@example.com').at(-1)!.text)![1];
  assert.equal((await anna.post('code', { code })).level, 2);
  assert.equal((db.prepare('select email from conversations where id = ?').get(annaConv) as any).email, 'anna@example.com', 'Anna’s chat stays in her thread');
  const again = await anna.post('hello', { lang: 'en' }); // the device's next hello: a new conversation, Bob's
  assert.ok(!again.items.some((i: any) => /ORD-7Q4K-M2/.test(i.text ?? '')), 'none of Anna’s chat on Bob’s side');
  anna.close();
});

test('on a shared tablet, the second person’s new conversation is in their thread, so it leaves the device when their grant lapses', async () => {
  const cleo = await checked('', 'ORD-CLEO-X3', 'cleo@example.com');
  fake.script(o => {
    const last = o.messages.at(-1);
    if (Array.isArray(last.content)) {
      const r = JSON.parse(last.content[0].content);
      return [{ text: r.orders ? `Your orders: ${r.orders.map((x: any) => `${x.id} (${x.address_masked})`).join(', ')}` : 'Done.' }];
    }
    if (/FINN/.test(words(last))) return [{ tool: 'check_order', input: { order: 'ORD-FINN-X6', email: 'finn@example.com' } }, { tool: 'send_code', input: {} }];
    return /my orders/.test(words(last)) ? [{ tool: 'my_orders', input: { show: false } }] : [{ text: 'OK.' }];
  });
  await new Promise(r => setTimeout(r, 1600)); // past the gap after the last draft
  await cleo.say('ORD-FINN-X6, finn@example.com'); // Finn, on Cleo's tablet
  await cleo.until(() => cleo.replies().find(r => r.widget?.type === 'code_entry' && r.widget.to === 'f•••@example.com'));
  const code = /\b(\d{6})\b/.exec(email.outbox.filter(m => m.kind === 'code' && m.to === 'finn@example.com').at(-1)!.text)![1];
  assert.equal((await cleo.post('code', { code })).level, 2);
  await cleo.post('hello', { lang: 'en' }); // a new conversation: Finn's
  const conv = (db.prepare("select conversation from sessions where email = 'finn@example.com' order by seen desc limit 1").get() as any).conversation;
  assert.equal((db.prepare('select email from conversations where id = ?').get(conv) as any).email, 'finn@example.com', 'in Finn’s thread');
  await new Promise(r => setTimeout(r, 1600));
  await cleo.say('show my orders');
  await cleo.until(() => db.prepare("select 1 from messages where conversation = ? and text like 'Your orders: ORD-FINN-X6%'").get(conv));
  db.prepare('update sessions set email_seen = email_seen - 25 * 3600000 where conversation = ?').run(conv); // a day unused
  const later = await cleo.post('hello', { lang: 'en' });
  assert.equal(later.level, 0);
  assert.ok(!later.items.some((i: any) => /ORD-FINN|Test Street/.test(JSON.stringify(i))), 'none of Finn’s orders after the grant lapsed');
  cleo.close();
});

test('a code typed in the chat: someone else holding the cookie from before it hears nothing of the thread, and can’t take the new id', async () => {
  const before = await checked('', 'ORD-DORA-X4', 'dora@example.com'); // an earlier conversation in Dora's thread
  await before.say('my earlier question about frames');
  await before.until(() => before.replies().find(r => r.text === 'OK.'));
  before.close();
  fake.script(o => {
    const last = o.messages.at(-1);
    if (Array.isArray(last.content)) return [{ text: 'Thanks, that’s you. Your blanket is on its way.' }];
    if (/ORD-/.test(words(last))) return [{ tool: 'check_order', input: { order: 'ORD-DORA-X4', email: 'dora@example.com' } }, { tool: 'send_code', input: {} }];
    const code = /\b(\d{6})\b/.exec(words(last));
    return code ? [{ tool: 'check_code', input: { code: code[1] } }] : [{ text: 'OK.' }];
  });
  await new Promise(r => setTimeout(r, 1600)); // past the gap after the last draft
  const c = await customer('', { renews: false }); // this page is slow to renew: the other browser asks first
  const sent = email.outbox.length;
  await c.say('ORD-DORA-X4, dora@example.com');
  await c.until(() => email.outbox.slice(sent).some(m => m.kind === 'code')); // (its stream hears only "renew" until it renews)
  await c.post('renew');                          // the order check's own renew
  const planted = await customer(c.cookie());     // another browser holding the same cookie, listening, and asking for every new id
  const code = /\b(\d{6})\b/.exec(email.outbox.filter(m => m.kind === 'code' && m.to === 'dora@example.com').at(-1)!.text)![1];
  await c.say(`it's ${code}`);                    // typed in the chat: the model's check_code raises the grant
  await planted.until(() => planted.events.some(e => e.t === 'renew'));
  await new Promise(r => setTimeout(r, 1000));    // the answer is given, and the other browser has asked for the new id
  assert.ok(db.prepare("select 1 from messages where text like 'Thanks, that’s you.%'").get(), 'the answer was given');
  await c.post('renew');                          // now the customer's page asks
  const items = (await c.post('hello', { lang: 'en' })).items;
  assert.equal(items[0].k, 'earlier');
  assert.ok(items[0].items.some((x: any) => x.k === 'me' && /frames/.test(x.text)), 'the customer’s page has the thread, after its renew');
  await new Promise(r => setTimeout(r, 500));
  assert.ok(!planted.events.some(e => e.t === 'earlier' || (e.t === 'reply' && /that’s you|frames/.test(e.text))), 'the other browser heard none of it');
  const theirs = await planted.post('hello', { lang: 'en' });
  assert.equal(theirs.level, 0, 'and its renew didn’t take the checked session');
  assert.ok(!theirs.items.some((i: any) => i.k === 'earlier' || /that’s you/.test(i.text ?? '')));
  planted.close(); c.close();
});

test('a send_code draft that is dropped leaves the code already in their inbox working, and their hourly codes unspent', async () => {
  fake.script(o => {
    const last = o.messages.at(-1);
    if (Array.isArray(last.content)) return [{ text: 'Done.' }];
    if (/ORD-/.test(words(last))) return [{ tool: 'check_order', input: { order: 'ORD-EMIL-X5', email: 'emil@example.com' } }, { tool: 'send_code', input: {} }];
    return /another code$/.test(words(last)) ? [{ wait: 400 }, { tool: 'send_code', input: {} }] : [{ text: 'OK.' }];
  });
  const c = await customer();
  await c.say('ORD-EMIL-X5, emil@example.com');
  await c.until(() => c.replies().find(r => r.widget?.type === 'code_entry'));
  const codes = () => email.outbox.filter(m => m.kind === 'code' && m.to === 'emil@example.com');
  const first = /\b(\d{6})\b/.exec(codes().at(-1)!.text)![1], rows = () => (db.prepare("select count(*) as n from codes where email = 'emil@example.com'").get() as any).n;
  assert.equal(rows(), 1);
  await new Promise(r => setTimeout(r, 1600)); // past the gap after the first draft
  await c.say('please send another code');
  await new Promise(r => setTimeout(r, 300)); // the draft is running
  await c.post('typing', { on: true });     // they type on: when it finishes (send_code ran), it's held
  await new Promise(r => setTimeout(r, 600));
  await c.say('oh wait, I found it');       // the follow-up drops the held draft
  await c.until(() => c.replies().find(r => r.text === 'OK.'), 6000);
  assert.equal(codes().length, 1, 'no second email');
  assert.equal(codes()[0].headers, undefined, 'a code is a template, with no AI mark');
  assert.equal(rows(), 1, 'no second code made');
  assert.equal((await c.post('code', { code: first })).level, 2, 'the first code still works');
  c.close();
});

test('an email to a person carries the whole conversation, and what the customer writes after it follows to the same card', async () => {
  fake.script(() => [{ text: 'I can look that up if you send the order number.' }]);
  const c = await customer();
  await c.say('my blanket came with a crease right across Mila’s name');
  await c.until(() => c.replies().find(r => /order number/.test(r.text)));
  await c.say('Email a person', { menu: 'person' });
  await c.until(() => c.replies().find(r => /What email should they reply to\?/.test(r.text)));
  await c.say('frida@example.com');
  const sum = await c.until(() => c.replies().find(r => r.widget?.type === 'summary'));
  assert.ok(sum.widget.rows.some((row: string[]) => row[1] === 'the whole conversation'));
  await c.say('', { widget: sum.widget.id, action: sum.widget.options[0].action, note: '' }); // no note: the chat is the problem
  const sent = await c.until(() => c.replies().find(r => r.text.startsWith('Sent.')));
  const ref = /Reference (H-\d+)/.exec(sent.text)![1];
  const card = await c.until(() => cards.find(x => x.case === ref));
  assert.equal(card.kind, 'person'); assert.equal(card.words, ''); assert.equal(card.to, 'frida@example.com');
  assert.ok(card.chat.some((m: any) => m.who === 'customer' && /crease right across Mila’s name/.test(m.text)), 'the customer’s own words');
  assert.ok(card.chat.some((m: any) => m.who === 'ai' && /order number/.test(m.text)), 'and the helper’s');
  await c.say('it’s order ORD-7Q4K-M2, if that helps');
  const more = await c.until(() => cards.find(x => x.case === ref && x.kind === 'more'));
  assert.ok(more.chat.some((m: any) => m.who === 'customer' && /ORD-7Q4K-M2, if that helps/.test(m.text)));
  assert.ok(!more.chat.some((m: any) => /crease/.test(m.text)), 'only what came after');
  c.close();
});

test('the Send tap goes to the address its card showed: if another order changed it since, a fresh card instead of a case', async () => {
  fake.script(o => {
    const last = o.messages.at(-1);
    if (Array.isArray(last.content)) return [{ text: 'Found it.' }];
    const m = /(ORD-\S+), (\S+@example\.com)/.exec(words(last));
    return m ? [{ tool: 'check_order', input: { order: m[1], email: m[2] } }] : [{ text: 'OK.' }];
  });
  const c = await customer();
  await c.say('ORD-JONA-Y3, jon@example.com');
  await c.until(() => c.replies().find(r => r.text === 'Found it.'));
  await c.say('Email a person', { menu: 'person' });
  const first = await c.until(() => c.replies().find(r => r.widget?.type === 'summary'));
  assert.match(first.widget.rows[0][1], /^j•••@example\.com/);
  await c.say('ORD-KAIA-Y4, kai@example.com'); // another order, another email: the grant is Kai's now, the card still Jon's
  await c.until(() => c.replies().filter(r => r.text === 'Found it.').length === 2);
  await c.say('', { widget: first.widget.id, action: first.widget.options[0].action, note: 'please help' });
  await c.until(() => c.replies().find(r => /^Nothing has gone yet/.test(r.text)));
  const fresh = await c.until(() => c.replies().find(r => r.widget?.type === 'summary' && r.widget.id !== first.widget.id));
  assert.match(fresh.widget.rows[0][1], /^k•••@example\.com \(the order’s email\)/);
  assert.equal(db.prepare("select count(*) n from cases where email in ('jon@example.com', 'kai@example.com')").get().n, 0, 'nothing filed on the old card');
  await c.say('', { widget: fresh.widget.id, action: fresh.widget.options[0].action, note: 'please help' });
  await c.until(() => c.replies().find(r => r.text.startsWith('Sent. A person will reply to k•••@example.com')));
  const rows = db.prepare("select email, checked from cases where email in ('jon@example.com', 'kai@example.com')").all();
  assert.deepEqual(rows.map((r: any) => [r.email, r.checked]), [['kai@example.com', 'order']]);
  c.close();
});

test('a cap reached between two rounds of one answer stops it: no further model calls in the tool loop', async () => {
  let calls = 0;
  fake.script(o => { // past the cap in one call; another test's conversation still retrying in the background isn't counted
    if (words(o.messages[0]) === 'show me everything') calls++;
    return [{ text: `${'x'.repeat(400)} `.repeat(200) }, { tool: 'my_orders', input: { show: false } }];
  });
  const c = await customer();
  await c.say('show me everything');
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'outage'), 8000);
  assert.equal(calls, 1, 'the second round never ran');
  assert.deepEqual(card.widget.options.map((o: any) => o.label), ['Email a person']);
  c.close();
});

test('an answer still calling tools at its last model call says so, and makes no further call', async () => {
  let calls = 0;
  fake.script(o => {
    if (words(o.messages[0]) === 'look everything up') calls++;
    return [{ tool: 'my_orders', input: { show: false } }];
  });
  const c = await customer();
  await c.say('look everything up');
  const out = () => numbers.counts('shop', numbers.dayOf(now())).timing['fake.chat.rounds.out']?.[String(TURN_ROUNDS)] ?? 0;
  const before = out();
  await c.until(() => c.replies().find(r => r.text === t('rounds_out', 'en')), 8000);
  assert.equal(calls, TURN_ROUNDS);
  assert.equal(out(), before + 1, 'the bound reached is counted');
  c.close();
});

// a second person on a checked customer's tablet: their order checked and a code sent by the model, in the first one's chat
async function secondOnTablet(c: Awaited<ReturnType<typeof customer>>, order: string, mail: string) {
  fake.script(o => {
    const last = o.messages.at(-1);
    if (Array.isArray(last.content)) return [{ text: 'Done.' }];
    return [{ tool: 'check_order', input: { order, email: mail } }, { tool: 'send_code', input: {} }];
  });
  await new Promise(r => setTimeout(r, 1600)); // past the gap after the last draft
  await c.say(`${order}, ${mail}`);
  await c.until(() => email.outbox.find(m => m.kind === 'code' && m.to === mail));
  await new Promise(r => setTimeout(r, 300)); // its renew
  return /\b(\d{6})\b/.exec(email.outbox.filter(m => m.kind === 'code' && m.to === mail).at(-1)!.text)![1];
}
const convOf = (mail: string) => (db.prepare('select id from conversations where email = ? order by id desc limit 1').get(mail) as any).id;
const pickers = (conv: number) => (db.prepare("select count(*) as n from messages where conversation = ? and widget like '%order_picker%'").get(conv) as any).n;

test('on a shared tablet, a code typed in the chat for another email ends the tool batch: nothing of theirs runs in the first one’s chat', async () => {
  const gina = await checked('', 'ORD-GINA-Y0', 'gin@example.com');
  const conv = convOf('gin@example.com');
  const code = await secondOnTablet(gina, 'ORD-HUGO-Y1', 'hug@example.com');
  const results: string[] = [];
  fake.script(o => {
    const last = o.messages.at(-1);
    if (Array.isArray(last.content)) { results.push(JSON.stringify(last.content)); return [{ text: 'Here they are.' }]; }
    return /\d{6}/.test(words(last)) ? [{ tool: 'check_code', input: { code } }, { tool: 'my_orders', input: { show: true } }] : [{ text: 'OK.' }];
  });
  await new Promise(r => setTimeout(r, 1600));
  await gina.say(`the code is ${code}`);
  await gina.until(() => db.prepare("select 1 from sessions where email = 'hug@example.com'").get());
  await new Promise(r => setTimeout(r, 800));
  assert.equal(pickers(conv), 0, 'no order picker in Gina’s chat');
  assert.ok(!results.some(r => /HUGO/.test(r)) && !asked.includes('hug@example.com'), 'my_orders never ran with Hugo’s grant');
  assert.ok(!(db.prepare("select text from messages where conversation = ? and who = 'ai'").all(conv) as any[]).some(m => /Here they are|HUGO|Hugo Street/.test(m.text)));
  gina.close();
});

test('on a shared tablet, a draft running in the first one’s chat is dropped when the device moves to another email’s thread', async () => {
  const ivy = await checked('', 'ORD-IVY0-Y2', 'ivy@example.com');
  const conv = convOf('ivy@example.com');
  const code = await secondOnTablet(ivy, 'ORD-JONA-Y3', 'jon@example.com');
  fake.script(o => {
    const last = o.messages.at(-1);
    if (Array.isArray(last.content)) return [{ text: `Your orders: ${JSON.parse(last.content[0].content).orders?.map((x: any) => `${x.id} (${x.address_masked})`).join(', ')}` }];
    return /my orders/.test(words(last)) ? [{ wait: 900 }, { tool: 'my_orders', input: { show: true } }] : [{ text: 'OK.' }];
  });
  await new Promise(r => setTimeout(r, 1600));
  await ivy.say('show my orders');
  await new Promise(r => setTimeout(r, 400)); // the draft is running, with Ivy's grant
  assert.equal((await ivy.post('code', { code })).level, 2); // Jon types his code in the box
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(pickers(conv), 0, 'no order picker in Ivy’s chat');
  assert.ok(!asked.includes('jon@example.com'), 'the draft never asked for Jon’s orders');
  assert.ok(!(db.prepare("select text from messages where conversation = ? and who = 'ai'").all(conv) as any[]).some(m => /Your orders|JONA|Jona Street/.test(m.text)), 'none of Jon’s orders in Ivy’s chat');
  ivy.close();
});

test('a stream left open hears nothing more of the thread once the email grant has lapsed, and the device leaves it', async () => {
  const c = await checked('', 'ORD-KAIA-Y4', 'kai@example.com');
  await new Promise(r => setTimeout(r, 600)); // the answer after the code
  const conv = convOf('kai@example.com');
  db.prepare("update sessions set email_seen = email_seen - 25 * 3600000 where email = 'kai@example.com'").run(); // a day unused, the tab still open
  engine.live(conv)!.send({ t: 'reply', id: 'r-thread', text: 'Kaia’s order is on its way to Kaia Street 1.' }); // another device's answer in the thread
  await new Promise(r => setTimeout(r, 400));
  assert.ok(!c.events.some(e => /Kaia Street/.test(e.text ?? '')), 'the open stream heard none of it');
  assert.ok(!db.prepare('select 1 from sessions where conversation = ?').get(conv), 'the device left the thread');
  c.close();
});

test('a follow-up sent between two bubbles of an answer gets its own answer', async () => {
  let calls = 0;
  fake.script(o => {
    if (/second thing/.test(words(o.messages.at(-1)))) { calls++; return [{ text: 'And about the second thing: yes.' }]; }
    return [{ wait: 1300 }, { text: 'One, the first part of the answer.\n\nTwo, the second part of it.\n\nThree, and the last part.' }];
  });
  const c = await customer();
  await c.say('a question');
  await c.until(() => c.replies().find(r => /^Two/.test(r.text)), 6000);
  await new Promise(r => setTimeout(r, 20));
  await c.say('and a second thing');
  await c.until(() => c.replies().find(r => /second thing: yes/.test(r.text)), 6000);
  assert.equal(calls, 1);
  c.close();
});

// the conversation a customer's chat is in: the greeting is its first stored message ('r<id>')
const chatOf = (c: any) => (db.prepare('select conversation from messages where id = ?').get(Number(c.hello.items[0].id.slice(1))) as any).conversation;
const stored = (conv: number) => (db.prepare('select count(*) as n from messages where conversation = ?').get(conv) as any).n;

test('a bad code or a bad link sent again and again stops adding messages at its limit (each one stores a reply)', async () => {
  const c = await customer();
  const conv = chatOf(c);
  const codes: any[] = [];
  for (let i = 0; i < 25; i++) codes.push(await c.post('code', { code: '000000' })); // no code was ever sent: the gate counts nothing
  assert.equal(codes.filter(r => r.why === 'slow down').length, 5, '20 an hour');
  await new Promise(r => setTimeout(r, 300));
  const afterCodes = stored(conv);
  for (let i = 0; i < 3; i++) await c.post('code', { code: '000000' });
  const links: any[] = [];
  for (let i = 0; i < 15; i++) links.push(await c.post('link', { token: 'not.a-token' }));
  assert.equal(links.filter(r => r.why === 'slow down').length, 5, '10 an hour');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(stored(conv), afterCodes + 10, 'only the 10 links within the limit stored a reply; the codes past it none');
  c.close();
});

test('a draft cut short by a follow-up counts every character it streamed, not only the unfinished bubble', async () => {
  const para = 'Your Mila blanket left our workshop on Monday and is on its way with the post, tracked all the way. '.repeat(6).trim();
  fake.script(o => /second/.test(words(o.messages.at(-1))) ? [{ text: 'Got it.' }] : [{ text: `${para}\n\nAnd one` }, { wait: 3000 }, { text: 'more thing.' }]);
  const c = await customer();
  const conv = chatOf(c);
  await c.say('where is my blanket');
  await new Promise(r => setTimeout(r, 1000));  // the paragraph is streamed (a bubble, waiting for the rest), the tail not yet
  await c.say('a second question');              // the follow-up drops the draft mid-stream
  await c.until(() => c.replies().find(r => r.text === 'Got it.'), 6000);
  const row = db.prepare("select output, estimate from ledger where conversation = ? and purpose = 'draft'").get(conv) as any;
  assert.ok(row, 'the dropped draft is in the ledger');
  assert.equal(row.estimate, 1);
  assert.ok(row.output >= Math.ceil(para.length / 4), `output ${row.output} counts the ${para.length} characters already shown`);
  c.close();
});

// An emailed answer (a team's answer, answers.ts) links only to hosts the widget would link: a mail client links whatever
// it finds, and a visitor can steer the model's words
test('an emailed answer with a web address that isn’t the company’s or a carrier’s fails the link check', () => {
  assert.equal(engine.linksOk('Your order is on hold, pay at https://pay-shop.example/now or evil.example.', 'zoe@example.com'), false);
  // a carrier's tracking page and the company's own host pass
  assert.equal(engine.linksOk('Track it at https://www.ups.com/x, or see help.example.com.', 'yara@example.com'), true);
  // a domain in another script is a link to a mail client too
  assert.equal(engine.linksOk('You can pay at оплата.рф or at pay。evil。com.', 'olga@example.com'), false);
});

test('an emailed answer is judged by the whole host a word names, not by the end of it that’s the company’s', () => {
  // and by every run of host characters as written: NFKC makes '…', '‥', '︙' and '․' full stops, but a linkifier stops
  // there and links evil.com
  for (const host of ['e\u0301example.com', 'x_example.com', '\u00e9example.com', 'evil.com\u2026example.com',
    'evil.com\u2025example.com', 'evil.com\ufe19example.com', 'evil.com\u2024example.com', 'evil.com..example.com',
    '192.168.0.1/login', '(10.0.0.1)', '\uff11\uff10.0.0.1',
    // another script's full stop before the company's domain: the parser reads a host under ours, a linkifier that stops
    // at that full stop links evil.example
    'evil.example\u3002example.com', 'evil.example\uff0eexample.com', 'https://evil.example\uff61example.com/pay',
    'https://evil.example\u3002example.com/pay', 'https://evil.example%E3%80%82example.com/pay']) {
    assert.equal(engine.linksOk(`Pay at ${host} now.`, 'look@example.com'), false, host);
  }
  assert.equal(engine.linksOk('Pay at example.com now, e.g. €12.50 for 14.8cm.', 'plain@example.com'), true);
  assert.equal(engine.linksOk('It’s all at help.example.com… and example.com.', 'dots@example.com'), true);
  // Chinese and Japanese end a sentence with U+3002 and no space: words, not a host
  assert.equal(engine.linksOk('您的订单已发货。请查收。', 'zh@example.com'), true);
  assert.equal(engine.linksOk('ご注文は発送済みです。詳しくは example.com をご覧ください。', 'ja@example.com'), true);
});

test('an emailed answer judges every web address in a run of them, and a domain after the bracket that ends one', () => {
  for (const links of ['(https://example.com/)(https://evil.com/pay)', '[Help](https://example.com/)[Pay](https://evil.com/pay)',
    'https://example.com/,https://evil.com/x', '[Help](https://example.com/)evil.com', 'https://example.com/,evil.com']) {
    assert.equal(engine.linksOk(`Pay at ${links} now.`, 'run@example.com'), false, links);
  }
  // both the company's: it passes
  for (const links of ['(https://example.com/)(https://help.example.com/pay)', '[Help](https://example.com/)[Pay](https://help.example.com/pay)',
    'https://example.com/,https://help.example.com/x', 'https://example.com/go?to=https://help.example.com/x']) {
    assert.equal(engine.linksOk(`Pay at ${links} now.`, 'ours@example.com'), true, links);
  }
});

test('an emailed answer that repeats the recipient’s own address passes', () => {
  // not a host of the company's: only taking it out lets it through
  assert.equal(engine.linksOk('Yes, I sent it to ines@inbox.test. More at help.example.com.', 'ines@inbox.test'), true);
});

test('closing a widget matches its id exactly: an id with a wildcard closes nothing else in the chat', async () => {
  fake.script(() => [{ text: 'Let’s look.' }]);
  const c = await customer();
  const chips = c.hello.items.at(-1).w;
  await c.say('', { widget: '%', action: chips.options[0].action }); // a tap, sent with a made-up widget id
  await c.until(() => c.replies().find(r => r.text === 'Let’s look.'));
  const again = await c.post('hello', { lang: 'en' });
  assert.equal(again.items.find((it: any) => it.w?.id === chips.id).w.ws, undefined, 'the starting chips are still open');
  c.close();
});

test('the outage message ends in one small "Email a person" link and nothing else, whatever the cause and whether email can be sent; with chatFirst, only linkFor’s (a stop’s by default)', async () => {
  const said = async (local: boolean, chatFirst: boolean, linkFor?: string[]) => JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    process.env.DATA_DIR = ${JSON.stringify(mkdtempSync(join(tmpdir(), 'care-card-')))}; delete process.env.CARE_EMAIL_API_KEY;
    ${local ? "process.env.CARE_LOCAL = '1';" : 'delete process.env.CARE_LOCAL;'}
    const person = await import(${JSON.stringify(new URL('./person.ts', import.meta.url).pathname)});
    (await import(${JSON.stringify(new URL('./company.ts', import.meta.url).pathname)})).use({ chatFirst: ${chatFirst}${linkFor ? `, linkFor: ${JSON.stringify(linkFor)}` : ''} });
    const said = [];
    for (const down of ['service', 'cap', 'stop'])
      person.outageCard({ live: { down, stall: 'shop' }, conv: { id: 1, shop: 'shop', email: null, state: {} }, lang: 'en', busy: false, out: { say: (text, w) => said.push({ text, w }) } });
    console.log(JSON.stringify(said)); process.exit(0);`], { encoding: 'utf8' })).stdout);
  const all = ['service', 'cap', 'stop'];
  for (const [local, chatFirst, linkFor] of [[true, false], [false, false], [true, true], [false, true], [true, true, all], [false, true, all]] as [boolean, boolean, string[]?][]) {
    const out = await said(local, chatFirst, linkFor);
    assert.deepEqual(out.map((o: any) => o.w.cause), ['service', 'cap', 'stop']);
    for (const { text, w } of out) {
      assert.ok(text, `${w.cause}: the message says what’s wrong`);
      assert.equal(w.type, 'outage');
      const link = !chatFirst || (linkFor ?? ['stop']).includes(w.cause);
      assert.deepEqual(w.options, link ? [{ kind: 'email_person', label: 'Email a person' }] : [], `${w.cause}, email ${local ? 'on' : 'off'}, chatFirst ${chatFirst}, linkFor ${linkFor ?? 'default'}: ${link ? 'the one link, not a primary chip' : 'no person while it waits'}`);
      assert.equal(w.note, undefined, 'no address asked for');
    }
  }
});

test('"Delete this conversation" in a chat never linked to an email: its messages go from the server, and every tab starts afresh', async () => {
  fake.script(() => [{ text: 'Noted.' }]);
  const c = await customer();
  assert.equal(c.hello.lang, 'en');
  assert.deepEqual(c.hello.may, { delete: true, kept: false }, 'no other copy: the delete step deletes it everywhere, no box');
  const conv = chatOf(c);
  await c.say('my blanket for Mila has a crease');
  await c.until(() => c.replies().find(r => r.text === 'Noted.'));
  assert.deepEqual(await c.post('delete'), { ok: true });
  await c.until(() => c.events.find(e => e.t === 'forget'));
  assert.equal(stored(conv), 0);
  assert.equal(db.prepare('select 1 from conversations where id = ?').get(conv), undefined);
  const again = await c.post('hello', { lang: 'en' }); // the same device, a new conversation, a fresh greeting
  assert.ok(again.items.length > 0 && !JSON.stringify(again.items).includes('crease'));
  c.close();
});

test('"Delete this conversation" at level 2 deletes that one conversation of the thread; a device whose grant lapsed deletes only its own new chat', async () => {
  const c = await checked('', 'ORD-LINA-Y5', 'lin@example.com'); // a customer of its own: the tablet tests spend Gina's hourly codes
  const conv = (db.prepare("select conversation from sessions where email = 'lin@example.com'").get() as any).conversation;
  assert.equal((db.prepare('select email from conversations where id = ?').get(conv) as any).email, 'lin@example.com');
  assert.deepEqual((await c.post('hello', { lang: 'en' })).may, { delete: true, kept: true }, 'linked: the step asks whether our copy goes too');
  assert.deepEqual(await c.post('delete'), { ok: true });
  assert.equal(stored(conv), 0);
  c.close();

  // a second conversation in the same thread; then the grant lapses (a day unused) and the device leaves the thread
  const d = await checked('', 'ORD-LINA-Y5', 'lin@example.com');
  const thread = (db.prepare("select conversation from sessions where email = 'lin@example.com' and conversation is not null").get() as any).conversation;
  db.prepare('update sessions set email_seen = email_seen - 25 * 3600000 where conversation = ?').run(thread);
  const later = await d.post('hello', { lang: 'en' });
  assert.equal(later.level, 0);
  assert.deepEqual(later.may, { delete: true, kept: false }, 'its own new chat, never linked');
  assert.deepEqual(await d.post('delete'), { ok: true });
  assert.ok(stored(thread) > 0, 'the email’s thread stays: only its owner, checked, can delete it');
  d.close();
  // the thread's answer after the code (due 300 ms on) starts on this test's script, not on the next test's
  await new Promise(r => setTimeout(r, 1000));
});

// ---- the health-detail check: a customer's message with a health term never reaches the model
const sawIt = (needle: RegExp) => seen.filter(ms => ms.some((m: any) => needle.test(words(m)))).length; // model calls that saw it
// the stored message with that client id, in the conversation a reply of the helper's (its id: 'r' + row id) is in
const msg = (reply: any, client: string) => db.prepare('select * from messages where client = ? and conversation = (select conversation from messages where id = ?)')
  .get(client, Number(reply.id.slice(1))) as any;

test('EN: care holds a message with a health term under the health-detail card, the model never sees it, and "Edit my message" drops it', async () => {
  seen.length = 0;
  fake.script(o => { seen.push(o.messages); return [{ text: 'Happy to help with that.' }]; });
  const c = await customer();
  await c.say('My son was born premature and spent two weeks in the NICU. Can the blanket show his homecoming?');
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'health'));
  assert.equal(card.text, t('health_card', 'en'));
  assert.deepEqual(card.widget.options.map((o: any) => o.label), [t('health_edit', 'en'), t('health_person', 'en')]);
  assert.ok(!card.widget.options.some((o: any) => o.primary), 'two buttons of equal weight');
  assert.equal(msg(card, 'c1').health, 'held');
  await c.say('', { widget: card.widget.id, action: card.widget.options[0].action });
  const drop = await c.until(() => c.events.find(e => e.t === 'drop'));
  assert.deepEqual(drop.ids, ['c1']); assert.match(drop.text, /NICU/, 'the words go back to the input');
  assert.equal(msg(card, 'c1'), undefined, 'gone from care’s store');
  await c.say('Can the blanket show the day he came home?');
  await c.until(() => c.replies().find(r => r.text === 'Happy to help with that.'));
  assert.equal(sawIt(/NICU|premature/), 0, 'no model call saw it, held or after'); assert.equal(sawIt(/came home/), 1);
  c.close();
});

test('the health card’s "Send it to a person instead" files a person case with the message, and the model sees only that it went to a person', async () => {
  seen.length = 0;
  fake.script(o => { seen.push(o.messages); return [{ text: 'That works.' }]; });
  const c = await customer('', { lang: 'fr' }); // a language the company doesn't speak: its first one
  assert.equal(c.hello.lang, 'en');
  await c.say('Our daughter was born premature, can her homecoming date go on the blanket?');
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'health'));
  assert.equal(card.text, t('health_card', 'en'));
  assert.deepEqual(card.widget.options.map((o: any) => o.label), [t('health_edit', 'en'), t('health_person', 'en')]);
  await c.say('', { widget: card.widget.id, action: card.widget.options[1].action });
  await c.until(() => c.replies().find(r => r.text === t('person_address', 'en')));
  await c.say('nora@example.com');
  const sent = await c.until(() => c.replies().find(r => r.text.startsWith('Sent.')));
  const ref = /(H-\d+)/.exec(sent.text)![1];
  const kase = db.prepare('select * from cases where id = ?').get(Number(ref.slice(2)) - 1000) as any;
  assert.equal(kase.kind, 'person'); assert.equal(kase.health, 1); assert.equal(kase.email, 'nora@example.com');
  assert.match(kase.words, /born premature/);
  assert.equal(msg(card, 'c1').health, 'person');
  const hqCard = await c.until(() => cards.find(x => x.case === ref));
  assert.equal(hqCard.health, true); assert.equal(hqCard.draft, null);
  await c.say('And when does it come?');
  await c.until(() => c.replies().find(r => r.text === 'That works.'));
  assert.equal(sawIt(/premature/), 0, 'never in a model request');
  assert.equal(sawIt(/sent to a person on the team instead/), 1, 'a marker instead');
  c.close();
});

test('the widget’s own card sends the message marked for a person; with an email to a person already gone, it goes with that one', async () => {
  seen.length = 0;
  fake.script(o => { seen.push(o.messages); return [{ text: 'Gladly.' }]; });
  const c = await customer();
  await c.say('Our son was born premature, can the date on the blanket be different?', { health: 'person' });
  await c.until(() => c.replies().find(r => r.text === t('person_address', 'en')));
  await c.say('otto@example.com');
  const sent = await c.until(() => c.replies().find(r => r.text.startsWith('Sent.')));
  const ref = /(H-\d+)/.exec(sent.text)![1];
  assert.equal(msg(sent, 'c1').health, 'person');
  await c.until(() => cards.find(x => x.case === ref));
  await c.say('He was in an incubator too.', { health: 'person' }); // a second one: the email has gone, it follows to the same card
  await c.until(() => c.replies().find(r => r.text === t('already', 'en', { ref, to: 'o•••@example.com' })));
  const more = await c.until(() => cards.find(x => x.case === ref && x.kind === 'more'));
  assert.ok(more.chat.some((m: any) => m.health === true && /incubator/.test(m.text)), 'marked, for a person only');
  // (by its words: another test's late call may land in the shared list too)
  assert.equal(sawIt(/premature|incubator|otto@/), 0, 'no model call saw any of it');
  c.close();
});

test('a new message instead of a choice is the edit: the held message and its card go', async () => {
  seen.length = 0;
  fake.script(o => { seen.push(o.messages); return [{ text: 'Let me look.' }]; });
  const c = await customer();
  await c.say('I was in hospital when it came');
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'health'));
  await c.say('never mind, where is my parcel?');
  await c.until(() => c.events.find(e => e.t === 'drop' && e.ids.includes('c1')));
  await c.until(() => c.events.find(e => e.t === 'close' && e.widget === card.widget.id && e.gone));
  await c.until(() => c.replies().find(r => r.text === 'Let me look.'));
  assert.equal(msg(card, 'c1'), undefined); assert.equal(sawIt(/hospital/), 0);
  c.close();
});

test('a health detail the check misses: the helper calls remove_health_detail, and its text leaves care’s store and every later turn', async () => {
  seen.length = 0;
  fake.script(o => {
    seen.push(o.messages);
    return /due date/.test(words(o.messages.at(-1))) ? [{ tool: 'remove_health_detail', input: {} }] : [{ text: 'Yes, any date works.' }];
  });
  const c = await customer();
  await c.say('She came six weeks before her due date and we stayed on the ward for a month');
  const line = await c.until(() => c.replies().find(r => /taken that message out of our chat/.test(r.text)));
  assert.match(line.text, /Could you write it again without them\?/);
  const r = msg(line, 'c1');
  assert.equal(r.text, ''); assert.equal(r.health, 'removed');
  assert.deepEqual((await c.until(() => c.events.find(e => e.t === 'redact'))).ids, ['c1']);
  await c.say('Can the blanket show 3 March?');
  await c.until(() => c.replies().find(x => x.text === 'Yes, any date works.'));
  assert.ok(words(seen.at(-1)[0]).includes('[removed: a health detail]'));
  const later = seen.filter(ms => ms.some((m: any) => /3 March/.test(words(m)))); // (by its words: another test's late call may land here too)
  assert.ok(later.length > 0);
  assert.equal(later.filter(ms => ms.some((m: any) => /due date|ward/.test(words(m)))).length, 0, 'in no later turn');
  assert.ok((await c.post('hello', { lang: 'en' })).items.some((it: any) => it.id === 'c1' && it.removed), 'the chat shows it was taken out');
  c.close();
});

// ---- what the health-detail check must still hold under races and follow-ups
const caseOf = (ref: string) => db.prepare('select * from cases where id = ?').get(Number(ref.slice(2)) - 1000) as any;

test('a held message that comes while a draft runs leaves no earlier question unanswered (care’s card, and its Edit)', async () => {
  // like the API (newer models have no prefill): a request whose last turn is the helper's is refused with a 400
  fake.script(o => o.messages.at(-1).role === 'assistant' ? [{ fail: 400 }] : [{ wait: 400 }, { text: `Answer: ${words(o.messages.at(-1)).replace(/\s+/g, ' ').slice(0, 60)}` }]);
  const c = await customer();
  await c.say('my blanket has a crease');
  await new Promise(r => setTimeout(r, 300)); // its draft runs
  await c.say('My son was born premature', { health: 'person' }); // the widget's own card: "Send it to a person instead"
  await c.until(() => c.replies().find(r => /What email should they reply to\?/.test(r.text)));
  await c.until(() => c.replies().find(r => /^Answer: my blanket has a crease/.test(r.text)));
  await new Promise(r => setTimeout(r, 1500)); // the next draft may start
  await c.say('where is my parcel?');
  await new Promise(r => setTimeout(r, 300)); // its draft runs
  await c.say('I was in hospital last week'); // held: the running draft is discarded
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'health'));
  await c.until(() => c.replies().find(r => /^Answer: where is my parcel/.test(r.text)));
  await c.say('and when does it ship?');
  await new Promise(r => setTimeout(r, 300));
  await c.say('', { widget: card.widget.id, action: card.widget.options[0].action }); // "Edit my message" while that draft runs
  await c.until(() => c.replies().find(r => /^Answer: [\s\S]*when does it ship/.test(r.text)));
  c.close();
});

test('a health message sent to a person after an email to a person went: that case gets no AI draft or redraft from then on', async () => {
  const asks: string[] = [];
  fake.script(o => { asks.push(JSON.stringify(o.messages)); return [{ text: 'OK.' }]; });
  const c = await customer();
  await c.say('Email a person', { menu: 'person' });
  await c.until(() => c.replies().find(r => /What email should they reply to\?/.test(r.text)));
  await c.say('greta@example.com');
  const sum = await c.until(() => c.replies().find(r => r.widget?.type === 'summary'));
  await c.say('', { widget: sum.widget.id, action: sum.widget.options[0].action, note: 'the blanket is creased' });
  const ref = /Reference (H-\d+)/.exec((await c.until(() => c.replies().find(r => r.text.startsWith('Sent.')))).text)![1];
  await c.until(() => cards.find(x => x.case === ref));
  await c.say('Our son was born premature, so the date on it should change', { health: 'person' });
  await c.until(() => c.replies().find(r => /has already gone/.test(r.text)));
  await c.until(() => cards.find(x => x.case === ref && x.kind === 'more' && x.chat.some((m: any) => m.health)));
  asks.length = 0;
  const drafts = await import('./drafts.ts');
  drafts.redraft([{ id: 'review-ask-1', case: ref, ask: 'warmer, please', draft: 'Dear Greta,' }]);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(asks.filter(a => a.includes(ref)).length, 0, 'no redraft for the case the health message went with');
  assert.equal(caseOf(ref).health, 1);
  c.close();
});

test('a health message waiting for its reply address, then "Email a person": the case that carries it gets no AI draft', async () => {
  fake.script(() => [{ text: 'OK.' }]);
  const c = await customer();
  await c.say('She was in the NICU for a week');
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'health'));
  await c.say('', { widget: card.widget.id, action: card.widget.options[1].action });
  await c.until(() => c.replies().find(r => /What email should they reply to\?/.test(r.text) && !/Of course/.test(r.text)));
  await c.say('Email a person', { menu: 'person' }); // the ⋯ menu instead of an address: its own step takes over
  await c.until(() => c.replies().find(r => /^Of course/.test(r.text)));
  await c.say('hanna@example.com');
  const sum = await c.until(() => c.replies().find(r => r.widget?.type === 'summary'));
  await c.say('', { widget: sum.widget.id, action: sum.widget.options[0].action, note: '' });
  const ref = /Reference (H-\d+)/.exec((await c.until(() => c.replies().find(r => r.text.startsWith('Sent.')))).text)![1];
  const hqCard = await c.until(() => cards.find(x => x.case === ref));
  assert.ok(hqCard.chat.some((m: any) => m.health && /NICU/.test(m.text)), 'the person case carries it');
  assert.equal(caseOf(ref).health, 1, 'so no model drafts for it');
  c.close();
});

test('remove_health_detail: the helper’s own words in that answer go too, and a tool called before it in the batch never runs', async () => {
  seen.length = 0;
  fake.script(o => {
    seen.push(o.messages);
    const last = words(o.messages.at(-1));
    if (/due date/.test(last)) return [{ text: 'Six weeks before her due date, how scary.' }, { tool: 'remove_health_detail', input: {} }];
    if (/the ward/.test(last)) return [{ tool: 'ask_for_person', input: { reason: 'asked', note: 'Her daughter stayed on the ward for a month' } }, { tool: 'remove_health_detail', input: {} }];
    return [{ text: 'Yes, any date works.' }];
  });
  const c = await customer();
  await c.say('She came six weeks before her due date');
  await c.until(() => c.replies().find(r => /taken that message out/.test(r.text)));
  await c.say('Can the blanket show 3 March?');
  await c.until(() => c.replies().find(x => x.text === 'Yes, any date works.'));
  assert.equal(seen.slice(1).filter(ms => ms.some((m: any) => /due date/.test(words(m)))).length, 0, 'the helper’s repeat is in no later request');
  await c.say('We stayed on the ward for a month, I want a person');
  await c.until(() => c.replies().filter(r => /taken that message out/.test(r.text)).length === 2);
  const conv = db.prepare('select conversation from messages where id = ?').get(Number(c.replies().at(-1).id.slice(1))) as any;
  const state = JSON.parse((db.prepare('select state from conversations where id = ?').get(conv.conversation) as any).state);
  assert.ok(!/ward/.test(JSON.stringify(state)), 'no note holds it, for a case’s words and its draft');
  assert.equal(db.prepare("select count(*) n from messages where conversation = ? and text like '%ward%'").get(conv.conversation).n, 0);
  c.close();
});

test('the health route’s address through the model files nothing from a dropped draft: one case, however often it’s given', async () => {
  fake.script(o => /my email is/.test(words(o.messages.at(-1))) ? [{ wait: 300 }, { tool: 'reply_address', input: { email: 'pia@example.com' } }] : [{ text: 'OK.' }]);
  const c = await customer();
  await c.say('I was in hospital after the birth, can the date change?', { health: 'person' });
  const ask = await c.until(() => c.replies().find(r => /What email should they reply to\?/.test(r.text)));
  await c.say('my email is pia@example.com');
  await new Promise(r => setTimeout(r, 250)); // the draft has started
  await c.post('typing', { on: true }); // its tool runs, but nothing is delivered while they type
  await new Promise(r => setTimeout(r, 500));
  await c.say('pia@example.com'); // the draft goes (restore() puts the step back), and the address alone answers the step
  await c.until(() => c.replies().find(r => r.text.startsWith('Sent.')));
  await new Promise(r => setTimeout(r, 300));
  const conv = (db.prepare('select conversation from messages where id = ?').get(Number(ask.id.slice(1))) as any).conversation;
  assert.equal((db.prepare('select count(*) as n from cases where conversation = ?').get(conv) as any).n, 1);
  c.close();
});

// ---- a health detail in the email card's note
test('a note on the email card with a health detail files nothing until the health card’s "Send it to a person instead"; "Edit" brings the card back with it', async () => {
  fake.script(() => [{ text: 'OK.' }]);
  const c = await customer();
  await c.say('I was in hospital, she was born early', { menu: 'person' }); // only the menu's label is stored, never this text
  await c.until(() => c.replies().find(r => /What email should they reply to\?/.test(r.text)));
  const conv = chatOf(c), cases = () => (db.prepare('select * from cases where conversation = ?').all(conv) as any[]);
  assert.equal(db.prepare("select count(*) n from messages where conversation = ? and text like '%hospital%'").get(conv).n, 0);
  await c.say('lena@example.com');
  const sum = await c.until(() => c.replies().find(r => r.widget?.type === 'summary'));
  const note = 'Our son was in the NICU, can the blanket show the day he came home?';
  await c.say('', { widget: sum.widget.id, action: sum.widget.options[0].action, note });
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'health'));
  assert.equal(cases().length, 0, 'not filed: the card said nothing yet about who reads it');
  await c.say('', { widget: card.widget.id, action: card.widget.options[0].action }); // "Edit my message"
  const again = await c.until(() => c.replies().find(r => r.widget?.type === 'summary' && r.widget.id !== sum.widget.id));
  assert.equal(again.widget.note, note, 'the note is back in the email card to change');
  assert.equal(cases().length, 0);
  await c.say('', { widget: again.widget.id, action: again.widget.options[0].action, note });
  const card2 = await c.until(() => c.replies().find(r => r.widget?.type === 'health' && r.widget.id !== card.widget.id));
  assert.equal(cases().length, 0);
  await c.say('', { widget: card2.widget.id, action: card2.widget.options[1].action }); // "Send it to a person instead": the consent
  await c.until(() => c.replies().find(r => r.text.startsWith('Sent. A person will reply to l•••@example.com')));
  const filed = cases();
  assert.equal(filed.length, 1); assert.equal(filed[0].health, 1, 'no AI drafts for it'); assert.match(filed[0].words, /NICU/);
  c.close();
});

// ---- a detail the helper sees only a turn later
test('remove_health_detail for an earlier, answered message: that message and the helper’s answer to it go, the request asking for it stays, and no later request carries it', async () => {
  seen.length = 0;
  fake.script(o => {
    seen.push(o.messages);
    const all = o.messages.map(raw).join('\n'), last = words(o.messages.at(-1));
    if (/take that .* out/.test(last)) {
      const n = Number(/\[#(\d+)\] [^\n]*due date/.exec(all)?.[1]);
      return [{ tool: 'remove_health_detail', input: { messages: [n] } }];
    }
    if (/due date/.test(last)) return [{ text: 'Six weeks before her due date: the blanket can show any date.' }];
    return [{ text: 'Yes, any date works.' }];
  });
  const c = await customer();
  await c.say('She came six weeks before her due date, can the blanket show 3 March?');
  const first = await c.until(() => c.replies().find(r => /the blanket can show any date/.test(r.text)));
  await c.say('Please take that personal detail out of our chat');
  const line = await c.until(() => c.replies().find(r => /taken that message out of our chat/.test(r.text)));
  assert.ok(!/write it again/.test(line.text), 'nothing to write again: it was an earlier message');
  const conv = chatOf(c);
  assert.equal(msg(line, 'c1').health, 'removed');
  assert.equal(msg(line, 'c2').health, null, 'the request to take it out is still there');
  assert.match(msg(line, 'c2').text, /take that personal detail/);
  assert.equal(db.prepare("select count(*) n from messages where conversation = ? and text like '%due date%'").get(conv).n, 0, 'nor the helper’s answer that repeated it');
  const redact = await c.until(() => c.events.find(e => e.t === 'redact'));
  assert.ok(redact.ids.includes('c1') && redact.ids.includes(first.id));
  await c.say('And can it be large?');
  await c.until(() => c.replies().find(x => x.text === 'Yes, any date works.'));
  assert.equal(seen.at(-1).filter((m: any) => /due date/.test(words(m))).length, 0, 'the third request doesn’t carry it');
  c.close();
});

test('remove_health_detail naming no message of this customer’s removes nothing, says nothing about a removal, and the answer goes on', async () => {
  let foreign = 0;
  fake.script(o => {
    const last = o.messages.at(-1);
    if (Array.isArray(last.content)) return [{ text: 'Your blanket can show any date.' }];
    if (/parcel/.test(words(last))) return [{ text: 'It’s on its way.' }];
    return [{ tool: 'remove_health_detail', input: { messages: [foreign, 999999] } }];
  });
  const other = await customer();
  await other.say('hello there, a question about my parcel');
  await other.until(() => other.replies().find(r => r.text === 'It’s on its way.'));
  foreign = (db.prepare("select id from messages where conversation = ? and who = 'me'").get(chatOf(other)) as any).id;
  const c = await customer();
  await c.say('Can the blanket show 3 March?');
  await c.until(() => c.replies().find(r => r.text === 'Your blanket can show any date.'));
  assert.ok(!c.replies().some(r => /taken that message out/.test(r.text)));
  assert.equal(msg(c.replies()[0], 'c1').health, null);
  assert.ok(db.prepare('select text from messages where id = ?').get(foreign).text.length > 0, 'another conversation’s message is untouched');
  other.close(); c.close();
});

test('a held health message after an email to a person went, then a tap on another card: the customer is never told it went unless HQ gets it', async () => {
  fake.script(() => [{ text: 'OK.' }]);
  const c = await customer();
  const chips = c.hello.items.at(-1).w;
  await c.say('Email a person', { menu: 'person' });
  await c.until(() => c.replies().find(r => /What email should they reply to\?/.test(r.text)));
  await c.say('ines@example.com');
  const sum = await c.until(() => c.replies().find(r => r.widget?.type === 'summary'));
  await c.say('', { widget: sum.widget.id, action: sum.widget.options[0].action, note: 'the blanket is creased' });
  const ref = /Reference (H-\d+)/.exec((await c.until(() => c.replies().find(r => r.text.startsWith('Sent.')))).text)![1];
  await c.until(() => cards.find(x => x.case === ref));
  await c.say('Our son was born premature, so the date should change');
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'health'));
  await c.say('', { widget: chips.id, action: chips.options[0].action }); // another open card: HQ's minute sync may run now
  await c.until(() => cards.find(x => x.case === ref && x.kind === 'more'));
  await c.say('', { widget: card.widget.id, action: card.widget.options[1].action }); // "Send it to a person instead"
  await new Promise(r => setTimeout(r, 800));
  const told = c.replies().some(r => /has already gone/.test(r.text));
  const carried = cards.some(x => x.case === ref && x.kind === 'more' && x.chat.some((m: any) => /premature/.test(m.text)));
  assert.ok(!told || carried, 'told it went with the email, so HQ has it');
  c.close();
});

// ---- a case HQ has becomes a health case: HQ hears it once, as `health: true` on a `more`
const takeOutScript = () => fake.script(o => {
  const all = o.messages.map(raw).join('\n'), last = words(o.messages.at(-1));
  if (/take it out/.test(last)) return [{ tool: 'remove_health_detail', input: { messages: [Number(/\[#(\d+)\] [^\n]*due date/.exec(all)?.[1])] } }];
  return [{ text: 'OK.' }];
});
async function emailPerson(c: any, address: string) {
  await c.say('Email a person', { menu: 'person' });
  await c.until(() => c.replies().find((r: any) => /What email should they reply to\?/.test(r.text)));
  await c.say(address);
  const sum = await c.until(() => c.replies().find((r: any) => r.widget?.type === 'summary'));
  await c.say('', { widget: sum.widget.id, action: sum.widget.options[0].action, note: 'the blanket is creased' });
  return /Reference (H-\d+)/.exec((await c.until(() => c.replies().find((r: any) => r.text.startsWith('Sent.')))).text)![1];
}
const syncUntil = async (f: () => unknown) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > 4000) throw new Error('timed out waiting'); await hq.sync(); await new Promise(r => setTimeout(r, 50)); } };

test('remove_health_detail after an email to a person reached HQ: HQ hears once that it’s a health case, asked again after a 5xx', async () => {
  takeOutScript();
  const c = await customer();
  const ref = await emailPerson(c, 'tess@example.com');
  await c.until(() => cards.find(x => x.case === ref && x.kind === 'person'));
  const told = () => cards.filter(x => x.case === ref && x.kind === 'more' && x.health === true);
  let failures = 1;
  hqStatus = card => card.case === ref && card.health === true && failures-- > 0 ? 503 : 200;
  try {
    await c.say('She came six weeks before her due date, so the blanket should say so');
    await c.until(() => c.replies().find(r => r.text === 'OK.'));
    await c.say('please take it out');
    await c.until(() => c.replies().find(r => /taken that message out of our chat/.test(r.text)));
    await syncUntil(() => told().length >= 2);
  } finally { hqStatus = () => 200; }
  for (let i = 0; i < 3; i++) { await hq.sync(); await new Promise(r => setTimeout(r, 50)); }
  assert.equal(told().length, 2, 'the 503, then the one HQ took, and nothing after');
  assert.ok(db.prepare('select 1 from cases where id = ? and health = 1 and health_hq is not null').get(Number(ref.slice(2)) - 1000));
  c.close();
});

test('a case marked a health case before HQ had it: its first card says so, and no `more` follows to tell HQ again', async () => {
  takeOutScript();
  const c = await customer();
  hqStatus = card => card.kind === 'person' && card.to === 'ugo@example.com' ? 503 : 200; // HQ down for this case's card
  let ref = '';
  try {
    ref = await emailPerson(c, 'ugo@example.com');
    await c.say('She came six weeks before her due date, so the blanket should say so');
    await c.until(() => c.replies().find(r => r.text === 'OK.'));
    await c.say('please take it out');
    await c.until(() => c.replies().find(r => /taken that message out of our chat/.test(r.text)));
    assert.ok(cards.some(x => x.case === ref && x.kind === 'person' && !x.health), 'HQ was asked before the mark, and answered 503');
  } finally { hqStatus = () => 200; }
  await syncUntil(() => cards.find(x => x.case === ref && x.kind === 'person' && x.health === true));
  for (let i = 0; i < 3; i++) { await hq.sync(); await new Promise(r => setTimeout(r, 50)); }
  assert.ok(!cards.some(x => x.case === ref && x.kind === 'more' && x.health), 'the first card carried it');
  c.close();
});

// ---- what an earlier answer wrote from a removed message goes with it
const DETAIL = 'She came six weeks before her due date';
const detailScript = () => fake.script(o => {
  const all = o.messages.map(raw).join('\n'), last = words(o.messages.at(-1));
  if (/take it out/.test(last)) return [{ tool: 'remove_health_detail', input: { messages: [Number(/\[#(\d+)\] [^\n]*due date/.exec(all)?.[1])] } }];
  if (/due date/.test(last)) return [{ tool: 'ask_for_person', input: { reason: 'asked', note: DETAIL } }];
  return [{ text: 'OK.' }];
});

test('remove_health_detail for an earlier turn takes the email card’s note out of the state, every stored card and the live page, and its Send can’t file it', async () => {
  detailScript();
  const c = await customer();
  await c.say(`${DETAIL}. Please email a person about changing the blanket date.`);
  await c.until(() => c.replies().find(r => /What email should they reply to\?/.test(r.text)));
  await c.say('mia@example.com'); // the address alone answers the step: the card shows the note the helper wrote
  const sum = await c.until(() => c.replies().find(r => r.widget?.type === 'summary'));
  assert.equal(sum.widget.note, DETAIL);
  assert.equal(sum.widget.noteAiGenerated, true);
  await c.say('please take it out');
  await c.until(() => c.replies().find(r => /taken that message out of our chat/.test(r.text)));
  const conv = chatOf(c), cases = () => (db.prepare('select * from cases where conversation = ?').all(conv) as any[]);
  const state = (db.prepare('select state from conversations where id = ?').get(conv) as any).state;
  assert.ok(!state.includes('due date'), 'no note in the state');
  assert.equal(db.prepare("select count(*) n from messages where conversation = ? and (text like '%due date%' or widget like '%due date%')").get(conv).n, 0, 'nor on the stored card');
  const redact = await c.until(() => c.events.find(e => e.t === 'redact'));
  assert.ok(redact.notes.includes(sum.id), 'the page drops the card’s note');
  assert.ok(c.events.some(e => e.t === 'close' && e.widget === sum.widget.id && e.gone), 'and the card closes');
  const hello = await c.post('hello', { lang: 'en' });
  assert.ok(!JSON.stringify(hello.items).includes('due date'), 'a reload doesn’t bring it back');
  assert.ok(!JSON.stringify(hello.items).includes('noteAiGenerated'), 'nor the mark of a note that’s gone');
  // the old card's Send, with the note the page held: expired, nothing filed
  assert.ok((await c.say('', { widget: sum.widget.id, action: sum.widget.options[0].action, note: DETAIL })).resync);
  assert.equal(cases().length, 0);
  // a fresh card from the menu has no note, and what it files doesn't carry the detail
  await c.say('Email a person', { menu: 'person' });
  const fresh = await c.until(() => c.replies().find(r => r.widget?.type === 'summary' && r.widget.id !== sum.widget.id));
  assert.ok(!fresh.widget.note, 'the new card has no note');
  await c.say('', { widget: fresh.widget.id, action: fresh.widget.options[0].action });
  await c.until(() => c.replies().find(r => r.text.startsWith('Sent.')));
  assert.equal(cases().length, 1); assert.ok(!/due date/.test(cases()[0].words));
  c.close();
});

test('remove_health_detail after the email card already filed the helper’s note: no model drafts for that case', async () => {
  detailScript();
  const c = await customer();
  await c.say(`${DETAIL}. Please email a person about changing the blanket date.`);
  await c.until(() => c.replies().find(r => /What email should they reply to\?/.test(r.text)));
  await c.say('noa@example.com');
  const sum = await c.until(() => c.replies().find(r => r.widget?.type === 'summary'));
  await c.say('', { widget: sum.widget.id, action: sum.widget.options[0].action, note: sum.widget.note }); // the check misses it
  const ref = /Reference (H-\d+)/.exec((await c.until(() => c.replies().find(r => r.text.startsWith('Sent.')))).text)![1];
  assert.equal(caseOf(ref).health, null);
  await c.say('please take it out');
  await c.until(() => c.replies().find(r => /taken that message out of our chat/.test(r.text)));
  assert.equal(caseOf(ref).health, 1, 'its words carry the detail: a person answers it, no AI draft');
  c.close();
});

// ---- the helper's measures: "Did this help?" and first words (numbers.ts), counted per app and day with nothing linked
const tally = (like: string) => (db.prepare("select coalesce(sum(n), 0) as n from tallies where app = 'shop' and name like ?").get(like) as any).n as number;
const quietFor = (ms: number) => new Promise(r => setTimeout(r, ms));

test('"Did this help?" comes once, after an answer from the knowledge and a pause; a Yes is a count, with nothing kept in the chat', async () => {
  fake.script(() => [{ text: 'Yes, we ship to Belgium: 3 to 5 working days.' }, { tool: 'answered', input: { from: 'knowledge' } }]);
  const asked = tally('helped_asked'), yes = tally('helped_yes');
  const c = await customer();
  const conv = chatOf(c);
  await c.say('Do you ship to Belgium?');
  const answer = await c.until(() => c.replies().find(r => /Belgium/.test(r.text)));
  assert.ok(!c.replies().some(r => r.widget?.type === 'helped'), 'not with the answer: after a pause');
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'helped'));
  assert.ok(Number(card.id.slice(1)) > Number(answer.id.slice(1)));
  assert.equal(card.text, 'Did this help?');
  assert.deepEqual(card.widget.options.map((o: any) => o.label), ['Yes', 'Not really']);
  assert.equal(tally('helped_asked'), asked + 1);
  const before = stored(conv);
  await c.say('', { widget: card.widget.id, action: card.widget.options[0].action });
  const closed = await c.until(() => c.events.find(e => e.t === 'close' && e.widget === card.widget.id));
  assert.deepEqual({ ...closed, t: undefined, widget: undefined }, { t: undefined, widget: undefined, done: true }, 'closed without saying which');
  assert.equal(tally('helped_yes'), yes + 1);
  assert.equal(stored(conv), before, 'no message for the tap');
  const row = db.prepare("select widget from messages where conversation = ? and json_extract(widget, '$.type') = 'helped'").get(conv) as any;
  assert.deepEqual(JSON.parse(row.widget).ws, { done: true });
  assert.equal((db.prepare("select count(*) as n from actions where conversation = ? and kind = 'helped'").get(conv) as any).n, 0, 'neither button’s action is kept');
  assert.equal(engine.live(conv)!.conv.state.helped, 'answered');
  // another answer from the knowledge: never asked twice
  await c.say('And to Germany?');
  await c.until(() => c.replies().filter(r => /Belgium/.test(r.text)).length === 2);
  await quietFor(900);
  assert.equal(c.replies().filter(r => r.widget?.type === 'helped').length, 1);
  assert.equal(tally('helped_asked'), asked + 1);
  c.close();
});

test('"Did this help?" after an order was looked up; "Not really" gets one line, shown and not kept', async () => {
  fake.script(o => Array.isArray(o.messages.at(-1)!.content) ? [{ text: 'It shipped on Monday with UPS.' }, { tool: 'answered', input: { from: 'order' } }]
    : [{ tool: 'check_order', input: { order: 'ORD-NORA-Z1', email: 'nora@example.com' } }]);
  const no = tally('helped_no');
  const c = await customer();
  const conv = chatOf(c);
  await c.say('Where is ORD-NORA-Z1? nora@example.com');
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'helped'));
  await c.say('', { widget: card.widget.id, action: card.widget.options[1].action });
  const line = await c.until(() => c.replies().find(r => r.text === 'If that doesn’t work for you, a person can look at it: just ask.'));
  assert.ok(line);
  assert.equal(tally('helped_no'), no + 1);
  assert.equal((db.prepare('select count(*) as n from messages where conversation = ? and text like ?').get(conv, 'If that doesn’t work%') as any).n, 0, 'the line isn’t kept');
  assert.ok(!(await c.post('hello', { lang: 'en' })).items.some((i: any) => /doesn’t work for you/.test(i.text ?? '')));
  c.close();
});

test('"Did this help?" isn’t asked for an answer without words, an order nobody looked up, or once they asked for a person', async () => {
  const asked = tally('helped_asked');
  fake.script(o => Array.isArray(o.messages.at(-1)!.content) ? [{ text: 'It’s on its way.' }] : [{ tool: 'answered', input: { from: 'knowledge' } }]);
  const w = await customer(); // answered with no words yet: refused, and the words that follow aren't an outcome
  await w.say('Is it coming?');
  await w.until(() => w.replies().find(r => /on its way/.test(r.text)));
  fake.script(() => [{ text: 'It’s on its way.' }, { tool: 'answered', input: { from: 'order' } }]);
  const b = await customer();
  await b.say('Where is my order?');
  await b.until(() => b.replies().find(r => /on its way/.test(r.text)));
  fake.script(() => [{ text: 'Blankets ship in a box.' }, { tool: 'answered', input: { from: 'knowledge' } }]);
  const d = await customer();
  await d.say('Email a person', { menu: 'person' });
  await d.until(() => d.replies().find(r => /What email should they reply to\?/.test(r.text)));
  await d.say('How does it ship?');
  await d.until(() => d.replies().find(r => /in a box/.test(r.text)));
  await quietFor(900);
  for (const x of [w, b, d]) assert.ok(!x.replies().some(r => r.widget?.type === 'helped'));
  assert.equal(tally('helped_asked'), asked);
  w.close(); b.close(); d.close();
});

test('"Did this help?" tapped while a draft runs stays answered when that draft is dropped', async () => {
  fake.script(() => [{ text: 'Yes, gift wrap is free.' }, { tool: 'answered', input: { from: 'knowledge' } }]);
  const c = await customer();
  const conv = chatOf(c);
  await c.say('Is gift wrap free?');
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'helped'));
  fake.script(() => [{ wait: 600 }, { text: 'Sure.' }]);
  await c.say('one more thing');
  await c.until(() => engine.live(conv)!.draft); // the draft is running
  await c.say('', { widget: card.widget.id, action: card.widget.options[0].action });
  await c.say('actually, two'); // the running draft is dropped, and the state it started from comes back
  await c.until(() => c.replies().find(r => r.text === 'Sure.'));
  assert.equal(engine.live(conv)!.conv.state.helped, 'answered');
  c.close();
});

test('"Did this help?" tapped after the email grant lapsed counts nothing in the new chat and keeps no vote against the thread', async () => {
  const c = await checked('', 'ORD-HUGO-Y1', 'hug@example.com');
  const thread = convOf('hug@example.com');
  const l = engine.live(thread)!;
  l.closeWidget(l.openWidget()!.id, { done: true }); // the widget sends the code box's id with the code; checked() doesn't
  await quietFor(1600); // past the gap after the last draft
  fake.script(() => [{ text: 'Yes, gift wrap is free.' }, { tool: 'answered', input: { from: 'knowledge' } }]);
  await c.say('Is gift wrap free?');
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'helped'));
  db.prepare('update sessions set email_seen = email_seen - 25 * 3600000 where conversation = ?').run(thread); // a day unused
  assert.equal((await c.post('hello', { lang: 'en' })).level, 0);
  const conv = (db.prepare("select conversation from sessions where conversation is not null order by seen desc limit 1").get() as any).conversation;
  assert.notEqual(conv, thread, 'a new chat');
  const yes = tally('helped_yes'), no = tally('helped_no');
  await c.say('', { widget: card.widget.id, action: card.widget.options[0].action });
  assert.equal((db.prepare("select count(*) as n from actions where conversation = ? and kind = 'helped'").get(thread) as any).n, 0, 'no vote kept against the thread');
  assert.equal(engine.live(conv)!.conv.state.helped, undefined, 'the new chat was never asked');
  assert.deepEqual([tally('helped_yes'), tally('helped_no')], [yes, no]);
  assert.equal((db.prepare('select count(*) as n from messages where conversation = ? and who = ?').get(conv, 'me') as any).n, 0, 'nothing stored for the tap');
  c.close();
});

test('first words are counted per reply, plain and looked up apart, from the customer’s message to the first bubble', async () => {
  const plain = tally('fw_plain:%'), lookup = tally('fw_lookup:%');
  const steps = (kind: string) => (db.prepare("select name, n from tallies where app = 'shop' and name like ?").all(`fw_${kind}:%`) as any[]);
  const before = new Map(steps('plain').map(r => [r.name, r.n]));
  fake.script(() => [{ wait: 450 }, { text: 'Hello there.' }]);
  const c = await customer();
  await c.say('hi');
  await c.until(() => c.replies().find(r => r.text === 'Hello there.'));
  assert.equal(tally('fw_plain:%'), plain + 1);
  const grew = steps('plain').find(r => r.n !== (before.get(r.name) ?? 0))!;
  assert.ok(Number(grew.name.split(':')[1]) >= 600, `the 150 ms breath and the model's 450 ms are in it (${grew.name})`);
  fake.script(o => Array.isArray(o.messages.at(-1)!.content) ? [{ text: 'I can’t find that one.' }] : [{ tool: 'order_status', input: { order: 'ORD-NOPE' } }]);
  await c.say('where is ORD-NOPE?');
  await c.until(() => c.replies().find(r => /can’t find/.test(r.text)));
  assert.equal(tally('fw_lookup:%'), lookup + 1);
  assert.equal(tally('fw_plain:%'), plain + 1);
  // the server's own template steps (the way to a person) aren't the helper's answers: nothing counted
  await c.say('Email a person', { menu: 'person' });
  await c.until(() => c.replies().find(r => /What email should they reply to\?/.test(r.text)));
  assert.equal(tally('fw_plain:%') + tally('fw_lookup:%'), plain + lookup + 2);
  c.close();
});

test('a turn is timed whole, with its model calls, its tools and its rounds, under the provider it ran on', async () => {
  const timing = () => numbers.counts('shop', numbers.dayOf(now())).timing;
  const totals = () => {
    const histograms = timing();
    const total = (what: string) => Object.values(histograms[`fake.chat.${what}.done`] ?? {}).reduce((sum, n) => sum + n, 0);
    return { turn: total('turn'), model: total('model'), tool: total('tool'), two: histograms['fake.chat.rounds.done']?.['2'] ?? 0 };
  };
  const was = totals();
  const before = timing()['fake.chat.turn.done'] ?? {};
  fake.script(o => Array.isArray(o.messages.at(-1)!.content) ? [{ wait: 300 }, { text: 'I can’t find ORD-LATE.' }] : [{ tool: 'order_status', input: { order: 'ORD-LATE' } }]);
  const c = await customer();
  await c.say('where is ORD-LATE?');
  await c.until(() => c.replies().find(r => /ORD-LATE/.test(r.text)));
  assert.deepEqual(totals(), { turn: was.turn + 1, model: was.model + 2, tool: was.tool + 1, two: was.two + 1 });
  const longest = Math.max(...Object.entries(timing()['fake.chat.turn.done']).filter(([at, n]) => n > (before[at] ?? 0)).map(([at]) => Number(at)));
  assert.ok(longest >= 300, `the second round's 300 ms is in the turn (${longest})`);
  c.close();
});

test('words written before a lookup never reach the customer, and the next round sees its turn as they did: only the words after the results', async () => {
  seen.length = 0;
  const results = (o: any) => o.messages.filter((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result')).length;
  fake.script(o => {
    seen.push(o.messages);
    if (results(o) === 0) return [{ text: 'Sorry about that.\n\n' }, { text: 'I’ll look at your order first.' }, { tool: 'order_status', input: { order: 'ORD-NOPE' } }];
    if (results(o) === 1) return [{ text: 'The system note says I can go ahead, so I’ll check again.' }, { tool: 'order_status', input: { order: 'ORD-NOPE' } }];
    return [{ text: 'Sorry, I can’t find that order.' }];
  });
  const c = await customer();
  await c.say('where is ORD-NOPE?');
  await c.until(() => c.replies().find(r => /can’t find that order/.test(r.text)));
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(c.replies().map(r => r.text), ['Sorry, I can’t find that order.']);
  assert.ok(c.events.some(e => e.t === 'line' && e.text), 'the status line covered the wait');
  assert.equal(seen.length, 3);
  for (const turn of seen.slice(1).flatMap(ms => ms.filter((m: any) => m.role === 'assistant')))
    assert.ok(!turn.content.some((b: any) => b.type === 'text'), 'no later round sees words the customer never did');
  assert.equal(db.prepare("select count(*) as n from messages where conversation = ? and (text like '%look at your order%' or text like '%system note%')").get(chatOf(c)).n, 0);
  c.close();
});

test('a round whose first paragraph went out before its tool call: the next call sees that paragraph, not the ones taken back', async () => {
  seen.length = 0;
  fake.script(o => {
    seen.push(o.messages);
    if (!o.messages.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result')))
      return [{ text: 'I can help.\n\nHere are the steps you need.\n\n' }, { tool: 'order_status', input: { order: 'ORD-NOPE' } }];
    return [{ text: 'Sorry, I can’t find that order.' }];
  });
  const c = await customer();
  await c.say('where is ORD-NOPE?');
  await c.until(() => c.replies().find(r => /can’t find that order/.test(r.text)));
  assert.deepEqual(c.replies().map(r => r.text), ['I can help.', 'Sorry, I can’t find that order.']);
  const turn = seen[1].find((m: any) => m.role === 'assistant' && Array.isArray(m.content));
  assert.deepEqual(turn.content.filter((b: any) => b.type === 'text').map((b: any) => b.text), ['I can help.']);
  c.close();
});

test('the closing call counts only words written after the last lookup result: answered after a lookup with none is sent back', async () => {
  fake.script(o => {
    const last = o.messages.at(-1)!.content;
    if (!Array.isArray(last)) return [{ text: 'Let me look that up.' }, { tool: 'order_status', input: { order: 'ORD-NOPE' } }];
    // the turn says which result this is: the lookup's (answered, with no words of this round), or answered's own
    const asked = (o.messages.at(-2)!.content as any[]).find(b => b.type === 'tool_use').name;
    if (asked === 'order_status') return [{ tool: 'answered', input: { from: 'knowledge' } }];
    return [{ text: 'I can’t find that one.' }, { tool: 'answered', input: { from: 'knowledge' } }];
  });
  const c = await customer();
  await c.say('where is ORD-NOPE?');
  await c.until(() => c.replies().find(r => /can’t find that one/.test(r.text)));
  await c.until(() => !engine.live(chatOf(c))!.draft); // the answer is over: nothing more comes
  assert.deepEqual(c.replies().map(r => r.text), ['I can’t find that one.']);
  c.close();
});

test('a plain answer still streams: its first bubble goes out while the model is still writing the last', async () => {
  let open!: () => void;
  const gate = new Promise<void>(r => { open = r; });
  fake.script(() => [{ text: 'One, the first part.\n\nTwo, the second part.\n\n' }, { until: gate }, { text: 'Three, the last part.' }]);
  const c = await customer();
  await c.say('a question');
  await c.until(() => c.replies().find(r => /^One/.test(r.text)));
  open(); // the model writes the last part only now, once the first bubble is out
  await c.until(() => c.replies().find(r => /^Three/.test(r.text)));
  assert.deepEqual(c.replies().map(r => r.text), ['One, the first part.', 'Two, the second part.', 'Three, the last part.']);
  c.close();
});

test('a last round that writes nothing, after the words before the lookups were taken back: the model is asked once for its answer', async () => {
  seen.length = 0;
  const results = (o: any) => o.messages.filter((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result')).length;
  fake.script(o => {
    seen.push(o.messages);
    if (results(o) === 0) return [{ text: 'Let me look.' }, { tool: 'order_status', input: { order: 'ORD-NOPE' } }];
    if (results(o) === 1) return [{ text: 'One more look.' }, { tool: 'order_status', input: { order: 'ORD-NOPE' } }];
    // the third call writes nothing; the fourth sees the note under the results
    return (o.messages.at(-1)!.content as any[]).some(b => b.type === 'text') ? [{ text: 'Sorry, I can’t find that order.' }] : [];
  });
  const c = await customer();
  await c.say('where is ORD-NOPE?');
  await c.until(() => c.replies().find(r => /can’t find that order/.test(r.text)));
  await c.until(() => !engine.live(chatOf(c))!.draft);
  assert.deepEqual(c.replies().map(r => r.text), ['Sorry, I can’t find that order.']);
  assert.ok(seen.length <= 4, 'one more call, no more');
  c.close();
});

test('a round a tool ends with its card keeps its words: they go out, the card under them', async () => {
  fake.script(o => {
    const last = o.messages.at(-1)!.content;
    if (!Array.isArray(last)) return [{ text: 'Let me check that order.' }, { tool: 'order_status', input: { order: 'ORD-NOPE' } }];
    return [{ text: 'I can’t find it, and the page may be at fault.\n\nCould you send the team a snapshot?' }, { tool: 'offer_snapshot', input: { problem: 'the order page' } }];
  });
  const c = await customer();
  await c.say('my order page is blank, ORD-NOPE');
  const card = await c.until(() => c.replies().find(r => r.widget?.type === 'consent'));
  assert.equal(card.text, 'Could you send the team a snapshot?');
  assert.deepEqual(c.replies().map(r => r.text), ['I can’t find it, and the page may be at fault.', 'Could you send the team a snapshot?']);
  c.close();
});

test('a tool that speaks for its round: the model\'s words beside the call are taken back, the ones it gave the tool to say stay', async () => {
  const offer = { def: { name: 'show_offer', description: 'Shows the offer.', input_schema: { type: 'object', properties: { also: { type: 'string' } } } },
    run: async (c: any, _s: any, input: any) => { c.out.modelSays(input.also); c.out.say('The server’s offer.'); return { content: '{}', done: true, speaks: true as const }; } };
  await withSetting('tools', [offer], async () => {
    fake.script(() => [{ text: 'They asked for the offer, so I show it.' }, { tool: 'show_offer', input: { also: 'And yes, I’m an AI.' } }]);
    const c = await customer();
    await c.say('show me the offer, and are you an AI?');
    await c.until(() => c.replies().find(r => r.text === 'The server’s offer.'));
    await c.until(() => !engine.live(chatOf(c))!.draft);
    assert.deepEqual(c.replies().map(r => r.text), ['And yes, I’m an AI.', 'The server’s offer.']);
    c.close();
  });
});

// Someone else holding the same cookie (a planted one) reads the customer's words, then speaks last
const proofModel = () => fake.script(o => {
  if (Array.isArray(o.messages.at(-1)!.content)) return [{ text: 'Found it.' }];
  const all = o.messages.map(words).join('\n'), order = /ORD-[A-Z0-9]{4}-[A-Z0-9]{2}/.exec(all), mail = /\b[a-z]{3}@example\.com/.exec(all);
  return order && mail ? [{ tool: 'check_order', input: { order: order[0], email: mail[0] } }] : [{ text: 'OK.' }];
});

test('a check the model ran is held for the page that typed the proof, not for another holder of the cookie who spoke last', async () => {
  proofModel();
  await new Promise(r => setTimeout(r, 1600)); // past the gap after the last draft
  const attacker = await customer('', { renews: false });
  const victim = await customer(attacker.cookie(), { renews: false }); // the attacker's cookie, planted in the customer's browser
  await victim.say('my order ORD-MIRA-Y6, mir@example.com');
  const read = await attacker.post('hello', { lang: 'en' });
  assert.ok(read.items.some((i: any) => /ORD-MIRA-Y6/.test(i.text ?? '')), 'the other holder reads the customer’s words');
  await attacker.say('ok');                       // from its own page, before the draft starts: the draft answers both
  await victim.until(() => victim.events.some(e => e.t === 'renew'));
  await attacker.until(() => attacker.events.some(e => e.t === 'renew'));
  assert.deepEqual(await attacker.post('renew'), { retry: true }, 'the page that spoke last can’t take the grant, even asking first');
  assert.deepEqual(await victim.post('renew'), { ok: true }, 'the page that typed the order number and email takes it');
  assert.equal((await victim.post('hello', { lang: 'en' })).level, 1);
  const theirs = await attacker.post('hello', { lang: 'en' }); // its cookie is dead: a fresh session
  assert.equal(theirs.level, 0);
  assert.ok(!theirs.items.some((i: any) => /ORD-MIRA-Y6|Found it/.test(i.text ?? '')));
  attacker.close(); victim.close();
});

test('an order number and an email typed on two pages prove nothing in that chat: no grant, typed again or not; a new chat checks them', async () => {
  const results: string[] = [];
  fake.script(o => {
    const last = o.messages.at(-1);
    if (Array.isArray(last.content)) { results.push(last.content[0].content); return [{ text: 'I can’t check that here.' }]; }
    const all = o.messages.map(words).join('\n');
    return /ORD-NOAH-Y7/.test(all) && /noa@example\.com/.test(all) ? [{ tool: 'check_order', input: { order: 'ORD-NOAH-Y7', email: 'noa@example.com' } }] : [{ text: 'OK.' }];
  });
  await new Promise(r => setTimeout(r, 1600));
  const one = await customer('', { renews: false });
  const two = await customer(one.cookie(), { renews: false }); // the same cookie on another page
  await one.say('my order is ORD-NOAH-Y7');
  await one.until(() => one.replies().some(r => r.text === 'OK.'));
  await two.say('noa@example.com');
  await one.until(() => results.length === 1);
  assert.match(results[0], /"match":false.*No check was made/);
  const granted = () => db.prepare("select 1 from sessions where orders like '%ORD-NOAH-Y7%'").get();
  assert.ok(!one.events.some(e => e.t === 'renew') && !granted(), 'no grant');
  // typed again on one page, both in one message: the order number is still on two pages, so still no check
  await new Promise(r => setTimeout(r, 1600));
  await two.say('ORD-NOAH-Y7 noa@example.com');
  await two.until(() => results.length === 2);
  assert.match(results[1], /"match":false.*No check was made/);
  assert.ok(![...one.events, ...two.events].some(e => e.t === 'renew') && !granted(), 'still no grant');
  // the delete step's "this device only" (forget): a new chat, where both typed on one page are checked and held for it
  await two.post('forget');
  two.close(); one.close();
  await new Promise(r => setTimeout(r, 1600));
  const fresh = await customer('', { renews: false });
  await fresh.say('ORD-NOAH-Y7 noa@example.com');
  await fresh.until(() => results.length === 3);
  assert.match(results[2], /"match":true/);
  assert.deepEqual(await fresh.post('renew'), { ok: true });
  fresh.close();
});

// The other holder doesn't just speak last, it types the customer's proof again from its own page
test('an order number and email the other holder of the cookie typed again after reading them prove nothing for either page', async () => {
  const results: string[] = [];
  fake.script(o => {
    const last = o.messages.at(-1);
    if (Array.isArray(last.content)) { results.push(last.content[0].content); return [{ text: 'I can’t check that here.' }]; }
    const all = o.messages.map(words).join('\n'); // checked once it's typed twice, so the check sees both copies
    return (all.match(/ORD-OLGA-Y8/g) ?? []).length > 1 ? [{ tool: 'check_order', input: { order: 'ORD-OLGA-Y8', email: 'olg@example.com' } }] : [{ text: 'OK.' }];
  });
  await new Promise(r => setTimeout(r, 1600));
  const victim = await customer('', { renews: false });
  await victim.say('my order ORD-OLGA-Y8, olg@example.com');
  const attacker = await customer(victim.cookie(), { renews: false }); // the cookie, planted or copied
  assert.ok(attacker.hello.items.some((i: any) => /ORD-OLGA-Y8/.test(i.text ?? '')), 'the other holder reads the customer’s words');
  await attacker.say('my order ORD-OLGA-Y8, olg@example.com'); // typed again, from its own page: now the newest
  await victim.until(() => results.length === 1);
  assert.match(results[0], /"match":false.*No check was made/);
  await new Promise(r => setTimeout(r, 300));
  assert.ok(![...victim.events, ...attacker.events].some(e => e.t === 'renew'), 'no grant held for any page');
  assert.ok(!db.prepare("select 1 from sessions where orders like '%ORD-OLGA-Y8%'").get(), 'no grant');
  assert.equal((await attacker.post('hello', { lang: 'en' })).level, 0);
  victim.close(); attacker.close();
});

test('a code the other holder of the cookie typed again after reading it proves nothing in the chat; the code box still works', async () => {
  const results: string[] = [];
  fake.script(o => {
    const last = o.messages.at(-1);
    if (Array.isArray(last.content)) { results.push(last.content.map((b: any) => b.content).join('\n')); return [{ text: 'Done.' }]; }
    const all = o.messages.map(words).join('\n'), codes = all.match(/\b\d{6}\b/g) ?? [];
    if (codes.length > 1) return [{ tool: 'check_code', input: { code: codes[0] } }]; // checked once it's typed twice
    return /ORD-PIET-Y9/.test(words(last)) ? [{ tool: 'check_order', input: { order: 'ORD-PIET-Y9', email: 'pie@example.com' } }, { tool: 'send_code', input: {} }] : [{ text: 'OK.' }];
  });
  await new Promise(r => setTimeout(r, 1600));
  const victim = await customer();
  await victim.say('ORD-PIET-Y9, pie@example.com');
  await victim.until(() => email.outbox.find(m => m.kind === 'code' && m.to === 'pie@example.com'));
  await victim.until(() => victim.replies().find(r => r.widget?.type === 'code_entry'));
  await new Promise(r => setTimeout(r, 300)); // its renew is done: level 1, held for nobody
  const code = /\b(\d{6})\b/.exec(email.outbox.filter(m => m.kind === 'code' && m.to === 'pie@example.com').at(-1)!.text)![1];
  await new Promise(r => setTimeout(r, 1600));
  await victim.say(`it's ${code}`);
  const attacker = await customer(victim.cookie(), { renews: false });
  assert.ok(attacker.hello.items.some((i: any) => (i.text ?? '').includes(code)), 'the other holder reads the code');
  await attacker.say(code);
  await victim.until(() => results.some(r => /No check was made/.test(r)));
  assert.ok(!results.some(r => /"ok":true/.test(r)));
  await new Promise(r => setTimeout(r, 300));
  assert.ok(!attacker.events.some(e => e.t === 'renew' || e.t === 'level'), 'nothing raised for the other page');
  assert.notEqual((await attacker.post('hello', { lang: 'en' })).level, 2);
  assert.notEqual((await victim.post('hello', { lang: 'en' })).level, 2);
  // the code box checks on the POST itself, for the page that sends it
  assert.deepEqual(await victim.post('code', { code }), { ok: true, level: 2 });
  assert.notEqual((await attacker.post('hello', { lang: 'en' })).level, 2, 'the other page doesn’t get the checked session');
  victim.close(); attacker.close();
});

// A second check in the same model run, typed on another page, mustn't take over the first's hold
test('a grant held for the page that typed a code isn’t rebound by a check typed on another page in the same model run', async () => {
  const results: string[] = [];
  fake.script(o => {
    const last = o.messages.at(-1);
    if (Array.isArray(last.content)) { results.push(last.content.map((b: any) => b.content).join('\n')); return [{ text: 'Done.' }]; }
    const all = o.messages.map(words).join('\n'), code = /\b\d{6}\b/.exec(all);
    if (code && /ORD-RUBY-Y11/.test(all)) return [{ tool: 'check_code', input: { code: code[0] } }, { tool: 'check_order', input: { order: 'ORD-RUBY-Y11', email: 'rub@example.com' } }];
    return /ORD-QUIN-Y10/.test(words(last)) ? [{ tool: 'check_order', input: { order: 'ORD-QUIN-Y10', email: 'qui@example.com' } }, { tool: 'send_code', input: {} }] : [{ text: 'OK.' }];
  });
  await new Promise(r => setTimeout(r, 1600));
  const victim = await customer('', { renews: false });
  await victim.say('ORD-QUIN-Y10, qui@example.com');
  await victim.until(() => victim.events.some(e => e.t === 'renew'));
  assert.deepEqual(await victim.post('renew'), { ok: true }); // level 1, held for nobody now
  await victim.until(() => email.outbox.find(m => m.kind === 'code' && m.to === 'qui@example.com'));
  await victim.until(() => victim.replies().find(r => r.widget?.type === 'code_entry'));
  const code = /\b(\d{6})\b/.exec(email.outbox.filter(m => m.kind === 'code' && m.to === 'qui@example.com').at(-1)!.text)![1];
  await new Promise(r => setTimeout(r, 1600));
  const other = await customer(victim.cookie(), { renews: false }); // the cookie on another page, planted or copied
  const renews = (c: typeof other) => c.events.filter(e => e.t === 'renew').length;
  const before = renews(victim);
  // both before the draft starts: one run checks the victim's code (held for its page), then the other page's own order
  await victim.say(`it's ${code}`);
  await other.say('ORD-RUBY-Y11, rub@example.com');
  await victim.until(() => results.length === 1);
  assert.match(results[0], /"ok":true/);
  assert.match(results[0], /"match":false.*No check was made/);
  await victim.until(() => renews(victim) > before);
  await other.until(() => renews(other) > 0);
  assert.deepEqual(await other.post('renew'), { retry: true }, 'the other page can’t take the code’s grant, even asking first');
  assert.deepEqual(await victim.post('renew'), { ok: true }, 'the page that typed the code takes it');
  assert.equal((await victim.post('hello', { lang: 'en' })).level, 2);
  assert.equal((await other.post('hello', { lang: 'en' })).level, 0); // its cookie is dead: a fresh session
  assert.ok(!db.prepare("select 1 from sessions where orders like '%ORD-RUBY-Y11%'").get(), 'the other page’s order was never granted');
  victim.close(); other.close();
});

test('an order checked and taken up on one page, checked again after a reload (a new page): nothing is held, the session lives on', async () => {
  const results: string[] = [];
  fake.script(o => {
    const last = o.messages.at(-1)!;
    if (Array.isArray(last.content)) { results.push(last.content.map((b: any) => b.content).join('\n')); return [{ text: 'Found it.' }]; }
    return /ORD-SVEN-Y12|again/.test(words(last)) ? [{ tool: 'check_order', input: { order: 'ORD-SVEN-Y12', email: 'sve@example.com' } }] : [{ text: 'OK.' }];
  });
  await new Promise(r => setTimeout(r, 1600));
  const a = await customer('', { renews: false });
  await a.say('ORD-SVEN-Y12, sve@example.com');
  await a.until(() => a.events.some(e => e.t === 'renew'));
  assert.deepEqual(await a.post('renew'), { ok: true }); // the grant, taken up by the page that typed it
  a.close();
  const b = await customer(a.cookie(), { renews: false }); // the reload: the same cookie, a new page
  assert.equal(b.hello.level, 1);
  await new Promise(r => setTimeout(r, 1600));
  await b.say('can you check that order again?'); // the values were typed on page a, which is gone
  await b.until(() => results.length === 2);
  assert.match(results[1], /"match":true/);
  await new Promise(r => setTimeout(r, 300));
  assert.ok(!b.events.some(e => e.t === 'renew'), 'nothing rose, so no new id is asked for');
  db.prepare('update sessions set rotate_at = rotate_at - 120000 where rotate_at is not null').run(); // past the hold time
  assert.equal((await b.post('hello', { lang: 'en' })).level, 1, 'the session still holds the order from the new page');
  const r = await b.say('thanks');
  assert.ok(!r.retry, 'and the new page may use it');
  b.close();
});

test.after(() => { shop.close(); hqServer.close(); setTimeout(() => process.exit(0), 50); });
