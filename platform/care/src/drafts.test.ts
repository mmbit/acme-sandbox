// node --test src/drafts.test.ts   (the real server and database in a throwaway DATA_DIR, the fake model, and a local
// server playing HQ's Care app). What the board gets on a card (a draft, its summary, a translation into the board's
// language), when the
// card goes, "Ask for changes", a health detail in no draft or summary, and a card HQ refuses for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HQ's side of the line: the cards care posts, its state with the board's asks, and a 422 for a card it can't take
const cards: any[] = [];
let redraft: any[] = [], states = 0; // states: HQ's state asked for, the last call of every sync run
let board: string | undefined; // the board's language in HQ's state
const hqServer = createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d).on('end', () => {
    if (req.headers.authorization !== 'Bearer hq-test-token') return void res.writeHead(401).end();
    const json = (status: number, o: object) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (req.url === '/api/care/cards') {
      const card = JSON.parse(body);
      cards.push(card);
      return card.words === 'REFUSE ME' ? json(422, { error: 'bad card' }) : json(200, { ok: true, id: String(cards.length) });
    }
    states++;
    json(200, { busy: 'auto', queue: { waiting: 0, oldest: null }, redraft, ...(board ? { board } : {}) });
  });
});
await new Promise<void>(r => hqServer.listen(0, '127.0.0.1', r));

Object.assign(process.env, { DATA_DIR: mkdtempSync(join(tmpdir(), 'care-drafts-')), PORT: String(20000 + Math.floor(Math.random() * 20000)),
  CARE_LOCAL: '1', CARE_PROVIDER: 'fake', CARE_NAMES: JSON.stringify({ shop: 'Shop' }),
  CARE_COMPANY_DIR: new URL('../../../template/products/care', import.meta.url).pathname,
  CARE_HQ_URL: `http://127.0.0.1:${(hqServer.address() as any).port}`, CARE_HQ_TOKEN: 'hq-test-token' });
const fake = await import('./fake.ts');
const { db } = await import('./db.ts');
const ledger = await import('./ledger.ts');
const hq = await import('./hq.ts');
const summaries = await import('./summaries.ts');
await import('./server.ts');

// the fake model: what each call was asked (its tool, instructions and data), and a draft or summary as asked
const calls: { tool: string; system: string; data: any }[] = [];
let answer: (data: any, system: string) => any[] = (data, system) => [{ tool: 'write_draft', input: {
  draft: data.board_ask ? `${data.board_draft} (warmer)` : `Hello, about ${data.case}: a person will check it.\n\nKind regards,`,
  summary: 'Wants to know where the mug is.', translation: /in French/.test(system) ? 'Hello (in English)' : '' } }];
fake.script(o => {
  const data = JSON.parse(o.messages[0].content as string), tool = o.tools[0].name;
  calls.push({ tool, system: o.system, data });
  if (tool === 'write_question') return [{ tool, input: { question: data.customer_words === 'NO SUMMARY' ? '' : 'Does Shop ship mugs to Belgium, and how long does it take?' } }];
  if (tool === 'write_summary') return [{ tool, input: { summary: 'Asked where the mug is; told it ships Friday.', question: 'Asks when a mug ships. Answered from the order status.' } }];
  return answer(data, o.system);
});

// a case as person.ts files it: its conversation (whose data it holds), the messages, the row, and the nudge to HQ
// (marks: each message's health mark; health: the case carries one, engine.ts/person.ts)
function file(o: { kind?: string; checked?: string; lang?: string; to?: string; thread?: string | null; dataOf?: string[]; words?: string; said?: string[]; marks?: (string | null)[]; health?: boolean } = {}) {
  const t0 = Date.now(), to = o.to ?? 'anna@example.com';
  // conversations go by shop
  const conv = Number(db.prepare('insert into conversations (shop, email, created, last, state) values (?, ?, ?, ?, ?)')
    .run('shop', o.thread ?? null, t0, t0, JSON.stringify({ lang: o.lang ?? 'en', dataOf: o.dataOf ?? [] })).lastInsertRowid);
  for (const [i, text] of (o.said ?? ['where is my Mila mug?', 'It shipped on Monday with Royal Mail.']).entries())
    db.prepare('insert into messages (conversation, at, who, text, health) values (?, ?, ?, ?, ?)').run(conv, t0, i % 2 ? 'ai' : 'me', text, o.marks?.[i] ?? null);
  const id = Number(db.prepare('insert into cases (app, conversation, kind, email, checked, words, facts, lang, created, health) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('shop', conv, o.kind ?? 'person', to, o.checked ?? 'checked', o.words ?? 'please help', JSON.stringify({ orders: ['ORD-7Q4K-M2'] }), o.lang ?? 'en', t0, o.health ? 1 : null).lastInsertRowid);
  hq.nudge();
  return { conv, id, ref: `H-${1000 + id}`, t0 };
}
const until = async <T>(f: () => T, ms = 4000): Promise<NonNullable<T>> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const x = f(); if (x) return x as NonNullable<T>; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('timed out waiting');
};
// a sync at a moved-on time; one already running swallows it, so try until what it should do is done
async function syncAt(t: number, done: () => unknown) { return until(() => { if (done()) return true; hq.sync(t); return false; }, 4000); }
const card = (ref: string, kind = 'person') => cards.find(c => c.case === ref && c.kind === kind);

test('an email to a person reaches HQ with its draft and summary, and one in another language with an English translation', async () => {
  const en = file(), fr = file({ lang: 'fr', said: ['où est ma tasse ?'] });
  const a = await until(() => card(en.ref)), b = await until(() => card(fr.ref));
  assert.match(a.draft, new RegExp(`about ${en.ref}`)); assert.equal(a.summary, 'Wants to know where the mug is.');
  assert.equal('translation' in a, false, 'an English draft has none');
  assert.equal(b.translation, 'Hello (in English)');
  assert.match(calls.find(c => c.data.case === fr.ref)!.system, /the email in French/);
  assert.ok(a.chat.some((m: any) => m.who === 'customer' && /Mila mug/.test(m.text)), 'the card still carries the conversation');
  for (const x of [en, fr]) assert.equal((db.prepare("select count(*) as n from ledger where conversation = ? and purpose = 'draft-reply'").get(x.conv) as any).n, 1);
  assert.equal(cards.filter(c => c.case === en.ref).length, 1, 'the draft went with the card, not again after it');
});

test("with the board on Dutch the summary and translation are in Dutch; a Dutch draft has none", async () => {
  const kept = () => (db.prepare("select value from hq_said where key = 'board'").get() as any)?.value;
  const was = answer;
  answer = () => [{ tool: 'write_draft', input: { draft: 'Bonjour.', summary: 'Wil weten waar de mok is.', translation: 'Hallo.' } }];
  try {
    board = 'nl';
    await until(() => { if (kept() === 'nl') return true; hq.sync(); return false; });
    const fr = file({ lang: 'fr', said: ['où est ma tasse ?'] }), nl = file({ lang: 'nl', said: ['waar is mijn mok?'] });
    const a = await until(() => card(fr.ref)), b = await until(() => card(nl.ref));
    const system = calls.find(c => c.data.case === fr.ref)!.system;
    assert.match(system, /summary: one or two lines in Dutch/); assert.match(system, /translation: the draft translated into Dutch/);
    assert.equal(a.translation, 'Hallo.');
    assert.equal('translation' in b, false, "a draft in the board's language has none, whatever the model wrote");
  } finally {
    answer = was; board = 'en';
    await until(() => { if (kept() === 'en') return true; hq.sync(); return false; });
  }
});

test('a card waits while its draft is written, goes without one after 2 minutes, and the draft follows to the same card', async () => {
  answer = (data, system) => [{ wait: 1500 }, { tool: 'write_draft', input: { draft: 'Late, but here.', summary: 's', translation: '' } }];
  const c = file();
  await new Promise(r => setTimeout(r, 300));
  hq.sync();
  await new Promise(r => setTimeout(r, 300));
  assert.equal(card(c.ref), undefined, 'not while the draft is being written');
  await syncAt(c.t0 + 2 * 60_000 + 1000, () => card(c.ref));
  assert.equal(card(c.ref).draft, null);
  const late = await until(() => card(c.ref, 'draft'));
  assert.equal(late.draft, 'Late, but here.'); assert.equal(late.ask, undefined);
});

test('with the model failing the card goes at once without a draft, and a later try sends the draft after it', async () => {
  answer = () => [{ fail: 500 }];
  const c = file();
  const first = await until(() => card(c.ref));
  assert.equal(first.draft, null);
  answer = () => [{ tool: 'write_draft', input: { draft: 'Second try.', summary: '', translation: '' } }];
  ledger.breaker.ok();
  await syncAt(Date.now() + 6 * 60_000, () => card(c.ref, 'draft'));
  assert.equal(card(c.ref, 'draft').draft, 'Second try.');
  assert.equal(card(c.ref, 'draft').summary, null, 'an empty summary isn’t sent as one');
});

test('with the model down (the breaker open) no call is made, the card goes at once, and the draft follows when it’s back', async () => {
  answer = () => [{ tool: 'write_draft', input: { draft: 'After the outage.', summary: '', translation: '' } }];
  ledger.breaker.failed(); ledger.breaker.failed();
  const before = calls.length, c = file();
  assert.equal((await until(() => card(c.ref))).draft, null);
  assert.equal(calls.length, before, 'no model call while it’s down');
  ledger.breaker.ok();
  await syncAt(Date.now() + 6 * 60_000, () => card(c.ref, 'draft'));
  assert.equal(card(c.ref, 'draft').draft, 'After the outage.');
});

test('a conversation that showed another email’s orders, or an address not checked, gets an order-free draft', async () => {
  answer = (data) => [{ tool: 'write_draft', input: { draft: `Hello ${data.case}`, summary: '', translation: '' } }];
  const own = file({ thread: 'anna@example.com', dataOf: ['anna@example.com'] });
  const mixed = file({ thread: 'anna@example.com', dataOf: ['anna@example.com', 'bob@example.com'] });
  const typed = file({ checked: 'none', to: 'cleo@example.com' });
  await until(() => card(own.ref) && card(mixed.ref) && card(typed.ref));
  const asked = (ref: string) => calls.find(c => c.data.case === ref)!;
  assert.doesNotMatch(asked(own.ref).system, /Mention no order details/);
  assert.deepEqual(asked(own.ref).data.facts, { orders: ['ORD-7Q4K-M2'] });
  // never an ask again for what the customer said they don't have
  assert.match(asked(own.ref).system, /Never ask again for something the customer said they don't have/);
  for (const ref of [mixed.ref, typed.ref]) {
    assert.match(asked(ref).system, /Mention no order details at all/);
    assert.match(asked(ref).system, /if they said they don't have the number, don't ask for it/);
    assert.equal(asked(ref).data.facts, undefined, 'and the order facts aren’t in its prompt');
  }
});

test('"Ask for changes" is redrafted once per ask, from the board’s own text, and goes back to the same card', async () => {
  answer = (data) => [{ tool: 'write_draft', input: { draft: data.board_ask ? `${data.board_draft} (warmer)` : 'First draft.', summary: '', translation: '' } }];
  const c = file();
  await until(() => card(c.ref));
  const before = calls.length;
  redraft = [{ id: 'ask-1', case: c.ref, ask: 'warmer, please', draft: 'Dear Anna, the board’s own edit.' }];
  await syncAt(Date.now(), () => cards.find(x => x.kind === 'draft' && x.ask === 'ask-1')); // HQ's state is read every minute
  const back = cards.find(x => x.kind === 'draft' && x.ask === 'ask-1');
  assert.equal(back.case, c.ref); assert.equal(back.draft, 'Dear Anna, the board’s own edit. (warmer)');
  const call = calls.slice(before).find(x => x.data.board_ask)!;
  assert.equal(call.data.board_ask, 'warmer, please');
  assert.match(call.system, /change only what it asked/);
  for (let i = 0; i < 3; i++) { hq.sync(); await new Promise(r => setTimeout(r, 150)); } // HQ still lists it a while
  assert.equal(cards.filter(x => x.ask === 'ask-1').length, 1);
  assert.equal(calls.slice(before).filter(x => x.data.board_ask).length, 1, 'one model call for one ask');
  redraft = [];
});

test('a health detail reaches no model: no draft or redraft for a case it went with, none in another draft or a summary; HQ’s card says so', async () => {
  const before = calls.length;
  // sent to a person from the health card: the case carries it, and so does its message
  const h = file({ said: ['where is my mug? (health case)', 'It shipped on Monday.', 'She was born early and was in the NICU'], marks: [null, null, 'person'],
    words: 'She was born early and was in the NICU', health: true, thread: 'anna@example.com' });
  const sent = await until(() => card(h.ref));
  assert.equal(sent.health, true, 'HQ’s card says no team draft comes'); assert.equal(sent.draft, null);
  assert.ok(sent.chat.some((m: any) => m.health === true && /NICU/.test(m.text)), 'a person reads it on the card, marked');
  // another case, whose conversation has a held message, and one stored before a term joined the list (no mark)
  const o = file({ said: ['where is my mug? (other case)', 'It shipped.', 'my son was in hospital', 'One moment.', 'I was ill all week, by the way'], marks: [null, null, 'held', null, null], thread: 'bob@example.com' });
  await until(() => card(o.ref, 'draft') ?? card(o.ref)?.draft);
  const prompt = JSON.stringify(calls.slice(before).find(x => x.data.case === o.ref)!.data);
  assert.ok(prompt.includes('(other case)') && !prompt.includes('hospital') && !prompt.includes('ill all week'), 'the other draft never sees them');
  assert.ok(!(card(o.ref) ?? {}).chat?.some((m: any) => /hospital/.test(m.text)), 'and a held one goes nowhere, not even to HQ');
  redraft = [{ id: 'ask-health', case: h.ref, ask: 'warmer, please', draft: 'Dear Anna,' }];
  await syncAt(Date.now(), () => db.prepare("select 1 from redrafts where ask = 'ask-health'").get());
  redraft = [];
  assert.ok(!calls.slice(before).some(x => x.data.case === h.ref), 'no draft and no redraft for the health case: no model call at all');
  const summed = () => calls.slice(before).find(x => x.tool === 'write_summary' && JSON.stringify(x.data).includes('(health case)'));
  for (let i = 0; i < 10 && !summed(); i++) await summaries.summarize(Date.now() + 31 * 60_000);
  assert.ok(summed() && !JSON.stringify(summed()!.data).includes('NICU'), 'the summary and the question line are written without it');
});

test('a message stored before its term joined the lists goes to no model and not to HQ either: nobody consented', async () => {
  const c = file({ said: ['where is my mug? (old row)', 'It shipped.', 'my daughter was in the NICU'], marks: [null, null, null] });
  const sent = await until(() => card(c.ref));
  assert.ok(sent.chat.some((m: any) => /old row/.test(m.text)) && !sent.chat.some((m: any) => /NICU/.test(m.text)));
});

test('a redraft written while a health detail joined its case is dropped, not sent', async () => {
  answer = (data) => data.board_ask ? [{ wait: 400 }, { tool: 'write_draft', input: { draft: 'Late redraft.', summary: '', translation: '' } }]
    : [{ tool: 'write_draft', input: { draft: 'First.', summary: '', translation: '' } }];
  const c = file();
  await until(() => card(c.ref));
  redraft = [{ id: 'ask-joined', case: c.ref, ask: 'shorter', draft: 'First.' }];
  await syncAt(Date.now(), () => calls.some(x => x.data.board_ask === 'shorter'));
  redraft = [];
  db.prepare('update cases set health = 1 where id = ?').run(c.id); // person.ts health(): the customer sent one to a person meanwhile
  await until(() => db.prepare("select 1 from redrafts where ask = 'ask-joined'").get());
  for (let i = 0; i < 3; i++) { hq.sync(); await new Promise(r => setTimeout(r, 100)); }
  assert.ok(!cards.some(x => x.ask === 'ask-joined'));
});

// ---- health terms found after a case was filed, questions' summaries, and a card HQ refuses for good
test('a case’s own words with a health term and no mark (filed before the check, or before the term joined a list): no model call, and it’s a health case from then on', async () => {
  const before = calls.length;
  const c = file({ words: 'my daughter was in the NICU, can someone call me?' });
  const sent = await until(() => card(c.ref));
  assert.equal(sent.health, true, 'HQ’s card says no team draft comes'); assert.equal(sent.draft, null);
  assert.equal(db.prepare('select health from cases where id = ?').get(c.id).health, 1);
  redraft = [{ id: 'ask-words', case: c.ref, ask: 'warmer, please', draft: 'Dear Anna,' }];
  await syncAt(Date.now(), () => db.prepare("select 1 from redrafts where ask = 'ask-words'").get());
  redraft = [];
  assert.ok(!calls.slice(before).some(x => x.data.case === c.ref || /NICU/.test(JSON.stringify(x.data))), 'the fake model got no request with it');
  assert.ok(!cards.some(x => x.case === c.ref && x.kind === 'more'), 'its first card said so: no `more` tells HQ again');
});

test('"Ask for changes" on a card HQ has whose words hold a term added to the lists since: no model call, and HQ hears once that it’s a health case', async () => {
  const before = calls.length;
  const c = file({ words: 'please help (term added later)' });
  const sent = await until(() => card(c.ref));
  assert.equal(sent.health, undefined);
  // the words as they were filed, before the check knew this term (a row from then, played here)
  db.prepare("update cases set words = 'my daughter was in the NICU, please help' where id = ?").run(c.id);
  redraft = [{ id: 'ask-later', case: c.ref, ask: 'warmer, please', draft: 'Dear Anna,' }];
  const told = () => cards.filter(x => x.case === c.ref && x.kind === 'more' && x.health === true);
  await syncAt(Date.now(), () => told().length);
  redraft = [];
  for (let i = 0; i < 3; i++) { await hq.sync(); await new Promise(r => setTimeout(r, 50)); }
  assert.equal(told().length, 1);
  assert.deepEqual(told()[0].chat, [], 'nothing new from the customer: the mark alone');
  assert.ok(!cards.some(x => x.ask === 'ask-later'), 'no redraft');
  assert.ok(!calls.slice(before).some(x => /NICU/.test(JSON.stringify(x.data))), 'the fake model got no request with it');
});

test('a customer message the check holds now, after the card went: no empty `more` to HQ, and the case moves past it', async () => {
  const c = file();
  await until(() => card(c.ref));
  const row = db.prepare('select chat_to from cases where id = ?');
  const mid = Number(db.prepare("insert into messages (conversation, at, who, text) values (?, ?, 'me', 'I was in hospital last week')").run(c.conv, Date.now()).lastInsertRowid);
  await syncAt(Date.now(), () => row.get(c.id).chat_to >= mid);
  for (let i = 0; i < 3; i++) { await hq.sync(); await new Promise(r => setTimeout(r, 50)); }
  assert.equal(cards.filter(x => x.case === c.ref && x.kind === 'more').length, 0, 'nothing to send, so nothing posted');
  db.prepare("insert into messages (conversation, at, who, text) values (?, ?, 'me', 'it’s order ORD-7Q4K-M2')").run(c.conv, Date.now());
  const more = await syncAt(Date.now(), () => card(c.ref, 'more'));
  assert.ok(more && !cards.some(x => x.case === c.ref && x.kind === 'more' && x.chat.some((m: any) => /hospital/.test(m.text))));
});

test('a question reaches HQ with the question in general words, written by care\'s model from the customer\'s words alone', async () => {
  const words = 'Hi, Anna here from Gent: will my mug for Mila (ORD-7Q4K-M2) ship to Belgium, and how long?';
  const c = file({ kind: 'question', words, to: 'anna@example.com' });
  const q = await until(() => card(c.ref, 'question'));
  assert.equal(q.summary, 'Does Shop ship mugs to Belgium, and how long does it take?');
  assert.equal(q.words, words, 'the board\'s card keeps the customer\'s own words');
  const call = calls.find(x => x.tool === 'write_question' && x.data.customer_words === words)!;
  assert.deepEqual(Object.keys(call.data).sort(), ['customer_words', 'language'], 'no conversation, facts or address go into it');
  assert.match(call.system, /must not learn who asked/);
  assert.equal((db.prepare("select count(*) as n from ledger where conversation = ? and purpose = 'question'").get(c.conv) as any).n, 1);
});

test('a question whose summary can\'t be written waits through its tries, then goes without one (the board answers it)', async () => {
  const c = file({ kind: 'question', words: 'NO SUMMARY' });
  const tries = () => calls.filter(x => x.tool === 'write_question' && x.data.customer_words === 'NO SUMMARY').length;
  await until(() => tries() === 1);
  await new Promise(r => setTimeout(r, 200)); await hq.sync();
  assert.equal(card(c.ref, 'question'), undefined, 'one failed try: it waits');
  await syncAt(c.t0 + 6 * 60_000, () => tries() === 2);
  assert.equal(card(c.ref, 'question'), undefined);
  await syncAt(c.t0 + 12 * 60_000, () => tries() === 3);
  const q = await until(() => { hq.sync(c.t0 + 12 * 60_000); return card(c.ref, 'question'); });
  assert.equal(q.summary, null);
  assert.equal(tries(), 3);
});

test('a question whose words hold a health term goes to no model: no summary or knowledge answer, it’s a health case at once', async () => {
  const before = calls.length;
  const c = file({ kind: 'question', words: 'can my mug ship before my surgery next week?' });
  const q = await until(() => card(c.ref, 'question'));
  assert.equal(q.summary, null, 'the board answers it'); assert.equal(q.health, true);
  assert.equal(db.prepare('select health from cases where id = ?').get(c.id).health, 1);
  assert.ok(!calls.slice(before).some(x => /surgery/.test(JSON.stringify(x.data))), 'the fake model got no request with it');
});

test('a card HQ refuses for good is tried for a day, said once in the log, then left in the database', async () => {
  const logged: string[] = [], error = console.error;
  console.error = (...a: any[]) => { logged.push(a.join(' ')); };
  try {
    const c = file({ kind: 'question', words: 'REFUSE ME' });
    await until(() => card(c.ref, 'question'));
    const tries = () => cards.filter(x => x.case === c.ref).length;
    await syncAt(Date.now() + 3600_000, () => tries() >= 2);
    // the background syncs use the real clock, so move the refusal a day back for them too, then wait for two runs to end:
    // the second started after the move
    db.prepare('update cases set failed = failed - ? where id = ?').run(24 * 3600_000, c.id);
    const runs = states;
    await syncAt(Date.now(), () => states >= runs + 2);
    const n = tries();
    for (let i = 0; i < 3; i++) { await hq.sync(c.t0 + 24 * 3600_000 + 60_000); await new Promise(r => setTimeout(r, 100)); }
    assert.equal(tries(), n, 'past a day it isn’t sent again');
    assert.equal(logged.filter(l => l.includes(c.ref)).length, 1);
    assert.match(logged.find(l => l.includes(c.ref))!, /refused case H-\d+ \(422\)/);
    assert.ok(db.prepare('select failed from cases where id = ? and sent_hq is null').get(c.id), 'kept, unsent');
  } finally { console.error = error; }
});

test.after(() => { hqServer.close(); setTimeout(() => process.exit(0), 50); });
