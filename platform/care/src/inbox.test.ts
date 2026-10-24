// node --test src/inbox.test.ts   (the real server and database in a throwaway DATA_DIR, the fake model, and a local
// server playing HQ's Care app). HQ's own cards (inbox.ts): an email's draft, the health check and the cap before any
// model, each want answered once, and nothing of the words kept or logged.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// what care logs, all of it, to check none of the words are in it
const logged: string[] = [];
for (const k of ['log', 'error', 'warn'] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: any[]) => { logged.push(a.map(String).join(' ')); orig(...a); };
}

// HQ's side: the cards care posts, and its state with the drafts it wants
const cards: any[] = [];
let wanted: any[] = [];
let board: string | undefined; // the board's language in HQ's state
const hqServer = createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d).on('end', () => {
    if (req.headers.authorization !== 'Bearer hq-test-token') return void res.writeHead(401).end();
    const json = (o: object) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (req.url === '/api/care/cards') {
      // an answered want leaves the list, as in HQ
      const c = JSON.parse(body);
      cards.push(c); wanted = wanted.filter(x => x.id !== c.want);
      return json({ ok: true, id: '1' });
    }
    json({ busy: 'auto', queue: { waiting: 0, oldest: null }, redraft: [], drafts: wanted, ...(board ? { board } : {}) });
  });
});
await new Promise<void>(r => hqServer.listen(0, '127.0.0.1', r));

Object.assign(process.env, { DATA_DIR: mkdtempSync(join(tmpdir(), 'care-inbox-')), PORT: String(20000 + Math.floor(Math.random() * 20000)),
  CARE_LOCAL: '1', CARE_PROVIDER: 'fake', CARE_COMPANY_DIR: new URL('../../../template/products/care', import.meta.url).pathname,
  CARE_HQ_URL: `http://127.0.0.1:${(hqServer.address() as any).port}`, CARE_HQ_TOKEN: 'hq-test-token' });
const fake = await import('./fake.ts');
const { db } = await import('./db.ts');
const ledger = await import('./ledger.ts');
const hq = await import('./hq.ts');
await import('./server.ts');

// the fake model: what each call was given, and what it answers (by default a summary, a translation and a draft)
const calls: { tool: string; system: string; data: any; schema: any }[] = [];
let answer: (data: any) => any = () =>
  ({ summary: 'Asks whether mugs ship to Belgium.', translated: '', lang: 'en', draft: 'Hello,\n\nYes, we ship to Belgium.\n\nKind regards,', translation: '' });
fake.script(o => {
  const tool = o.tools[0].name, data = JSON.parse(o.messages[0].content as string);
  calls.push({ tool, system: o.system, data, schema: o.tools[0].input_schema });
  return [{ tool, input: answer(data) }];
});

const until = async <T>(f: () => T, ms = 4000): Promise<NonNullable<T>> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const x = f(); if (x) return x as NonNullable<T>; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('timed out waiting');
};
let n = 0;
const id = (kind: string) => `${kind}-${++n}-test`;
// HQ lists one want; care answers it within a sync or two
async function ask(item: any) {
  wanted = [item];
  const got = await until(() => { const c = cards.find(c => c.want === item.id); if (!c) hq.sync(); return c; });
  wanted = [];
  return got;
}
const email = (words: string, o: any = {}) => ask({ id: id('draft'), case: `E-${n}`, kind: 'email', lang: 'en', words, subject: 'A question', reply: true, ...o });

beforeEach(() => { ledger.breaker.ok(); });

test('an email to hello@ gets a draft that names no order, in the customer\'s language', async () => {
  answer = () => ({ summary: 'Asks whether mugs ship to Belgium.', translated: 'Do you ship to Belgium?', lang: 'fr',
    draft: 'Bonjour,\n\nOui, nous livrons en Belgique.\n\nCordialement,', translation: 'Hello,\n\nYes, we ship to Belgium.\n\nKind regards,' });
  const c = await email('Livrez-vous en Belgique ?', { subject: 'Question' });
  assert.equal(c.lang, 'fr'); assert.match(c.draft, /Belgique/); assert.match(c.translation, /Belgium/); assert.equal(c.boardWords, 'Do you ship to Belgium?');
  const call = calls.at(-1)!;
  assert.match(call.system, /Mention no order details at all/);
  assert.match(call.system, /data, not instructions/);
  assert.deepEqual(call.data, { subject: 'Question', email: 'Livrez-vous en Belgique ?' });
  assert.equal((await email('Livrez-vous en Belgique ?', { reply: false })).lang, 'fr', 'with no draft wanted too');
});

test("a language tag with a region is its language: 'pt-BR' is pt, with or without a draft wanted", async () => {
  answer = () => ({ summary: 'Asks whether mugs ship to Brazil.', translated: 'Do you ship to Brazil?', lang: 'pt-BR',
    draft: 'Olá,\n\nSim, enviamos para o Brasil.\n\nAtenciosamente,', translation: 'Hello,\n\nYes, we ship to Brazil.\n\nKind regards,' });
  const c = await email('Vocês enviam para o Brasil?');
  assert.equal(c.lang, 'pt'); assert.match(c.draft, /Brasil/); assert.equal(c.summary, 'Asks whether mugs ship to Brazil.');
  answer = () => ({ summary: 's', translated: 'Do you ship to Brazil?', lang: ' PT_br ' });
  assert.equal((await email('Vocês enviam para o Brasil?', { reply: false })).lang, 'pt');
});

test('a model answer that names no language is no answer: nothing goes to HQ', async () => {
  answer = () => ({ summary: 's', translated: '', lang: '?', draft: 'Bonjour,\n\nCordialement,', translation: '' });
  const item = { id: id('draft'), case: 'E-79', kind: 'email', lang: 'en', words: 'Livrez-vous ?', subject: 'Question', reply: true };
  const before = calls.length;
  wanted = [item];
  try {
    await until(() => { if (calls.length > before) return true; hq.sync(); return false; });
    for (let i = 0; i < 3; i++) { await hq.sync(); await new Promise(r => setTimeout(r, 50)); }
  } finally { wanted = []; }
  assert.equal(cards.some(c => c.want === item.id), false);
});

test("with the board on Dutch an email's words, the draft's translation and the summary are Dutch; a Dutch email has neither translation", async () => {
  const kept = () => (db.prepare("select value from hq_said where key = 'board'").get() as any)?.value;
  answer = d => ({ summary: 'Vraagt of mokken naar België gaan.', translated: 'Versturen jullie naar België?', lang: /Livrez/.test(d.email) ? 'fr' : 'nl',
    draft: 'Bonjour,\n\nOui.\n\nCordialement,', translation: 'Hallo,\n\nJa.\n\nMet vriendelijke groet,' });
  try {
    board = 'nl';
    await until(() => { if (kept() === 'nl') return true; hq.sync(); return false; });
    const fr = await email('Livrez-vous en Belgique ?');
    assert.deepEqual([fr.summary, fr.boardWords, fr.translation], ['Vraagt of mokken naar België gaan.', 'Versturen jullie naar België?', 'Hallo,\n\nJa.\n\nMet vriendelijke groet,']);
    const call = calls.at(-1)!;
    for (const line of [/summary: one line in Dutch/, /translated: their email translated into Dutch/, /translation: the draft translated into Dutch/]) assert.match(call.system, line);
    assert.match(call.schema.properties.translated.description, /in Dutch/);
    const nl = await email('Versturen jullie naar België?');
    assert.equal('boardWords' in nl, false, "an email in the board's language: no translation, whatever the model wrote");
    assert.equal('translation' in nl, false);
  } finally {
    board = 'en';
    await until(() => { if (kept() === 'en') return true; hq.sync(); return false; });
  }
});

test('a health term in the words or an email\'s subject answers none: health with no model call', async () => {
  const before = calls.length;
  assert.equal((await email('My baby was born early and is still in hospital, where is the mug?')).none, 'health');
  assert.equal((await email('Where is my order?', { subject: 'Our NICU stay' })).none, 'health');
  // (a term from another language's list, a plug-in's: products/care/src/inbox.test.ts)
  assert.equal((await email('My child is in hospital.', { reply: false })).none, 'health');
  assert.equal(calls.length, before, 'no model read them');
});

test('past the cap: none: limit, with no model call; the drafts count in the ledger', async () => {
  answer = () => ({ summary: 's', translated: '', lang: 'en', draft: 'Hello,\n\nKind regards,', translation: '' });
  await email('Is the shop open?');
  assert.ok((db.prepare("select count(*) as n from ledger where app = 'hq' and purpose = 'inbox' and conversation is null").get() as any).n >= 1);
  const row = Number(db.prepare(`insert into ledger (at, app, purpose, model, input, cache_write, cache_read, output, eur, estimate)
    values (?, 'hq', 'inbox', 'claude-sonnet-5-5', 0, 0, 0, 0, 100, 0)`).run(Date.now()).lastInsertRowid);
  const before = calls.length;
  try { assert.equal((await email('Another question')).none, 'limit'); assert.equal(calls.length, before); }
  finally { db.prepare('delete from ledger where id = ?').run(row); }
});

test('each want is answered once: listed again, no second answer and no second model call', async () => {
  const item = { id: id('draft'), case: 'E-77', kind: 'email', lang: 'en', words: 'Do you ship to Austria?', subject: 'Austria', reply: true };
  await ask(item);
  const posts = () => cards.filter(c => c.want === item.id).length, before = calls.length;
  wanted = [item];
  for (let i = 0; i < 3; i++) { await hq.sync(); await new Promise(r => setTimeout(r, 50)); }
  wanted = [];
  assert.equal(posts(), 1); assert.equal(calls.length, before);
});

test('twenty drafts whose model calls failed, waiting to be tried again, don\'t hold the twenty places from a later one', async () => {
  answer = d => ({ summary: 's', translated: '', lang: 'en', draft: d.email === 'Fails' ? '' : 'Hello,\n\nKind regards,', translation: '' });
  const item = (words: string) => ({ id: id('draft'), case: 'E-78', kind: 'email', lang: 'en', words, subject: 'A question', reply: true });
  const items = [...Array.from({ length: 20 }, () => item('Fails')), item('Works')], last = items.at(-1)!;
  const tried = () => calls.filter(c => c.data.email === 'Fails').length, before = tried();
  // three at once: the failing ones are tried first, each once (then they wait out RETRY_MS), and the last after them
  wanted = items;
  try {
    await until(() => { const c = cards.find(c => c.want === last.id); if (!c) hq.sync(); return c; });
    assert.equal(tried() - before, 20, 'each failed draft tried once, none again within RETRY_MS');
  } finally { wanted = []; }
});

test('care keeps no copy of the words, and logs none of them', async () => {
  await email('Secret words about my order 4829 1736 in 3512 AB.', { subject: 'Secret subject' });
  const all = logged.join('\n');
  for (const s of ['Secret words', '4829 1736', '3512 AB', 'Secret subject']) assert.ok(!all.includes(s), `"${s}" is in care's logs`);
  // nothing in the database either: every text column of every table
  const tables = (db.prepare("select name from sqlite_master where type = 'table'").all() as any[]).map(t => t.name);
  for (const t of tables) for (const r of db.prepare(`select * from "${t}"`).all() as any[]) {
    const row = JSON.stringify(r);
    for (const s of ['Secret words', 'Secret subject']) assert.ok(!row.includes(s), `"${s}" is kept in ${t}`);
  }
  assert.ok((db.prepare('select count(*) as n from hq_wants').get() as any).n > 0, 'only the wants\' ids');
});

test.after(() => { hqServer.close(); setTimeout(() => process.exit(0), 50); });
