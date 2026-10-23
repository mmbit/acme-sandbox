// node --test src/answers.test.ts   (the real server and database in a throwaway DATA_DIR, a knowledge base of its own, the
// fake model, the local outbox, and a local server playing HQ's Care app). The no-answer loop, care's side: a knowledge
// entry's `answers:` stays out of the prompt; after the start each named question is answered once by email, never in
// the chat, and HQ hears it; the ones that aren't questions of that app, already answered or unknown are skipped; one the
// knowledge doesn't answer, or whose answer links outside, isn't sent; a failed email is tried again and goes once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HQ's side of the line: every card care posts
const cards: any[] = [];
const hqServer = createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d).on('end', () => {
    const json = (o: object) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (req.url === '/api/care/cards') { cards.push(JSON.parse(body)); return json({ ok: true, id: String(cards.length) }); }
    json({ busy: 'auto', queue: { waiting: 0, oldest: null } });
  });
});
await new Promise<void>(r => hqServer.listen(0, '127.0.0.1', r));

// the knowledge: an entry of shop's and a shared one, each naming cases (a fresh database numbers them from H-1001), and
// two quoting a chat label
const KB_DIR = mkdtempSync(join(tmpdir(), 'care-kb-'));
const entry = (folder: string, file: string, answers: string, body: string) => {
  mkdirSync(join(KB_DIR, folder), { recursive: true });
  writeFileSync(join(KB_DIR, folder, file), `---\nquestion: ${body.split('.')[0]}?\nsource: the shop's FAQ, "Gifts"\nverified: 2026-10-02\nanswers: "${answers}"\n---\n${body}\n`);
};
entry('shop', 'gift-wrap.md', 'H-1001, H-1002, H-1004, H-1005, H-1099', 'Gift wrapping. We don\'t gift-wrap yet: every order comes in a sturdy box.');
entry('shared', 'belgium.md', 'H-1003,H-1006, H-1007, H-1008, H-1009, H-1010, H-1011', 'Shipping to Belgium. We ship to Belgium; it usually takes 3 to 5 working days.');
entry('shared', 'delete.md', '', 'Deleting the chat. Tap “{label:m_delete}” in the chat\'s menu.');
// one a page shows too, in three languages, each with its own question
mkdirSync(join(KB_DIR, 'langs'));
writeFileSync(join(KB_DIR, 'langs', 'wrap.md'), '---\nquestion: Can you gift-wrap my order?\nquestion.nl: Kunnen jullie mijn bestelling inpakken?\nquestion.de: Könnt ihr meine Bestellung einpacken?\nfaq: shop\nsource: the Help page\nverified: 2026-10-21\n---\nNo, not yet.\n\n## nl\nNee, nog niet.\n\n## de\nNein, noch nicht.\n\n## chat\nOffer the gift message instead.\n');
entry('unread', 'typo.md', '', 'A label the chat doesn\'t have. Tap “{label:m_delete_it}”.'); // no app reads unread/

const logs: string[] = [], log = console.log;
console.log = (...a: any[]) => { logs.push(a.join(' ')); };
Object.assign(process.env, { DATA_DIR: mkdtempSync(join(tmpdir(), 'care-answers-')), PORT: String(20000 + Math.floor(Math.random() * 20000)),
  CARE_LOCAL: '1', CARE_PROVIDER: 'fake', CARE_KB_DIR: KB_DIR, CARE_MAIL_RETRY_MS: '1000',
  CARE_NAMES: JSON.stringify({ shop: 'Shop', other: 'Elsewhere' }),
  CARE_COMPANY_DIR: new URL('../../../template/products/care', import.meta.url).pathname,
  CARE_HQ_URL: `http://127.0.0.1:${(hqServer.address() as any).port}`, CARE_HQ_TOKEN: 'hq-test-token' });
const fake = await import('./fake.ts');
const { db } = await import('./db.ts');
const email = await import('./email.ts');
const kb = await import('./kb.ts');
const i18n = await import('../public/i18n.js'), { words: own } = await import(`${process.env.CARE_COMPANY_DIR}/public/plugin.js`);
const answers = await import('./answers.ts');
const { t } = await import('./texts.ts');
await import('./server.ts');

// the fake model: the question's summary for HQ's card, and the helper's answer as the question's words ask
const calls: { tool: string; tools: string[]; cached: string; data: any }[] = [];
fake.script(o => {
  const data = JSON.parse(o.messages[0].content as string), tool = o.tools[0].name;
  calls.push({ tool, tools: o.tools.map(x => x.name), cached: o.cached ?? '', data });
  if (tool === 'write_question') return [{ tool, input: { question: 'A question about the shop.' } }];
  if (data.question === 'FAIL') return [{ fail: 529 }];
  if (data.question === 'DONT KNOW') return [{ tool, input: { known: false, answer: '' } }];
  if (data.question === 'LINK') return [{ tool, input: { known: true, answer: 'It\'s all on https://evil.example/wrap.' } }];
  return [{ tool, input: { known: true, answer: `Answer to: ${data.question}` } }];
});

// the cases as person.ts files them, in order (H-1001…): a conversation with the question asked in it, and the case
const t0 = Date.UTC(2026, 9, 2, 10);
function file(kind: string, app: string, words: string, lang = 'en', answered: number | null = null) {
  // conversations go by shop
  const conv = Number(db.prepare('insert into conversations (shop, created, last, state) values (?, ?, ?, ?)').run(app, t0, t0, JSON.stringify({ lang })).lastInsertRowid);
  db.prepare('insert into messages (conversation, at, who, text) values (?, ?, ?, ?)').run(conv, t0, 'me', words);
  const id = Number(db.prepare('insert into cases (app, conversation, kind, email, checked, words, facts, lang, created, answered, answered_hq) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(app, conv, kind, `c${conv}@example.com`, 'none', words, '{}', lang, t0, answered, answered).lastInsertRowid);
  return { id, conv, ref: `H-${1000 + id}`, to: `c${conv}@example.com` };
}
const shop = file('question', 'shop', 'Can you gift-wrap the mug?');           // H-1001: answered
const elsewhere = file('question', 'other', 'Do you gift-wrap?');                 // H-1002: named in shop/, but other's
const abroad = file('question', 'other', 'Verzenden jullie naar België?', 'nl');  // H-1003: shared/ answers any app's
const person = file('person', 'shop', 'please call me');                          // H-1004: not a question
const done = file('question', 'shop@preview', 'Gift wrap?', 'en', t0);            // H-1005: answered before
const unknown = file('question', 'shop', 'DONT KNOW');                             // H-1006: the knowledge doesn't answer it
const preview = file('question', 'shop@preview', 'Do you ship to Belgium?', 'de'); // H-1007: shared/, the preview twin
const link = file('question', 'shop', 'LINK');                                     // H-1008: an answer linking outside
const failing = file('question', 'shop', 'FAIL');                                  // H-1009: the model keeps failing

const until = async <T>(f: () => T, ms = 4000): Promise<NonNullable<T>> => {
  const start = Date.now();
  while (Date.now() - start < ms) { const x = f(); if (x) return x as NonNullable<T>; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('timed out waiting');
};
const row = (id: number) => db.prepare('select * from cases where id = ?').get(id) as any;
const mails = (to: string) => email.outbox.filter(m => m.to === to);
const asked = (words: string) => calls.filter(c => c.tool === 'write_answer' && c.data.question === words).length;
const messages = () => (db.prepare('select count(*) as n from messages').get() as any).n;

test('an entry\'s answers: line stays out of the prompt, and names its cases', () => {
  const k = kb.knowledge('shop', 'en');
  assert.match(k, /question: Gift wrapping\?/); assert.match(k, /Shipping to Belgium/);
  assert.doesNotMatch(k, /answers:|H-10/);
  assert.doesNotMatch(kb.knowledge('other', 'en'), /Gift wrapping/, 'another app reads only shared/');
  assert.deepEqual(kb.named().filter(n => n.folder === 'shared').map(n => n.ref), ['H-1003', 'H-1006', 'H-1007', 'H-1008', 'H-1009', 'H-1010', 'H-1011']);
});

test('an entry in several languages reaches a conversation in its own language only, without its faq: line', () => {
  const nl = kb.knowledge('langs', 'nl'), en = kb.knowledge('langs', 'en'), fr = kb.knowledge('langs', 'fr');
  assert.match(nl, /question: Kunnen jullie mijn bestelling inpakken\?\nsource: the Help page\nverified: 2026-10-21\n---\nNee, nog niet\.\nOffer the gift message instead\./);
  assert.doesNotMatch(nl, /Can you gift|No, not yet|Könnt|Nein|faq:|## /);
  assert.match(en, /question: Can you gift-wrap my order\?[\s\S]*---\nNo, not yet\.\nOffer the gift message instead\./);
  assert.doesNotMatch(en, /Kunnen|Nee,|Nein|faq:/);
  assert.equal(fr, en, 'a language it has no words in reads the English');
  assert.notEqual(kb.version('langs', 'nl'), kb.version('langs', 'de'));
});

test('an entry quotes the chat\'s own label by its key, and a key the chat has no words for is found', () => {
  assert.match(kb.knowledge('shop', 'en'), new RegExp(`Tap “${i18n.words('en')('m_delete')}” in the chat's menu`));
  i18n.use({ words: { en: { ...own.en, m_delete: 'Wipe it' } } }); // a renamed button: the knowledge follows it
  try { assert.match(kb.knowledge('shop', 'en'), /Tap “Wipe it” in the chat's menu/); } finally { i18n.use({ words: own }); }
  assert.deepEqual(kb.unknownLabels(), [{ folder: 'unread', file: 'typo.md', key: 'm_delete_it' }]);
  assert.match(kb.knowledge('unread', 'en'), /Tap “\{label:m_delete_it\}”/, 'one the chat has no words for stays its key');
});

test('after the start, each named question is answered once by email, signed by the helper, never in the chat; HQ hears it', async () => {
  const before = messages();
  email.local.down = true; // the email service is down at first: the answers wait, and go once it's back
  await answers.pass(t0 + 60_000);
  assert.equal(mails(shop.to).length, 0);
  assert.equal(JSON.parse(row(shop.id).answer).tries, 1, 'kept with its try counted');
  email.local.down = false;
  await answers.pass(t0 + 120_000);
  for (let i = 0; i < 3; i++) await answers.pass(t0 + 600_000);
  for (const c of [shop, abroad, preview]) assert.equal(mails(c.to).length, 1, `${c.ref}: one email`);
  const m = mails(shop.to)[0];
  assert.equal(m.from, 'Pebble <help@example.com>', 'the company\'s sender');
  assert.equal(m.replyTo, `case-${1000 + shop.id}@example.com`, 'a reply reaches the case in HQ\'s Care, at the sender\'s domain');
  assert.equal(m.subject, t('subject_team', 'en', { app: 'Shop', ref: shop.ref }));
  const body = (app: string, answer: string) => [t('team_intro', 'en', { app, date: '2 October 2026' }), `Answer to: ${answer}`, t('team_reply', 'en'), t('sign', 'en', { app })].join('\n\n');
  assert.equal(m.text, body('Shop', 'Can you gift-wrap the mug?'));
  assert.deepEqual(m.headers, { 'AI-Disclosure': 'mode=machine-generated' }, 'the model wrote the answer');
  // a question asked in a language the company doesn't speak is answered in its first one (a plug-in's other languages:
  // products/care/src/answers.test.ts)
  assert.equal(mails(abroad.to)[0].subject, t('subject_team', 'en', { app: 'Elsewhere', ref: abroad.ref }));
  assert.equal(mails(abroad.to)[0].text, body('Elsewhere', 'Verzenden jullie naar België?'));
  assert.equal(mails(preview.to)[0].text, body('Shop', 'Do you ship to Belgium?'), 'the preview twin is named as its app');
  assert.equal(messages(), before, 'nothing was posted into any chat');
  for (const c of [shop, abroad, preview]) {
    assert.ok(row(c.id).answered && row(c.id).answer === null, `${c.ref} marked answered`);
    assert.equal(asked(row(c.id).words), 1, `${c.ref}: one model call`);
    assert.equal((db.prepare("select count(*) as n from ledger where conversation = ? and purpose = 'answer'").get(c.conv) as any).n, 1);
  }
  // the call: the question, its day and language, with the app's knowledge and no order tools
  const call = calls.find(c => c.data.question === 'Can you gift-wrap the mug?')!;
  assert.deepEqual(call.tools, ['write_answer']);
  assert.deepEqual(call.data, { question: 'Can you gift-wrap the mug?', asked_on: '2 October 2026', language: 'English' });
  assert.match(call.cached, /Gift wrapping/); assert.doesNotMatch(call.cached, /answers:|H-1001/);
  assert.doesNotMatch(calls.find(c => c.data.question === 'Verzenden jullie naar België?')!.cached, /Gift wrapping/, 'other\'s knowledge is shared/ only');
  // HQ hears each answer once, after the question's card
  for (const c of [shop, abroad, preview]) {
    await until(() => cards.some(x => x.kind === 'answered' && x.case === c.ref));
    assert.ok(cards.findIndex(x => x.kind === 'question' && x.case === c.ref) < cards.findIndex(x => x.kind === 'answered' && x.case === c.ref));
  }
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(cards.filter(x => x.kind === 'answered').map(x => x.case).sort(), [shop.ref, abroad.ref, preview.ref].sort());
  assert.deepEqual(cards.find(x => x.kind === 'answered'), { kind: 'answered', case: cards.find(x => x.kind === 'answered').case });
});

test('another app\'s question, a person case, an answered one and an unknown id are skipped with a log line', async () => {
  for (const c of [elsewhere, person, done]) { assert.equal(mails(c.to).length, 0); assert.equal(asked(row(c.id).words), 0); }
  assert.equal(row(elsewhere.id).answered, null);
  for (const [ref, why] of [[elsewhere.ref, 'a question from other, another app'], [person.ref, 'a person case, not a question'],
    [done.ref, 'already answered'], ['H-1099', 'no such case']])
    assert.ok(logs.some(l => l.includes(`${ref} (named in kb/shop/gift-wrap.md): skipped, ${why}`)), `${ref}: ${why}`);
});

test('a question the knowledge doesn\'t answer, or whose answer links outside, isn\'t sent: it stays with HQ\'s card', async () => {
  for (const c of [unknown, link]) {
    assert.equal(mails(c.to).length, 0);
    assert.equal(row(c.id).answered, null);
    assert.equal(row(c.id).answer_tried, kb.version('shop', 'en'));
    assert.equal(asked(row(c.id).words), 1, 'asked once: not again with the same knowledge');
  }
  assert.ok(logs.some(l => l.includes(`${unknown.ref}: not answered by email (the knowledge doesn't answer it)`)));
  assert.ok(logs.some(l => l.includes(`${link.ref}: not answered by email (a web address that isn't ours)`)));
  assert.ok(!cards.some(x => x.kind === 'answered' && [unknown.ref, link.ref].includes(x.case)));
});

test('an answer call that keeps failing is tried three times, five minutes apart, then left for HQ\'s card', async () => {
  assert.equal(asked('FAIL'), 2, 'tried at the first pass and again at the one after 5 minutes; the pass between waited');
  assert.equal(row(failing.id).answer_tried, null);
  await answers.pass(t0 + 14 * 60_000);
  assert.equal(asked('FAIL'), 2, 'not 5 minutes since the last try');
  await answers.pass(t0 + 16 * 60_000);
  assert.equal(asked('FAIL'), 3);
  assert.equal(row(failing.id).answer_tried, kb.version('shop', 'en'));
  await answers.pass(t0 + 30 * 60_000);
  assert.equal(asked('FAIL'), 3);
  assert.equal(mails(failing.to).length, 0);
});

test('a case deleted while its answer is written (HQ\'s erased: the customer asked) gets no email', async () => {
  const gone = file('question', 'shop', 'ERASE ME'); // H-1010, filed only now
  fake.script(o => {
    const data = JSON.parse(o.messages[0].content as string), tool = o.tools[0].name;
    calls.push({ tool, tools: o.tools.map(x => x.name), cached: o.cached ?? '', data });
    if (tool === 'write_question') return [{ tool, input: { question: 'A question about the shop.' } }];
    if (data.question === 'ERASE ME') db.prepare('delete from cases where id = ?').run(gone.id); // mid-call
    return [{ tool, input: { known: true, answer: 'An answer.' } }];
  });
  await answers.pass(t0 + 40 * 60_000);
  assert.equal(asked('ERASE ME'), 1);
  assert.equal(row(gone.id), undefined);
  assert.equal(mails(gone.to).length, 0);
});

test('a question a health detail went with, or whose words hold a health term, is skipped: no model reads it', async () => {
  const sick = file('question', 'shop', 'Do you ship to Belgium before my surgery?'); // H-1011, filed only now
  await answers.pass(t0 + 50 * 60_000);
  assert.equal(asked(row(sick.id).words), 0);
  assert.equal(mails(sick.to).length, 0);
  assert.ok(logs.some(l => l.includes(`${sick.ref} (named in kb/shared/belgium.md): skipped, a health detail went with it`)));
});

test.after(() => { console.log = log; hqServer.close(); setTimeout(() => process.exit(0), 50); });
