// node --test src/rights.test.ts   (the real server with the template's plug-in, a throwaway DATA_DIR and knowledge base,
// the fake model and a local server playing HQ's Care app). A data request as a customer makes it in the chat: filed
// at once with their own words and its receipt, never answered or closed from the knowledge, never lost for want of an
// address, and naming the copies the team still has after the chat itself was deleted.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HQ's side of the line: every card care posts
const cards: any[] = [];
const hqServer = createServer((req, res) => {
  let body = '';
  req
    .on('data', d => (body += d))
    .on('end', () => {
      const json = (o: object) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      if (req.url === '/api/care/cards') {
        cards.push(JSON.parse(body));
        return json({ ok: true, id: String(cards.length) });
      }
      json({ busy: 'auto', queue: { waiting: 0, oldest: null } });
    });
});
await new Promise<void>(r => hqServer.listen(0, '127.0.0.1', r));

// the knowledge names the first two cases a fresh database files: the data request (H-1001) and a question (H-1002)
const KB_DIR = mkdtempSync(join(tmpdir(), 'care-kb-'));
mkdirSync(join(KB_DIR, 'shared'));
writeFileSync(
  join(KB_DIR, 'shared', 'data.md'),
  '---\nquestion: What data do you keep?\nsource: the privacy notice\nverified: 2026-10-21\nanswers: "H-1001, H-1002"\n---\nThe chat keeps the conversation and anything sent to the team.\n',
);

const PORT = 20000 + Math.floor(Math.random() * 20000);
Object.assign(process.env, {
  DATA_DIR: mkdtempSync(join(tmpdir(), 'care-rights-')),
  PORT: String(PORT),
  CARE_LOCAL: '1',
  CARE_PROVIDER: 'fake',
  CARE_KB_DIR: KB_DIR,
  CARE_NAMES: JSON.stringify({ shop: 'Shop' }),
  CARE_COMPANY_DIR: new URL('../../../template/products/care', import.meta.url).pathname,
  CARE_HQ_URL: `http://127.0.0.1:${(hqServer.address() as any).port}`,
  CARE_HQ_TOKEN: 'hq-test-token',
});
const fake = await import('./fake.ts');
const { db } = await import('./db.ts');
const email = await import('./email.ts');
const hq = await import('./hq.ts');
const answers = await import('./answers.ts');
const { t, mask } = await import('./texts.ts');
const { settings } = await import('./company.ts');
await import('./server.ts');
await new Promise(r => setTimeout(r, 100));

// ---- a customer: a cookie, the chat's stream, and the widget's POSTs
const BASE = `http://127.0.0.1:${PORT}`;
async function customer() {
  let cookie = '';
  const events: any[] = [];
  const tab = crypto.randomUUID();
  const headers = () => ({
    'x-care-app': 'shop',
    origin: BASE,
    'content-type': 'application/json',
    'x-forwarded-for': '10.1.2.3',
    'x-care-tab': tab,
    ...(cookie ? { cookie } : {}),
  });
  const post = async (path: string, body: any = {}) => {
    const r = await fetch(`${BASE}/__care/api/${path}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    const set = r.headers
      .getSetCookie()
      .filter(c => c.startsWith('__Host-care='))
      .at(-1);
    if (set) cookie = set.split(';')[0];
    return r.json() as any;
  };
  await post('hello', { lang: 'en' });
  const ctl = new AbortController();
  const stream = await fetch(`${BASE}/__care/api/stream`, { headers: headers(), signal: ctl.signal });
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of stream.body as any) {
        buf += dec.decode(chunk);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (ev.startsWith('data: ')) events.push(JSON.parse(ev.slice(6)));
        }
      }
    } catch {
      /* closed */
    }
  })();
  let n = 0;
  const say = (text: string) => post('say', { id: `c${++n}`, text });
  const replies = () => events.filter(e => e.t === 'reply');
  return { post, say, replies, close: () => ctl.abort() };
}
const until = async <T>(f: () => T, ms = 6000): Promise<NonNullable<T>> => {
  const start = performance.now(); // a test's mocked Date stands still
  while (performance.now() - start < ms) {
    const x = f();
    if (x) return x as NonNullable<T>;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
};
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const rows = (kind: string) => db.prepare('select * from cases where kind = ? order by id').all(kind) as any[];
const facts = (c: any) => JSON.parse(c.facts);
const card = (kind: string, ref: string) => cards.find(x => x.kind === kind && x.case === ref);
// the customer's messages the model sees, by the numbers the server gives them ([#12])
const numbered = (m: any) =>
  [...String(typeof m.content === 'string' ? m.content : '').matchAll(/\[#(\d+)\]/g)].map(x => Number(x[1]));
const said = (m: any) => (typeof m.content === 'string' ? m.content : '');

// the fake model: what each test's customer asks for, by the words they wrote; the answer and summary calls of the
// question case
fake.script(o => {
  const tool = o.tools[0]?.name;
  if (tool === 'write_question') return [{ tool, input: { question: 'Does the app have a timer?' } }];
  if (tool === 'write_answer')
    return [{ tool, input: { known: true, answer: 'The chat keeps the conversation and anything sent to the team.' } }];
  const last = o.messages.at(-1)!;
  if (typeof last.content !== 'string') return [];
  const text = said(last),
    mine = numbered(last);
  if (/copy of all the personal data/.test(text))
    return [{ tool: 'privacy_request', input: { rights: ['access'], messages: mine } }];
  if (/delete everything your team still has/.test(text))
    return [{ tool: 'privacy_request', input: { rights: ['erasure'], messages: mine, email: 'cleo@example.com' } }];
  if (/a copy of what you hold about me and then delete it/.test(text))
    return [
      { tool: 'privacy_request', input: { rights: ['access', 'erasure'], messages: mine, email: 'gus@example.com' } },
    ];
  if (/correct my name|correct the address on my account/.test(text))
    return [{ tool: 'privacy_request', input: { rights: ['correction'], messages: mine } }];
  if (/My first message here was part of it/.test(text)) {
    const first = o.messages
      .map(said)
      .join('\n')
      .match(/\[#(\d+)\] What do you hold about my order/)!;
    return [{ tool: 'privacy_request', input: { rights: ['access'], messages: [Number(first[1])] } }];
  }
  if (/ask the team/.test(text)) return [{ tool: 'ask_team', input: { question: 'Does the app have a timer?' } }];
  const typed = /\S+@\S+\.\w+/.exec(text.replace(/\[#\d+\] /g, ''));
  if (typed) return [{ tool: 'reply_address', input: { email: typed[0] } }];
  return [{ text: 'OK.' }];
});

// a request long and specific enough that a 2,000-character cut would lose what it asks for, in one message
const ITEMS = Array.from(
  { length: 60 },
  (_, i) => `the conversation of ${i + 1} October about the rain sound and its fader`,
);
const LONG = `Please send me a copy of all the personal data you hold about me. In particular: ${ITEMS.join('; ')}. Also tell me who else has seen it.`;

test('a data request goes to the team at once, in their own words and received when they sent it, with no yes, no case for trying here and no purchase', async ctx => {
  ctx.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 31, 10, 5) });
  await withChatFirst(async () => {
    const c = await customer();
    const { bodyMax } = await c.post('hello', { lang: 'en' });
    assert.ok(LONG.length > 2000 && new TextEncoder().encode(JSON.stringify({ text: LONG })).length < bodyMax);
    await c.say(LONG);
    await until(() => c.replies().find(r => r.text === t('rights_address', 'en')));
    const [held] = rows('rights');
    assert.equal(held.words, LONG, 'the whole request, as written');
    assert.ok(
      !c.replies().some(r => r.widget?.type === 'choice' || r.widget?.type === 'summary'),
      'no "Let\'s try here", no email card',
    );
    mock.timers.setTime(Date.UTC(2026, 10, 1, 9, 0)); // the address comes the next day
    await pause(1600); // past the gap after the last draft
    await c.say('anna.rights@example.com');
    await until(() =>
      c.replies().find(r => r.text === t('rights_sent', 'en', { to: mask('anna.rights@example.com') })),
    );
    const got = await until(() => card('rights', `H-${1000 + held.id}`));
    assert.equal(got.words, LONG);
    assert.deepEqual(got.chat, [], 'only the request, not the whole chat');
    assert.equal(got.draft, null, 'no model drafts its reply');
    assert.equal(got.to, 'anna.rights@example.com');
    assert.equal(got.check, 'none', 'no order needed');
    assert.equal(
      got.facts.received,
      '31 October 2026 at 10:05 (Europe/London)',
      'the receipt is the request, not the address that came after',
    );
    assert.equal(got.facts.answer_by, '30 November 2026');
    c.close();
  });
});

test('the delete button removes the chat, and a later erasure request names the cases the team still has', async () => {
  const c = await customer();
  await c.say('Does it have a timer? Please ask the team');
  await until(() => c.replies().find(r => r.text === t('team_address', 'en')));
  await pause(1600);
  await c.say('cleo@example.com');
  const question = await until(() => rows('question')[0]);
  assert.equal((await c.post('delete')).ok, true);
  assert.equal(
    (db.prepare('select conversation from cases where id = ?').get(question.id) as any).conversation,
    null,
    'what went to the team stays',
  );
  c.close();
  const d = await customer();
  const words = 'Please delete everything your team still has from my earlier chat. Reply to cleo@example.com';
  await d.say(words);
  await until(() => d.replies().find(r => r.text === t('rights_sent', 'en', { to: mask('cleo@example.com') })));
  const erasure = await until(() => cards.find(x => x.kind === 'rights' && x.facts.right.includes('erasure')));
  assert.equal(erasure.words, words);
  assert.equal(erasure.to, 'cleo@example.com');
  assert.deepEqual(erasure.facts.other_cases, [`H-${1000 + question.id} (Shop)`]);
  d.close();
});

test('the knowledge never answers or closes a data request, while it answers the question it names', async () => {
  const [request] = rows('rights'),
    [question] = rows('question');
  assert.deepEqual([request.id, question.id], [1, 2], 'the cases the knowledge names');
  await answers.pass();
  await until(() => db.prepare('select answered from cases where id = ?').get(question.id) as any).then(r =>
    assert.ok(r.answered),
  );
  assert.equal((db.prepare('select answered, answer from cases where id = ?').get(request.id) as any).answered, null);
  assert.ok(!email.outbox.some(m => m.to === 'anna.rights@example.com'), 'no email from the knowledge');
  await hq.sync();
  assert.ok(!cards.some(x => x.kind === 'answered' && x.case === 'H-1001'), 'its card stays open in HQ');
});

test('one message that asks for two rights reaches HQ with both', async () => {
  const c = await customer();
  const words = 'Send me a copy of what you hold about me and then delete it. Reply to gus@example.com';
  await c.say(words);
  const got = await until(() => cards.find(x => x.kind === 'rights' && x.words === words));
  assert.deepEqual(got.facts.right, ['access', 'erasure']);
  c.close();
});

test('a request still waiting for its address reaches HQ once the chat has gone quiet, and an address given after reaches its card', async () => {
  const c = await customer();
  await c.say('Please correct my name on what you hold: it is Dora, not Dara');
  await until(() => c.replies().find(r => r.text === t('rights_address', 'en')));
  const held = rows('rights').find(x => facts(x).right.includes('correction'));
  await hq.sync();
  assert.equal(card('rights', `H-${1000 + held.id}`), undefined, 'waiting for the address');
  await hq.sync(Date.now() + 31 * 60_000);
  const got = card('rights', `H-${1000 + held.id}`);
  assert.equal(got.to, null);
  assert.equal(got.words, 'Please correct my name on what you hold: it is Dora, not Dara');
  await pause(1600);
  await c.say('dora.rights@example.com');
  await until(() => c.replies().find(r => r.text === t('rights_sent', 'en', { to: mask('dora.rights@example.com') })));
  await hq.sync();
  const again = cards.filter(x => x.kind === 'rights' && x.case === `H-${1000 + held.id}`);
  assert.equal(again.at(-1).to, 'dora.rights@example.com', 'the same card, now with the address');
  c.close();
});

test('an address given after a question to the team still reaches the request, with an earlier case under that address, and the question goes too', async () => {
  const a = await customer();
  await a.say('Does it have a timer? Please ask the team');
  await until(() => a.replies().find(r => r.text === t('team_address', 'en')));
  await pause(1600);
  await a.say('fern.rights@example.com');
  const earlier = await until(() => rows('question').find(x => x.email === 'fern.rights@example.com'));
  a.close();
  const c = await customer();
  const words = 'Please correct my name on what you hold: it is Fern, not Fren';
  await c.say(words);
  await until(() => c.replies().find(r => r.text === t('rights_address', 'en')));
  const held = rows('rights').find(x => x.words === words);
  await hq.sync(Date.now() + 31 * 60_000);
  assert.equal(card('rights', `H-${1000 + held.id}`).to, null, 'gone without an address');
  await pause(1600);
  await c.say('Does it have a timer? Please ask the team');
  await until(() => c.replies().filter(r => r.text === t('team_address', 'en')).length);
  await pause(1600);
  await c.say('fern.rights@example.com');
  const to = mask('fern.rights@example.com');
  await until(() => c.replies().find(r => r.text === t('rights_sent', 'en', { to })));
  await until(() => c.replies().find(r => r.text === t('team_sent', 'en', { to })));
  await hq.sync();
  const again = cards.filter(x => x.kind === 'rights' && x.case === `H-${1000 + held.id}`).at(-1);
  assert.equal(again.to, 'fern.rights@example.com', 'the same card, now with the address');
  assert.ok(again.facts.other_cases.includes(`H-${1000 + earlier.id} (Shop)`), 'with the earlier case under it');
  assert.ok(
    rows('question').some(x => x.id !== earlier.id && x.email === 'fern.rights@example.com'),
    'the question went to the team as well',
  );
  c.close();
});

test('words from an earlier message that join a request take its receipt and last day to answer back to that message', async ctx => {
  ctx.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2027, 0, 31, 23, 50) });
  const c = await customer();
  const first = 'What do you hold about my order from last week?';
  await c.say(first);
  await until(() => c.replies().find(r => r.text === 'OK.'));
  mock.timers.setTime(Date.UTC(2027, 1, 1, 0, 10));
  await pause(1600);
  await c.say('Please correct the address on my account');
  await until(() => c.replies().find(r => r.text === t('rights_address', 'en')));
  mock.timers.setTime(Date.UTC(2027, 1, 1, 0, 11));
  await pause(1600);
  await c.say('My first message here was part of it');
  await until(() => rows('rights').find(x => x.words.endsWith(first)));
  mock.timers.setTime(Date.UTC(2027, 1, 1, 0, 12));
  await pause(1600);
  await c.say('eve.rights@example.com');
  const got = await until(() => cards.find(x => x.kind === 'rights' && x.to === 'eve.rights@example.com'));
  assert.equal(got.words, `Please correct the address on my account\n\n${first}`);
  assert.deepEqual(got.facts.right, ['correction', 'access']);
  assert.equal(got.facts.received, '31 January 2027 at 23:50 (Europe/London)');
  assert.equal(got.facts.answer_by, '28 February 2027');
  c.close();
});

test('a request’s receipt is when it was sent on the company’s clock, and its last day to answer the same date a month on, or that month’s last day', async ctx => {
  ctx.after(() => mock.timers.reset());
  const sent: [number, string, string][] = [
    [Date.UTC(2027, 2, 31, 12, 0), '31 March 2027 at 13:00 (Europe/London)', '30 April 2027'],
    [Date.UTC(2027, 5, 30, 23, 30), '1 July 2027 at 00:30 (Europe/London)', '1 August 2027'],
    [Date.UTC(2027, 11, 31, 9, 15), '31 December 2027 at 09:15 (Europe/London)', '31 January 2028'],
    [Date.UTC(2028, 0, 31, 10, 0), '31 January 2028 at 10:00 (Europe/London)', '29 February 2028'],
  ];
  mock.timers.enable({ apis: ['Date'], now: sent[0][0] });
  for (const [i, [at, received, answerBy]] of sent.entries()) {
    mock.timers.setTime(at);
    const c = await customer();
    const words = `Please delete everything your team still has about my order ${i + 1}. Reply to cleo@example.com`;
    await c.say(words);
    const got = await until(() => cards.find(x => x.kind === 'rights' && x.words === words));
    assert.deepEqual([got.facts.received, got.facts.answer_by], [received, answerBy]);
    c.close();
  }
});

async function withChatFirst(f: () => Promise<void>) {
  const was = settings.chatFirst;
  settings.chatFirst = true;
  try {
    await f();
  } finally {
    settings.chatFirst = was;
  }
}

test.after(() => {
  hqServer.close();
  setTimeout(() => process.exit(0), 50);
});
