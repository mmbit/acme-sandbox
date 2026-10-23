// node --test src/shop.test.ts
// One chat for a shop of several apps (config.ts SHOPS): the real server with the template's plug-in, the fake model, and two
// local servers playing two apps' order endpoints, Bud and Hui, as stalls of the shop "front" on one origin. One session
// and one conversation across the stalls; each order checked by its own app; a checked email's orders from every stall;
// the stall dresses the helper and never decides what she may show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VIEW = { ref: 'R-1', title: 'A thing', status: 'shipped', shipped_at: '2026-09-28T09:00:00Z', delivered_at: null, carrier: 'UPS',
  tracking_url: 'https://www.ups.com/x', country: 'NL', total_cents: 2500, address_masked: 'Street 1' };
// each app's orders (id, email, placed): Bud's BUD-1 and Hui's HUI-1 are Anna's; both apps have a 1001 of Ben's
const ORDERS: Record<string, { id: string; email: string; placed: string }[]> = {
  bud: [{ id: 'BUD-1', email: 'anna@example.com', placed: '2026-09-20' }, { id: '1001', email: 'ben@example.com', placed: '2026-09-21' },
    { id: 'BUD-CARA', email: 'cara@example.com', placed: '2026-09-22' }],
  hui: [{ id: 'HUI-1', email: 'anna@example.com', placed: '2026-09-25' }, { id: '1001', email: 'ben@example.com', placed: '2026-09-26' }],
};
const asked: string[] = []; // `<app> <path>`, each call an app's endpoint got
const down = new Set<string>(); // apps whose endpoint answers 503
const endpoint = (app: string) => createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d).on('end', () => {
    if (req.headers.authorization !== `Bearer token-${app}`) return void res.writeHead(401).end();
    if (down.has(app)) return void res.writeHead(503).end();
    asked.push(`${app} ${req.url}`);
    const b = JSON.parse(body), json = (o: object) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    const view = (o: typeof ORDERS.bud[0]) => ({ ...VIEW, id: o.id, placed_at: `${o.placed}T10:00:00Z`, title: `${app}'s thing` });
    const mine = ORDERS[app];
    if (req.url === '/api/care/match') { const o = mine.find(x => x.id === b.order?.toUpperCase() && x.email === b.email?.toLowerCase()); return json(o ? { match: true, order: view(o) } : { match: false }); }
    if (req.url === '/api/care/orders') return json({ orders: mine.filter(x => x.email === b.email).map(view) });
    res.writeHead(404).end();
  });
});
const servers = { bud: endpoint('bud'), hui: endpoint('hui') };
for (const s of Object.values(servers)) await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
const url = (app: 'bud' | 'hui') => `http://127.0.0.1:${(servers[app].address() as any).port}/`;

const PORT = 20000 + Math.floor(Math.random() * 20000);
Object.assign(process.env, { DATA_DIR: mkdtempSync(join(tmpdir(), 'care-shop-')), PORT: String(PORT), CARE_LOCAL: '1', CARE_PROVIDER: 'fake',
  CARE_APPS: JSON.stringify({ bud: url('bud'), hui: url('hui') }), CARE_TOKENS: JSON.stringify({ bud: 'token-bud', hui: 'token-hui' }),
  CARE_SHOPS: JSON.stringify({ front: ['bud', 'hui'] }), CARE_NAMES: JSON.stringify({ front: 'The Shop', bud: 'Bud', hui: 'Hui' }),
  CARE_COMPANY_DIR: new URL('../../../template/products/care', import.meta.url).pathname });
const fake = await import('./fake.ts');
const { db } = await import('./db.ts');
const email = await import('./email.ts');
const gate = await import('./gate.ts');
const numbers = await import('./numbers.ts');
await import('./server.ts');
await new Promise(r => setTimeout(r, 100));

// ---- a customer's browser: one cookie jar for the whole origin, a page on a stall at a time (as Caddy says it)
const BASE = `http://127.0.0.1:${PORT}`;
async function browser(stall: string, shop: string | null = 'front') {
  let cookie = '';
  const ip = `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, tab = crypto.randomUUID();
  const page = { stall, shop };
  const headers = () => ({ 'x-care-app': page.stall, ...(page.shop ? { 'x-care-shop': page.shop } : {}), origin: BASE, 'content-type': 'application/json',
    'x-forwarded-for': ip, 'x-care-tab': tab, ...(cookie ? { cookie } : {}) });
  const post = async (path: string, body: any = {}) => {
    const r = await fetch(`${BASE}/__care/api/${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    const set = r.headers.getSetCookie().filter(c => c.startsWith('__Host-care=')).at(-1);
    if (set) cookie = set.split(';')[0];
    return { status: r.status, ...(await r.json() as any) };
  };
  let n = 0;
  // a message (or a card's tap: answer), then the conversation once the helper's answer to it is there (a reply after it:
  // its text, or its card's type)
  const say = async (text: string, done: RegExp, answer?: object) => {
    await post('say', { id: `c${++n}`, text, ...(answer ? { answer } : {}) });
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      const r = await post('renew'); // a grant the model raised is held for this page: take it, as the widget does
      if (r.status === 200) {
        const h = await post('hello', { lang: 'en' }), after = h.items?.slice(h.items.findLastIndex((i: any) => i.k === 'me' && i.text.startsWith(text)) + 1) ?? [];
        if (after.some((i: any) => i.k === 'ai' && (done.test(i.text ?? '') || done.test(i.w?.type ?? '')))) return h;
      }
      await new Promise(r => setTimeout(r, 30));
    }
    throw new Error(`no answer matching ${done}`);
  };
  // the stall the next requests come from: another shelf of the same shop, same cookie
  const go = (stall: string) => { page.stall = stall; };
  return { post, say, go, cookie: () => cookie };
}
const lastTool = (o: any) => { const c = o.messages.at(-1).content; return Array.isArray(c) ? JSON.parse(c.at(-1).content) : null; };

test('one session and one conversation across the stalls of a shop: the next stall carries on the same chat, in its own apron', async () => {
  fake.script(() => [{ text: 'Hello from the shop.' }]);
  const b = await browser('bud');
  const first = await b.post('hello', { lang: 'en' });
  assert.equal(first.name, 'Bud'); assert.equal(first.stall, 'bud');
  await b.say('do you ship to Belgium?', /Hello from the shop/);
  b.go('hui');
  const there = await b.post('hello', { lang: 'en' });
  assert.equal(there.status, 200);
  assert.equal(there.name, 'Hui', 'the helper wears the stall\'s name');
  assert.equal(there.stall, 'hui', 'and the widget is told which stall it\'s in (its costume)');
  assert.ok(there.items.some((i: any) => i.text === 'do you ship to Belgium?'), 'the same conversation');
  assert.equal((db.prepare('select count(*) as n from sessions').get() as any).n, 1, 'one session');
});

test('the helper reads the stall the customer is in: its instructions and knowledge, and the facts say which stall and that every stall\'s orders can be checked', async () => {
  const seen: any[] = [];
  fake.script(o => { seen.push(o); return [{ text: 'Sure.' }]; });
  const b = await browser('bud');
  await b.post('hello', { lang: 'en' });
  await b.say('a question on Bud', /Sure/);
  b.go('hui');
  await b.say('and one on Hui', /Sure/);
  assert.match(seen[0].cached, /\bBud\b/); assert.doesNotMatch(seen[0].cached, /\bHui\b/);
  assert.match(seen.at(-1).cached, /\bHui\b/, 'the stall the message came from');
  for (const name of ['The Shop', 'Bud', 'Hui']) assert.match(seen.at(-1).system, new RegExp(`\\b${name}\\b`), 'the facts name the shop and its stalls');
});

test('a stall Caddy didn\'t put in the shop is refused, and without a shop an app is a shop of its own (the shop\'s cookie isn\'t its session)', async () => {
  const b = await browser('bud');
  await b.post('hello', { lang: 'en' });
  b.go('other');
  assert.equal((await b.post('hello', { lang: 'en' })).status, 400, 'not one of front\'s stalls');
  const alone = await browser('bud', null); // bud's own host: a shop of one
  const r = await alone.post('hello', { lang: 'en' });
  assert.equal(r.status, 200);
  const s = db.prepare('select shop from sessions order by created desc limit 1').get() as any;
  assert.equal(s.shop, 'bud');
});

test('an order is checked by its own app, whichever stall the customer types it in: the grant carries the app, and the chat\'s spend goes to it', async () => {
  fake.script(o => {
    const r = lastTool(o);
    if (r?.match) return [{ text: `Found ${r.order.id} from ${r.order.from} (${r.order.app}).` }];
    return [{ tool: 'check_order', input: { order: 'BUD-1', email: 'anna@example.com' } }];
  });
  asked.length = 0;
  const b = await browser('hui'); // in Hui's stall, about a Bud order
  await b.post('hello', { lang: 'en' });
  const h = await b.say('BUD-1, anna@example.com', /Found BUD-1/);
  assert.ok(h.items.some((i: any) => i.text === 'Found BUD-1 from Bud (bud).'));
  assert.deepEqual(asked.filter(a => a.endsWith('/match')).sort(), ['bud /api/care/match', 'hui /api/care/match'], 'both stalls asked; only Bud has it');
  const s = db.prepare('select orders, order_email from sessions order by seen desc limit 1').get() as any;
  assert.deepEqual(JSON.parse(s.orders), [{ app: 'bud', id: 'BUD-1' }]);
  const conv = db.prepare('select id, state from conversations order by id desc limit 1').get() as any;
  assert.deepEqual(JSON.parse(conv.state).orderApps, ['bud']);
  const rows = db.prepare('select app from ledger where conversation = ? order by id').all(conv.id) as any[];
  assert.deepEqual(rows.map(r => r.app), ['hui', 'bud'], 'the round that asked for the check is the stall\'s spend; the answer from the order, its app\'s');
});

test('a checked email sees its orders from every stall, newest first, each saying where it\'s from; order_status finds each in its own app', async () => {
  let orders: any = null, status: any = null;
  fake.script(o => {
    const r = lastTool(o), last = o.messages.at(-1);
    if (r?.orders && !orders) { orders = r.orders; return [{ tool: 'order_status', input: { order: 'BUD-1', show_tracking: false } }]; }
    if (r?.order && orders) { status = r.order; return [{ text: 'Listed.' }]; }
    if (Array.isArray(last.content)) return [{ text: 'Done.' }];
    if (/HUI-1/.test(JSON.stringify(last.content))) return [{ tool: 'check_order', input: { order: 'HUI-1', email: 'anna@example.com' } }, { tool: 'send_code', input: {} }];
    return [{ tool: 'my_orders', input: { show: true } }];
  });
  const b = await browser('bud');
  await b.post('hello', { lang: 'en' });
  await b.say('HUI-1, anna@example.com', /^code_entry$/);
  const code = /\b(\d{6})\b/.exec(email.outbox.filter(m => m.kind === 'code' && m.to === 'anna@example.com').at(-1)!.text)![1];
  assert.equal((await b.post('code', { code })).level, 2);
  await b.say('show me all my orders', /Listed/);
  assert.deepEqual(orders.map((o: any) => [o.id, o.app, o.from]), [['HUI-1', 'hui', 'Hui'], ['BUD-1', 'bud', 'Bud']]);
  assert.equal(status.id, 'BUD-1'); assert.equal(status.app, 'bud');
  assert.equal(status.total_cents, 2500, 'level 2 sees the price');
});

test('one number in two stalls: both are the customer\'s once they match, and an order tool needs the app to tell them apart', async () => {
  let checked: any = null;
  fake.script(o => {
    const r = lastTool(o);
    if (r && 'match' in r) { checked = r; return [{ text: 'Both found.' }]; }
    return [{ tool: 'check_order', input: { order: '1001', email: 'ben@example.com' } }];
  });
  const b = await browser('bud');
  await b.post('hello', { lang: 'en' });
  await b.say('1001, ben@example.com', /Both found/);
  assert.deepEqual(checked.orders.map((o: any) => o.order.app).sort(), ['bud', 'hui']);
  const s = db.prepare('select * from sessions order by seen desc limit 1').get() as any;
  const session = { id: s.id, shop: s.shop, conversation: s.conversation, orders: JSON.parse(s.orders), orderEmail: s.order_email, email: null, emailAt: null, emailSeen: null };
  assert.deepEqual(await gate.find(session, '1001'), { ok: false, why: 'several' }, 'two orders with that number: no app named, none');
  const hui = await gate.find(session, '1001', 'hui'), bud = await gate.find(session, '1001', 'bud');
  assert.equal(hui.ok && hui.view.title, "hui's thing");
  assert.equal(bud.ok && bud.app, 'bud');
});

test('the order picker\'s cards carry their app, and a tap names it: one number in two stalls is still the order picked', async () => {
  let status: any = null;
  fake.script(o => {
    const r = lastTool(o), last = o.messages.at(-1), said = JSON.stringify(last.content);
    if (r?.orders && !('match' in r)) return [{ text: 'Pick one.' }];
    if (r?.order) { status = r.order; return [{ text: 'Status given.' }]; }
    if (r) return [{ text: 'Done.' }];
    const picked = /\(1001, (\w+)\)/.exec(said);
    if (picked) return [{ tool: 'order_status', input: { order: '1001', app: picked[1], show_tracking: false } }];
    if (/1001, ben@/.test(said)) return [{ tool: 'check_order', input: { order: '1001', email: 'ben@example.com' } }, { tool: 'send_code', input: {} }];
    return [{ tool: 'my_orders', input: { show: true } }];
  });
  const b = await browser('bud');
  await b.post('hello', { lang: 'en' });
  await b.say('1001, ben@example.com', /^code_entry$/);
  const code = /\b(\d{6})\b/.exec(email.outbox.filter(m => m.kind === 'code' && m.to === 'ben@example.com').at(-1)!.text)![1];
  assert.equal((await b.post('code', { code })).level, 2);
  const h = await b.say('show me my orders', /Pick one/);
  const card = h.items.findLast((i: any) => i.w?.type === 'order_picker').w;
  assert.deepEqual(card.orders.map((o: any) => [o.id, o.app]), [['1001', 'hui'], ['1001', 'bud']]);
  const after = await b.say("The bud's thing", /Status given/, { widget: card.id, order: '1001', app: 'bud' });
  assert.ok(after.items.some((i: any) => i.k === 'me' && i.text === "The bud's thing (1001, bud)"), 'the tap\'s app goes into the words');
  assert.deepEqual([status.id, status.app, status.title], ['1001', 'bud', "bud's thing"]);
});

test('a stall that doesn\'t answer leaves no order unique: with no app named, find() says so rather than give the other stall\'s', async (t) => {
  t.after(() => down.clear());
  const at = Date.now();
  const session = { id: 'x', shop: 'front', conversation: null, orders: [], orderEmail: null, email: 'ben@example.com', emailAt: at, emailSeen: at };
  down.add('hui');
  assert.deepEqual(await gate.find(session, '1001'), { ok: false, why: 'unanswered' }, 'Bud\'s 1001 alone isn\'t known to be the one');
  assert.deepEqual(await gate.find(session, '1001', 'hui'), { ok: false, why: 'unanswered' });
  const bud = await gate.find(session, '1001', 'bud');
  assert.equal(bud.ok && bud.app, 'bud', 'the app named answered');
  down.clear();
  assert.deepEqual(await gate.find(session, '1002'), { ok: false, why: 'none' });
});

test('a check is never another app\'s: an order number in one app with another app\'s email matches nothing', async () => {
  let result: any = null;
  fake.script(o => { const r = lastTool(o); if (r) { result = r; return [{ text: 'Checked.' }]; } return [{ tool: 'check_order', input: { order: 'HUI-1', email: 'cara@example.com' } }]; });
  const b = await browser('hui');
  await b.post('hello', { lang: 'en' });
  await b.say('HUI-1, cara@example.com', /Checked/);
  assert.equal(result.match, false);
  const s = db.prepare('select orders from sessions order by seen desc limit 1').get() as any;
  assert.deepEqual(JSON.parse(s.orders), []);
});

test('Numbers counts a shop\'s conversation in each stall the customer wrote from that day', async () => {
  fake.script(() => [{ text: 'Noted.' }]);
  const day = numbers.dayOf(Date.now());
  const counts = (app: string) => numbers.again([day]).find(x => x.app === app)?.counts.conversations ?? 0;
  const before = { bud: counts('bud'), hui: counts('hui') };
  const b = await browser('bud');
  await b.post('hello', { lang: 'en' });
  await b.say('one in Bud', /Noted/);
  b.go('hui');
  await b.say('one in Hui', /Noted/);
  const conv = (db.prepare('select id from conversations order by id desc limit 1').get() as any).id;
  const per = (app: string) => (db.prepare("select count(*) as n from messages where conversation = ? and who = 'me' and app = ?").get(conv, app) as any).n;
  assert.equal(per('bud'), 1); assert.equal(per('hui'), 1);
  assert.deepEqual({ bud: counts('bud'), hui: counts('hui') }, { bud: before.bud + 1, hui: before.hui + 1 }, 'one conversation more in each');
});

test('a link from our emails opens the shop it was made for, on any of its stalls, and no other shop', async () => {
  const b = await browser('hui');
  await b.post('hello', { lang: 'en' });
  assert.equal((await b.post('link', { token: gate.makeLink('front', 'dina@example.com') })).level, 2);
  const alone = await browser('bud', null);
  await alone.post('hello', { lang: 'en' });
  assert.equal((await alone.post('link', { token: gate.makeLink('front', 'dina@example.com') })).ok, false, 'bud\'s own host is another shop');
});

test.after(() => { for (const s of Object.values(servers)) s.close(); setTimeout(() => process.exit(0), 50); });
