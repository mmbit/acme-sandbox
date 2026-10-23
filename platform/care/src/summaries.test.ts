// node --test src/summaries.test.ts   (the real database in a throwaway DATA_DIR and the fake model). A quiet
// conversation's summary and question-log line (summaries.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

Object.assign(process.env, {
  DATA_DIR: mkdtempSync(join(tmpdir(), 'care-summaries-')),
  CARE_LOCAL: '1',
  CARE_PROVIDER: 'fake',
  CARE_NAMES: JSON.stringify({ shop: 'Shop' }),
  CARE_COMPANY_DIR: new URL('../../../template/products/care', import.meta.url).pathname,
});
const fake = await import('./fake.ts');
const { db } = await import('./db.ts');
const summaries = await import('./summaries.ts');
await (await import('./company.ts')).load(); // the plug-in's health terms, which chat() checks

// the fake model: each summary call's data, and the same summary and question line every time
const calls: any[] = [];
fake.script(o => {
  calls.push(JSON.parse(o.messages[0].content as string));
  return [
    {
      tool: 'write_summary',
      input: {
        summary: 'Asked where the mug is; told it ships Friday.',
        question: 'Asks when a mug ships. Answered from the order status.',
      },
    },
  ];
});

test('a quiet conversation gets one summary and one question-log line, and again only after new messages', async () => {
  const t0 = Date.now();
  const conv = Number(
    db
      .prepare('insert into conversations (shop, email, created, last, state) values (?, ?, ?, ?, ?)')
      .run('shop', 'anna@example.com', t0, t0, '{}').lastInsertRowid,
  );
  const say = (at: number, who: string, text: string) =>
    db.prepare('insert into messages (conversation, at, who, text) values (?, ?, ?, ?)').run(conv, at, who, text);
  say(t0, 'me', 'where is my Mila mug?');
  say(t0, 'ai', 'It shipped on Monday with Royal Mail.');
  const summed = () =>
    (db.prepare("select count(*) as n from ledger where conversation = ? and purpose = 'summary'").get(conv) as any).n;
  await summaries.summarize(t0); // not quiet yet
  assert.equal(summed(), 0);
  await summaries.summarize(t0 + 31 * 60_000);
  assert.equal(summed(), 1);
  const row = db.prepare('select summary, summarized from conversations where id = ?').get(conv) as any;
  assert.equal(row.summary, 'Asked where the mug is; told it ships Friday.');
  const lines = () =>
    (db.prepare("select line from questions where line like 'Asks when a mug ships%'").all() as any[]).length;
  assert.equal(lines(), 1);
  await summaries.summarize(t0 + 31 * 60_000);
  assert.equal(summed(), 1, 'nothing new: no second call');
  say(row.summarized + 1000, 'me', 'and can I change the name?');
  await summaries.summarize(t0 + 62 * 60_000);
  assert.equal(summed(), 2);
  assert.equal(lines(), 2);
  const last = calls.at(-1).conversation;
  assert.deepEqual(
    last.filter((m: any) => m.new).map((m: any) => m.text),
    ['and can I change the name?'],
    'the line is about what’s new',
  );
  const q = db
    .prepare('pragma table_info(questions)')
    .all()
    .map((x: any) => x.name);
  assert.deepEqual(q, ['id', 'app', 'day', 'line'], 'a question line has no link back to its conversation');
});
