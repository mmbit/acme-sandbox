// node --test src/phone.test.ts   The phone's routes as the voice line meets
// them: the real server with the template's plug-in, its phone routes on a port of their own, a throwaway DATA_DIR, the
// fake model, and a local server playing two stalls' order endpoints (`code`, `view`) and HQ. The token, a turn streaming
// text and steps, the caps, the code read out (in code, never kept), order_status before and after it, the objection,
// the fault note and retention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'phone-test-stall-token';
const VIEW = {
  id: 'ORD-7Q4K-M2',
  ref: 'R-4829',
  placed_at: '2026-09-24T10:00:00Z',
  // what it is, for the phone; a stall that still sent the chat's title has it left out
  product: 'Blanket',
  title: '“Mila” blanket',
  status: 'shipped',
  shipped_at: '2026-09-28T09:00:00Z',
  delivered_at: null,
  carrier: 'UPS',
  tracking_url: 'https://www.ups.com/x',
  country: 'GB',
  total_cents: 3995,
  address_masked: 'Test Street 1, Leeds',
  town: 'Leeds',
};
// the stalls' `code` and `view` (kits/payments plays them for real): each code a stall was asked to email, by stall
const BASKET = '1234566';
const codes: { app: string; order: string; code: string; lang: string }[] = [];
// the postcodes a stall was asked to check, and the answers after a call it was asked to have emailed; every order here
// goes to 1234 AB
const postcodes: { app: string; order: string; postcode: string }[] = [];
const emailed: { app: string; key: string; order: string; text: string; lang: string }[] = [];
// how the stalls answer the next `answer`: sent, their 503 (HQ not reached), unsure (HQ's reply lost), or the connection
// dropped; and the order whose `postcode` the second stall can't answer (a restart)
let answering: 'sent' | 'no HQ' | 'unsure' | 'dropped' = 'sent';
const POSTCODE_AWAY = 'AWAY1';
let secondStallDown = false;
const stall = (app: string, orders: string[]) =>
  createServer((req, res) => {
    let body = '';
    req
      .on('data', d => (body += d))
      .on('end', () => {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
        const b = JSON.parse(body);
        const json = (o: object) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
        if (req.url === '/api/care/code') {
          codes.push({ app, ...b });
          return json({});
        }
        if (req.url === '/api/care/postcode') {
          postcodes.push({ app, ...b });
          if ((b.order === POSTCODE_AWAY || secondStallDown) && app === 'shop2') return void res.writeHead(500).end();
          return json({ match: (orders.includes(b.order) || b.order === BASKET) && b.postcode === '1234AB' });
        }
        if (req.url === '/api/care/answer') {
          emailed.push({ app, ...b });
          if (answering === 'no HQ') return void res.writeHead(503).end(JSON.stringify({ error: 'no HQ' }));
          if (answering === 'dropped') return void req.socket.destroy();
          return json(answering === 'unsure' ? { sent: false, unsure: true, why: 'payments 502' } : { sent: true });
        }
        // a basket's number, one checkout across both stalls: two of the first's orders, one cancelled, and one of the
        // second's
        if (req.url === '/api/care/view' && b.order === BASKET) {
          const mine = (
            app === 'shop'
              ? [
                  { ...VIEW, id: 'ORD-B1', status: 'cancelled' },
                  { ...VIEW, id: 'ORD-B3', status: 'printing' },
                ]
              : [{ ...VIEW, id: 'ORD-B4', status: 'printing' }]
          ).map(v => ({ ...v, number: BASKET }));
          return json({ match: true, order: mine[0], ...(mine.length > 1 ? { orders: mine } : {}) });
        }
        if (req.url === '/api/care/view')
          return json(orders.includes(b.order) ? { match: true, order: { ...VIEW, id: b.order } } : { match: false });
        res.writeHead(404).end();
      });
  });
// and the preview's stall, where a tester's order is kept
const shopA = stall('shop', ['ORD7Q4KM2']),
  shopB = stall('shop2', ['ORDB2']),
  shopP = stall('shop@preview', ['TESTER1']);
for (const s of [shopA, shopB, shopP]) await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
const cards: any[] = [];
const hqServer = createServer((req, res) => {
  let body = '';
  req
    .on('data', d => (body += d))
    .on('end', () => {
      if (req.url === '/api/care/cards') cards.push(JSON.parse(body));
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify(
            req.url === '/api/care/cards'
              ? { ok: true, id: String(cards.length) }
              : { busy: 'auto', queue: { waiting: 0, oldest: null } },
          ),
        );
    });
});
await new Promise<void>(r => hqServer.listen(0, '127.0.0.1', r));

const PORT = 20000 + Math.floor(Math.random() * 20000),
  PHONE_PORT = PORT + 1;
const PHONE_TOKEN = 'phone-test-line-token';
const url = (s: any) => `http://127.0.0.1:${(s.address() as any).port}`;
Object.assign(process.env, {
  DATA_DIR: mkdtempSync(join(tmpdir(), 'care-phone-')),
  PORT: String(PORT),
  CARE_LOCAL: '1',
  CARE_PROVIDER: 'fake',
  CARE_APPS: JSON.stringify({ shop: url(shopA), shop2: url(shopB), 'shop@preview': url(shopP) }),
  CARE_TOKENS: JSON.stringify({ shop: TOKEN, shop2: TOKEN, 'shop@preview': TOKEN }),
  CARE_SHOPS: JSON.stringify({ front: ['shop', 'shop2'], 'front@preview': ['shop@preview'] }),
  CARE_NAMES: JSON.stringify({ shop: 'Shop', shop2: 'Shop Two', front: 'The Front' }),
  CARE_PHONE_PORT: String(PHONE_PORT),
  CARE_PHONE_TOKEN: PHONE_TOKEN,
  CARE_CAP_PHONE_MONTH: '8',
  CARE_HQ_URL: url(hqServer),
  CARE_HQ_TOKEN: 'hq-test-token',
  CARE_COMPANY_DIR: new URL('../../../template/products/care', import.meta.url).pathname,
});
const fake = await import('./fake.ts');
const { db } = await import('./db.ts');
const ledger = await import('./ledger.ts');
const hq = await import('./hq.ts');
const phone = await import('./phone.ts');
const phonecall = await import('./phonecall.ts');
const numbers = await import('./numbers.ts');
const { sweep } = await import('./db.ts');
await import('./server.ts');
// the company's order references (the plug-in's `orderRef`): here, the ones this file says
const REFS = new Set(['48291736', BASKET]);
(await import('./company.ts')).use({ orderRef: d => REFS.has(d) });
const { t } = await import('./texts.ts');
const { TURN_ROUNDS } = await import('./model.ts');
await new Promise(r => setTimeout(r, 150));

// ---- the voice line's side: the three routes
const BASE = `http://127.0.0.1:${PHONE_PORT}`;
// (a turn and the end say which languages the caller has heard the notice in: here English, unless the test says
// otherwise)
const post = (path: string, body: any, token = PHONE_TOKEN, signal?: AbortSignal) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(path === '/phone/start' ? body : { informed: ['en'], ...body }),
  });
async function start() {
  const r = await post('/phone/start', { call: 'CA' + 'f'.repeat(32) });
  assert.equal(r.status, 200);
  return (await r.json()) as any;
}
// (informed)
async function say(conversation: number, text: string, lang = 'en', informed = [lang]) {
  const r = await post('/phone/turn', { conversation, text, lang, informed });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /application\/x-ndjson/);
  return (await r.text())
    .trim()
    .split('\n')
    .map(l => JSON.parse(l));
}
const words = (lines: any[]) =>
  lines
    .filter(l => 'text' in l)
    .map(l => l.text)
    .join('');
// the model's side: what each call saw, and a script answering by round (a tool's result in the messages: the next round)
const seen: any[] = [];
function model(...rounds: any[][]) {
  fake.script(o => {
    seen.push(o);
    const m = o.messages;
    let i = m.length - 1;
    while (i >= 0 && typeof m[i].content !== 'string') i--; // the caller's words: the rounds after them are tools' results
    return rounds[Math.min((m.length - 1 - i) / 2, rounds.length - 1)];
  });
}
const lastUser = () => {
  const m = seen.at(-1).messages;
  const u = m.at(-1);
  return typeof u.content === 'string' ? u.content : JSON.stringify(u.content);
};
const results = () =>
  (seen.at(-1).messages.at(-1).content as any[]).filter(b => b.type === 'tool_result').map(b => JSON.parse(b.content));
const stored = (conversation: number) =>
  db
    .prepare('select who, text, ai_generated from messages where conversation = ? order by id')
    .all(conversation) as any[];
const until = async (f: () => any, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const x = f();
    if (x) return x;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
};
const clearLedger = () => db.prepare('delete from ledger').run();

test("the routes need the line's token, compared whole: anything else is a 401 with no body, and only the three routes answer", async () => {
  for (const tok of ['', 'wrong', PHONE_TOKEN + 'x', PHONE_TOKEN.slice(0, -1)]) {
    const r = await post('/phone/start', { call: 'CA1' }, tok);
    assert.equal(r.status, 401);
    assert.equal(await r.text(), '');
  }
  assert.equal((await post('/phone/nothing', {})).status, 404);
  // the chat's port doesn't answer them
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${PORT}/phone/start`, {
        method: 'POST',
        headers: { authorization: `Bearer ${PHONE_TOKEN}` },
      })
    ).status,
    404,
  );
});

test("a call starts a phone conversation in the front's tables, with the plug-in's words for the line", async () => {
  const s = await start();
  assert.equal(s.helper, 'Pebble');
  assert.deepEqual(s.langs, ['en']);
  assert.deepEqual(s.words.en, {
    ai: t('phone_ai', 'en'),
    reply_ai: t('phone_reply_ai', 'en'),
    transcript: t('phone_transcript', 'en'),
    ask: t('phone_ask', 'en'),
    objected: t('phone_objected', 'en'),
  });
  const row = db.prepare('select shop, kind, linked from conversations where id = ?').get(s.conversation) as any;
  assert.deepEqual({ ...row }, { shop: 'front', kind: 'phone', linked: null });
  // the CallSid isn't kept
  assert.doesNotMatch(
    JSON.stringify(db.prepare('select * from conversations where id = ?').get(s.conversation)),
    /CAfff/,
  );
});

test("a turn streams the reply as it is written, its steps and the tools' own words, then the end; the words are kept", async () => {
  clearLedger();
  const s = await start();
  model([{ text: 'Of course. ' }, { tool: 'ask_for_person', input: {} }], [{ text: 'Anything else I can help with?' }]);
  const lines = await say(s.conversation, 'Can I talk to a person?');
  const kinds = lines.map(l => Object.keys(l)[0]);
  assert.deepEqual(
    kinds.filter((k, i) => k !== kinds[i - 1]),
    ['text', 'step', 'text', 'used', 'text', 'end'],
  );
  assert.equal(lines.find(l => l.step).step, 'ask_for_person');
  assert.equal(
    words(lines).replace(/\s+/g, ' '),
    `Of course. ${t('phone_person', 'en')} Anything else I can help with?`,
  );
  // the instructions: the plug-in's, the phone's part after them; the tools are the phone's
  assert.match(seen.at(-1).cached, /ON THE PHONE/);
  assert.deepEqual(
    seen.at(-1).tools.map((x: any) => x.name),
    [
      'check_postcode',
      'send_code',
      'order_status',
      'email_answer',
      'report_fault',
      'ask_for_person',
      'pass_on_feedback',
      'no_transcript',
      'hang_up',
    ],
  );
  const kept = stored(s.conversation);
  assert.deepEqual(
    kept.map(m => [m.who, m.text, m.ai_generated]),
    [
      ['me', 'Can I talk to a person?', null],
      ['ai', 'Of course.', 1],
      ['ai', t('phone_person', 'en'), null],
      ['ai', 'Anything else I can help with?', 1],
    ],
  );
  // each model call is in the ledger, as the phone's
  assert.deepEqual(
    (db.prepare('select distinct purpose from ledger').all() as any[]).map(r => r.purpose),
    ['phone'],
  );
});

test("a call's start reads its prompt into the model's cache, in the opening's language, so the first turn reads it", async () => {
  const company = await import('./company.ts');
  company.use({ langs: ['en', 'de'] }); // (a prompt no test has cached yet)
  try {
    const asked = seen.length;
    const r = await post('/phone/start', { call: 'CA' + 'e'.repeat(32), lang: 'de' });
    const { conversation } = (await r.json()) as any;
    const warmed = () =>
      db.prepare('select cache_write, estimate from ledger where conversation = ?').all(conversation) as any[];
    await until(() => warmed().length);
    assert.equal(seen.length, asked, 'no answer of the model taken');
    assert.ok(warmed()[0].cache_write > 0 && warmed()[0].estimate === 1);
    model([{ text: '[de] Guten Abend.' }]);
    const lines = await say(conversation, 'Hallo.', 'de', ['de']);
    assert.deepEqual([lines.at(-1).model.written, lines.at(-1).model.read > 0], [0, true]);
  } finally {
    company.use({ langs: ['en'] });
  }
});

test('hang_up is a step the line acts on, and it ends the turn', async () => {
  const s = await start();
  model([{ text: 'Bye now.' }, { tool: 'hang_up', input: {} }], [{ text: 'never said' }]);
  const lines = await say(s.conversation, 'That was all, thanks.');
  const { model: tally, ...end } = lines.at(-1);
  assert.deepEqual([...lines.slice(-3, -1), end], [{ step: 'hang_up' }, { used: 'hang_up' }, { end: true }]);
  assert.doesNotMatch(words(lines), /never/);
  // the turn's end says how its model calls went, for the line's log: one call, its first words, the cache
  assert.deepEqual(Object.keys(tally).sort(), ['first', 'read', 'rounds', 'written']);
  assert.equal(tally.rounds, 1);
});

test("the plug-in's phoneCore names the engine's own tools its line offers: only those and its own, the line's closing ones always", async () => {
  const company = await import('./company.ts');
  const own = {
    def: { name: 'partner_note', description: 'a note', input_schema: { type: 'object', properties: {} } },
    run: async () => ({ content: '{"noted":true}' }),
  };
  company.use({ phoneCore: ['ask_for_person'], phoneTools: [own] });
  try {
    const s = await start();
    model(
      [
        { tool: 'order_status', input: {} },
        { tool: 'partner_note', input: {} },
      ],
      [{ text: 'Noted.' }],
    );
    await say(s.conversation, 'Where is order R-4829?');
    assert.deepEqual(
      seen.at(-1).tools.map((x: any) => x.name),
      ['ask_for_person', 'partner_note', 'no_transcript', 'hang_up'],
    );
    // a tool of the engine's the line doesn't offer, called anyway: no such tool, nothing looked up
    assert.deepEqual(results(), [{ error: 'no tool called order_status' }, { noted: true }]);
  } finally {
    company.use({ phoneCore: null, phoneTools: [] });
  }
});

test("the phone's own month stops a call at its start and mid-call; so do the month's total and the breaker", async () => {
  clearLedger();
  const s = await start();
  const add = (eur: number, purpose = 'phone') =>
    db
      .prepare(
        "insert into ledger (at, app, purpose, model, input, cache_write, cache_read, output, eur) values (?, 'front', ?, 'x', 0, 0, 0, 0, ?)",
      )
      .run(Date.now(), purpose, eur);
  add(8);
  let r = await post('/phone/start', { call: 'CA2' });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { why: 'cap' });
  model([{ text: 'should not run' }]);
  const n = seen.length;
  assert.deepEqual(await say(s.conversation, 'Hello?'), [{ unanswered: 'cap' }]);
  assert.equal(seen.length, n, 'no model call');
  clearLedger();
  add(19, 'reply'); // the chats spent the month: the phone stops too
  r = await post('/phone/start', { call: 'CA3' });
  assert.deepEqual(await r.json(), { why: 'cap' });
  clearLedger();
  // a cap reached between two rounds of one turn: the next round isn't asked for
  let rounds = 0;
  fake.script(o => {
    seen.push(o);
    rounds++;
    add(8);
    return [{ tool: 'no_transcript', input: {} }];
  });
  const lines = await say(s.conversation, 'Please keep no transcript.');
  assert.deepEqual(lines.at(-1), { unanswered: 'cap' });
  assert.equal(rounds, 1);
  clearLedger();
  // the breaker down: a call doesn't start, a turn that isn't its probe isn't answered
  ledger.breaker.failed();
  ledger.breaker.failed();
  r = await post('/phone/start', { call: 'CA4' });
  assert.deepEqual(await r.json(), { why: 'down' });
  assert.deepEqual(await say(s.conversation, 'Hello?'), [{ unanswered: 'down' }]);
  ledger.breaker.ok();
  // the provider failing mid-turn
  model([{ fail: 529 }]);
  assert.deepEqual((await say(s.conversation, 'Hello?')).at(-1), { unanswered: 'down' });
  ledger.breaker.ok();
});

test('a turn still calling tools at its last model call says so: the caller hears it, and no model reads those results', async () => {
  const s = await start(),
    n = seen.length;
  const app = phonecall.about(phonecall.load(s.conversation)!);
  const out = () =>
    numbers.counts(app, numbers.dayOf(Date.now())).timing['fake.phone.rounds.out']?.[String(TURN_ROUNDS)] ?? 0;
  const before = out();
  model([{ tool: 'order_status', input: {} }]);
  const lines = await say(s.conversation, 'Where is my parcel?');
  assert.equal(seen.length - n, TURN_ROUNDS);
  assert.equal(out(), before + 1, 'the bound reached is counted');
  assert.ok(words(lines).endsWith(t('phone_rounds_out', 'en')));
  assert.deepEqual(
    [lines.at(-1).end, lines.at(-1).model?.rounds],
    [true, TURN_ROUNDS],
    "its model calls, for the line's log",
  );
  assert.equal(stored(s.conversation).at(-1).text, t('phone_rounds_out', 'en'));
});

test('the phone is off without a month of its own: the line plays its message', async () => {
  const { CAP } = await import('./config.ts');
  const was = CAP.phoneMonth;
  CAP.phoneMonth = 0;
  try {
    const r = await post('/phone/start', { call: 'CA5' });
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { why: 'off' });
  } finally {
    CAP.phoneMonth = was;
  }
});

test("send_code: one code per stall, the same answer for an order that doesn't exist, three an order number a day across calls", async () => {
  codes.length = 0;
  const a = await start(),
    b = await start();
  model([{ tool: 'send_code', input: { order: 'ord-7q4k-m2' } }], [{ text: 'Okay.' }]);
  await say(a.conversation, 'My order is ORD-7Q4K-M2.');
  const real = results()[0];
  await until(() => codes.length === 3);
  assert.deepEqual(codes.map(c => [c.app, c.order]).sort(), [
    ['shop', 'ORD7Q4KM2'],
    ['shop2', 'ORD7Q4KM2'],
    ['shop@preview', 'ORD7Q4KM2'],
  ]);
  assert.equal(new Set(codes.map(c => c.code)).size, 3, 'each stall its own code');
  assert.match(codes[0].code, /^\d{6}$/);
  model([{ tool: 'send_code', input: { order: 'NOPE-1234' } }], [{ text: 'Okay.' }]);
  await say(b.conversation, 'It is NOPE-1234.');
  assert.deepEqual(results()[0], real, "the model hears the same for an order that isn't ours");
  assert.equal(real.say, t('phone_code_sent', 'en'));
  // the third for ORD-7Q4K-M2 today (one more call), then the limit, in any call
  model([{ tool: 'send_code', input: { order: 'ORD 7Q4K M2' } }], [{ text: 'Okay.' }]);
  await say(b.conversation, 'Try ORD-7Q4K-M2.');
  await say((await start()).conversation, 'ORD-7Q4K-M2 please.');
  await until(() => codes.length === 12);
  await say((await start()).conversation, 'ORD-7Q4K-M2 again.');
  assert.equal(results()[0].say, t('phone_code_limit', 'en'));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(codes.length, 12, 'no fourth code');
  db.prepare('delete from hits').run();
});

// the code the stall 'shop' was asked to email, as a caller says it
const spell = (code: string, lang: 'en' | 'nl' | 'de') =>
  code
    .split('')
    .map(
      d =>
        ({
          en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'],
          nl: ['nul', 'een', 'twee', 'drie', 'vier', 'vijf', 'zes', 'zeven', 'acht', 'negen'],
          de: ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun'],
        })[lang][Number(d)],
    )
    .join(' ');
async function codeFor(conversation: number, order = 'ORD-7Q4K-M2', app = 'shop') {
  codes.length = 0;
  model([{ tool: 'send_code', input: { order } }], [{ text: 'A code is on its way.' }]);
  await say(conversation, `The order is ${order}.`);
  await until(() => codes.length === 3);
  db.prepare('delete from hits').run();
  return codes.find(c => c.app === app)!.code;
}

test('the code read out: checked in code, taken out of what is kept and what the model reads; right opens that one order', async () => {
  const s = await start();
  model([{ tool: 'order_status', input: {} }], [{ text: 'No order yet.' }]);
  await say(s.conversation, 'Where is order ORD-7Q4K-M2?');
  assert.equal(results()[0].found, false, 'before the code, nothing about any order');
  const code = await codeFor(s.conversation);
  const wrong = code === '123456' ? '654321' : '123456';
  model([{ text: 'Hmm.' }]);
  await say(s.conversation, `It says ${wrong.slice(0, 3)} ${wrong.slice(3)}.`);
  assert.doesNotMatch(lastUser(), /\d{3}/);
  assert.match(lastUser(), /\(read out the code\)/);
  assert.match(lastUser(), /wrong\. 4 more tries/);
  // spoken in words, with a filler: right
  await say(s.conversation, `Sorry, it's ${spell(code, 'en').replace(/ /, ', uh, ')}.`);
  assert.match(lastUser(), /right\. Order ORD7Q4KM2 is open/);
  for (const d of [wrong, code]) assert.ok(!JSON.stringify(seen.at(-1)).includes(d), 'never in what the model gets');
  for (const m of stored(s.conversation))
    assert.doesNotMatch(m.text, /\d{6}|\d{3} \d{3}|\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/);
  assert.equal(stored(s.conversation).filter(m => m.text.includes('(read out the code)')).length, 2);
  assert.ok(
    (db.prepare('select linked from conversations where id = ?').get(s.conversation) as any).linked,
    'linked: kept 12 months',
  );
  // that order as the code opens it: what's in it, the price, the street and town; never the tracking link
  model([{ tool: 'order_status', input: {} }], [{ text: 'It shipped.' }]);
  await say(s.conversation, 'So where is it?');
  const o = results()[0].order;
  assert.equal(o.status, 'shipped');
  assert.equal(o.tracking, true);
  assert.deepEqual([o.product, o.quantity, o.total_cents, o.address], ['Blanket', 1, 3995, 'Test Street 1, Leeds']);
  // never the tracking link, nor the chat's title: what's printed on it
  assert.doesNotMatch(JSON.stringify(results()[0]), /ups\.com|Mila/);
  // spent once right: read again, it's not checked again
  model([{ text: 'Ok.' }]);
  await say(s.conversation, `${code}`);
  assert.match(lastUser(), /can't be used any more/);
});

test("a code in Dutch and German words, in pairs or read twice in a breath, is read too; another stall's code opens that stall's order", async () => {
  for (const [lang, form] of [
    ['nl', 'words'],
    ['de', 'words'],
    ['en', 'pairs'],
    ['en', 'twice'],
  ] as const) {
    const s = await start();
    const code = await codeFor(s.conversation);
    model([{ text: 'Ok.' }]);
    const said = {
      words: () => spell(code, lang),
      pairs: () => `${code.slice(0, 2)}-${code.slice(2, 4)}-${code.slice(4)}`,
      twice: () => `${code}, ${code}`,
    }[form]();
    await say(s.conversation, `De code is ${said}`, lang);
    assert.match(lastUser(), /right/, `${lang} ${form}`);
    assert.ok(!JSON.stringify(seen.at(-1)).includes(code), `${lang} ${form}: never in what the model gets`);
    for (const m of stored(s.conversation)) assert.doesNotMatch(m.text, /\d{3}/, `${lang} ${form}: never kept`);
  }
  const s = await start();
  await codeFor(s.conversation, 'ORD-B2');
  const other = codes.find(c => c.app === 'shop2')!.code;
  model([{ text: 'Ok.' }]);
  await say(s.conversation, other);
  assert.match(lastUser(), /right/);
  model([{ tool: 'order_status', input: {} }], [{ text: 'Ok.' }]);
  await say(s.conversation, 'Where is it?');
  assert.equal(results()[0].order.from, 'Shop Two');
});

test("a basket's number opens the whole checkout, each stall's orders in it, each where it stands", async () => {
  const s = await start();
  const code = await codeFor(s.conversation, '123 4566');
  model([{ text: 'Ok.' }]);
  await say(s.conversation, code);
  assert.match(lastUser(), /right/);
  model([{ tool: 'order_status', input: {} }], [{ text: 'Ok.' }]);
  await say(s.conversation, 'Where are they?');
  const r = results()[0];
  assert.deepEqual(
    r.items.map((i: any) => [i.order.order, i.order.from, i.order.status]),
    [
      [BASKET, 'Shop', 'cancelled'],
      [BASKET, 'Shop', 'printing'],
      [BASKET, 'Shop Two', 'printing'],
    ],
  );
  assert.match(r.note, /3 things/);
  assert.doesNotMatch(r.note, /could not be asked/);
});

test("a tester's order, kept by the preview's stall, opens on the shop's phone like any other", async () => {
  const s = await start();
  const code = await codeFor(s.conversation, 'TESTER1', 'shop@preview');
  model([{ text: 'Ok.' }]);
  await say(s.conversation, code);
  assert.match(lastUser(), /right\. Order TESTER1 is open/);
  model([{ tool: 'order_status', input: {} }], [{ text: 'Ok.' }]);
  await say(s.conversation, 'Where is it?');
  assert.deepEqual(
    [results()[0].order.order, results()[0].order.from, results()[0].order.status],
    ['TESTER1', 'Shop', 'shipped'],
  );
});

test('check_postcode: a right postcode opens where the order stands and no more; a wrong one and no order answer alike', async () => {
  const s = await start();
  postcodes.length = 0;
  const logged: string[] = [];
  const log = console.log;
  console.log = (...x: unknown[]) => void logged.push(x.join(' '));
  try {
    model(
      [{ tool: 'check_postcode', input: { order: 'ORD-7Q4K-M2', postcode: '1234 ab', topic: 'status' } }],
      [{ text: 'Ok.' }],
    );
    await say(s.conversation, 'Has ORD-7Q4K-M2 shipped? My postcode is 1234 AB.');
  } finally {
    console.log = log;
  }
  assert.equal(results()[0].matched, true);
  assert.deepEqual(postcodes.map(p => [p.app, p.order, p.postcode]).sort(), [
    ['shop', 'ORD7Q4KM2', '1234AB'],
    ['shop2', 'ORD7Q4KM2', '1234AB'],
    ['shop@preview', 'ORD7Q4KM2', '1234AB'],
  ]);
  // the ask is logged for the count: the check and the topic, no words or numbers
  assert.deepEqual(
    logged.filter(l => l.includes('an ask by')),
    [`care: phone conversation ${s.conversation}: an ask by postcode, about status`],
  );
  // its status only: not what it is, its price, town or address
  model([{ tool: 'order_status', input: {} }], [{ text: 'It shipped.' }]);
  await say(s.conversation, 'So where is it?');
  const status = results()[0];
  assert.deepEqual(
    [status.order.status, status.order.carrier, status.order.tracking, status.order.shipped_at],
    ['shipped', 'UPS', true, VIEW.shipped_at],
  );
  assert.doesNotMatch(JSON.stringify(status), /Blanket|Mila|3995|Leeds|Test Street|GB|ups\.com/);
  assert.match(status.note, /send_code/);
  assert.match(seen.at(-1).system, /postcode matched order ORD7Q4KM2/);
  // a wrong postcode and an order that isn't ours: the model hears the same
  const b = await start();
  model(
    [{ tool: 'check_postcode', input: { order: 'ORD-7Q4K-M2', postcode: '9999 ZZ', topic: 'status' } }],
    [{ text: 'Hm.' }],
  );
  await say(b.conversation, 'ORD-7Q4K-M2, 9999 ZZ.');
  const wrong = results()[0];
  model(
    [{ tool: 'check_postcode', input: { order: 'NOPE-1234', postcode: '1234 AB', topic: 'status' } }],
    [{ text: 'Hm.' }],
  );
  await say(b.conversation, 'NOPE-1234, 1234 AB.');
  const none = results()[0];
  assert.equal(wrong.matched, false);
  assert.deepEqual(
    { ...none, note: none.note.replace(/\d more tr\w+/, '') },
    { ...wrong, note: wrong.note.replace(/\d more tr\w+/, '') },
  );
  model([{ tool: 'order_status', input: {} }], [{ text: 'No.' }]);
  await say(b.conversation, 'Where is it?');
  assert.equal(results()[0].found, false, 'nothing opened');
  db.prepare('delete from hits').run();
});

test("check_postcode: no match while a stall couldn't be asked isn't a wrong postcode, and takes no try", async () => {
  db.prepare('delete from hits').run();
  const s = await start();
  const errors: string[] = [];
  const error = console.error;
  console.error = (...x: unknown[]) => void errors.push(x.join(' '));
  const ask = async (order: string) => {
    model([{ tool: 'check_postcode', input: { order, postcode: '1234 AB', topic: 'status' } }], [{ text: 'Hm.' }]);
    await say(s.conversation, `${order}, 1234 AB.`);
    return results()[0];
  };
  let away: any;
  try {
    // more often than the call's tries: none is taken, nor the order number's day
    for (let i = 0; i < 4; i++) away = await ask(POSTCODE_AWAY);
  } finally {
    console.error = error;
  }
  assert.equal(away.matched, false);
  assert.match(away.note, /can't be checked just now/);
  assert.ok(errors.includes(`care: phone conversation ${s.conversation}: a postcode check couldn't ask every stall`));
  assert.equal(phonecall.load(s.conversation)!.state.phone.postcodes, 0);
  assert.equal((db.prepare('select count(*) as n from hits').get() as any).n, 0);
  // the right postcode for another stall's order, while one can't answer: not a match either, or wrong guesses cost nothing
  secondStallDown = true;
  try {
    const hit = await ask('ORD7Q4KM2');
    assert.equal(hit.matched, false);
    assert.match(hit.note, /can't be checked just now/);
  } finally {
    secondStallDown = false;
  }
  assert.equal(phonecall.load(s.conversation)!.state.phone.status, undefined);
  assert.equal(phonecall.load(s.conversation)!.state.phone.postcodes, 0);
  // every stall answering no match is a wrong one, and counts
  const wrong = await ask('NOPE-1234');
  assert.match(wrong.note, /don't match an order/);
  assert.equal(phonecall.load(s.conversation)!.state.phone.postcodes, 1);
  db.prepare('delete from hits').run();
});

test('a code for one order and a postcode for another keep both open: order_status gives the one named, else the newest', async () => {
  const s = await start();
  const code = await codeFor(s.conversation);
  model([{ text: 'Thanks.' }]);
  await say(s.conversation, `It's ${code}.`);
  assert.match(lastUser(), /right\. Order ORD7Q4KM2 is open/);
  model(
    [{ tool: 'check_postcode', input: { order: 'ORD-B2', postcode: '1234 AB', topic: 'status' } }],
    [{ text: 'Ok.' }],
  );
  await say(s.conversation, 'And has ORD-B2 shipped? 1234 AB.');
  assert.equal(results()[0].matched, true);
  const status = async (input: object) => {
    model([{ tool: 'order_status', input }], [{ text: 'Ok.' }]);
    await say(s.conversation, 'Where is it?');
    return results()[0];
  };
  // the newest check's order, at its own level: the postcode's, its status only
  const newest = await status({});
  assert.deepEqual([newest.order.order, newest.order.from, newest.order.product], ['ORDB2', 'Shop Two', undefined]);
  // the code's order, named, in full; the postcode's, named, still its status only
  const coded = await status({ order: 'ORD-7Q4K-M2' });
  assert.deepEqual([coded.order.order, coded.order.product, coded.order.total_cents], ['ORD7Q4KM2', 'Blanket', 3995]);
  assert.equal((await status({ order: 'ORD B2' })).order.product, undefined);
  const other = await status({ order: 'NOPE-1234' });
  assert.equal(other.found, false);
  assert.match(other.note, /only ORD7Q4KM2 and ORDB2/);
  // the facts name both
  for (const fact of [/code for order ORD7Q4KM2/, /postcode matched order ORDB2/, /Two orders are open/])
    assert.match(seen.at(-1).system, fact);
  db.prepare('delete from hits').run();
});

test('check_postcode: three tries a call; five an order number a day, across calls', async () => {
  const s = await start();
  const ask = async (conversation: number, postcode: string) => {
    model([{ tool: 'check_postcode', input: { order: 'ORD-7Q4K-M2', postcode, topic: 'status' } }], [{ text: 'Hm.' }]);
    await say(conversation, `ORD-7Q4K-M2, ${postcode}.`);
    return results()[0];
  };
  for (const p of ['1111 AA', '2222 AA', '3333 AA']) assert.equal((await ask(s.conversation, p)).matched, false);
  postcodes.length = 0;
  const fourth = await ask(s.conversation, '1234 AB');
  assert.deepEqual([fourth.matched, fourth.say], [false, t('phone_postcode_limit', 'en')]);
  assert.equal(postcodes.length, 0, 'the stalls are not asked');
  // a new call has its own three, but the order number has two left today
  const b = await start();
  assert.equal((await ask(b.conversation, '4444 AA')).matched, false);
  assert.equal((await ask(b.conversation, '1234 AB')).matched, true);
  const c = await start();
  assert.equal((await ask(c.conversation, '1234 AB')).say, t('phone_postcode_limit', 'en'));
  db.prepare('delete from hits').run();
});

test('email_answer: the same words whatever the order; once the call is over, one email for its questions, through the stall that has it', async () => {
  emailed.length = 0;
  const s = await start();
  const ask = async (conversation: number, order: string, question: string, topic = 'cancel') => {
    model([{ tool: 'email_answer', input: { order, question, topic } }], [{ text: 'Ok.' }]);
    await say(conversation, `About ${order}: ${question}`);
    return results()[0];
  };
  const ours = await ask(s.conversation, 'ORD-B2', 'How do I cancel it?');
  const twice = await ask(s.conversation, 'ORD-B2', 'And can I change the text?', 'change');
  const nothing = await ask(s.conversation, 'NOPE-1234', 'How do I cancel it?');
  assert.deepEqual(ours, nothing, "the model hears the same for an order that isn't ours");
  assert.deepEqual(twice, ours);
  assert.equal(ours.say, t('phone_answer_kept', 'en'));
  // nothing while the call is on
  const phoneanswer = await import('./phoneanswer.ts');
  await phoneanswer.pass();
  assert.equal(emailed.length, 0);
  let asked: any = null;
  fake.script(o => {
    asked = o;
    return [
      {
        tool: 'write_answer',
        input: {
          asked: 'The question was how to cancel it, and whether the text can change.',
          known: true,
          answer: 'On your order page, until it goes to print.',
        },
      },
    ];
  });
  assert.equal((await post('/phone/end', { conversation: s.conversation, ended: 'caller' })).status, 200);
  await phoneanswer.pass();
  // one email for ORD-B2, from shop2, its two questions in one model call with that order; none for NOPE-1234
  // with its key, the call's and the order's: HQ sends one email a key
  assert.deepEqual(
    emailed.map(e => [e.app, e.key, e.order, e.lang]),
    [['shop2', `${s.conversation}:ORDB2`, 'ORDB2', 'en']],
  );
  assert.deepEqual(JSON.parse(asked.messages[0].content).questions, [
    'How do I cancel it?',
    'And can I change the text?',
  ]);
  // what it is, never the chat's title: what's printed on it
  assert.equal(JSON.parse(asked.messages[0].content).order[0].order.product, 'Blanket');
  assert.doesNotMatch(asked.messages[0].content, /Mila/);
  assert.equal(
    emailed[0].text,
    `The question was how to cancel it, and whether the text can change.\n\nOn your order page, until it goes to print.\n\n${t('team_reply', 'en')}`,
  );
  assert.equal((db.prepare('select count(*) as n from phone_answers').get() as any).n, 0, 'nothing kept once gone');
  // what the knowledge and the order don't answer: the email says a person answers a reply
  const b = await start();
  await ask(b.conversation, 'ORD-B2', 'Can you print it on a mug?', 'other');
  fake.script(() => [
    { tool: 'write_answer', input: { asked: 'The question was about a mug.', known: false, answer: '' } },
  ]);
  await post('/phone/end', { conversation: b.conversation, ended: 'caller' });
  await phoneanswer.pass();
  assert.equal(emailed.at(-1)!.text, `The question was about a mug.\n\n${t('phone_answer_unknown', 'en')}`);
  // three asks an order number a day, across calls (the first call's two and this one's)
  const c = await start();
  assert.equal((await ask(c.conversation, 'ORD-B2', 'One more?')).say, t('phone_answer_limit', 'en'));
  db.prepare('delete from hits').run();
});

// a call that asked for an answer about ORD-B2, ended: its conversation
async function answerAsked() {
  const s = await start();
  model(
    [{ tool: 'email_answer', input: { order: 'ORD-B2', question: 'How do I cancel it?', topic: 'cancel' } }],
    [{ text: 'Ok.' }],
  );
  await say(s.conversation, 'About ORD-B2: how do I cancel it?');
  await post('/phone/end', { conversation: s.conversation, ended: 'caller' });
  return s.conversation;
}
const answerRow = (conversation: number) =>
  db.prepare('select tries, email from phone_answers where conversation = ?').get(conversation) as any;
const RETRY_MS = 5 * 60_000;
const writes = (input: object) => fake.script(() => [{ tool: 'write_answer', input }]);
const ANSWERED = { asked: 'The question was how to cancel it.', known: true, answer: 'On your order page.' };

test("email_answer: a write_answer that won't do is a failed try, never the unknown answer's email", async () => {
  db.prepare('delete from hits').run();
  emailed.length = 0;
  const phoneanswer = await import('./phoneanswer.ts');
  const conversation = await answerAsked();
  const errors: string[] = [];
  const error = console.error;
  console.error = (...x: unknown[]) => void errors.push(x.join(' '));
  let at = Date.now();
  try {
    for (const input of [
      { ...ANSWERED, answer: '' },
      { ...ANSWERED, answer: 'Here: https://evil.example/cancel' },
      { ...ANSWERED, asked: '' },
      { ...ANSWERED, known: 'yes' },
    ]) {
      writes(input);
      await phoneanswer.pass(at);
      at += RETRY_MS;
    }
  } finally {
    console.error = error;
  }
  assert.equal(emailed.length, 0, 'nothing goes');
  assert.deepEqual({ ...answerRow(conversation) }, { tries: 4, email: null });
  assert.equal(errors.filter(e => e.includes("write_answer won't do")).length, 4);
  // the next that holds goes
  writes(ANSWERED);
  await phoneanswer.pass(at);
  assert.deepEqual(
    emailed.map(e => e.text),
    [`${ANSWERED.asked}\n\n${ANSWERED.answer}\n\n${t('team_reply', 'en')}`],
  );
  assert.equal(answerRow(conversation), undefined);
  db.prepare('delete from hits').run();
});

test("the email answer is asked again only when it surely didn't go; one that may have gone is left, said in the log", async () => {
  db.prepare('delete from hits').run();
  emailed.length = 0;
  const phoneanswer = await import('./phoneanswer.ts');
  const errors: string[] = [];
  const error = console.error;
  console.error = (...x: unknown[]) => void errors.push(x.join(' '));
  try {
    // the stall's 503, HQ not reached: tried again with the same key, and it goes
    const first = await answerAsked();
    writes(ANSWERED);
    answering = 'no HQ';
    await phoneanswer.pass();
    assert.equal(answerRow(first).tries, 1);
    answering = 'sent';
    await phoneanswer.pass(Date.now() + RETRY_MS);
    assert.deepEqual(
      emailed.map(e => e.key),
      [`${first}:ORDB2`, `${first}:ORDB2`],
    );
    assert.equal(answerRow(first), undefined);
    // HQ's reply lost (the stall's unsure), or the stall's connection dropped: never asked again
    for (const how of ['unsure', 'dropped'] as const) {
      const c = await answerAsked();
      writes(ANSWERED);
      answering = how;
      emailed.length = 0;
      await phoneanswer.pass();
      await phoneanswer.pass(Date.now() + RETRY_MS);
      assert.equal(emailed.length, 1, how);
      assert.equal(answerRow(c), undefined, how);
      assert.ok(
        errors.includes(
          `care: phone conversation ${c}: the email answer may or may not have gone through shop2: not asked again`,
        ),
        how,
      );
    }
  } finally {
    console.error = error;
    answering = 'sent';
  }
  db.prepare('delete from hits').run();
});

test('a code is never one that, said after an article, reads as an order reference', async () => {
  const company = await import('./company.ts');
  // half of all "1" + code runs are a reference here: no code may be one of them
  company.use({ orderRef: d => REFS.has(d) || (d.length === 7 && d[0] === '1' && Number(d[6]) % 2 === 0) });
  try {
    for (let i = 0; i < 8; i++) {
      const s = await start();
      const code = await codeFor(s.conversation);
      assert.ok(Number(code[5]) % 2 === 1, code);
    }
  } finally {
    company.use({ orderRef: d => REFS.has(d) });
  }
});

test('five wrong tries spend a code; after ten minutes it is spent; a new ask replaces the last', async () => {
  const s = await start();
  const code = await codeFor(s.conversation);
  const wrong = String((Number(code) + 1) % 1e6).padStart(6, '0');
  model([{ text: 'Hmm.' }]);
  for (let i = 0; i < 4; i++) {
    await say(s.conversation, wrong);
    assert.match(lastUser(), /wrong/);
  }
  await say(s.conversation, wrong);
  assert.match(lastUser(), /can't be used any more/);
  await say(s.conversation, code);
  assert.match(lastUser(), /can't be used any more/, 'the right one is spent too');
  const old = await codeFor(s.conversation);
  const fresh = await codeFor(s.conversation);
  model([{ text: 'Hmm.' }]);
  // the replaced code is just a wrong one now
  if (old !== fresh) {
    await say(s.conversation, old);
    assert.match(lastUser(), /wrong\. 4 more tries/);
  }
  db.prepare('update phone_codes set created = created - 600001 where conversation = ?').run(s.conversation);
  await say(s.conversation, fresh);
  assert.match(lastUser(), /can't be used any more/);
  // a number that isn't six digits while a code was asked for: taken out, not a try
  await say(s.conversation, 'it is 4 8 2 9 1');
  assert.match(lastUser(), /\(read out a number\)/);
  assert.doesNotMatch(lastUser(), /4 8 2/);
  // an order's reference is said on this line too: kept as said
  await say(s.conversation, 'my other order is 4829 1736');
  assert.match(lastUser(), /4829 1736/);
  assert.doesNotMatch(lastUser(), /\(read out a number\)/);
  // eight digits that aren't one are taken out
  await say(s.conversation, 'my other order is 4829 1737');
  assert.match(lastUser(), /\(read out a number\)/);
  assert.doesNotMatch(lastUser(), /4829/);
  // one said in words whose first is also "a" ("one", "een", "ein") is kept whole, no code try
  await say(s.conversation, 'my order is one two three four five six six');
  assert.match(lastUser(), /one two three four five six six/);
  assert.doesNotMatch(lastUser(), /\(read out a number\)|\(read out the code\)|can't be used/);
});

test('a code with two digits more in the same run (its first pair said again) is misheard: taken out, not a try', async () => {
  const s = await start();
  const code = await codeFor(s.conversation);
  // the first pair said again, or (if that happens to make a reference) a pair that doesn't
  const again = REFS.has(code + code.slice(0, 2)) ? code[0] + ((Number(code[1]) + 1) % 10) : code.slice(0, 2);
  model([{ text: 'Hmm.' }]);
  await say(s.conversation, `the code is ${code.slice(0, 2)} ${code.slice(2, 4)} ${code.slice(4)}, uh ${again}`);
  assert.match(lastUser(), /\(read out a number\)/);
  assert.match(lastUser(), /read the code again/);
  assert.ok(
    !JSON.stringify(seen.at(-1)).includes(code.slice(2, 4) + ' ' + code.slice(4)),
    'never in what the model gets',
  );
  for (const m of stored(s.conversation)) assert.doesNotMatch(m.text, /\d{2} \d{2}/, 'never kept');
  await say(s.conversation, code);
  assert.match(lastUser(), /right/, 'misheard was no try');
});

test("spoken numbers: digits, words in three languages, pairs, fillers; an article before a code isn't part of it", () => {
  return import('./phonecode.ts').then(({ numberRuns }) => {
    const d = (s: string) => numberRuns(s).map(r => r.digits);
    assert.deepEqual(d('it is 482 917, thanks'), ['482917']);
    assert.deepEqual(d('four eight two, um, nine one seven'), ['482917']);
    assert.deepEqual(d('forty-eight twenty nine seventeen'), ['482917']);
    assert.deepEqual(d('achtenveertig negenentwintig zeventien'), ['482917']);
    assert.deepEqual(d('achtundvierzig neunundzwanzig siebzehn'), ['482917']);
    assert.deepEqual(d('drieëntwintig nul nul één twee'), ['230012']);
    assert.deepEqual(d('de code is een 4 8 2 9 1 7'), ['482917']);
    const ref = (digits: string) => digits === BASKET;
    assert.deepEqual(
      numberRuns('one two three four five six six', ref).map(r => r.digits),
      [BASKET],
    );
    assert.deepEqual(
      numberRuns('een 4 8 2 9 1 7', ref).map(r => r.digits),
      ['482917'],
    );
    assert.deepEqual(d('four oh two one one one'), ['402111']);
    assert.deepEqual(d('oh, it is 12 and 34'), ['12', '34']);
    assert.deepEqual(d('order BUD-7Q4K-M2 from the 3rd'), []);
  });
});

test('report_fault keeps a dated note with the order, code or not; it stays in care and shows beside the order', async () => {
  const s = await start();
  model(
    [{ tool: 'report_fault', input: { order: 'ord-7q4k-m2', what: 'The print is smudged.' } }],
    [{ text: 'Noted.' }],
  );
  await say(s.conversation, 'My blanket ORD-7Q4K-M2 came smudged.');
  assert.equal(results()[0].say, t('phone_fault', 'en'));
  const c = db.prepare("select * from cases where kind = 'fault' and conversation = ?").get(s.conversation) as any;
  assert.equal(c.words, 'The print is smudged.');
  assert.equal(c.checked, 'none');
  assert.equal(c.email, null);
  assert.deepEqual(JSON.parse(c.facts), {
    order: 'ORD7Q4KM2',
    reported: new Date().toISOString().slice(0, 10),
    by: 'phone',
  });
  assert.match(phonecall.faultsFor('ORD-7Q4K-M2').at(-1)!, /by phone, not checked who called: The print is smudged\./);
  await hq.sync();
  assert.ok(!cards.some(x => x.case === `H-${1000 + c.id}`), 'no card of its own in HQ');
});

test("an objection deletes the call's words when it ends; the code check's result and a fault note stay", async () => {
  const s = await start();
  const code = await codeFor(s.conversation);
  model([{ tool: 'no_transcript', input: {} }], [{ text: 'Of course.' }]);
  const lines = await say(s.conversation, `I'd rather you kept no transcript. The code is ${code}.`);
  assert.ok(lines.some(l => l.step === 'no_transcript'));
  model([{ tool: 'report_fault', input: { order: 'ORD-7Q4K-M2', what: 'A corner is torn.' } }], [{ text: 'Noted.' }]);
  await say(s.conversation, 'Also a corner is torn.');
  assert.ok(stored(s.conversation).length > 0);
  const r = await post('/phone/end', { conversation: s.conversation, ended: 'caller' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {});
  assert.equal(stored(s.conversation).length, 0);
  const st = JSON.parse((db.prepare('select state from conversations where id = ?').get(s.conversation) as any).state);
  assert.deepEqual(
    st.phone.checks.map((x: any) => x.result),
    ['right'],
  );
  assert.equal(st.phone.ended.why, 'caller');
  const f = db
    .prepare("select checked from cases where kind = 'fault' and conversation = ?")
    .get(s.conversation) as any;
  assert.equal(f.checked, 'checked');
  // an ended call takes no more turns
  assert.equal((await post('/phone/turn', { conversation: s.conversation, text: 'hi', lang: 'en' })).status, 404);
});

test('pass_on_feedback: a note for the team in general words, held from HQ until the call ends; an objection drops it, and none is taken after one', async () => {
  const notes = (conversation: number) =>
    db.prepare("select * from cases where kind = 'feedback' and conversation = ?").all(conversation) as any[];
  const s = await start();
  model(
    [{ tool: 'pass_on_feedback', input: { feedback: 'Order 1234567 from anna@example.com was slow.' } }],
    [{ text: 'Sorry.' }],
  );
  await say(s.conversation, 'Order 1234567 was a bit slow, pass that on.');
  assert.equal(results()[0].ok, false, 'a number or an address in it: written again in general words');
  assert.deepEqual(notes(s.conversation), []);
  model(
    [{ tool: 'pass_on_feedback', input: { feedback: 'The phone line answers a little slowly.' } }],
    [{ text: 'Passed on.' }],
  );
  await say(s.conversation, 'Sometimes you are a little slow. Please pass it on.');
  assert.equal(results()[0].ok, true);
  const [n] = notes(s.conversation);
  assert.equal(n.words, 'The phone line answers a little slowly.');
  assert.deepEqual(
    [n.email, n.checked, n.facts, n.held],
    [null, 'none', '{}', 'call'],
    'no reply address, nothing about an order',
  );
  const sent = () => cards.filter(x => x.case === `H-${1000 + n.id}`);
  await hq.sync();
  assert.equal(sent().length, 0, 'held while the call goes on');
  await post('/phone/end', { conversation: s.conversation, ended: 'caller' });
  await hq.sync();
  await until(() => sent().length);
  assert.deepEqual(
    sent().map(x => [x.kind, x.to, x.words, x.chat]),
    [['feedback', null, 'The phone line answers a little slowly.', []]],
    'to the team once the call is over, with none of the call',
  );
  // a caller who objects: the note goes with their words
  const no = await start();
  model(
    [{ tool: 'pass_on_feedback', input: { feedback: 'The menu on the site is hard to find.' } }],
    [{ text: 'Passed on.' }],
  );
  await say(no.conversation, 'The menu is hard to find, tell your team.');
  model([{ tool: 'no_transcript', input: {} }], [{ text: 'Of course.' }]);
  await say(no.conversation, "Actually, I'd rather you kept no transcript.");
  assert.equal(notes(no.conversation).length, 1);
  // and a note after the objection isn't taken: the model is told so, to say it
  model(
    [{ tool: 'pass_on_feedback', input: { feedback: 'The phone line answers a little slowly.' } }],
    [{ text: 'I can’t keep it: please write to us.' }],
  );
  await say(no.conversation, 'You are a little slow, pass that on.');
  assert.equal(results()[0].ok, false);
  assert.match(results()[0].note, /^Not passed on: the caller asked for no transcript/);
  assert.equal(notes(no.conversation).length, 1, 'only the one from before the objection, deleted at the end');
  await post('/phone/end', { conversation: no.conversation, ended: 'caller' });
  assert.deepEqual(notes(no.conversation), []);
  // and one who hung up before the notice played whole: never kept
  const gone = await start();
  model(
    [{ tool: 'pass_on_feedback', input: { feedback: 'The shop could use more colours.' } }],
    [{ text: 'Passed on.' }],
  );
  await say(gone.conversation, 'More colours please, pass it on.', 'en', []);
  await post('/phone/end', { conversation: gone.conversation, ended: 'hung_up', informed: [] });
  assert.deepEqual(notes(gone.conversation), []);
});

test('a call the line never ended is ended by the sweep, so an objection is still carried out', async () => {
  const s = await start();
  model([{ tool: 'no_transcript', input: {} }], [{ text: 'Sure.' }]);
  await say(s.conversation, 'No transcript please.');
  phone.sweep(Date.now() + 16 * 60_000);
  assert.equal(stored(s.conversation).length, 0);
});

test('an objection holds once the line has confirmed it, even when the caller hangs up before the model is done', async () => {
  const s = await start();
  model([{ tool: 'no_transcript', input: {} }, { until: new Promise(() => {}) }]);
  const ctl = new AbortController();
  const r = await post(
    '/phone/turn',
    { conversation: s.conversation, text: 'Please keep no transcript.', lang: 'en' },
    PHONE_TOKEN,
    ctl.signal,
  );
  const reader = r.body!.getReader();
  let heard = '';
  while (!heard.includes('"step":"no_transcript"')) heard += new TextDecoder().decode((await reader.read()).value);
  ctl.abort();
  assert.equal((await post('/phone/end', { conversation: s.conversation, ended: 'caller' })).status, 200);
  assert.equal(stored(s.conversation).length, 0);
});

test("the line closing a turn stops the model's stream; what was said is kept, and what it cost", async () => {
  clearLedger();
  const s = await start();
  let open!: () => void;
  const gate = new Promise<void>(r => {
    open = r;
  });
  model([{ text: 'Let me think about that. ' }, { until: gate }, { text: 'never said' }]);
  const ctl = new AbortController();
  const r = await post(
    '/phone/turn',
    { conversation: s.conversation, text: 'A long question', lang: 'en' },
    PHONE_TOKEN,
    ctl.signal,
  );
  const reader = r.body!.getReader();
  let heard = '';
  while (!heard.includes('that')) heard += new TextDecoder().decode((await reader.read()).value);
  assert.match(heard, /"text":"Let "/);
  ctl.abort();
  await until(() => stored(s.conversation).some(m => m.who === 'ai'));
  assert.equal(stored(s.conversation).find(m => m.who === 'ai').text, 'Let me think about that.');
  assert.ok(
    (db.prepare("select count(*) as n from ledger where purpose = 'phone' and estimate = 1").get() as any).n >= 1,
  );
  open();
});

test('a newer turn stops the one before and waits for it: the words stay in the order they were said', async () => {
  const s = await start();
  const gate = new Promise<void>(() => {}); // never opens: only the newer turn ends it
  model([{ text: 'Your parcel is ' }, { until: gate }]);
  const first = await post('/phone/turn', { conversation: s.conversation, text: 'Where is my parcel?', lang: 'en' });
  const reader = first.body!.getReader();
  let heard = '';
  while (!heard.includes('"is ')) heard += new TextDecoder().decode((await reader.read()).value);
  model([{ text: 'Sure, go ahead.' }]);
  await say(s.conversation, 'Wait, one more thing.');
  assert.deepEqual(
    stored(s.conversation).map(m => [m.who, m.text]),
    [
      ['me', 'Where is my parcel?'],
      ['ai', 'Your parcel is'],
      ['me', 'Wait, one more thing.'],
      ['ai', 'Sure, go ahead.'],
    ],
  );
  // the model's copy ends on the caller's words, after what it had said (in the language it said it in)
  assert.equal(seen.at(-1).messages.at(-2).content, 'Your parcel is');
});

test("the reply's language is the model's tag: taken off, streamed before the words, kept with them, and the tools speak it", async () => {
  const company = await import('./company.ts');
  company.use({ langs: ['en', 'nl'] });
  try {
    const s = await start();
    // (the tag split across two pieces of the stream; the round after the tool tagged again)
    model(
      [{ text: '[n' }, { text: 'l] Natuurlijk. ' }, { tool: 'ask_for_person', input: {} }],
      [{ text: '[nl] Nog iets?' }],
    );
    const lines = await say(s.conversation, 'Mag ik iemand spreken?', 'en', ['en', 'nl']);
    assert.deepEqual(
      lines.filter(l => !('text' in l)).map(l => Object.keys(l)[0]),
      ['lang', 'step', 'used', 'lang', 'end'],
    );
    assert.deepEqual(lines[0], { lang: 'nl' });
    assert.equal(words(lines).replace(/\s+/g, ' '), `Natuurlijk. ${t('phone_person', 'nl')} Nog iets?`);
    assert.match(
      seen.at(-1).cached,
      /LANGUAGE\. Answer in the language the caller speaks: English \[en\], Dutch \[nl\]/,
    );
    assert.deepEqual(
      (
        db
          .prepare('select who, text, lang from messages where conversation = ? order by id')
          .all(s.conversation) as any[]
      ).map(m => [m.who, m.text, m.lang]),
      [
        ['me', 'Mag ik iemand spreken?', null],
        ['ai', 'Natuurlijk.', 'nl'],
        ['ai', t('phone_person', 'nl'), 'nl'],
        ['ai', 'Nog iets?', 'nl'],
      ],
    );
    // before the call settles, first words with no tag (or words too short to tell from one) are asked for once more,
    // then go unanswered
    for (const untagged of [[{ text: 'Fijne dag.' }], [{ text: '[' }]]) {
      const asked = seen.length;
      model(untagged);
      const lines = await say(s.conversation, 'Hm?', 'nl');
      assert.equal(seen.length - asked, 2, 'one more try');
      assert.deepEqual(lines, [{ unanswered: 'error' }], 'nothing said in a guessed voice');
    }
    assert.doesNotMatch(seen.at(-1).system, /The call is settled/);
    const asked = seen.length;
    fake.script(
      o => (seen.push(o), seen.length - asked === 1 ? [{ text: 'Graag.' }] : [{ text: '[nl] Graag gedaan.' }]),
    );
    const again = await say(s.conversation, 'Dank je.', 'nl');
    assert.deepEqual([again[0], words(again)], [{ lang: 'nl' }, 'Graag gedaan.'], 'tagged on the second try');
    // the next turn: the model reads its replies as it tagged them, and the facts carry the call's language, which
    // that second reply in it settled
    model([{ text: '[nl] Fijne dag.' }]);
    await say(s.conversation, 'Nee, dank je.', 'nl');
    assert.match(String(seen.at(-1).messages[1].content), /^\[nl\] Natuurlijk\./);
    assert.match(seen.at(-1).system, /The call is settled in Dutch \[nl\]/);
    // settled, words with no tag are in its language: a goodbye after a tool, which left the tag off, is said
    model(
      [{ tool: 'pass_on_feedback', input: { feedback: 'The phone line is friendly.' } }],
      [{ text: 'Dank je, ik geef het door. Fijne avond!' }, { tool: 'hang_up', input: {} }],
    );
    const bye = await say(s.conversation, 'Geef dat maar door als feedback. Doei!', 'nl');
    assert.deepEqual(
      bye.filter(l => !('text' in l)).map(l => Object.values(l)[0]),
      ['pass_on_feedback', 'pass_on_feedback', 'nl', 'hang_up', 'hang_up', true],
    );
    assert.equal(words(bye), 'Dank je, ik geef het door. Fijne avond!');
    // a reply cut off at a tag's start is no reply, settled or not: asked again once, then unanswered
    const cut = seen.length;
    model([{ text: '[' }]);
    assert.deepEqual(await say(s.conversation, 'Hm?', 'nl'), [{ unanswered: 'error' }]);
    assert.equal(seen.length - cut, 2, 'one more try');
  } finally {
    company.use({ langs: ['en'] });
  }
});

test("the call's language settles with the second reply they were informed in: one odd turn doesn't move it, their asking does", async () => {
  const company = await import('./company.ts');
  company.use({ langs: ['en', 'nl'] });
  try {
    const s = await start();
    model([{ text: '[nl] Goedenavond, waarmee kan ik helpen?' }]);
    await say(s.conversation, 'Hallo?', 'nl', ['nl']);
    assert.equal(
      phonecall.load(s.conversation)!.state.phone.locked,
      undefined,
      'one short first reply settles nothing',
    );
    model([{ text: '[nl] Waar gaat het over?' }]);
    await say(s.conversation, 'Ik heb een vraag.', 'nl', ['nl']);
    assert.equal(
      phonecall.load(s.conversation)!.state.phone.locked,
      'nl',
      "settled: a second reply in the notice's language",
    );
    // a turn misheard as English, and a reply that starts in English: asked again, told so, and answered in Dutch
    const asked = seen.length;
    fake.script(
      o => (seen.push(o), seen.length - asked === 1 ? [{ text: '[en] Sorry, what?' }] : [{ text: '[nl] Pardon?' }]),
    );
    const lines = await say(s.conversation, 'Some times you are a little slow.', 'nl', ['nl']);
    assert.equal(seen.length - asked, 2, 'asked once more');
    assert.match(seen.at(-1).system, /The call is settled in Dutch \[nl\]/);
    assert.match(lastUser(), /this call is in Dutch: answer in Dutch \[nl\]/);
    assert.deepEqual([lines[0], words(lines)], [{ lang: 'nl' }, 'Pardon?']);
    assert.ok(!stored(s.conversation).some(m => m.text.includes('what?')), 'nothing in English said or kept');
    // the caller asks for English: the switch, then the reply in English; informed once is informed, so what they say
    // in English is kept with no notice again
    model([{ tool: 'switch_language', input: { lang: 'en' } }], [{ text: '[en] Of course.' }]);
    const switched = await say(s.conversation, 'Kunnen we Engels praten?', 'nl', ['nl']);
    assert.deepEqual(
      switched.filter(l => 'lang' in l),
      [{ lang: 'en' }],
    );
    const p = phonecall.load(s.conversation)!.state.phone;
    assert.deepEqual([p.locked, p.informed], ['en', ['nl', 'en']]);
    model([{ text: '[en] We are in Groningen.' }]);
    await say(s.conversation, 'Where are you based?', 'en', ['nl']);
    assert.ok(
      stored(s.conversation).some(m => m.text === 'Where are you based?'),
      'kept',
    );
    // a model that stays in another language when told: the turn goes unanswered, and the call stays in English
    const again = seen.length;
    fake.script(o => (seen.push(o), [{ text: '[nl] Graag gedaan.' }]));
    const insisted = await say(s.conversation, 'Dank je wel.', 'en', ['nl']);
    assert.equal(seen.length - again, 2);
    assert.deepEqual([insisted, phonecall.load(s.conversation)!.state.phone.locked], [[{ unanswered: 'error' }], 'en']);
  } finally {
    company.use({ langs: ['en'] });
  }
});

test("a switch before the call settles counts as no notice: what they say next waits for the new language's lines", async () => {
  const company = await import('./company.ts');
  company.use({ langs: ['en', 'nl'] });
  try {
    const s = await start();
    model([{ text: '[nl] Goedenavond.' }]);
    await say(s.conversation, 'Allô?', 'nl', ['nl']);
    model([{ tool: 'switch_language', input: { lang: 'en' } }], [{ text: '[en] Of course.' }]);
    await say(s.conversation, 'English?', 'nl', ['nl']);
    assert.deepEqual(phonecall.load(s.conversation)!.state.phone.informed, ['nl'], 'English not counted as heard');
    model([{ text: '[en] We are in Groningen.' }]);
    await say(s.conversation, 'Where are you based?', 'en', ['nl']);
    assert.ok(!stored(s.conversation).some(m => m.text === 'Where are you based?'), 'held, not kept');
  } finally {
    company.use({ langs: ['en'] });
  }
});

test('a second switch before the call settles counts as no notice either', async () => {
  const company = await import('./company.ts');
  company.use({ langs: ['en', 'nl', 'de'] });
  try {
    const s = await start();
    model([{ text: '[nl] Goedenavond.' }]);
    await say(s.conversation, 'Hallo?', 'nl', ['nl']);
    model([{ tool: 'switch_language', input: { lang: 'en' } }], [{ text: '[en] Of course.' }]);
    await say(s.conversation, 'English?', 'nl', ['nl']);
    // one reply in English, its notice heard whole since: then German
    model([{ tool: 'switch_language', input: { lang: 'de' } }], [{ text: '[de] Natürlich.' }]);
    await say(s.conversation, 'Or German?', 'en', ['nl', 'en']);
    model([{ text: '[de] Wir sind in Groningen.' }]);
    await say(s.conversation, 'Wo seid ihr?', 'de', ['nl', 'en']);
    assert.ok(!stored(s.conversation).some(m => m.text === 'Wo seid ihr?'), "held: German's lines not heard yet");
  } finally {
    company.use({ langs: ['en'] });
  }
});

test('a turn counts once in each language towards settling, however its rounds move between them', async () => {
  const company = await import('./company.ts');
  company.use({ langs: ['en', 'nl', 'de'] });
  try {
    const s = await start();
    model(
      [{ text: '[nl] Even kijken. ' }, { tool: 'ask_for_person', input: {} }],
      [{ text: '[en] Or in English. ' }, { tool: 'ask_for_person', input: {} }],
      [{ text: '[nl] Nog iets?' }],
    );
    await say(s.conversation, 'Hallo?', 'nl', ['nl', 'en']);
    // one turn in Dutch: not settled, so a switch to German brings its lines first
    model([{ tool: 'switch_language', input: { lang: 'de' } }], [{ text: '[de] Natürlich.' }]);
    await say(s.conversation, 'Auf Deutsch?', 'nl', ['nl', 'en']);
    model([{ text: '[de] Wir sind in Groningen.' }]);
    await say(s.conversation, 'Wo seid ihr?', 'de', ['nl', 'en']);
    assert.ok(!stored(s.conversation).some(m => m.text === 'Wo seid ihr?'), "held: German's lines not heard yet");
  } finally {
    company.use({ langs: ['en'] });
  }
});

test("a caller's words are kept only once they've heard their own language's notice whole: the reply's tag says which", async () => {
  const company = await import('./company.ts');
  company.use({ langs: ['en', 'nl', 'de'] });
  const kept = (s: any) => stored(s.conversation).map(m => [m.who, m.text]);
  // what else they said that a tool keeps: a fault note (cases), a question for an email answer (phone_answers)
  const noted = (s: any) =>
    ['cases', 'phone_answers'].map(
      table => (db.prepare(`select count(*) as n from ${table} where conversation = ?`).get(s.conversation) as any).n,
    );
  const tools = () =>
    model(
      [
        { text: '[de] Gern.' },
        { tool: 'report_fault', input: { order: 'ORD-7Q4K-M2', what: 'Eine Ecke ist kaputt.' } },
        { tool: 'email_answer', input: { order: 'ORD-7Q4K-M2', question: 'Wann kommt es?', topic: 'delivery' } },
      ],
      [{ text: '[de] Notiert.' }],
    );
  try {
    // a German speaker on a +32 number: the opening's Dutch notice played whole, of the English only its AI line
    const s = await start();
    model([{ text: '[de] Gern, nenn mir die Bestellnummer.' }]);
    await say(s.conversation, 'Wo ist mein Paket?', 'nl', ['nl']);
    assert.deepEqual(kept(s), [], 'nothing kept before the German lines have played');
    assert.equal(lastUser(), 'Wo ist mein Paket?', 'the model has their words');
    // talked over before the German lines ended: their next words wait too, and the model still has the call so far
    model([{ text: '[de] Danke.' }]);
    await say(s.conversation, 'Es ist ORD-7Q4K-M2.', 'de', ['nl']);
    assert.deepEqual(kept(s), []);
    assert.equal(seen.at(-1).messages[0].content, 'Wo ist mein Paket?');
    // once the line says they've played whole, all of it is kept as it was said, in order, before the next words
    model([{ text: '[de] Bitte.' }]);
    await say(s.conversation, 'Danke.', 'de', ['nl', 'de']);
    assert.deepEqual(kept(s), [
      ['me', 'Wo ist mein Paket?'],
      ['ai', 'Gern, nenn mir die Bestellnummer.'],
      ['me', 'Es ist ORD-7Q4K-M2.'],
      ['ai', 'Danke.'],
      ['me', 'Danke.'],
      ['ai', 'Bitte.'],
    ]);

    // hung up during the German lines: none of their words is kept, nor what the tools took from them
    const gone = await start();
    tools();
    await say(gone.conversation, 'Hallo, eine Ecke ist kaputt. Und wann kommt es?', 'nl', ['nl']);
    assert.deepEqual(noted(gone), [0, 0], 'no fault note or question before the German lines have played');
    assert.equal(
      (await post('/phone/end', { conversation: gone.conversation, ended: 'caller', informed: ['nl'] })).status,
      200,
    );
    assert.deepEqual(kept(gone), []);
    assert.deepEqual(noted(gone), [0, 0]);
    // ...and heard whole before the hang-up, they're kept, the tools' records with them
    const whole = await start();
    tools();
    await say(whole.conversation, 'Hallo, eine Ecke ist kaputt. Und wann kommt es?', 'nl', ['nl']);
    await post('/phone/end', { conversation: whole.conversation, ended: 'caller', informed: ['nl', 'de'] });
    assert.deepEqual(kept(whole), [
      ['me', 'Hallo, eine Ecke ist kaputt. Und wann kommt es?'],
      ['ai', 'Gern.'],
      ['ai', 'Notiert.'],
    ]);
    assert.deepEqual(noted(whole), [1, 1]);

    // a no before the lines have played whole: the words held then are never kept, even once the lines have; a fault
    // note, which a case needs, is (once they have)
    const no = await start();
    model(
      [
        { text: '[de] Kein Problem.' },
        { tool: 'report_fault', input: { order: 'ORD-7Q4K-M2', what: 'Eine Ecke ist kaputt.' } },
        { tool: 'no_transcript', input: {} },
      ],
      [{ text: '[de] Sonst noch etwas?' }],
    );
    await say(no.conversation, 'Bitte kein Protokoll. Eine Ecke ist kaputt.', 'nl', ['nl']);
    assert.deepEqual(noted(no), [0, 0]);
    model([{ text: '[de] Gern.' }]);
    await say(no.conversation, 'Wo ist mein Paket?', 'de', ['nl', 'de']);
    assert.deepEqual(
      kept(no).filter(([who]) => who === 'me'),
      [],
    );
    assert.deepEqual(noted(no), [1, 0]);
    // ...and the model keeps the call so far, their words after the no too
    assert.equal(lastUser(), 'Wo ist mein Paket?');
    model([{ text: '[de] Ja.' }]);
    await say(no.conversation, 'Und wann kommt es?', 'de', ['nl', 'de']);
    assert.deepEqual(
      seen
        .at(-1)
        .messages.filter((m: any) => m.role === 'user')
        .map((m: any) => m.content),
      ['Bitte kein Protokoll. Eine Ecke ist kaputt.', 'Wo ist mein Paket?', 'Und wann kommt es?'],
    );
  } finally {
    company.use({ langs: ['en'] });
  }
});

test('retention: a call no code linked goes after 30 days, a linked one after 12 months', async () => {
  const a = await start(),
    b = await start();
  db.prepare('update conversations set linked = ? where id = ?').run(Date.now(), b.conversation);
  sweep(Date.now() + 31 * 864e5);
  assert.equal(db.prepare('select id from conversations where id = ?').get(a.conversation), undefined);
  assert.ok(db.prepare('select id from conversations where id = ?').get(b.conversation));
  sweep(Date.now() + 366 * 864e5);
  assert.equal(db.prepare('select id from conversations where id = ?').get(b.conversation), undefined);
});

test('the end', () => {
  setTimeout(() => process.exit(0), 50);
});
